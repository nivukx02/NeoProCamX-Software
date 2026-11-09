'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ConversionQueue } = require('../src/core/conversion-queue');
const { buildPlan } = require('../src/core/conversion-profiles');

const media = Object.freeze({
  filePath: 'D:\\clips\\CAMX_SOURCE.mov', name: 'CAMX_SOURCE.mov', supported: true,
  kind: 'container', raw: false, width: 1920, height: 1080, fps: 30,
  duration: 10, colorTransfer: 'bt709', audio: false
});

function capabilities(preferredGpuEncoder) {
  return {
    ready: true,
    preferredGpuEncoder,
    logicalCores: 8,
    memoryBytes: 16 * 1024 ** 3,
    encoders: { libx265: true, prores: true, ffv1: true, r210: true, v210: true }
  };
}

test('conversion queue defaults every rendered job to GPU-auto policy', async t => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'camx-gpu-auto-'));
  t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));
  const service = { detect: async () => capabilities('hevc_amf') };
  const queue = new ConversionQueue(service, { probe: async () => media }, () => {});
  queue.pump = () => {};
  const [job] = await queue.enqueue({
    inputs: [media], outputDirectory, profileId: 'rec709-sdr-ffv1rgb16', quality: 'maximum',
    aiEnhance: false, mfsrEnhance: false
  });
  assert.equal(job.executionMode, 'gpu-auto');
});

test('GPU-auto remains valid when no hardware encoder exists so CPU can take over', async t => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'camx-cpu-fallback-'));
  t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));
  const service = { detect: async () => capabilities(null) };
  const queue = new ConversionQueue(service, { probe: async () => media }, () => {});
  queue.pump = () => {};
  const [job] = await queue.enqueue({
    inputs: [media], outputDirectory, profileId: 'rec709-sdr-ffv1rgb16', quality: 'maximum',
    aiEnhance: false, mfsrEnhance: false
  });
  assert.equal(job.executionMode, 'gpu-auto');
});

test('queue enforces SDR-to-SDR and keeps legacy lossy profiles out of the public workflow', async t => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'camx-route-gate-'));
  t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));
  const queue = new ConversionQueue({ detect: async () => capabilities(null) }, { probe: async () => media }, () => {});
  queue.pump = () => {};
  await assert.rejects(queue.enqueue({
    inputs: [media], outputDirectory, profileId: 'ndr10-pq-ffv1rgb16', quality: 'maximum'
  }), /SDR sources can only use the SDR to SDR/);
  await assert.rejects(queue.enqueue({
    inputs: [media], outputDirectory, profileId: 'sdr-master', quality: 'maximum'
  }), /legacy profile is not available/);
});

test('GPU-auto retries a failed hardware encoder once without changing the quality contract', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'camx-encoder-retry-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const partialPath = path.join(directory, 'output.partial.mov');
  const evidencePath = `${partialPath}.niv99-evidence.jsonl`;
  const cachePath = `${partialPath}.quality.nqis`;
  const caps = {
    ...capabilities('hevc_amf'),
    memoryBytes: 16 * 1024 ** 3,
    mfsr: {
      ready: true, workerPath: 'D:\\runtime\\camx-ai.exe',
      engine: 'WebGPU/WGSL', algorithm: 'CAMX_OFFLINE_MFSR_V2'
    },
    compute: {
      ready: true, version: 'CAMX-WGSL-COMPUTE-v1', engine: 'WebGPU/WGSL Vulkan',
      backend: 'Vulkan', adapter: 'Test GPU', maximumCodeDelta: 1, kernels: ['mfsr']
    },
    ai: { ready: false }
  };
  const job = {
    profileId: 'sdr-master', quality: 'maximum', executionMode: 'gpu-auto',
    aiEnhance: false, mfsrEnhance: true, media, partialPath,
    qualityInstructionCache: { writePath: cachePath }
  };
  const plan = buildPlan(job, media, caps, partialPath);
  const fingerprint = '{"source":"unchanged"}';
  plan.processorArgs.push(
    '--quality-cache-write', cachePath,
    '--quality-cache-fingerprint', fingerprint,
    '--quality-cache-frames', '300'
  );
  for (const artifact of [partialPath, evidencePath, cachePath]) fs.writeFileSync(artifact, 'incomplete');

  const events = [];
  const queue = new ConversionQueue({ detect: async () => caps }, { probe: async () => media }, event => events.push(event));
  const retried = await queue.prepareAutomaticCpuRetry(
    job, plan, caps,
    'encoder failed\nhevc_amf encoder->Init() failed with error 5'
  );

  assert.equal(retried, true);
  assert.ok(plan.encoderArgs.includes('libx265'));
  assert.ok(!plan.encoderArgs.includes('hevc_amf'));
  assert.equal(plan.execution.requested, 'gpu-auto');
  assert.equal(plan.execution.encode, 'CPU libx265');
  assert.equal(plan.execution.automaticEncoderFallback.from, 'GPU hevc_amf');
  assert.equal(plan.execution.automaticEncoderFallback.to, 'CPU libx265');
  assert.equal(plan.execution.automaticEncoderFallback.qualityContractPreserved, true);
  assert.equal(plan.gpu, true, 'validated GPU image processing remains enabled');
  assert.deepEqual(plan.processorArgs.slice(plan.processorArgs.indexOf('--quality-cache-write')), [
    '--quality-cache-write', cachePath,
    '--quality-cache-fingerprint', fingerprint,
    '--quality-cache-frames', '300'
  ]);
  assert.equal(fs.existsSync(partialPath), false);
  assert.equal(fs.existsSync(evidencePath), false);
  assert.equal(fs.existsSync(cachePath), false);
  assert.equal(job.progress, 0.04);
  assert.match(job.progressStage, /restarting with exact CPU encoder/);
  assert.equal(events.at(-1).job._gpuEncoderRetryAttempted, undefined);
  assert.equal(await queue.prepareAutomaticCpuRetry(job, plan, caps, 'second failure'), false);
});
