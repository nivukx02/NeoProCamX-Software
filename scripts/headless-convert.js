#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CapabilityService } = require('../src/core/capabilities');
const { MediaProbe } = require('../src/core/media-probe');
const { ConversionQueue } = require('../src/core/conversion-queue');
const { PROFILES } = require('../src/core/conversion-profiles');

function argumentsFrom(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) continue;
    const value = argv[index + 1];
    if (value && !value.startsWith('--')) {
      parsed[key.slice(2)] = value;
      index += 1;
    } else parsed[key.slice(2)] = true;
  }
  return parsed;
}

function event(name, payload = {}) {
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), event: name, ...payload })}\n`);
}

function jobSummary(job) {
  return {
    id: job.id,
    state: job.state,
    stage: job.progressStage,
    progress: job.progress,
    processedFrames: job.processedFrames,
    expectedFrames: job.expectedFrames,
    processingFps: job.processingFps,
    elapsedSeconds: job.elapsedSeconds,
    etaSeconds: job.etaSeconds,
    speed: job.speed,
    gpu: job.gpu,
    engine: job.engine,
    execution: job.execution,
    losslessContract: job.losslessContract,
    compute: job.compute,
    error: job.error,
    outputPath: job.outputPath,
    bytesWritten: job.bytesWritten,
    validation: job.validation
  };
}

async function main() {
  const args = argumentsFrom(process.argv.slice(2));
  const input = path.resolve(args.input || process.env.CAMX_HEADLESS_INPUT || '');
  const outputDirectory = path.resolve(args.output || process.env.CAMX_HEADLESS_OUTPUT || '');
  const profileId = args.profile || process.env.CAMX_HEADLESS_PROFILE || 'ndr10-pq-ffv1rgb16';
  const quality = args.quality || process.env.CAMX_HEADLESS_QUALITY || 'maximum';
  const executionMode = args.execution || process.env.CAMX_HEADLESS_EXECUTION || 'gpu-auto';
  if (!input || !fs.existsSync(input)) throw new Error(`Input does not exist: ${input || '(empty)'}`);
  if (!outputDirectory) throw new Error('Output directory is required');
  if (!PROFILES[profileId]) throw new Error(`Unknown profile: ${profileId}`);

  const cacheDirectory = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'camx-studio');
  const capabilityService = new CapabilityService({ cacheDirectory });
  const mediaProbe = new MediaProbe(capabilityService);
  const capabilities = await capabilityService.detect();
  event('capabilities', {
    cpuModel: capabilities.cpuModel,
    logicalCores: capabilities.logicalCores,
    gpu: capabilities.gpu,
    compute: capabilities.compute,
    ai: capabilities.ai,
    mfsr: capabilities.mfsr,
    preferredGpuEncoder: capabilities.preferredGpuEncoder,
    preferredLosslessGpuEncoder: capabilities.preferredLosslessGpuEncoder,
    losslessGpuEncoding: capabilities.losslessGpuEncoding,
    encoderRuntime: capabilities.encoderRuntime
  });
  const media = await mediaProbe.probe(input);
  event('source', {
    input,
    bytes: media.size,
    kind: media.kind,
    width: media.width,
    height: media.height,
    fps: media.fps,
    duration: media.duration,
    frames: media.frames,
    bitDepth: media.bitDepth,
    pixelFormat: media.pixelFormat,
    recovered: media.recovered,
    warnings: media.warnings
  });

  let finish;
  let fail;
  const terminal = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  let lastProgressAt = 0;
  let lastStage = null;
  const queue = new ConversionQueue(capabilityService, mediaProbe, message => {
    const job = message?.job;
    if (!job) return;
    const terminalState = ['complete', 'failed', 'cancelled'].includes(job.state);
    const now = Date.now();
    if (terminalState || job.progressStage !== lastStage || now - lastProgressAt >= 5000) {
      event('job', { updateType: message.type, job: jobSummary(job) });
      lastProgressAt = now;
      lastStage = job.progressStage;
    }
    if (job.state === 'complete') finish(job);
    else if (job.state === 'failed' || job.state === 'cancelled') fail(new Error(job.error || `Conversion ${job.state}`));
  });

  const stop = signal => {
    event('signal', { signal });
    queue.shutdown();
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));

  const created = await queue.enqueue({
    inputs: [media],
    outputDirectory,
    profileId,
    quality,
    executionMode,
    aiEnhance: true,
    mfsrEnhance: true,
    logVariant: 'base'
  });
  event('queued', { profile: PROFILES[profileId], job: created[0] });
  const completed = await terminal;
  event('complete', { job: jobSummary(completed), receiptPath: `${completed.outputPath}.json` });
}

main().catch(error => {
  event('fatal', { message: error.message, stack: error.stack });
  process.exitCode = 1;
});
