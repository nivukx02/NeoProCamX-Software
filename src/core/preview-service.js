'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { tempDirectory } = require('./runtime-paths');
const { createBackgroundFrameStream, startBackgroundTask } = require('./background-task-runner');
const { displayFilters, cameraAudioFilter } = require('./conversion-profiles');
const { rawPreviewGeometry } = require('./raw-develop');

function previewKey(media) {
  return crypto.createHash('sha256').update(JSON.stringify({
    filePath: path.resolve(media.filePath),
    size: Number(media.size || 0),
    modifiedAt: Number(media.modifiedAt || 0),
    kind: media.kind,
    raw: Boolean(media.raw),
    width: media.width,
    height: media.height,
    developColor: media.developColor || null,
    rawCalibration: media.rawCalibration || media.sidecar || null,
    audioSidecar: media.audioSidecar ? {
      packetCount: media.audioSidecar.packetCount,
      payloadBytes: media.audioSidecar.payloadBytes,
      finalPresentationTimeUs: media.audioSidecar.finalPresentationTimeUs,
      crcValidated: media.audioSidecar.crcValidated
    } : null,
    previewLut: media.previewLut ? {
      sha256: media.previewLut.sha256,
      size: media.previewLut.size,
      domainMin: media.previewLut.domainMin,
      domainMax: media.previewLut.domainMax
    } : null
  })).digest('hex');
}

function filterFilePath(filePath) {
  return String(filePath).replace(/\\/g, '/').replace(':', '\\:').replace(/'/g, "\\'");
}

function previewVideoFilter(media) {
  const resize = "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos";
  if (!media.previewLut?.filePath) {
    return `${displayFilters(media, 'sdr', 'yuv420')},${resize},format=yuv420p`;
  }
  // The camera companion consumes encoded NeoLog/AP1 values and returns sRGB/Rec.709 display
  // values. Apply it before resizing, then make the proxy's transfer/range contract explicit.
  const lut = filterFilePath(media.previewLut.filePath);
  return `format=gbrpf32le,lut3d=file='${lut}':interp=tetrahedral,` +
    'zscale=matrixin=gbr:primariesin=bt709:transferin=iec61966-2-1:rangein=full:' +
    `matrix=bt709:primaries=bt709:transfer=bt709:range=limited:dither=error_diffusion,${resize},format=yuv420p,` +
    'setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709';
}

function parsePreviewProgress(stream, media, onProgress) {
  let buffer = '';
  let outTimeSeconds = 0;
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      const split = line.indexOf('=');
      if (split <= 0) continue;
      const key = line.slice(0, split);
      const value = line.slice(split + 1);
      if (key === 'out_time_us') outTimeSeconds = Number(value) / 1e6;
      if (key === 'progress') {
        const duration = Number(media.duration || 0);
        onProgress?.({
          stage: value === 'end' ? 'Ready' : 'Building playback proxy',
          ratio: value === 'end' ? 1 : duration > 0 ? Math.min(0.99, outTimeSeconds / duration) : null
        });
      }
    }
  });
}

class PreviewService {
  constructor(capabilityService) {
    this.capabilityService = capabilityService;
    this.children = new Set();
    this.active = new Map();
  }

  async create(media, onProgress, requestId = crypto.randomUUID()) {
    if (!media?.filePath || !fs.existsSync(media.filePath)) throw new Error('Preview source is unavailable');
    const key = previewKey(media);
    const operation = { requestId, child: null, frameStream: null, backgroundTask: null, cancelled: false };
    this.active.set(requestId, operation);
    try {
      return await this.createUncached(media, key, onProgress, operation);
    } finally {
      if (this.active.get(requestId) === operation) this.active.delete(requestId);
    }
  }

  async createUncached(sourceMedia, key, onProgress, operation) {
    const caps = await this.capabilityService.detect();
    if (operation.cancelled) throw new Error('Preview cancelled');
    if (!caps.ffmpegPath) throw new Error('FFmpeg preview runtime is unavailable');
    const directory = path.join(tempDirectory(), 'previews');
    await fs.promises.mkdir(directory, { recursive: true });
    const outputPath = path.join(directory, `${key}.mp4`);
    if (fs.existsSync(outputPath) && (await fs.promises.stat(outputPath)).size > 0) {
      if (operation.cancelled) throw new Error('Preview cancelled');
      onProgress?.({ stage: 'Ready', ratio: 1, cached: true });
      return outputPath;
    }

    const partialPath = path.join(directory, `${key}.${process.pid}.${crypto.randomUUID()}.partial.mp4`);
    await fs.promises.rm(partialPath, { force: true });
    const media = { ...sourceMedia };
    const preparation = { media, partialPath: `${partialPath}.preview` };
    const preparationTask = startBackgroundTask('prepare-companions', preparation, { timeoutMs: 60 * 60 * 1000 });
    operation.backgroundTask = preparationTask;
    let prepared;
    try {
      prepared = await preparationTask.promise;
    } catch (error) {
      const base = preparation.partialPath;
      await Promise.all([
        `${base}.video-timeline.sendcmd`, `${base}.audio.aac`, `${base}.audio-timeline.sendcmd`
      ].map(filePath => fs.promises.rm(filePath, { force: true }).catch(() => {})));
      throw error;
    }
    operation.backgroundTask = null;
    const temporaryPaths = prepared.temporaryPaths;
    if (operation.cancelled) {
      await Promise.all(temporaryPaths.map(filePath => fs.promises.rm(filePath, { force: true }).catch(() => {})));
      throw new Error('Preview cancelled');
    }
    for (const [name, value] of Object.entries(prepared.mediaUpdates || {})) {
      if (value !== null) media[name] = value;
    }
    let frameStream = null;
    let child = null;
    try {
      const custom = ['npv10', 'npraw'].includes(media.kind);
      const rawPreview = custom && Boolean(media.raw);
      const previewGeometry = rawPreview ? rawPreviewGeometry(media) : { width: media.width, height: media.height };
      const args = ['-hide_banner', '-y', '-nostdin'];
      if (custom) {
        const pixelFormat = media.raw ? 'rgb48le' : media.pixelFormat;
        args.push('-f', 'rawvideo', '-pixel_format', pixelFormat,
          '-video_size', `${previewGeometry.width}x${previewGeometry.height}`, '-framerate', String(media.fps || 30), '-i', 'pipe:0');
        if (media.audioInputPath) args.push('-f', 'aac', '-i', media.audioInputPath);
      } else args.push('-i', media.filePath);
      args.push('-map', '0:v:0');
      if (media.audio || media.audioInputPath) args.push('-map', custom ? '1:a:0?' : '0:a:0?');
      const filter = previewVideoFilter(media);
      args.push('-vf', filter, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17',
        '-profile:v', 'high', '-pix_fmt', 'yuv420p');
      if (media.audio || media.audioInputPath) {
        const audioFilter = custom ? cameraAudioFilter(media) : null;
        if (audioFilter) args.push('-af', audioFilter);
        args.push('-c:a', 'aac', '-b:a', '192k');
      }
      else args.push('-an');
      args.push('-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', partialPath);

      onProgress?.({ stage: 'Building playback proxy', ratio: 0 });
      child = spawn(caps.ffmpegPath, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      operation.child = child;
      this.children.add(child);
      parsePreviewProgress(child.stdout, media, onProgress);
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-64 * 1024); });
      if (custom) {
        frameStream = createBackgroundFrameStream(media.filePath, media, {
          develop: Boolean(media.raw), rawPreview,
          quality: 'production',
          progressIntervalMs: 125
        });
        operation.frameStream = frameStream;
        frameStream.on('error', error => child.stdin.destroy(error));
        frameStream.pipe(child.stdin);
      } else child.stdin.end();
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      if (operation.cancelled) throw new Error('Preview cancelled');
      if (code !== 0) {
        const useful = stderr.split(/\r?\n/).filter(Boolean).slice(-12).join('\n');
        throw new Error(`Preview generation failed${useful ? `\n${useful}` : ''}`);
      }
      const stat = await fs.promises.stat(partialPath);
      if (!stat.isFile() || stat.size <= 0) throw new Error('Preview generation produced no playable video');
      await fs.promises.rename(partialPath, outputPath);
      onProgress?.({ stage: 'Ready', ratio: 1 });
      return outputPath;
    } finally {
      if (child) this.children.delete(child);
      frameStream?.destroy();
      operation.child = null;
      operation.frameStream = null;
      operation.backgroundTask = null;
      await fs.promises.rm(partialPath, { force: true }).catch(() => {});
      await Promise.all(temporaryPaths.map(filePath => fs.promises.rm(filePath, { force: true }).catch(() => {})));
    }
  }

  cancel(requestId) {
    const operation = this.active.get(requestId);
    if (!operation) return false;
    operation.cancelled = true;
    operation.backgroundTask?.cancel('Preview cancelled');
    operation.frameStream?.destroy();
    if (operation.child && operation.child.exitCode === null && !operation.child.killed) operation.child.kill('SIGTERM');
    return true;
  }

  cancelAllExcept(requestId = null) {
    for (const id of this.active.keys()) if (id !== requestId) this.cancel(id);
  }

  shutdown() {
    this.cancelAllExcept(null);
    for (const child of this.children) child.kill('SIGTERM');
    this.children.clear();
  }
}

module.exports = { PreviewService, previewKey, previewVideoFilter, parsePreviewProgress };
