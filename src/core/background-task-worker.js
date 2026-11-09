'use strict';

// All CPU-heavy JavaScript media work runs in this worker. Electron's main
// thread must remain available to pump window messages or Windows will mark
// CamX Studio as "Not responding" even though a conversion is still running.
const fs = require('node:fs');
const path = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');
const { probeNpv10, probeNpraw, createFrameStream } = require('./binary-formats');
const { createDevelopedRawStream, createPreviewRawStream } = require('./raw-develop');
const { writeDngSequence } = require('./cinema-dng');
const { probeNpv10Audio, prepareConversionCompanions } = require('./camera-sidecars');
const { validateVideo, validateDngSequence } = require('./output-validator');

function serializeError(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    stack: error?.stack || null,
    code: error?.code || null
  };
}

async function probeCustomMedia(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.npraw') return probeNpraw(filePath);
  if (extension !== '.npv10') throw new Error(`Unsupported background probe type: ${extension || 'none'}`);

  const info = await probeNpv10(filePath);
  const audioExpected = ['true', '1', 'yes', 'on'].includes(
    String(info.metadataValues?.audiostoredinnpv10bundle || '').toLowerCase()
  );
  const sidecarPath = `${filePath}.audio.npv10a`;
  if (audioExpected || fs.existsSync(sidecarPath)) {
    try {
      const audioSidecar = await probeNpv10Audio(filePath);
      if (Array.isArray(info.timestamps) && info.timestamps.length &&
          audioSidecar.videoOriginSensorTimestampNs !== info.timestamps[0]) {
        throw new Error(
          `audio/video origin mismatch (${audioSidecar.videoOriginSensorTimestampNs} != ${info.timestamps[0]})`
        );
      }
      info.audioSidecar = audioSidecar;
      info.audio = true;
    } catch (error) {
      if (audioExpected) throw new Error(`Required NPV10 audio sidecar failed validation: ${error.message}`);
      info.warnings.push(`Optional NPV10 audio sidecar ignored: ${error.message}`);
      info.audio = false;
    }
  } else {
    info.audio = false;
  }
  info.audioExpected = audioExpected;
  return info;
}

async function runTask(task, payload) {
  if (task === 'ping') return { ready: true, isolated: true };
  if (task === 'probe-custom') return probeCustomMedia(payload.filePath);
  if (task === 'cinema-dng') {
    return writeDngSequence(payload.directory, payload.sourcePath, payload.media, progress => {
      parentPort.postMessage({ type: 'progress', progress });
    });
  }
  if (task === 'prepare-companions') {
    const job = { media: payload.media, partialPath: payload.partialPath };
    const temporaryPaths = await prepareConversionCompanions(job);
    return {
      temporaryPaths,
      mediaUpdates: {
        videoTimelinePath: job.media.videoTimelinePath || null,
        audioInputPath: job.media.audioInputPath || null,
        audioTimelinePath: job.media.audioTimelinePath || null,
        variableFrameRate: Boolean(job.media.variableFrameRate)
      }
    };
  }
  if (task === 'validate-video') {
    return validateVideo(
      payload.filePath, payload.profile, payload.sourceMedia, payload.capabilities,
      payload.measuredContentLight || null
    );
  }
  if (task === 'validate-dng') {
    return validateDngSequence(payload.directory, payload.sourceMedia, payload.sequence);
  }
  throw new Error(`Unknown background media task: ${task}`);
}

async function startFrameStream(payload) {
  const stream = payload.rawPreview
    ? createPreviewRawStream(payload.filePath, payload.media, progress => {
      parentPort.postMessage({ type: 'progress', progress });
    })
    : payload.develop
    ? createDevelopedRawStream(payload.filePath, payload.media, payload.quality || 'maximum', progress => {
      parentPort.postMessage({ type: 'progress', progress });
    })
    : createFrameStream(payload.filePath, payload.media, progress => {
      parentPort.postMessage({ type: 'progress', progress });
    });
  const iterator = stream[Symbol.asyncIterator]();
  let busy = false;
  let stopped = false;

  const close = async () => {
    if (stopped) return;
    stopped = true;
    stream.destroy();
    try { await iterator.return?.(); } catch { /* Termination is best effort. */ }
  };

  parentPort.on('message', async message => {
    if (message?.type === 'cancel') {
      await close();
      parentPort.close();
      return;
    }
    if (message?.type !== 'next' || busy || stopped) return;
    busy = true;
    try {
      const item = await iterator.next();
      if (item.done) {
        stopped = true;
        parentPort.postMessage({ type: 'end' });
        parentPort.close();
        return;
      }
      const source = Buffer.isBuffer(item.value) ? item.value : Buffer.from(item.value);
      // Large frame buffers normally own their ArrayBuffer and can move between
      // threads without a copy. Pooled/sliced buffers are copied to an exact view.
      let bytes = source.byteOffset === 0 && source.byteLength === source.buffer.byteLength
        ? new Uint8Array(source.buffer)
        : Uint8Array.from(source);
      try {
        parentPort.postMessage({ type: 'frame', bytes }, [bytes.buffer]);
      } catch {
        bytes = Uint8Array.from(source);
        parentPort.postMessage({ type: 'frame', bytes }, [bytes.buffer]);
      }
    } catch (error) {
      stopped = true;
      parentPort.postMessage({ type: 'error', error: serializeError(error) });
      parentPort.close();
    } finally {
      busy = false;
    }
  });
  parentPort.postMessage({ type: 'ready' });
}

async function main() {
  if (workerData?.mode === 'frame-stream') {
    await startFrameStream(workerData.payload);
    return;
  }
  try {
    const result = await runTask(workerData?.task, workerData?.payload || {});
    parentPort.postMessage({ type: 'result', result });
  } catch (error) {
    parentPort.postMessage({ type: 'error', error: serializeError(error) });
  } finally {
    parentPort.close();
  }
}

void main();
