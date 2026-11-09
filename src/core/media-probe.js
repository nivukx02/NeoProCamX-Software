'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { parseDevelopColor, parseCameraMetadataSidecar } = require('./camera-sidecars');
const { inspectCompanionPreviewLut } = require('./companion-lut');
const { classifyLibraryItem, readImportClassification } = require('./library-classification');
const { runBackgroundTask } = require('./background-task-runner');

const execFileAsync = promisify(execFile);

class MediaProbe {
  constructor(capabilityService) {
    this.capabilityService = capabilityService;
    this.cache = new Map();
    this.inflight = new Map();
  }

  async probeMany(paths) {
    const unique = [...new Set((paths || []).filter(value => typeof value === 'string'))];
    const results = new Array(unique.length);
    let cursor = 0;
    // Two probes keep fast storage busy without launching an unbounded number
    // of FFprobe/worker processes when a whole folder is selected.
    const runners = Array.from({ length: Math.min(2, unique.length) }, async () => {
      while (cursor < unique.length) {
        const index = cursor++;
        const filePath = unique[index];
        try { results[index] = await this.probe(filePath); }
        catch (error) {
          const stat = await fs.promises.stat(filePath).catch(() => null);
          results[index] = { filePath, name: path.basename(filePath), size: stat?.size || 0, error: error.message, supported: false };
        }
      }
    });
    await Promise.all(runners);
    return results;
  }

  async probe(filePath) {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) throw new Error('Source is not a file');
    const resolvedPath = path.resolve(filePath);
    const cacheKey = process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
    const identity = `${stat.size}:${stat.mtimeMs}`;
    const cached = this.cache.get(cacheKey);
    if (cached?.identity === identity) return cached.media;
    const pending = this.inflight.get(cacheKey);
    if (pending?.identity === identity) return pending.promise;
    const promise = this.probeUncached(resolvedPath, stat).then(media => {
      this.cache.set(cacheKey, { identity, media });
      return media;
    }).finally(() => {
      if (this.inflight.get(cacheKey)?.promise === promise) this.inflight.delete(cacheKey);
    });
    this.inflight.set(cacheKey, { identity, promise });
    return promise;
  }

  async probeUncached(filePath, stat) {
    const extension = path.extname(filePath).toLowerCase();
    let info;
    if (extension === '.npv10' || extension === '.npraw') {
      info = await runBackgroundTask('probe-custom', { filePath }, { timeoutMs: 12 * 60 * 60 * 1000 });
    }
    else info = await this.probeFfmpeg(filePath, stat);
    try {
      info.previewLut = await inspectCompanionPreviewLut(filePath);
    } catch (error) {
      info.previewLut = null;
      info.warnings ||= [];
      info.warnings.push(`Companion viewing LUT ignored: ${error.message}`);
    }
    const inferredClassification = classifyLibraryItem({
      name: path.basename(filePath), extension, filePath, kind: info.kind,
      developColor: info.developColor,
      sidecar: extension === '.npraw' ? { name: 'develop.meta' } : null,
      segments: filePath.split(path.sep)
    });
    const importedClassification = await readImportClassification(filePath, stat);
    return {
      id: `${stat.dev}-${stat.ino}-${stat.size}-${stat.mtimeMs}`,
      name: path.basename(filePath), extension, modifiedAt: stat.mtimeMs,
      supported: true, warnings: [], ...info, ...inferredClassification,
      ...(importedClassification || {}), filePath, size: stat.size
    };
  }

  async probeFfmpeg(filePath, stat) {
    const caps = await this.capabilityService.detect();
    if (!caps.ffprobePath) throw new Error('FFprobe runtime is unavailable');
    const { stdout } = await execFileAsync(caps.ffprobePath, [
      '-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath
    ], { windowsHide: true, maxBuffer: 12 * 1024 * 1024 });
    const data = JSON.parse(stdout);
    const video = data.streams?.find(stream => stream.codec_type === 'video');
    if (!video) throw new Error('No video stream found');
    const [num, den] = String(video.avg_frame_rate || video.r_frame_rate || '0/1').split('/').map(Number);
    const fps = den ? num / den : 0;
    const duration = Number(video.duration || data.format?.duration || 0);
    const timeline = await this.probePacketTimeline(filePath);
    const raw = ['rawvideo', 'tiff', 'dng'].includes(String(video.codec_name).toLowerCase()) || ['.dng', '.raw'].includes(path.extname(filePath).toLowerCase());
    const warnings = [];
    let developColor = null;
    let cameraMetadata = null;
    const developColorPath = `${filePath}.devcolor`;
    if (fs.existsSync(developColorPath)) {
      try {
        developColor = parseDevelopColor(developColorPath);
        if (developColor.width !== Number(video.width) || developColor.height !== Number(video.height)) {
          warnings.push('Develop-color sidecar geometry does not match the video and was ignored');
          developColor = null;
        }
      } catch (error) {
        warnings.push(`Develop-color sidecar ignored: ${error.message}`);
      }
    }
    const cameraMetadataPath = `${filePath}.metadata.json`;
    if (fs.existsSync(cameraMetadataPath)) {
      try { cameraMetadata = parseCameraMetadataSidecar(cameraMetadataPath, path.basename(filePath)); }
      catch (error) { warnings.push(`Camera metadata sidecar ignored: ${error.message}`); }
    }
    const metadataPrimaries = cameraMetadata?.colorStandard === 'BT2020' ? 'bt2020' :
      cameraMetadata?.colorStandard === 'BT709' ? 'bt709' : null;
    // LINEAR is also used as the camera's private NeoLog marker, so the verified companion
    // viewing LUT remains authoritative for that case instead of mislabelling it as linear RGB.
    const metadataTransfer = cameraMetadata?.colorTransfer === 'ST2084' ? 'smpte2084' :
      cameraMetadata?.colorTransfer === 'HLG' ? 'arib-std-b67' :
        cameraMetadata?.colorTransfer === 'SDR_VIDEO' ? (metadataPrimaries === 'bt2020' ? 'bt2020-10' : 'bt709') : null;
    const metadataRange = cameraMetadata?.colorRange === 'FULL' ? 'pc' : cameraMetadata?.colorRange === 'LIMITED' ? 'tv' : null;
    const sidecarPrimaries = developColor ? (developColor.colorSpace === 1 ? 'bt2020' : 'bt709') : metadataPrimaries;
    const sidecarTransfer = developColor ? (developColor.colorTransfer === 1 ? 'arib-std-b67' : developColor.colorTransfer === 2 ? 'smpte2084' : 'bt709') : metadataTransfer;
    const rotation = developColor?.orientation ?? Number(video.tags?.rotate || video.side_data_list?.find(item => item.rotation !== undefined)?.rotation || 0);
    return {
      kind: raw ? 'camera-raw' : 'video',
      container: String(data.format?.format_long_name || data.format?.format_name || '').split(',')[0],
      width: Number(video.width || 0), height: Number(video.height || 0), fps,
      duration: timeline?.duration || duration,
      frames: timeline?.timestamps.length || Number(video.nb_frames || 0),
      estimatedFrames: timeline?.timestamps.length || Number(video.nb_frames || (duration && fps ? Math.round(duration * fps) : 0)),
      frameCountAuthority: timeline ? 'container-presentation-timestamps' : video.nb_frames ? 'container' : 'unknown',
      codec: video.codec_long_name || video.codec_name, pixelFormat: video.pix_fmt || 'unknown',
      bitDepth: Number(video.bits_per_raw_sample || (/10/.test(video.pix_fmt || '') ? 10 : /12/.test(video.pix_fmt || '') ? 12 : 8)),
      colorPrimaries: sidecarPrimaries || video.color_primaries || 'unknown', colorTransfer: sidecarTransfer || video.color_transfer || 'unknown',
      colorSpace: cameraMetadata && !developColor ? (metadataPrimaries === 'bt2020' ? 'bt2020nc' : 'bt709') : video.color_space || 'unknown',
      colorRange: metadataRange || video.color_range || 'unknown',
      rotation, orientation: rotation, developColor, cameraMetadata,
      metadataValues: cameraMetadata?.metadataValues || {},
      audio: data.streams?.some(stream => stream.codec_type === 'audio') || false,
      raw, metadata: data, size: stat.size, warnings,
      timestamps: timeline?.timestamps || null,
      timingAuthority: timeline ? 'container-presentation-timestamps' : 'container',
      variableFrameRate: Boolean(timeline?.variableFrameRate)
    };
  }

  async probePacketTimeline(filePath) {
    const caps = await this.capabilityService.detect();
    try {
      const packets = await this.streamPacketTimeline(caps.ffprobePath, filePath);
      if (!packets.length) return null;
      const first = packets[0].pts;
      const presentationUs = packets.map(packet => Math.round((packet.pts - first) * 1e6));
      if (presentationUs[0] !== 0 || presentationUs.some((value, index) => index && value <= presentationUs[index - 1])) {
        return null;
      }
      const deltas = presentationUs.slice(1).map((value, index) => value - presentationUs[index]);
      const sortedDeltas = [...deltas].sort((left, right) => left - right);
      const medianDelta = sortedDeltas.length ? sortedDeltas[Math.floor(sortedDeltas.length / 2)] : 0;
      const variableFrameRate = deltas.some(delta => Math.abs(delta - medianDelta) > 2);
      const finalDuration = Math.max(0, Number(packets.at(-1).duration || 0));
      const duration = presentationUs.at(-1) / 1e6 +
        (finalDuration > 0 ? finalDuration : medianDelta > 0 ? medianDelta / 1e6 : 0);
      return {
        timestamps: presentationUs.map(value => value * 1000),
        duration,
        variableFrameRate
      };
    } catch {
      return null;
    }
  }

  streamPacketTimeline(ffprobePath, filePath) {
    return new Promise((resolve, reject) => {
      const child = spawn(ffprobePath, [
        '-v', 'error', '-select_streams', 'v:0', '-show_packets',
        '-show_entries', 'packet=pts_time,duration_time', '-of', 'compact=p=0:nk=0', filePath
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const packets = [];
      let outputBuffer = '';
      let stderr = '';
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error); else resolve(value);
      };
      const consume = line => {
        if (!line) return;
        let pts = Number.NaN;
        let duration = 0;
        for (const field of line.split('|')) {
          const split = field.indexOf('=');
          if (split <= 0) continue;
          const key = field.slice(0, split);
          const value = Number(field.slice(split + 1));
          if (key === 'pts_time') pts = value;
          else if (key === 'duration_time' && Number.isFinite(value)) duration = value;
        }
        if (Number.isFinite(pts)) packets.push({ pts, duration });
      };
      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        finish(new Error('FFprobe packet timeline timed out'));
      }, 10 * 60 * 1000);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        outputBuffer += chunk;
        const lines = outputBuffer.split(/\r?\n/);
        outputBuffer = lines.pop() || '';
        for (const line of lines) consume(line);
      });
      child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-32 * 1024); });
      child.once('error', finish);
      child.once('close', code => {
        consume(outputBuffer);
        if (code !== 0) {
          finish(new Error(stderr.trim() || `FFprobe packet timeline exited with code ${code}`));
          return;
        }
        packets.sort((left, right) => left.pts - right.pts);
        finish(null, packets);
      });
    });
  }
}

module.exports = { MediaProbe };
