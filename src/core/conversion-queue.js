'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { finished } = require('node:stream/promises');
const readline = require('node:readline');
const {
  PROFILES, buildPlan, outputName, isPublicProfile, assertPublicConversionRoute
} = require('./conversion-profiles');
const { createBackgroundFrameStream, startBackgroundTask } = require('./background-task-runner');
const {
  stableFingerprint, serializeFingerprint, cacheFileFor,
  inspectQualityCache, publishQualityCache
} = require('./quality-cache');
const { SustainedConversionGovernor } = require('./conversion-governor');

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boundedNumber(args, option, fallback) {
  const index = Array.isArray(args) ? args.indexOf(option) : -1;
  return index >= 0 ? safeNumber(args[index + 1], fallback) : fallback;
}

function expectedFrameCount(media = {}) {
  const explicit = safeNumber(media.frames || media.estimatedFrames, 0);
  if (explicit > 0) return Math.round(explicit);
  const duration = safeNumber(media.duration, 0);
  const fps = safeNumber(media.fps, 0);
  return duration > 0 && fps > 0 ? Math.max(1, Math.round(duration * fps)) : null;
}

function qualityCacheArguments(args = []) {
  const index = args.findIndex(value => value === '--quality-cache-read' || value === '--quality-cache-write');
  return index >= 0 ? args.slice(index) : [];
}

function conciseFailureReason(reason) {
  return String(reason || 'Hardware encoder initialization failed')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(-4)
    .join(' | ')
    .replace(/\s+/g, ' ')
    .slice(0, 512);
}

function updateJobProgress(job, update = {}) {
  const elapsed = job.startedAt ? Math.max(0, (Date.now() - new Date(job.startedAt).getTime()) / 1000) : 0;
  const frame = Math.max(0, safeNumber(update.frame, job.processedFrames || 0));
  const expected = Math.max(0, safeNumber(job.expectedFrames, 0));
  const outTime = Math.max(0, safeNumber(update.outTimeSeconds, 0));
  const explicitRatio = safeNumber(update.ratio, -1);
  const ratio = explicitRatio >= 0 ? explicitRatio :
    expected > 0 && frame > 0 ? frame / expected :
      safeNumber(job.media?.duration, 0) > 0 && outTime > 0 ? outTime / safeNumber(job.media.duration) : 0;
  const reportedFps = safeNumber(update.fps, 0);
  const measuredFps = elapsed > 0 && frame > 0 ? frame / elapsed : 0;
  const processingFps = reportedFps > 0 ? reportedFps : measuredFps;
  const speedMultiplier = safeNumber(String(update.speed || '').replace('x', ''), 0);
  job.processedFrames = Math.max(job.processedFrames || 0, Math.round(frame));
  job.governor?.recordFrames(job.processedFrames);
  job.processingFps = processingFps > 0 ? Number(processingFps.toFixed(2)) : job.processingFps || 0;
  job.elapsedSeconds = Number(elapsed.toFixed(1));
  job.conversionProgress = Math.max(job.conversionProgress || 0, Math.min(1, ratio));
  job.progress = Number(Math.max(job.progress || 0, Math.min(0.88, 0.04 + job.conversionProgress * 0.84)).toFixed(6));
  if (update.speed) job.speed = update.speed;
  const remainingFrames = expected > 0 ? Math.max(0, expected - job.processedFrames) : 0;
  if (remainingFrames > 0 && job.processingFps > 0) job.etaSeconds = remainingFrames / job.processingFps;
  else if (speedMultiplier > 0 && safeNumber(job.media?.duration, 0) > outTime) {
    job.etaSeconds = (safeNumber(job.media.duration) - outTime) / speedMultiplier;
  } else if (job.conversionProgress >= 1) job.etaSeconds = 0;
  return job;
}

async function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, { highWaterMark: 8 * 1024 * 1024 });
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function uniqueOutput(directory, requestedName) {
  const extension = path.extname(requestedName);
  const base = path.basename(requestedName, extension);
  let candidate = path.join(directory, requestedName);
  let index = 2;
  while (fs.existsSync(candidate) || fs.existsSync(`${candidate}.json`)) candidate = path.join(directory, `${base}_${index++}${extension}`);
  return candidate;
}

function companionOutputPath(outputPath, suffix) {
  const extension = path.extname(outputPath);
  return path.join(path.dirname(outputPath), `${path.basename(outputPath, extension)}${suffix}`);
}

function presentationTimeUsForFrame(media = {}, oneBasedFrame = 1) {
  const index = Math.max(0, Math.trunc(oneBasedFrame) - 1);
  if (Array.isArray(media.timestamps) && Number.isFinite(Number(media.timestamps[index]))) {
    const first = Number(media.timestamps[0]);
    return Math.max(0, Math.floor((Number(media.timestamps[index]) - first) / 1000));
  }
  const fps = safeNumber(media.fps, 0);
  return fps > 0 ? Math.round(index * 1e6 / fps) : null;
}

function runtimeGpuExecutionReport(job) {
  const stages = (job.execution?.stages || []).map(stage => ({ ...stage }));
  const computeFallback = Boolean(job.compute?.fallback);
  const computeStageIds = new Set(['mfsr', 'niv99-omniclarity', 'canonical-delivery']);
  for (const stage of stages) {
    if (computeFallback && computeStageIds.has(stage.id) && stage.owner === 'GPU') {
      stage.owner = 'MIXED';
      stage.accelerated = true;
      stage.fallback = true;
      stage.fallbackStage = job.compute.fallbackStage || null;
      stage.fallbackReason = job.compute.fallbackReason || null;
    }
    if (stage.id === 'mfsr' && Number(job.mfsr?.processedFrames) > 0) {
      stage.gpuFrames = Number(job.mfsr?.gpuFrames || 0);
      stage.processedFrames = Number(job.mfsr.processedFrames);
    }
    if (stage.id === 'niv99-omniclarity' && Number(job.niv99?.processedFrames) > 0) {
      stage.gpuFrames = Number(job.niv99?.gpuFrames || 0);
      stage.processedFrames = Number(job.niv99.processedFrames);
    }
    if (stage.id === 'canonical-delivery' && Number(job.colorPipeline?.processedFrames) > 0) {
      stage.processedFrames = Number(job.colorPipeline.processedFrames);
      stage.engine = job.colorPipeline.compute || stage.engine;
      if (String(stage.engine || '').toLowerCase().includes('numpy')) {
        stage.owner = 'CPU';
        stage.accelerated = false;
      }
    }
  }
  return {
    requestedMode: job.executionMode || 'identity',
    stages,
    activeGpuStages: stages.filter(stage => stage.owner === 'GPU' || stage.owner === 'MIXED').length,
    totalStages: stages.length,
    runtimeFallback: computeFallback || Boolean(job.execution?.automaticEncoderFallback),
    fixedUtilizationGuarantee: false,
    utilizationMeasurement: null,
    statement: 'Maximum validated GPU paths were selected. A fixed GPU percentage is not asserted; actual stage ownership and fallbacks are recorded.'
  };
}

async function validateDynamicDeliveryMetadataFile(filePath, expectedFrames, expectedFinalHash = null) {
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let previous = '0'.repeat(64);
  let header = null;
  let footer = null;
  let frames = 0;
  let lastPts = -1;
  for await (const line of lines) {
    if (!line.trim()) continue;
    if (footer) throw new Error('Dynamic delivery metadata contains records after its footer');
    const record = JSON.parse(line);
    const { previousRecordSha256, recordSha256, ...payload } = record;
    const expectedHash = crypto.createHash('sha256').update(previous, 'hex')
      .update(JSON.stringify(payload), 'utf8').digest('hex');
    if (previousRecordSha256 !== previous || recordSha256 !== expectedHash) {
      throw new Error(`Dynamic delivery metadata hash-chain mismatch at record ${frames + 1}`);
    }
    previous = recordSha256;
    if (record.recordType === 'header') {
      if (header || frames) throw new Error('Dynamic delivery metadata header is out of order');
      if (record.schema !== 'com.neoproc.camx.dynamic-delivery.v1' || !record.privateTechnology ||
          record.vendorCertificationClaimed !== false) {
        throw new Error('Dynamic delivery metadata has an invalid private-technology boundary');
      }
      const tiers = record.definitions?.tiers || {};
      if (!['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'].every(tier => tiers[tier])) {
        throw new Error('Dynamic delivery metadata is missing a T0-T7 definition');
      }
      header = record;
    } else if (record.recordType === 'frame') {
      if (!header || Number(record.frame) !== frames + 1) {
        throw new Error(`Dynamic delivery frame sequence is invalid at frame ${frames + 1}`);
      }
      if (!['T1', 'T3', 'T4', 'T5', 'T6', 'T7'].every(tier => record.tiers?.[tier])) {
        throw new Error(`Dynamic delivery metadata tiers are incomplete at frame ${record.frame}`);
      }
      const pts = Number(record.presentationTimeUs);
      if (Number.isFinite(pts) && pts < lastPts) throw new Error(`Dynamic delivery timing regressed at frame ${record.frame}`);
      if (Number.isFinite(pts)) lastPts = pts;
      frames += 1;
    } else if (record.recordType === 'footer') {
      footer = record;
    } else {
      throw new Error(`Unknown dynamic delivery metadata record: ${record.recordType || 'unset'}`);
    }
  }
  if (!header || !footer || frames !== Number(expectedFrames) || Number(footer.frames) !== frames ||
      Number(footer.measuredContentLight?.framesMeasured) !== frames) {
    throw new Error(`Dynamic delivery metadata cadence is incomplete (${frames}/${expectedFrames})`);
  }
  if (expectedFinalHash && previous !== expectedFinalHash) {
    throw new Error('Dynamic delivery metadata final hash does not match the writer');
  }
  return { frames, finalHash: previous, measuredContentLight: footer.measuredContentLight };
}

async function stageCompanionArtifacts(job, plan) {
  const staged = [];
  for (const artifact of plan.companionArtifacts || []) {
    if (!artifact?.sourcePath || !artifact?.suffix) throw new Error('Invalid conversion companion contract');
    const outputPath = companionOutputPath(job.outputPath, artifact.suffix);
    if (fs.existsSync(outputPath)) throw new Error(`Companion output already exists: ${path.basename(outputPath)}`);
    const partialPath = `${job.partialPath}.${randomUUID()}.companion`;
    job.temporaryPaths.push(partialPath);
    await fs.promises.copyFile(artifact.sourcePath, partialPath, fs.constants.COPYFILE_EXCL);
    // Windows requires a writable handle for FlushFileBuffers/fsync. The staged copy is private
    // to this job, so r+ provides durable publication without changing its bytes.
    const handle = await fs.promises.open(partialPath, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    const stat = await fs.promises.stat(partialPath);
    if (!stat.isFile() || stat.size <= 0) throw new Error(`Conversion companion is empty: ${artifact.kind}`);
    staged.push({
      kind: artifact.kind,
      outputPath,
      partialPath,
      bytes: stat.size,
      sha256: await sha256(partialPath)
    });
  }
  return staged;
}

class ConversionQueue {
  constructor(capabilityService, mediaProbe, emit) {
    this.capabilityService = capabilityService;
    this.mediaProbe = mediaProbe;
    this.emit = emit;
    this.jobs = [];
    this.active = null;
    this.stopping = false;
  }

  snapshot() { return this.jobs.map(job => this.publicJob(job)); }

  publicJob(job) {
    // The full media descriptor can contain tens of thousands of timestamps
    // and AAC packet hashes. Sending it to the renderer on every progress tick
    // creates large structured-clone pauses in both Electron processes. The UI
    // already has its source descriptor and only needs job telemetry here.
    const { process, frameStream, temporaryPaths, governor, media, _gpuEncoderRetryAttempted, ...safe } = job;
    return safe;
  }

  async enqueue(request) {
    if (!request || !Array.isArray(request.inputs) || request.inputs.length === 0) throw new Error('No source files selected');
    if (!request.outputDirectory) throw new Error('No delivery folder selected');
    if (!PROFILES[request.profileId]) throw new Error('Unknown conversion profile');
    if (!isPublicProfile(request.profileId)) throw new Error('This legacy profile is not available in the current lossless workflow');
    if (request.executionMode && !['gpu-auto', 'cpu-master', 'gpu-encode'].includes(request.executionMode)) throw new Error('Unknown execution mode');
    const identityOutput = ['raw-copy', 'cinemadng'].includes(PROFILES[request.profileId].family);
    const executionMode = identityOutput ? null : (request.executionMode || 'gpu-auto');
    await fs.promises.mkdir(request.outputDirectory, { recursive: true });
    const caps = await this.capabilityService.detect();
    if (!caps.ready) throw new Error('FFmpeg runtime is incomplete');
    const mediaItems = [];
    for (const input of request.inputs) {
      if (input?.conversionEligible === false || input?.libraryKind === 'saved') {
        throw new Error(`Saved videos are preview/download only and cannot be rendered: ${input.name || input.filePath || input}`);
      }
      const media = input.kind ? input : await this.mediaProbe.probe(input.filePath || input);
      if (!media.supported || media.error) throw new Error(`Unsupported source: ${media.name || media.filePath}`);
      if (media.conversionEligible === false || media.libraryKind === 'saved') {
        throw new Error(`Only Cinema Cam conversion masters can be rendered: ${media.name || media.filePath}`);
      }
      assertPublicConversionRoute(PROFILES[request.profileId], media);
      if (request.profileId === 'cinemadng-sequence' && (!media.raw || !['npv10', 'npraw'].includes(media.kind))) {
        throw new Error(`CinemaDNG requires a CamX RAW source: ${media.name || media.filePath}`);
      }
      // Preflight before queue mutation: strict GPU and codec capability failures are atomic.
      buildPlan({
        profileId: request.profileId,
        quality: request.quality || 'maximum',
        executionMode,
        logVariant: request.logVariant || 'base',
        aiEnhance: request.aiEnhance !== false,
        mfsrEnhance: request.mfsrEnhance !== false,
        media
      }, media, caps, path.join(request.outputDirectory, `.camx-preflight${PROFILES[request.profileId].extension || '.mov'}`));
      mediaItems.push(media);
    }
    const created = [];
    for (const media of mediaItems) {
      const finalPath = uniqueOutput(request.outputDirectory, outputName(media.filePath, request.profileId, {
        logVariant: request.logVariant || 'base'
      }));
      const extension = path.extname(finalPath);
      const id = randomUUID();
      const partialPath = path.join(path.dirname(finalPath), `${path.basename(finalPath, extension)}.${id}.partial${extension}`);
      const job = {
        id, source: media.filePath, sourceName: path.basename(media.filePath), media,
        profileId: request.profileId, quality: request.quality || 'maximum', logVariant: request.logVariant || 'base',
        executionMode,
        aiEnhance: request.aiEnhance !== false, mfsrEnhance: request.mfsrEnhance !== false,
        outputPath: finalPath, partialPath, state: 'queued', progressStage: 'Queued', progress: 0,
        conversionProgress: 0, processedFrames: 0, expectedFrames: expectedFrameCount(media),
        processingFps: 0, elapsedSeconds: 0, speed: '—', etaSeconds: null,
        createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, error: null,
        engine: null, execution: null, gpu: false, bytesWritten: 0
      };
      this.jobs.push(job);
      created.push(this.publicJob(job));
      this.notify('added', job);
    }
    this.pump();
    return created;
  }

  cancel(id) {
    const job = this.jobs.find(item => item.id === id);
    if (!job || ['complete', 'failed', 'cancelled'].includes(job.state)) return false;
    job.cancelRequested = true;
    if (job.state === 'queued') {
      job.state = 'cancelled';
      job.progressStage = 'Cancelled';
      job.finishedAt = new Date().toISOString();
      this.notify('updated', job);
    } else if (job.process) {
      job.frameStream?.destroy();
      job.process.kill('SIGTERM');
    }
    return true;
  }

  remove(id) {
    const index = this.jobs.findIndex(item => item.id === id);
    if (index < 0 || this.jobs[index].state === 'running') return false;
    const [job] = this.jobs.splice(index, 1);
    this.emit({ type: 'removed', id: job.id });
    return true;
  }

  shutdown() {
    this.stopping = true;
    if (this.active?.process) this.active.process.kill('SIGTERM');
  }

  notify(type, job) { this.emit({ type, job: this.publicJob(job) }); }

  async runBackgroundJobTask(job, taskName, payload, options = {}) {
    const task = startBackgroundTask(taskName, payload, options);
    const processHandle = {
      kill: () => task.cancel(`${taskName} cancelled`)
    };
    job.process = processHandle;
    try {
      const result = await task.promise;
      if (job.cancelRequested) throw new Error('Conversion cancelled');
      return result;
    } finally {
      if (job.process === processHandle) job.process = null;
    }
  }

  async pump() {
    if (this.active || this.stopping) return;
    const next = this.jobs.find(job => job.state === 'queued' && !job.cancelRequested);
    if (!next) return;
    this.active = next;
    try { await this.run(next); }
    catch (error) {
      next.state = next.cancelRequested ? 'cancelled' : 'failed';
      next.progressStage = next.cancelRequested ? 'Cancelled' : 'Failed';
      next.error = error.message;
      next.finishedAt = new Date().toISOString();
      next.elapsedSeconds = next.startedAt ? Number(((Date.now() - new Date(next.startedAt).getTime()) / 1000).toFixed(1)) : 0;
      await fs.promises.rm(next.partialPath, { force: true, recursive: true }).catch(() => {});
      this.notify('updated', next);
    } finally {
      await Promise.all((next.temporaryPaths || []).map(filePath => fs.promises.rm(filePath, { force: true }).catch(() => {})));
      next.process = null;
      next.frameStream = null;
      this.active = null;
      setImmediate(() => this.pump());
    }
  }

  async run(job) {
    job.state = 'running';
    job.progressStage = 'Preparing';
    job.progress = 0.01;
    job.startedAt = new Date().toISOString();
    this.notify('progress', job);
    const caps = await this.capabilityService.detect();
    const sourceStatBefore = await fs.promises.stat(job.source);
    const sourceHash = await sha256(job.source);
    if (job.cancelRequested) throw new Error('Conversion cancelled');
    job.sourceIntegrity = {
      before: { bytes: sourceStatBefore.size, modifiedMs: Math.trunc(sourceStatBefore.mtimeMs), sha256: sourceHash },
      unchanged: null
    };
    if (['raw-preserve', 'cinemadng-sequence'].includes(job.profileId)) {
      job.temporaryPaths = [];
    } else {
      const prepared = await this.runBackgroundJobTask(job, 'prepare-companions', {
        media: job.media,
        partialPath: job.partialPath
      }, { timeoutMs: 60 * 60 * 1000 });
      job.temporaryPaths = prepared.temporaryPaths;
      for (const [key, value] of Object.entries(prepared.mediaUpdates || {})) {
        if (value !== null) job.media[key] = value;
      }
    }
    const plan = buildPlan(job, job.media, caps, job.partialPath);
    job.engine = plan.engine || 'verified-copy';
    job.gpu = plan.gpu;
    job.execution = plan.execution || null;
    job.ai = plan.ai || { enabled: false };
    job.mfsr = plan.mfsr || { enabled: false };
    job.niv99 = plan.niv99 || { enabled: false };
    job.rawDevelopment = plan.rawPipeline || null;
    job.colorPipeline = plan.colorPipeline || null;
    job.compute = plan.compute || null;
    job.losslessContract = plan.losslessContract || null;
    job.governor = new SustainedConversionGovernor({
      route: plan.operation,
      width: Number(job.media.width || 0),
      height: Number(job.media.height || 0),
      sourceFps: Number(job.media.fps || 0),
      compressedOutput: !['copy', 'cinemadng'].includes(plan.operation)
    }, { logicalCores: caps.logicalCores });
    if (plan.niv99?.enabled && job.expectedFrames > 0) {
      const fingerprint = stableFingerprint({
        sourceLength: sourceStatBefore.size,
        sourceLastModified: Math.trunc(sourceStatBefore.mtimeMs),
        sourceSha256: sourceHash,
        width: job.media.width,
        height: job.media.height,
        signalFamily: plan.niv99.signalFamily,
        detailProfile: plan.niv99.detailProfile,
        stageFlags: {
          niv99: true,
          riven: true,
          mfsr: Boolean(plan.mfsr?.enabled),
          ai: Boolean(plan.ai?.enabled),
          canonicalDelivery: Boolean(plan.colorPipeline?.exactCameraMath)
        },
        stageScales: {
          quality: job.quality,
          saturation: boundedNumber(plan.processorArgs, '--saturation', 1),
          warmth: boundedNumber(plan.processorArgs, '--warmth', 0),
          mfsrFrames: Number(plan.mfsr?.frames || 0),
          mfsrStrength: Number(plan.mfsr?.strength || 0)
        },
        frameCount: job.expectedFrames
      });
      const cachePath = cacheFileFor(job.source);
      const cached = inspectQualityCache(cachePath, fingerprint);
      const cacheWritePath = `${job.partialPath}.quality.nqis`;
      plan.processorArgs.push(
        cached ? '--quality-cache-read' : '--quality-cache-write', cached ? cachePath : cacheWritePath,
        '--quality-cache-fingerprint', serializeFingerprint(fingerprint),
        '--quality-cache-frames', String(job.expectedFrames)
      );
      if (!cached) job.temporaryPaths.push(cacheWritePath);
      job.qualityInstructionCache = {
        format: 'NQISCACH', version: 1, hit: Boolean(cached), records: cached?.recordCount || 0,
        sourceFingerprint: fingerprint, path: cachePath, writePath: cached ? null : cacheWritePath
      };
    } else {
      job.qualityInstructionCache = { format: 'NQISCACH', version: 1, hit: false, disabled: true };
    }
    job.progressStage = plan.operation === 'copy' ? 'Verifying copy' :
      plan.operation === 'cinemadng' ? 'Writing CinemaDNG' : 'Converting';
    job.progress = 0.04;
    this.notify('updated', job);
    let sequence = null;
    if (plan.operation === 'copy') await this.copyVerified(job);
    else if (plan.operation === 'cinemadng') sequence = await this.runCinemaDng(job);
    else if (plan.operation === 'enhance-ffmpeg') await this.runEnhancementPipeline(job, plan, caps);
    else await this.runFfmpeg(job, plan, caps);
    if (job.cancelRequested) throw new Error('Conversion cancelled');
    if (['ndr', 'nivukx'].includes(plan.profile.family)) {
      await this.remuxMeasuredHdrMetadata(job, plan, caps);
    }
    if (job.qualityInstructionCache?.writePath && fs.existsSync(job.qualityInstructionCache.writePath)) {
      const published = await publishQualityCache(
        job.qualityInstructionCache.writePath,
        job.source,
        job.qualityInstructionCache.sourceFingerprint
      );
      job.qualityInstructionCache = {
        ...job.qualityInstructionCache,
        writePath: null,
        written: published.written,
        records: published.recordCount || 0,
        crc32: published.crc32 ?? null,
        warning: published.written ? null : published.reason
      };
    }
    const sourceStatAfter = await fs.promises.stat(job.source);
    const sourceHashAfter = await sha256(job.source);
    const sourceUnchanged = sourceStatBefore.size === sourceStatAfter.size &&
      Math.trunc(sourceStatBefore.mtimeMs) === Math.trunc(sourceStatAfter.mtimeMs) &&
      sourceHash === sourceHashAfter;
    job.sourceIntegrity.after = {
      bytes: sourceStatAfter.size, modifiedMs: Math.trunc(sourceStatAfter.mtimeMs), sha256: sourceHashAfter
    };
    job.sourceIntegrity.unchanged = sourceUnchanged;
    if (!sourceUnchanged) throw new Error('Source changed during conversion; output was not published');
    job.progressStage = 'Validating output';
    job.progress = Math.max(job.progress, 0.90);
    job.etaSeconds = null;
    this.notify('progress', job);
    const validation = plan.operation === 'copy' ? { passed: true, bitExact: true } :
      plan.operation === 'cinemadng' ? await this.runBackgroundJobTask(job, 'validate-dng', {
        directory: job.partialPath, sourceMedia: job.media, sequence
      }, { timeoutMs: 60 * 60 * 1000 }) : await this.runBackgroundJobTask(job, 'validate-video', {
        filePath: job.partialPath, profile: plan.profile, sourceMedia: job.media, capabilities: caps,
        measuredContentLight: job.colorPipeline?.measuredContentLight || null
      }, { timeoutMs: 24 * 60 * 60 * 1000 });
    job.validation = validation;
    job.progressStage = 'Publishing';
    job.progress = 0.96;
    this.notify('progress', job);
    const companionArtifacts = plan.operation === 'cinemadng' || plan.operation === 'copy'
      ? [] : await stageCompanionArtifacts(job, plan);
    job.companionArtifacts = companionArtifacts.map(({ partialPath, ...artifact }) => artifact);
    const outputHash = sequence?.sequenceSha256 || await sha256(job.partialPath);
    const stat = await fs.promises.stat(job.partialPath);
    job.bytesWritten = sequence?.bytes || stat.size;
    job.sustainedPerformance = job.governor.summary();
    const gpuExecution = runtimeGpuExecutionReport(job);
    job.gpuExecution = gpuExecution;
    const receipt = {
      schema: 'com.neoproc.camx.studio.conversion-receipt.v8',
      createdAt: new Date().toISOString(), source: job.source, sourceSha256: sourceHash,
      output: job.outputPath, outputSha256: outputHash, outputBytes: job.bytesWritten,
      profile: plan.profile, quality: job.quality,
      logVariant: plan.profile.family === 'log' ? job.logVariant : null,
      selectedConversion: {
        delivery: plan.profile.deliveryId || plan.profile.id,
        transport: plan.profile.transportId || plan.profile.encoder,
        chromaSampling: job.losslessContract?.chromaSampling || null,
        logVariant: plan.profile.family === 'log' ? job.logVariant : null
      },
      engine: job.engine, gpuAccelerated: gpuExecution.activeGpuStages > 0,
      execution: job.execution,
      gpuExecution,
      computePipeline: job.compute,
      aiEnhancement: job.ai,
      multiFrameSuperResolution: job.mfsr,
      niv99OmniClarity: job.niv99,
      rawDevelopment: job.rawDevelopment,
      colorPipeline: job.colorPipeline,
      losslessContract: job.losslessContract,
      qualityInstructionCache: job.qualityInstructionCache,
      sustainedPerformance: job.sustainedPerformance,
      companionArtifacts: job.companionArtifacts,
      validation,
      qualityCertificate: {
        schema: 'com.neoproc.camx.studio.quality-certificate.v1',
        passed: Boolean(validation?.passed),
        noSilentDowngrade: true,
        codecLossless: Boolean(job.losslessContract?.codecLossless),
        losslessScope: job.losslessContract?.scope || null,
        chromaSampling: job.losslessContract?.chromaSampling || null,
        chromaPreserving: Boolean(job.losslessContract?.chromaPreserving),
        losslessAfterSelectedChromaSampling: Boolean(job.losslessContract?.codecLossless),
        chromaSubsamplingIrreversible: Boolean(job.losslessContract?.codecLossless) && !job.losslessContract?.chromaPreserving,
        gpuEncodingRuntimeProven: Boolean(job.losslessContract?.gpuEncodingRuntimeProven),
        sourceUnchanged: job.sourceIntegrity.unchanged,
        sourceBeforeSha256: sourceHash,
        sourceAfterSha256: sourceHashAfter,
        outputSha256: outputHash,
        exactCameraColorMath: Boolean(job.colorPipeline?.exactCameraMath),
        colorMathVersions: job.colorPipeline?.exactCameraMath ? Object.fromEntries(Object.entries({
          toneOperator: job.colorPipeline.toneOperator,
          calibration: job.colorPipeline.calibration,
          deliveryEngine: job.colorPipeline.deliveryEngine,
          transfer: job.colorPipeline.transferVersion,
          pipeline: job.colorPipeline.pipelineVersion,
          logVariant: job.colorPipeline.logVariant
        }).filter(([, value]) => value != null)) : null,
        measuredContentLight: job.colorPipeline?.measuredContentLight || null,
        rawSensorSamplesPreserved: plan.operation === 'copy' || plan.operation === 'cinemadng',
        frameCountValidated: validation?.decodedFrames || validation?.frames || null,
        audioValidated: !job.media.audio || Boolean(validation?.audio),
        qualityInvariantUnderGovernor: true,
        continuumParityValidated: job.compute?.ready
          ? Number(job.compute.maximumCodeDelta) <= 1 && !job.compute.fallback
          : null
      },
      sourceIntegrity: job.sourceIntegrity,
      sourceMedia: {
        container: job.media.container, codec: job.media.codec, width: job.media.width,
        height: job.media.height, fps: job.media.fps, bitDepth: job.media.bitDepth,
        colorPrimaries: job.media.colorPrimaries, colorTransfer: job.media.colorTransfer,
        timingAuthority: job.media.timingAuthority || (job.media.kind === 'npv10' ? 'header-cfr' : 'container'),
        recoveredValidPrefix: Boolean(job.media.recovered), recoveryWarnings: job.media.warnings || [],
        orientationDegrees: Number(job.media.orientation || job.media.rotation || 0),
        audioSidecar: job.media.audioSidecar ? {
          packetCount: job.media.audioSidecar.packetCount,
          payloadBytes: job.media.audioSidecar.payloadBytes,
          firstPresentationTimeUs: job.media.audioSidecar.firstPresentationTimeUs,
          finalPresentationTimeUs: job.media.audioSidecar.finalPresentationTimeUs,
          crcValidated: job.media.audioSidecar.crcValidated,
          codec: job.media.audioSidecar.codec,
          audioObjectType: job.media.audioSidecar.audioObjectType,
          codecConfigSha256: job.media.audioSidecar.codecConfigSha256,
          payloadSha256: job.media.audioSidecar.payloadSha256
        } : null,
        developColorSidecar: job.media.developColor || null
      }
    };
    const receiptJson = JSON.stringify(receipt, null, 2);
    if (plan.operation === 'cinemadng') {
      await fs.promises.writeFile(path.join(job.partialPath, 'conversion-receipt.json'), receiptJson, { encoding: 'utf8', flag: 'wx' });
      await fs.promises.rename(job.partialPath, job.outputPath);
    } else {
      const partialReceiptPath = `${job.partialPath}.receipt.json`;
      const receiptPath = `${job.outputPath}.json`;
      job.temporaryPaths.push(partialReceiptPath);
      await fs.promises.writeFile(partialReceiptPath, receiptJson, { encoding: 'utf8', flag: 'wx' });
      const publishedPaths = [];
      try {
        for (const artifact of companionArtifacts) {
          await fs.promises.rename(artifact.partialPath, artifact.outputPath);
          publishedPaths.push(artifact.outputPath);
        }
        await fs.promises.rename(partialReceiptPath, receiptPath);
        publishedPaths.push(receiptPath);
        await fs.promises.rename(job.partialPath, job.outputPath);
      } catch (error) {
        await Promise.all(publishedPaths.map(filePath => fs.promises.rm(filePath, { force: true }).catch(() => {})));
        throw error;
      }
    }
    job.state = 'complete';
    job.progressStage = 'Complete';
    job.progress = 1;
    job.conversionProgress = 1;
    job.etaSeconds = 0;
    job.elapsedSeconds = Number(((Date.now() - new Date(job.startedAt).getTime()) / 1000).toFixed(1));
    job.finishedAt = new Date().toISOString();
    this.notify('updated', job);
  }

  async copyVerified(job) {
    const sourceStat = await fs.promises.stat(job.source);
    let copied = 0;
    await new Promise((resolve, reject) => {
      const input = fs.createReadStream(job.source, { highWaterMark: 16 * 1024 * 1024 });
      const output = fs.createWriteStream(job.partialPath, { flags: 'wx', highWaterMark: 16 * 1024 * 1024 });
      job.process = { kill: () => { input.destroy(new Error('Conversion cancelled')); output.destroy(); } };
      input.on('data', chunk => {
        copied += chunk.length;
        const ratio = sourceStat.size ? copied / sourceStat.size : 0;
        const elapsed = Math.max(0.001, (Date.now() - new Date(job.startedAt).getTime()) / 1000);
        const bytesPerSecond = copied / elapsed;
        job.conversionProgress = ratio;
        job.progress = Math.min(0.88, 0.04 + ratio * 0.84);
        job.elapsedSeconds = Number(elapsed.toFixed(1));
        job.speed = `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
        job.etaSeconds = bytesPerSecond > 0 ? Math.max(0, sourceStat.size - copied) / bytesPerSecond : null;
        this.notify('progress', job);
      });
      input.on('error', reject); output.on('error', reject); output.on('finish', resolve);
      input.pipe(output);
    });
    const [left, right] = await Promise.all([sha256(job.source), sha256(job.partialPath)]);
    if (left !== right) throw new Error('RAW preservation checksum verification failed');
  }

  async runCinemaDng(job) {
    return this.runBackgroundJobTask(job, 'cinema-dng', {
      directory: job.partialPath,
      sourcePath: job.source,
      media: job.media
    }, {
      timeoutMs: 24 * 60 * 60 * 1000,
      progressIntervalMs: 125,
      onProgress: progress => {
        if (job.cancelRequested) return;
        updateJobProgress(job, progress);
        job.rawDevelopment = { identityMosaic: true, frames: progress.frame, expectedFrames: progress.frames };
        this.notify('progress', job);
      }
    });
  }

  async remuxMeasuredHdrMetadata(job, plan, caps) {
    const measured = job.colorPipeline?.measuredContentLight;
    if (!measured || Number(measured.framesMeasured) <= 0) {
      throw new Error('Canonical HDR conversion produced no measured content-light metadata');
    }
    const masteringPeak = Number(job.colorPipeline.masteringPeakNits || plan.profile.peakNits || 0);
    const maxCll = Math.max(0, Math.min(65535, Math.min(masteringPeak,
      Math.round(Number(measured.signalledMaxCLL)))));
    const maxFall = Math.max(0, Math.min(maxCll,
      Math.round(Number(measured.signalledMaxFALL))));
    if (!Number.isFinite(maxCll) || !Number.isFinite(maxFall) || masteringPeak <= 0) {
      throw new Error('Measured content-light metadata is invalid');
    }

    job.progressStage = 'Embedding measured content light';
    job.progress = Math.max(job.progress, 0.89);
    this.notify('progress', job);
    const extension = path.extname(job.partialPath) || '.mov';
    const remuxPath = `${job.partialPath}.${randomUUID()}.measured${extension}`;
    const backupPath = `${job.partialPath}.${randomUUID()}.pre-metadata`;
    job.temporaryPaths.push(remuxPath, backupPath);
    const masteringDisplay = `G(8500,39850)B(6550,2300)R(35400,14600)` +
      `WP(15635,16450)L(${Math.round(masteringPeak * 10000)},1)`;
    const args = [
      '-hide_banner', '-y', '-nostdin',
      '-mastering_display:v:0', masteringDisplay,
      '-content_light:v:0', `${maxCll},${maxFall}`,
      '-i', job.partialPath,
      '-map', '0', '-map_metadata', '0', '-c', 'copy',
      '-movflags', '+faststart+write_colr', '-nostats', remuxPath
    ];
    const child = spawn(caps.ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    job.process = child;
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-64 * 1024); });
    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    if (job.cancelRequested) throw new Error('Conversion cancelled');
    if (exitCode !== 0 || !fs.existsSync(remuxPath) || (await fs.promises.stat(remuxPath)).size <= 0) {
      throw new Error(`Measured HDR metadata remux failed${stderr ? `: ${conciseFailureReason(stderr)}` : ''}`);
    }

    await fs.promises.rename(job.partialPath, backupPath);
    try {
      await fs.promises.rename(remuxPath, job.partialPath);
    } catch (error) {
      await fs.promises.rename(backupPath, job.partialPath).catch(() => {});
      throw error;
    }
    await fs.promises.rm(backupPath, { force: true });
    job.colorPipeline = {
      ...job.colorPipeline,
      measuredContentLight: {
        ...measured,
        signalledMaxCLL: maxCll,
        signalledMaxFALL: maxFall,
        embeddedInContainer: true,
        embedding: 'post-render stream-copy metadata remux'
      }
    };
  }

  async prepareAutomaticCpuRetry(job, plan, caps, reason) {
    const failedEncode = String(plan.execution?.encode || '');
    if (job.cancelRequested || job.executionMode !== 'gpu-auto' ||
      job._gpuEncoderRetryAttempted || !failedEncode.startsWith('GPU ')) return false;

    job._gpuEncoderRetryAttempted = true;
    const cacheArguments = qualityCacheArguments(plan.processorArgs);
    const evidencePath = `${job.partialPath}.niv99-evidence.jsonl`;
    const dynamicMetadataPath = `${job.partialPath}.dynamic-delivery.jsonl`;
    const retryArtifacts = new Set([
      job.partialPath,
      evidencePath,
      dynamicMetadataPath,
      job.qualityInstructionCache?.writePath
    ].filter(Boolean));
    await Promise.all([...retryArtifacts].map(filePath => fs.promises.rm(filePath, {
      force: true, recursive: true, maxRetries: 4, retryDelay: 100
    })));

    const fallbackPlan = buildPlan(
      { ...job, executionMode: 'cpu-master' },
      job.media,
      caps,
      job.partialPath
    );
    if (cacheArguments.length && Array.isArray(fallbackPlan.processorArgs)) {
      fallbackPlan.processorArgs.push(...cacheArguments);
    }
    const fallback = {
      occurred: true,
      attempt: 1,
      from: failedEncode,
      to: fallbackPlan.execution?.encode || 'CPU encoder',
      reason: conciseFailureReason(reason),
      qualityContractPreserved: true
    };
    fallbackPlan.execution = {
      ...fallbackPlan.execution,
      requested: 'gpu-auto',
      automaticEncoderFallback: fallback
    };
    Object.assign(plan, fallbackPlan);

    job.engine = plan.engine;
    job.gpu = plan.gpu;
    job.execution = plan.execution;
    job.losslessContract = plan.losslessContract || null;
    job.process = null;
    job.frameStream = null;
    job.processedFrames = 0;
    job.processingFps = 0;
    job.conversionProgress = 0;
    job.progress = 0.04;
    job.speed = '—';
    job.etaSeconds = null;
    job.progressStage = 'GPU encoder unavailable; restarting with exact CPU encoder';
    this.notify('updated', job);
    return true;
  }

  async runFfmpeg(job, plan, caps) {
    const child = spawn(caps.ffmpegPath, plan.args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      priority: 'aboveNormal'
    });
    job.process = child;
    child.stdin.on('error', error => {
      if (error.code !== 'EPIPE' && !job.cancelRequested) stderr = `${stderr}\n${error.message}`;
    });
    let stderr = '';
    let progressBuffer = '';
    const progressState = {};
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-64 * 1024); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      progressBuffer += chunk;
      const lines = progressBuffer.split(/\r?\n/);
      progressBuffer = lines.pop() || '';
      for (const line of lines) {
        const index = line.indexOf('=');
        if (index <= 0) continue;
        const key = line.slice(0, index);
        const value = line.slice(index + 1);
        if (key === 'frame') progressState.frame = safeNumber(value);
        else if (key === 'fps') progressState.fps = safeNumber(value);
        else if (key === 'out_time_us') progressState.outTimeSeconds = safeNumber(value) / 1e6;
        else if (key === 'speed') progressState.speed = value;
        else if (key === 'progress') {
          updateJobProgress(job, progressState);
          this.notify('progress', job);
        }
      }
    });
    if (['npv10', 'npraw'].includes(job.media.kind)) {
      const onRawProgress = rawProgress => {
        updateJobProgress(job, rawProgress);
        if (rawProgress.raw) {
          job.rawDevelopment = { ...job.rawDevelopment, ...rawProgress.raw };
          job.governor?.recordStageLatency('niv99Raw', rawProgress.raw.processingMs);
        }
        this.notify('progress', job);
      };
      const stream = createBackgroundFrameStream(job.source, job.media, {
        develop: Boolean(plan.rawPipeline),
        quality: job.quality,
        onProgress: onRawProgress,
        progressIntervalMs: 125
      });
      job.frameStream = stream;
      stream.on('error', error => child.stdin.destroy(error));
      stream.pipe(child.stdin);
    } else {
      child.stdin.end();
    }
    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    if (job.cancelRequested) throw new Error('Conversion cancelled');
    if (exitCode !== 0) {
      const useful = stderr.split(/\r?\n/).filter(Boolean).slice(-16).join('\n');
      const failure = `Conversion engine exited with code ${exitCode}${useful ? `\n${useful}` : ''}`;
      if (await this.prepareAutomaticCpuRetry(job, plan, caps, failure)) {
        return this.runFfmpeg(job, plan, caps);
      }
      throw new Error(failure);
    }
    if (!fs.existsSync(job.partialPath) || (await fs.promises.stat(job.partialPath)).size === 0) throw new Error('Conversion produced no output');
    updateJobProgress(job, { frame: job.expectedFrames || job.processedFrames, ratio: 1 });
    this.notify('progress', job);
  }

  async runEnhancementPipeline(job, plan, caps) {
    if (!plan.processorPath) throw new Error('CamX frame-processing runtime is unavailable');
    const decoder = spawn(caps.ffmpegPath, plan.decoderArgs, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const processor = spawn(plan.processorPath, plan.processorArgs, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const encoder = spawn(caps.ffmpegPath, plan.encoderArgs, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const children = [decoder, processor, encoder];
    const childStages = ['decoder', 'processor', 'encoder'];
    let firstFailedStage = null;
    let terminatingPipeline = false;
    const closePromises = children.map(child => new Promise(resolve => child.once('close', code => resolve(code))));
    const killAll = () => {
      if (terminatingPipeline) return;
      terminatingPipeline = true;
      // Stop RAW production before closing the decoder pipe.  Otherwise a
      // worker can continue transferring 75 MiB frames after an encoder fault,
      // exhausting RAM while the controller waits for inherited pipe handles.
      if (job.frameStream && !job.frameStream.destroyed) job.frameStream.destroy();
      for (const child of children) {
        for (const stream of [child.stdin, child.stdout, child.stderr]) {
          if (stream && !stream.destroyed) stream.destroy();
        }
        if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
      }
    };
    children.forEach((child, index) => child.once('close', code => {
      if (code !== 0 && !job.cancelRequested) {
        firstFailedStage ||= childStages[index];
        killAll();
      }
    }));
    job.process = { kill: killAll };

    let niv99EvidencePath = null;
    let niv99EvidenceStream = null;
    let niv99EvidenceCompletion = null;
    if (plan.niv99?.enabled) {
      niv99EvidencePath = `${job.partialPath}.niv99-evidence.jsonl`;
      job.temporaryPaths.push(niv99EvidencePath);
      niv99EvidenceStream = fs.createWriteStream(niv99EvidencePath, { flags: 'wx' });
      niv99EvidenceCompletion = finished(niv99EvidenceStream).then(() => null, error => error);
    }
    let deliveryMetadataPath = null;
    let deliveryMetadataStream = null;
    let deliveryMetadataCompletion = null;
    let deliveryMetadataFrames = 0;
    let deliveryMetadataChain = '0'.repeat(64);
    const writeDeliveryMetadataRecord = record => {
      if (!deliveryMetadataStream) return;
      const canonical = JSON.stringify(record);
      const recordSha256 = crypto.createHash('sha256')
        .update(deliveryMetadataChain, 'hex').update(canonical, 'utf8').digest('hex');
      deliveryMetadataStream.write(`${JSON.stringify({
        ...record, previousRecordSha256: deliveryMetadataChain, recordSha256
      })}\n`);
      deliveryMetadataChain = recordSha256;
    };
    if (['ndr', 'nivukx'].includes(plan.profile.family)) {
      deliveryMetadataPath = `${job.partialPath}.dynamic-delivery.jsonl`;
      job.temporaryPaths.push(deliveryMetadataPath);
      deliveryMetadataStream = fs.createWriteStream(deliveryMetadataPath, { flags: 'wx' });
      deliveryMetadataCompletion = finished(deliveryMetadataStream).then(() => null, error => error);
    }

    let decoderError = '';
    let processorError = '';
    let processorEventBuffer = '';
    let encoderError = '';
    let launchError = null;
    decoder.stderr.setEncoding('utf8');
    decoder.stderr.on('data', chunk => { decoderError = `${decoderError}${chunk}`.slice(-64 * 1024); });
    encoder.stderr.setEncoding('utf8');
    encoder.stderr.on('data', chunk => { encoderError = `${encoderError}${chunk}`.slice(-64 * 1024); });
    processor.stderr.setEncoding('utf8');
    processor.stderr.on('data', chunk => {
      processorError = `${processorError}${chunk}`.slice(-64 * 1024);
      processorEventBuffer += String(chunk);
      const eventLines = processorEventBuffer.split(/\r?\n/);
      processorEventBuffer = eventLines.pop() || '';
      for (const line of eventLines.filter(value => value.startsWith('#CAMX_AI#'))) {
        try {
          const event = JSON.parse(line.slice('#CAMX_AI#'.length));
          if (niv99EvidenceStream && (event.event === 'niv99' || event.event === 'complete')) {
            niv99EvidenceStream.write(`${JSON.stringify(event)}\n`);
          }
          if (deliveryMetadataStream && event.event === 'ready') {
            writeDeliveryMetadataRecord({
              recordType: 'header',
              schema: event.dynamicMetadata?.schema || 'com.neoproc.camx.dynamic-delivery.v1',
              privateTechnology: true,
              vendorCertificationClaimed: false,
              sourceSha256: job.sourceIntegrity?.before?.sha256 || null,
              profileId: job.profileId,
              technology: event.deliveryTransform,
              width: Number(job.media.width || 0),
              height: Number(job.media.height || 0),
              timingAuthority: job.media.timingAuthority || 'container',
              integrity: 'SHA256_HASH_CHAIN_UNSIGNED',
              signature: null,
              definitions: event.dynamicMetadata || null
            });
          } else if (deliveryMetadataStream && event.event === 'delivery') {
            deliveryMetadataFrames += 1;
            writeDeliveryMetadataRecord({
              recordType: 'frame',
              schema: event.schema,
              frame: event.frame,
              presentationTimeUs: presentationTimeUsForFrame(job.media, event.frame),
              mode: event.mode,
              processingMs: event.processingMs,
              compute: event.compute,
              tiers: {
                T1: {
                  frameIndex: Math.max(0, Number(event.frame) - 1),
                  presentationTimeUs: presentationTimeUsForFrame(job.media, event.frame)
                },
                ...(event.tiers || {})
              }
            });
          } else if (deliveryMetadataStream && event.event === 'complete') {
            writeDeliveryMetadataRecord({
              recordType: 'footer',
              schema: 'com.neoproc.camx.dynamic-delivery.v1',
              frames: event.frames,
              measuredContentLight: event.measuredContentLight || null,
              continuumFrames: event.continuumFrames,
              continuumFusedDeliveryFrames: event.continuumFusedDeliveryFrames
            });
          }
          if (event.event === 'ready') {
            job.compute = {
              ...job.compute, active: event.compute || null, workerEngine: event.engine,
              continuum: event.continuum || event.compute?.continuum || job.compute?.continuum || null,
              ioPipeline: event.ioPipeline || null
            };
          } else if (event.event === 'gpu-fallback') {
            job.compute = {
              ...job.compute, fallback: true, fallbackStage: event.stage, fallbackReason: event.message
            };
          } else if (event.event === 'inference') {
            job.ai = {
              ...job.ai, lastInferenceMs: event.ms, modelDelta: event.delta, blend: event.mix,
              detail: event.detail, confidence: event.confidence, noise: event.noise,
              texture: event.texture, highlights: event.highlights, engine: event.engine || job.ai.engine
            };
          } else if (event.event === 'progress') {
            job.ai = { ...job.ai, frames: event.frames, inferences: event.inferences };
            updateJobProgress(job, { frame: event.frames });
            this.notify('progress', job);
          } else if (event.event === 'mfsr') {
            job.mfsr = {
              ...job.mfsr, activeFrames: event.activeFrames, fused: event.fused,
              confidence: event.confidence, meanShiftPixels: event.meanShiftPixels,
              consensus: event.consensus, lastBypass: event.bypass,
              memoryLimited: event.memoryLimited, sceneReset: event.sceneReset,
              compute: event.compute || job.mfsr.compute
            };
          } else if (event.event === 'niv99') {
            job.governor?.recordStageLatency('niv99', event.processingMs);
            job.niv99 = {
              ...job.niv99, processedFrames: event.frame, noise: event.noise,
              textureConfidence: event.textureConfidence, severity: event.severity,
              sceneReset: event.sceneReset, rivenApplied: event.rivenApplied,
              residualWarmthApplied: event.residualWarmthApplied,
              compute: event.compute || job.niv99.compute
            };
          } else if (event.event === 'delivery') {
            job.governor?.recordStageLatency('canonicalDelivery', event.processingMs);
            job.colorPipeline = {
              ...job.colorPipeline,
              processedFrames: event.frame,
              lastFrameMs: event.processingMs,
              deliveryEngine: event.version,
              toneOperator: event.toneOperator,
              calibration: event.calibration,
              compute: event.compute || job.colorPipeline.compute
            };
          } else if (event.event === 'continuum') {
            job.compute = {
              ...job.compute,
              continuum: {
                ...(job.compute?.continuum || {}), version: event.version,
                active: true, processedFrames: event.frame,
                lastFrameMs: event.processingMs, stages: event.stages,
                submissionsPerFrame: event.submissions,
                fullFrameReadbacksPerFrame: event.fullFrameReadbacks,
                residentTemporalState: event.residentTemporalState
              }
            };
          } else if (event.event === 'complete') {
            job.ai = { ...job.ai, frames: event.frames, inferences: event.inferences };
            job.mfsr = {
              ...job.mfsr, processedFrames: event.frames, fusedFrames: event.mfsrFusedFrames,
              sceneResets: event.mfsrSceneResets, rejectedRegistrations: event.mfsrRejectedRegistrations,
              gpuFrames: event.mfsrGpuFrames, gpuFallbacks: event.mfsrGpuFallbacks,
              gpuMotionBatches: event.mfsrGpuMotionBatches,
              gpuMotionFields: event.mfsrGpuMotionFields,
              gpuMotionFallbacks: event.mfsrGpuMotionFallbacks
            };
            job.niv99 = {
              ...job.niv99, processedFrames: event.niv99Frames,
              temporalFrames: event.niv99TemporalFrames, rivenFrames: event.niv99RivenFrames,
              sceneResets: event.niv99SceneResets, averageNoise: event.niv99AverageNoise,
              averageSeverity: event.niv99AverageSeverity,
              gpuFrames: event.niv99GpuFrames, gpuFallbacks: event.niv99GpuFallbacks
            };
            job.compute = {
              ...job.compute,
              continuum: {
                ...(job.compute?.continuum || {}), ...(event.continuum || {}),
                processedFrames: event.continuumFrames,
                fusedDeliveryFrames: event.continuumFusedDeliveryFrames
              },
              ioPipeline: event.ioPipeline || job.compute?.ioPipeline || null
            };
            if (event.measuredContentLight) {
              job.colorPipeline = {
                ...job.colorPipeline,
                measuredContentLight: event.measuredContentLight,
                dynamicMetadataSchema: event.measuredContentLight.schema,
                dynamicMetadataFrames: event.measuredContentLight.framesMeasured
              };
            }
          }
        } catch { /* Keep malformed or split diagnostics in processorError. */ }
      }
    });

    let progressBuffer = '';
    const progressState = {};
    encoder.stdout.setEncoding('utf8');
    encoder.stdout.on('data', chunk => {
      progressBuffer += chunk;
      const lines = progressBuffer.split(/\r?\n/);
      progressBuffer = lines.pop() || '';
      for (const line of lines) {
        const index = line.indexOf('=');
        if (index <= 0) continue;
        const key = line.slice(0, index);
        const value = line.slice(index + 1);
        if (key === 'frame') progressState.frame = safeNumber(value);
        else if (key === 'fps') progressState.fps = safeNumber(value);
        else if (key === 'out_time_us') progressState.outTimeSeconds = safeNumber(value) / 1e6;
        else if (key === 'speed') progressState.speed = value;
        else if (key === 'progress') {
          updateJobProgress(job, progressState);
          this.notify('progress', job);
        }
      }
    });

    // Every pipe endpoint needs an error listener.  On Windows, a child that
    // exits under memory/device pressure can report UNKNOWN (not only EPIPE)
    // on its stdin; leaving decoder.stdin unobserved terminates the entire
    // Electron/Node process and appears to the user as an app hang/crash.
    for (const stream of [decoder.stdin, decoder.stdout, processor.stdin, processor.stdout, encoder.stdin]) {
      stream.on('error', error => {
        if (error.code !== 'EPIPE' && !job.cancelRequested) {
          launchError ||= error;
          killAll();
        }
      });
    }
    for (const child of children) child.once('error', error => { launchError ||= error; killAll(); });
    decoder.stdout.pipe(processor.stdin);
    processor.stdout.pipe(encoder.stdin);

    if (['npv10', 'npraw'].includes(job.media.kind)) {
      const onRawProgress = rawProgress => {
        updateJobProgress(job, rawProgress);
        this.notify('progress', job);
        if (rawProgress.raw) {
          job.rawDevelopment = { ...job.rawDevelopment, ...rawProgress.raw };
          job.governor?.recordStageLatency('niv99Raw', rawProgress.raw.processingMs);
        }
      };
      const stream = createBackgroundFrameStream(job.source, job.media, {
        develop: Boolean(plan.rawPipeline),
        quality: job.quality,
        onProgress: onRawProgress,
        progressIntervalMs: 125
      });
      job.frameStream = stream;
      stream.on('error', error => { launchError ||= error; killAll(); });
      stream.pipe(decoder.stdin);
    } else {
      decoder.stdin.end();
    }

    const [decoderCode, processorCode, encoderCode] = await Promise.all(closePromises);
    if (niv99EvidenceStream) niv99EvidenceStream.end();
    if (deliveryMetadataStream) deliveryMetadataStream.end();
    const niv99EvidenceError = niv99EvidenceCompletion ? await niv99EvidenceCompletion : null;
    const deliveryMetadataError = deliveryMetadataCompletion ? await deliveryMetadataCompletion : null;
    if (job.cancelRequested) throw new Error('Conversion cancelled');
    const diagnosticTail = (stage, value) => {
      const lines = String(value || '').split(/\r?\n/).filter(Boolean).slice(-24);
      return lines.length ? `[${stage}]\n${lines.join('\n')}` : '';
    };
    const useful = [
      diagnosticTail('decoder', decoderError),
      diagnosticTail('processor', processorError),
      diagnosticTail('encoder', encoderError)
    ].filter(Boolean).join('\n');
    // A failed processor or decoder also terminates the encoder pipe.  Retry
    // with libx265 only when the encoder itself was the first failing stage;
    // otherwise the retry hides the real fault and repeats expensive RAW work.
    if (niv99EvidenceError) throw niv99EvidenceError;
    if (deliveryMetadataError) throw deliveryMetadataError;
    if (decoderCode !== 0 || processorCode !== 0 || encoderCode !== 0) {
      const failure = `CamX enhancement pipeline failed first in ${firstFailedStage || 'an unknown stage'} ` +
        `with codes ${decoderCode}/${processorCode}/${encoderCode}${useful ? `\n${useful}` : ''}`;
      if (encoderCode !== 0 && firstFailedStage === 'encoder' &&
          await this.prepareAutomaticCpuRetry(job, plan, caps, failure)) {
        return this.runEnhancementPipeline(job, plan, caps);
      }
      throw new Error(failure);
    }
    if (launchError) {
      const detail = useful ? `\n${useful}` : '';
      throw new Error(`${launchError.message || launchError}${detail}`);
    }
    if (!fs.existsSync(job.partialPath) || (await fs.promises.stat(job.partialPath)).size === 0) throw new Error('Enhanced conversion produced no output');
    updateJobProgress(job, { frame: job.expectedFrames || job.processedFrames, ratio: 1 });
    this.notify('progress', job);
    if (niv99EvidencePath) {
      const evidenceStat = await fs.promises.stat(niv99EvidencePath);
      if (evidenceStat.size <= 0) throw new Error('NIV99 emitted no frame-quality evidence');
      plan.companionArtifacts.push({
        kind: 'niv99-per-frame-quality-evidence',
        sourcePath: niv99EvidencePath,
        suffix: '_NIV99_Evidence.jsonl'
      });
      job.niv99 = { ...job.niv99, evidenceBytes: evidenceStat.size };
    }
    if (deliveryMetadataPath) {
      const metadataStat = await fs.promises.stat(deliveryMetadataPath);
      const measuredFrames = Number(job.colorPipeline?.measuredContentLight?.framesMeasured || 0);
      if (metadataStat.size <= 0 || measuredFrames <= 0 || deliveryMetadataFrames !== measuredFrames) {
        throw new Error(`Dynamic delivery metadata is incomplete (${deliveryMetadataFrames}/${measuredFrames} frames)`);
      }
      const metadataValidation = await validateDynamicDeliveryMetadataFile(
        deliveryMetadataPath, measuredFrames, deliveryMetadataChain
      );
      plan.companionArtifacts.push({
        kind: 'camx-private-dynamic-delivery-metadata',
        sourcePath: deliveryMetadataPath,
        suffix: plan.profile.family === 'nivukx'
          ? '_NIVUKX_Vision_Metadata.jsonl' : '_NDR10Plus_Metadata.jsonl'
      });
      job.colorPipeline = {
        ...job.colorPipeline,
        dynamicMetadataBytes: metadataStat.size,
        dynamicMetadataComplete: true,
        dynamicMetadataRecordHash: metadataValidation.finalHash,
        dynamicMetadataIntegrity: 'SHA256_HASH_CHAIN_UNSIGNED'
      };
    }
  }
}

module.exports = {
  ConversionQueue, sha256, uniqueOutput, expectedFrameCount, updateJobProgress,
  presentationTimeUsForFrame, runtimeGpuExecutionReport, validateDynamicDeliveryMetadataFile
};
