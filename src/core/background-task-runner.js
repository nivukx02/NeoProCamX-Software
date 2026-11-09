'use strict';

const path = require('node:path');
const { Readable } = require('node:stream');
const { Worker } = require('node:worker_threads');

const WORKER_PATH = path.join(__dirname, 'background-task-worker.js');

function workerError(payload, fallback = 'Background media task failed') {
  const error = new Error(payload?.message || fallback);
  if (payload?.name) error.name = payload.name;
  if (payload?.code) error.code = payload.code;
  if (payload?.stack) error.stack = payload.stack;
  return error;
}

function startBackgroundTask(task, payload, options = {}) {
  const worker = new Worker(WORKER_PATH, { workerData: { mode: 'task', task, payload } });
  let settled = false;
  let timeout = null;
  let resolvePromise;
  let rejectPromise;
  let lastProgressAt = 0;
  let pendingProgress = null;
  let progressTimer = null;
  const progressIntervalMs = Math.max(0, Number(options.progressIntervalMs || 0));

  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const dispatchProgress = progress => {
    if (!options.onProgress || settled) return;
    try { options.onProgress(progress); } catch { /* UI telemetry must never fail media work. */ }
  };
  const flushProgress = () => {
    progressTimer = null;
    if (!pendingProgress) return;
    const progress = pendingProgress;
    pendingProgress = null;
    lastProgressAt = Date.now();
    dispatchProgress(progress);
  };
  const queueProgress = progress => {
    if (!progressIntervalMs || progress?.ratio >= 1 || Date.now() - lastProgressAt >= progressIntervalMs) {
      if (progressTimer) clearTimeout(progressTimer);
      progressTimer = null;
      pendingProgress = null;
      lastProgressAt = Date.now();
      dispatchProgress(progress);
      return;
    }
    pendingProgress = progress;
    if (!progressTimer) progressTimer = setTimeout(flushProgress, progressIntervalMs);
  };
  const cleanup = () => {
    if (timeout) clearTimeout(timeout);
    if (progressTimer) clearTimeout(progressTimer);
    timeout = null;
    progressTimer = null;
  };
  const resolveOnce = result => {
    if (settled) return;
    settled = true;
    cleanup();
    resolvePromise(result);
    void worker.terminate();
  };
  const rejectOnce = error => {
    if (settled) return;
    settled = true;
    cleanup();
    rejectPromise(error);
    void worker.terminate();
  };

  worker.on('message', message => {
    if (message?.type === 'progress') queueProgress(message.progress);
    else if (message?.type === 'result') resolveOnce(message.result);
    else if (message?.type === 'error') rejectOnce(workerError(message.error));
  });
  worker.once('error', rejectOnce);
  worker.once('exit', code => {
    if (!settled) rejectOnce(new Error(`Background media worker exited before completion (code ${code})`));
  });
  if (Number(options.timeoutMs) > 0) {
    timeout = setTimeout(() => rejectOnce(new Error(`Background media task timed out: ${task}`)), Number(options.timeoutMs));
  }

  return {
    promise,
    cancel(reason = 'Background media task cancelled') {
      if (settled) return false;
      try { worker.postMessage({ type: 'cancel' }); } catch { /* Worker may already be exiting. */ }
      rejectOnce(new Error(reason));
      return true;
    }
  };
}

function runBackgroundTask(task, payload, options) {
  return startBackgroundTask(task, payload, options).promise;
}

class BackgroundFrameStream extends Readable {
  constructor(filePath, media, options = {}) {
    super({ highWaterMark: Math.max(1024 * 1024, Number(options.highWaterMark || 32 * 1024 * 1024)) });
    this.ready = false;
    this.waiting = false;
    this.wantFrame = false;
    this.ended = false;
    this.lastProgressAt = 0;
    this.pendingProgress = null;
    this.progressTimer = null;
    this.progressIntervalMs = Math.max(0, Number(options.progressIntervalMs || 0));
    this.onProgress = options.onProgress;
    this.worker = new Worker(WORKER_PATH, {
      workerData: {
        mode: 'frame-stream',
        payload: {
          filePath,
          media,
          rawPreview: options.rawPreview === true,
          develop: options.develop === true,
          quality: options.quality || 'maximum'
        }
      }
    });
    this.worker.on('message', message => this.handleMessage(message));
    this.worker.once('error', error => this.destroy(error));
    this.worker.once('exit', code => {
      if (!this.destroyed && !this.ended) this.destroy(new Error(`Frame worker exited unexpectedly (code ${code})`));
    });
  }

  emitProgress(progress) {
    if (!this.onProgress || this.destroyed) return;
    const dispatch = value => {
      try { this.onProgress(value); } catch { /* Progress callbacks are observational. */ }
    };
    if (!this.progressIntervalMs || progress?.ratio >= 1 || Date.now() - this.lastProgressAt >= this.progressIntervalMs) {
      if (this.progressTimer) clearTimeout(this.progressTimer);
      this.progressTimer = null;
      this.pendingProgress = null;
      this.lastProgressAt = Date.now();
      dispatch(progress);
      return;
    }
    this.pendingProgress = progress;
    if (!this.progressTimer) {
      this.progressTimer = setTimeout(() => {
        this.progressTimer = null;
        if (!this.pendingProgress || this.destroyed) return;
        const value = this.pendingProgress;
        this.pendingProgress = null;
        this.lastProgressAt = Date.now();
        dispatch(value);
      }, this.progressIntervalMs);
    }
  }

  handleMessage(message) {
    if (this.destroyed) return;
    if (message?.type === 'ready') {
      this.ready = true;
      this.requestFrame();
      return;
    }
    if (message?.type === 'progress') {
      this.emitProgress(message.progress);
      return;
    }
    if (message?.type === 'error') {
      this.destroy(workerError(message.error, 'Frame decoding failed'));
      return;
    }
    if (message?.type === 'end') {
      this.waiting = false;
      this.ended = true;
      this.push(null);
      return;
    }
    if (message?.type === 'frame') {
      this.waiting = false;
      const view = message.bytes;
      const buffer = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
      if (this.push(buffer)) {
        this.wantFrame = true;
        this.requestFrame();
      }
    }
  }

  requestFrame() {
    if (!this.ready || !this.wantFrame || this.waiting || this.ended || this.destroyed) return;
    this.wantFrame = false;
    this.waiting = true;
    this.worker.postMessage({ type: 'next' });
  }

  _read() {
    this.wantFrame = true;
    this.requestFrame();
  }

  _destroy(error, callback) {
    this.ended = true;
    if (this.progressTimer) clearTimeout(this.progressTimer);
    this.progressTimer = null;
    try { this.worker.postMessage({ type: 'cancel' }); } catch { /* Worker may already be gone. */ }
    this.worker.terminate().then(() => callback(error), () => callback(error));
  }
}

function createBackgroundFrameStream(filePath, media, options) {
  return new BackgroundFrameStream(filePath, media, options);
}

module.exports = {
  WORKER_PATH,
  workerError,
  startBackgroundTask,
  runBackgroundTask,
  BackgroundFrameStream,
  createBackgroundFrameStream
};
