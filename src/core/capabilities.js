'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { resolveExecutable, resolveAiRuntime } = require('./runtime-paths');
const { gpuEncoderArgs, gpuLosslessEncoderArgs } = require('./conversion-profiles');

const execFileAsync = promisify(execFile);
const CAMX_AI_MODEL_SHA256 = '64484177de04aa5d1ba3435ac3920bf366e58ec55ca2b1568f3258f51fd75c1c';
const CAMX_AI_ONNX_SHA256 = 'd2381d0a73dec3df8c426c5bbe2dbf355b52b1fb89cc7b763ad9240cba6ee1b3';
const CONTINUUM_VERSION = 'NIVUKX-CONTINUUM-v1';
const CAPABILITY_CACHE_SCHEMA = 2;
const CAPABILITY_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const GPU_ENCODER_BACKENDS = Object.freeze([
  Object.freeze({ encoder: 'hevc_nvenc', runtimeKey: 'hevcNvenc', label: 'NVIDIA NVENC', vendor: /nvidia/i, priority: 3 }),
  Object.freeze({ encoder: 'hevc_amf', runtimeKey: 'hevcAmf', label: 'AMD AMF', vendor: /amd|radeon|advanced micro/i, priority: 2 }),
  Object.freeze({ encoder: 'hevc_qsv', runtimeKey: 'hevcQsv', label: 'Intel Quick Sync', vendor: /intel/i, priority: 1 })
]);

function selectPreferredGpuEncoder(gpus = [], runtime = {}) {
  const candidates = [];
  for (const gpu of gpus) {
    const backend = GPU_ENCODER_BACKENDS.find(item => item.vendor.test(String(gpu?.name || '')) && runtime[item.runtimeKey]);
    if (backend) candidates.push({ ...backend, memoryBytes: Math.max(0, Number(gpu?.memoryBytes || 0)) });
  }
  candidates.sort((left, right) => right.memoryBytes - left.memoryBytes || right.priority - left.priority);
  if (candidates.length) return candidates[0].encoder;
  return GPU_ENCODER_BACKENDS.find(item => runtime[item.runtimeKey])?.encoder || null;
}

function gpuEncoderLabel(encoder) {
  return GPU_ENCODER_BACKENDS.find(item => item.encoder === encoder)?.label || null;
}

function fileSha256(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

class CapabilityService {
  constructor(options = {}) {
    this.cached = null;
    this.pending = null;
    this.cacheDirectory = typeof options.cacheDirectory === 'string' ? options.cacheDirectory : null;
    this.ffmpegPath = resolveExecutable('ffmpeg');
    this.ffprobePath = resolveExecutable('ffprobe');
  }

  runtimeFingerprint() {
    const runtime = resolveAiRuntime();
    const files = [this.ffmpegPath, this.ffprobePath, runtime.workerPath, runtime.modelPath, runtime.onnxModelPath]
      .filter(Boolean)
      .map(filePath => {
        try {
          const stat = fs.statSync(filePath);
          return { path: pathForFingerprint(filePath), size: stat.size, modifiedMs: Math.trunc(stat.mtimeMs) };
        } catch {
          return { path: pathForFingerprint(filePath), missing: true };
        }
      });
    return JSON.stringify({
      schema: CAPABILITY_CACHE_SCHEMA,
      platform: process.platform,
      architecture: process.arch,
      osRelease: os.release(),
      cpu: os.cpus()[0]?.model?.trim() || '',
      files
    });
  }

  cachePath() {
    return this.cacheDirectory ? require('node:path').join(this.cacheDirectory, `capabilities-v${CAPABILITY_CACHE_SCHEMA}.json`) : null;
  }

  async readPersistentCache() {
    const cachePath = this.cachePath();
    if (!cachePath) return null;
    try {
      const payload = JSON.parse(await fs.promises.readFile(cachePath, 'utf8'));
      if (payload.schema !== CAPABILITY_CACHE_SCHEMA || payload.fingerprint !== this.runtimeFingerprint() ||
          !payload.createdAt || Date.now() - Number(payload.createdAt) > CAPABILITY_CACHE_MAX_AGE_MS ||
          !payload.capabilities?.ready || !payload.capabilities?.ai?.ready || !payload.capabilities?.mfsr?.ready) return null;
      return payload.capabilities;
    } catch {
      return null;
    }
  }

  async writePersistentCache(capabilities) {
    const cachePath = this.cachePath();
    if (!cachePath || !capabilities?.ready || !capabilities?.ai?.ready || !capabilities?.mfsr?.ready) return;
    const temporaryPath = `${cachePath}.${process.pid}.tmp`;
    try {
      await fs.promises.mkdir(this.cacheDirectory, { recursive: true });
      await fs.promises.writeFile(temporaryPath, JSON.stringify({
        schema: CAPABILITY_CACHE_SCHEMA,
        createdAt: Date.now(),
        fingerprint: this.runtimeFingerprint(),
        capabilities
      }), { encoding: 'utf8', flag: 'w' });
      await fs.promises.rename(temporaryPath, cachePath);
    } catch {
      await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
    }
  }

  async detect(force = false) {
    if (this.cached && !force) return this.cached;
    if (this.pending) return this.pending;
    const detection = (async () => {
      if (!force) {
        const restored = await this.readPersistentCache();
        if (restored) {
          this.cached = restored;
          return restored;
        }
      }
      const capabilities = await this.detectUncached();
      await this.writePersistentCache(capabilities);
      return capabilities;
    })();
    this.pending = detection;
    try {
      return await detection;
    } finally {
      if (this.pending === detection) this.pending = null;
    }
  }

  async detectUncached() {
    const cpu = os.cpus();
    const aiRuntime = resolveAiRuntime();
    const aiModelHash = fileSha256(aiRuntime.modelPath);
    const [ai, mfsr, compute] = await Promise.all([
      this.inspectAi(aiRuntime, aiModelHash, cpu.length),
      this.inspectMfsr(aiRuntime),
      this.inspectGpuCompute(aiRuntime)
    ]);
    const base = {
      platform: process.platform,
      architecture: process.arch,
      cpuModel: cpu[0]?.model?.trim() || 'Unknown CPU',
      logicalCores: cpu.length,
      memoryBytes: os.totalmem(),
      ffmpegPath: this.ffmpegPath,
      ffprobePath: this.ffprobePath,
      ffmpegVersion: null,
      encoders: { libx265: false, hevcAmf: false, hevcNvenc: false, hevcQsv: false, prores: false, ffv1: false, r210: false, v210: false },
      filters: { zscale: false, lut3d: false, libplacebo: false, vulkan: false, opencl: false, tonemap: false },
      encoderRuntime: { hevcAmf: false, hevcNvenc: false, hevcQsv: false },
      losslessEncoderRuntime: { hevcNvenc: false },
      losslessGpuEncoding: { ready: false, encoder: null, pixelFormat: 'p010le', error: 'Not tested' },
      gpuEncoders: [],
      preferredGpuEncoder: null,
      preferredLosslessGpuEncoder: null,
      gpu: await this.detectGpu(),
      ai,
      mfsr,
      compute
    };
    if (compute.ready && mfsr.ready) {
      mfsr.engine = `${compute.engine} motion/fusion + CPU phase correlation`;
      mfsr.compute = compute;
    }
    if (this.ffmpegPath) {
      const [version, encoders, filters] = await Promise.all([
        this.runFfmpeg(['-hide_banner', '-version']),
        this.runFfmpeg(['-hide_banner', '-encoders']),
        this.runFfmpeg(['-hide_banner', '-filters'])
      ]);
      base.ffmpegVersion = version.split(/\r?\n/)[0] || null;
      base.encoders = {
        libx265: /\blibx265\b/.test(encoders),
        hevcAmf: /\bhevc_amf\b/.test(encoders),
        hevcNvenc: /\bhevc_nvenc\b/.test(encoders),
        hevcQsv: /\bhevc_qsv\b/.test(encoders),
        prores: /\bprores_ks\b/.test(encoders),
        ffv1: /\bffv1\b/.test(encoders),
        r210: /\br210\b/.test(encoders),
        v210: /\bv210\b/.test(encoders)
      };
      base.filters = {
        zscale: /\bzscale\b/.test(filters),
        lut3d: /\blut3d\b/.test(filters),
        libplacebo: /\blibplacebo\b/.test(filters),
        vulkan: /_vulkan\b/.test(filters),
        opencl: /_opencl\b/.test(filters),
        tonemap: /\btonemap\b/.test(filters)
      };
      base.encoderRuntime = {
        hevcAmf: base.encoders.hevcAmf && await this.encoderWorks('hevc_amf'),
        hevcNvenc: base.encoders.hevcNvenc && await this.encoderWorks('hevc_nvenc'),
        hevcQsv: base.encoders.hevcQsv && await this.encoderWorks('hevc_qsv')
      };
      if (base.encoderRuntime.hevcNvenc) {
        base.losslessGpuEncoding = await this.verifyLosslessGpuEncoder('hevc_nvenc');
        base.losslessEncoderRuntime.hevcNvenc = base.losslessGpuEncoding.ready;
      } else {
        base.losslessGpuEncoding = {
          ready: false, encoder: 'hevc_nvenc', pixelFormat: 'p010le',
          error: 'NVIDIA NVENC is unavailable; FFV1 provides the exact cross-vendor fallback'
        };
      }
    }
    base.preferredGpuEncoder = selectPreferredGpuEncoder(base.gpu, base.encoderRuntime);
    base.preferredLosslessGpuEncoder = base.losslessEncoderRuntime.hevcNvenc ? 'hevc_nvenc' : null;
    base.gpuEncoders = GPU_ENCODER_BACKENDS
      .filter(item => base.encoderRuntime[item.runtimeKey])
      .map(item => ({ encoder: item.encoder, label: item.label, selected: item.encoder === base.preferredGpuEncoder }));
    base.ready = Boolean(base.ffmpegPath && base.ffprobePath && base.encoders.libx265 && base.encoders.ffv1 &&
      base.filters.zscale && base.filters.lut3d);
    this.cached = base;
    return base;
  }

  async runFfmpeg(args) {
    try {
      const { stdout = '', stderr = '' } = await execFileAsync(this.ffmpegPath, args, {
        windowsHide: true,
        maxBuffer: 24 * 1024 * 1024
      });
      return `${stdout}\n${stderr}`;
    } catch (error) {
      return `${error.stdout || ''}\n${error.stderr || ''}`;
    }
  }

  async inspectAi(runtime, modelHash, logicalCores) {
    const base = {
      ready: false,
      engine: 'LiteRT CPU',
      model: 'CamX Camera Enhancement Denoise',
      modelSha256: modelHash,
      expectedSha256: CAMX_AI_MODEL_SHA256,
      onnxModelPath: runtime.onnxModelPath,
      onnxModelSha256: fileSha256(runtime.onnxModelPath),
      expectedOnnxSha256: CAMX_AI_ONNX_SHA256,
      workerPath: runtime.workerPath,
      modelPath: runtime.modelPath,
      error: null
    };
    if (!runtime.workerPath || !runtime.modelPath) return { ...base, error: 'AI runtime files are missing' };
    if (modelHash !== CAMX_AI_MODEL_SHA256) return { ...base, error: 'AI model integrity check failed' };
    try {
      const workerArgs = [
        '--model', runtime.modelPath, '--inspect', '--threads', String(Math.max(1, logicalCores || 1))
      ];
      if (runtime.onnxModelPath && fileSha256(runtime.onnxModelPath) === CAMX_AI_ONNX_SHA256) {
        workerArgs.push('--onnx-model', runtime.onnxModelPath);
      }
      const { stdout } = await execFileAsync(runtime.workerPath, workerArgs,
        { windowsHide: true, timeout: 90000, maxBuffer: 2 * 1024 * 1024 });
      const line = stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean).pop();
      const result = JSON.parse(line || '{}');
      if (!result.ready || String(result.sha256).toLowerCase() !== CAMX_AI_MODEL_SHA256) throw new Error('AI self-test returned an invalid identity');
      return {
        ...base, ready: true, engine: result.engine || base.engine,
        accelerated: Boolean(result.accelerated), parity: result.parity || null,
        input: result.input, output: result.output
      };
    } catch (error) {
      return { ...base, error: error.message };
    }
  }

  async inspectMfsr(runtime) {
    const base = {
      ready: false,
      engine: 'NumPy CPU',
      algorithm: 'CAMX_OFFLINE_MFSR_V2',
      workerPath: runtime.workerPath,
      precision: 'RGB48',
      outputScale: 1,
      canonicalDelivery: null,
      error: null
    };
    if (!runtime.workerPath) return { ...base, error: 'MFSR worker is missing' };
    try {
      const { stdout } = await execFileAsync(runtime.workerPath, ['--inspect-mfsr'], {
        windowsHide: true, timeout: 45000, maxBuffer: 2 * 1024 * 1024
      });
      const line = stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean).pop();
      const result = JSON.parse(line || '{}');
      const delivery = result.canonicalDelivery;
      const dynamicMetadata = delivery?.dynamicMetadata;
      if (!result.ready || result.algorithm !== base.algorithm || result.precision !== 'RGB48' ||
          !delivery?.ready || delivery.engine !== 'NDR-NIVUKX-DELIVERY-v1' ||
          delivery.toneOperator !== 'NDR-TONE-OP-v4' ||
          delivery.calibration !== 'NDR-NIVUKX-PY-CAL-v4' ||
          Number(delivery.diffuseWhiteNits) !== 203 ||
          !Array.isArray(delivery.modes) || !delivery.modes.includes('NDR10_PLUS') ||
          !delivery.modes.includes('NIVUKX_VISION') ||
          !Array.isArray(delivery.peaks) || !delivery.peaks.includes(5000) ||
          !delivery.peaks.includes(10000) ||
          dynamicMetadata?.schema !== 'com.neoproc.camx.dynamic-delivery.v1' ||
          dynamicMetadata.measuredContentLight !== true ||
          dynamicMetadata.appearanceAnalysis !== 'JZAZBZ_FP64_ANALYSIS' ||
          !Array.isArray(dynamicMetadata.tiers) ||
          !['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']
            .every(tier => dynamicMetadata.tiers.includes(tier))) {
        throw new Error('MFSR self-test returned an invalid processing contract');
      }
      return {
        ...base, ready: true, engine: result.engine || base.engine,
        minimumFrames: result.minimumFrames, maximumFrames: result.maximumFrames,
        guardrails: result.guardrails, canonicalDelivery: result.canonicalDelivery
      };
    } catch (error) {
      return { ...base, error: error.message };
    }
  }

  async inspectGpuCompute(runtime) {
    const base = {
      ready: false,
      version: 'CAMX-WGSL-COMPUTE-v1',
      engine: 'CPU reference fallback',
      backend: 'CPU',
      adapter: null,
      kernels: [],
      continuum: null,
      frameGraphs: [],
      maximumCodeDelta: null,
      error: null
    };
    if (!runtime.workerPath) return { ...base, error: 'GPU compute worker is missing' };
    try {
      const { stdout } = await execFileAsync(runtime.workerPath, ['--inspect-acceleration'], {
        windowsHide: true, timeout: 90000, maxBuffer: 2 * 1024 * 1024
      });
      const line = stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean).pop();
      const result = JSON.parse(line || '{}');
      const continuum = result.continuum;
      const requiredKernels = ['MFSR motion registration', 'MFSR fusion', 'NIV99/OmniClarity',
        'AI guidance', 'NDR/NIVUKX delivery'];
      if (!result.ready || result.version !== base.version || Number(result.maximumCodeDelta) > 1 ||
          !Array.isArray(result.kernels) || !requiredKernels.every(kernel => result.kernels.includes(kernel)) ||
          Number(result.motionParity?.maximumVectorDelta) !== 0 ||
          Number(result.motionParity?.maximumConfidenceDelta) > 1e-4 ||
          result.resourceReuse?.ready !== true ||
          Number(result.resourceReuse?.steadyStateAllocations) !== 0 ||
          continuum?.version !== CONTINUUM_VERSION || !continuum.deviceResident ||
          !continuum.persistentResources || !continuum.batchedMfsrSubmission ||
          !continuum.residentTemporalState || !continuum.packedRgb48TemporalRing ||
          Number(continuum.lastMfsrGraph?.submissions) !== 1 ||
          Number(continuum.lastMfsrGraph?.fullFrameReadbacks) !== 1 ||
          continuum.lastMfsrGraph?.motionRegistrationResident !== true ||
          !Array.isArray(result.frameGraphs) ||
          !result.frameGraphs.some(graph => graph?.version === CONTINUUM_VERSION &&
            Number(graph.submissions) === 1 && Number(graph.fullFrameReadbacks) === 1)) {
        throw new Error(result.error || 'GPU kernel parity self-test failed');
      }
      return { ...base, ...result, ready: true, error: null };
    } catch (error) {
      return { ...base, error: error.message };
    }
  }

  async detectGpu() {
    if (process.platform !== 'win32') return [];
    try {
      const script = "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion,Status | ConvertTo-Json -Compress";
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        maxBuffer: 1024 * 1024
      });
      const parsed = JSON.parse(stdout.trim() || '[]');
      return (Array.isArray(parsed) ? parsed : [parsed]).map(item => ({
        name: item.Name || 'Unknown GPU',
        memoryBytes: Number(item.AdapterRAM || 0),
        driver: item.DriverVersion || '',
        status: item.Status || ''
      }));
    } catch {
      return [];
    }
  }

  async encoderWorks(encoder) {
    try {
      const args = [
        '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=1920x1080:r=1',
        '-frames:v', '1', '-vf', 'format=p010le', ...gpuEncoderArgs(encoder, 12)
      ];
      args.push('-f', 'null', process.platform === 'win32' ? 'NUL' : '/dev/null');
      await execFileAsync(this.ffmpegPath, args, { windowsHide: true, timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
      return true;
    } catch {
      return false;
    }
  }

  async verifyLosslessGpuEncoder(encoder) {
    const width = 64;
    const height = 64;
    const frames = 2;
    const prefix = path.join(os.tmpdir(), 'camx-lossless-gpu-');
    const directory = await fs.promises.mkdtemp(prefix);
    const sourcePath = path.join(directory, 'source.p010');
    const encodedPath = path.join(directory, 'encoded.mkv');
    const decodedPath = path.join(directory, 'decoded.p010');
    try {
      const samplesPerFrame = width * height + (width * height) / 2;
      const source = Buffer.alloc(samplesPerFrame * frames * 2);
      for (let index = 0; index < samplesPerFrame * frames; index += 1) {
        const code = (index * 73 + Math.trunc(index / width) * 29 + 64) & 1023;
        source.writeUInt16LE(code << 6, index * 2);
      }
      await fs.promises.writeFile(sourcePath, source, { flag: 'wx' });
      await execFileAsync(this.ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pixel_format', 'p010le',
        '-video_size', `${width}x${height}`, '-framerate', '2', '-i', sourcePath,
        '-frames:v', String(frames), ...gpuLosslessEncoderArgs(encoder, 4), '-an', encodedPath
      ], { windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
      await execFileAsync(this.ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-y', '-i', encodedPath, '-map', '0:v:0',
        '-frames:v', String(frames), '-pix_fmt', 'p010le', '-f', 'rawvideo', decodedPath
      ], { windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
      const decoded = await fs.promises.readFile(decodedPath);
      const sourceSha256 = crypto.createHash('sha256').update(source).digest('hex');
      const decodedSha256 = crypto.createHash('sha256').update(decoded).digest('hex');
      if (decoded.length !== source.length || decodedSha256 !== sourceSha256) {
        throw new Error('decoded P010 samples differ from the encoder input');
      }
      return {
        ready: true, encoder, pixelFormat: 'p010le', frames, width, height,
        sourceSha256, decodedSha256, proof: 'decoded-frame-sha256-equality'
      };
    } catch (error) {
      return { ready: false, encoder, pixelFormat: 'p010le', error: error.message };
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function pathForFingerprint(filePath) {
  const resolved = require('node:path').resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

module.exports = {
  CapabilityService, GPU_ENCODER_BACKENDS, CONTINUUM_VERSION, CAPABILITY_CACHE_SCHEMA,
  selectPreferredGpuEncoder, gpuEncoderLabel
};
