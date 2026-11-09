'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  encodeNeoLog, decodeNeoLog, ensureNeoLogViewingLut, ensureNeoLogManifest, buildPlan, outputName, PROFILES,
  CONVERSION_CATALOG
} = require('../src/core/conversion-profiles');

const caps = { preferredGpuEncoder: 'hevc_amf' };
const canonicalRuntime = {
  ready: true,
  workerPath: 'D:\\runtime\\camx-ai.exe',
  algorithm: 'CAMX_OFFLINE_MFSR_V2',
  engine: 'NumPy CPU',
  canonicalDelivery: {
    ready: true, toneOperator: 'NDR-TONE-OP-v4',
    calibration: 'NDR-NIVUKX-PY-CAL-v4', engine: 'NDR-NIVUKX-DELIVERY-v1',
    diffuseWhiteNits: 203, peaks: [5000, 10000],
    dynamicMetadata: {
      schema: 'com.neoproc.camx.dynamic-delivery.v1', measuredContentLight: true,
      appearanceAnalysis: 'JZAZBZ_FP64_ANALYSIS',
      tiers: ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']
    }
  }
};
const withCanonicalRuntime = capabilities => ({ ...capabilities, mfsr: canonicalRuntime });
const commandArgs = plan => plan.args || plan.encoderArgs || [];
const media = {
  filePath: 'D:\\clips\\source.mov', kind: 'video', width: 3840, height: 2160, fps: 30,
  raw: false, colorTransfer: 'bt709', audio: true
};

test('all NeoLog v5 curves are bounded and monotonic', () => {
  for (const variant of ['base', 'shadow', 'highlight', 'cinema']) {
    let previous = -1;
    for (let i = 0; i <= 10000; i += 1) {
      const value = encodeNeoLog(i / 10000, variant);
      assert.ok(value >= previous - 1e-9, `${variant} is not monotonic at sample ${i}`);
      assert.ok(value >= 0 && value <= 1, `${variant} left the normalized range`);
      previous = value;
    }
  }
  assert.ok(Math.abs(encodeNeoLog(0.18, 'base') - 0.5) < 0.0002);
  for (const variant of ['base', 'shadow', 'highlight', 'cinema']) {
    for (const sample of [0, 0.01, 0.18, 1]) {
      assert.ok(Math.abs(decodeNeoLog(encodeNeoLog(sample, variant), variant) - sample) < 1e-7);
    }
  }
});

test('NeoLog conversion publishes a standard 33-cube Rec.709 viewing LUT', () => {
  const target = ensureNeoLogViewingLut('base');
  const lines = fs.readFileSync(target, 'utf8').split(/\r?\n/).filter(line => /^\d/.test(line));
  assert.equal(lines.length, 33 ** 3);
  const plan = buildPlan({ profileId: 'neolog-master', quality: 'maximum' }, media,
    { ...caps, encoders: { prores: true } }, 'D:\\out.mov');
  assert.equal(plan.companionArtifacts[0].kind, 'neolog-rec709-viewing-lut');
  assert.equal(plan.companionArtifacts[1].kind, 'neolog-color-identity-manifest');
  const manifest = JSON.parse(fs.readFileSync(ensureNeoLogManifest('base', plan.profile), 'utf8'));
  assert.equal(manifest.variant, 'base');
  assert.equal(manifest.sceneEncoding.primaries, 'ACEScg AP1');
  assert.equal(manifest.containerSignaling.colorPrimaries.startsWith('unspecified'), true);
  assert.equal(manifest.viewingTransform.sha256.length, 64);
  assert.equal(plan.colorPipeline.exactCameraMath, true);
  assert.equal(plan.colorPipeline.logVariant, 'base');
});

test('all quality plans default to maximum available GPU with exact CPU fallback', () => {
  for (const quality of ['maximum', 'production', 'accelerated']) {
    const automatic = buildPlan({ profileId: 'sdr-master', quality }, media, caps, `D:\\${quality}.mov`);
    assert.ok(automatic.args.includes('hevc_amf'), quality);
    assert.equal(automatic.gpu, true, quality);
    assert.equal(automatic.execution.requested, 'gpu-auto', quality);
  }
  const explicitCpu = buildPlan({
    profileId: 'sdr-master', quality: 'maximum', executionMode: 'cpu-master'
  }, media, caps, 'D:\\cpu.mov');
  assert.ok(explicitCpu.args.includes('libx265'));
  assert.equal(explicitCpu.gpu, false);
  const unavailableGpu = buildPlan({ profileId: 'sdr-master', quality: 'maximum' }, media,
    { preferredGpuEncoder: null }, 'D:\\fallback.mov');
  assert.ok(unavailableGpu.args.includes('libx265'));
  assert.equal(unavailableGpu.execution.encode, 'CPU libx265');
});

test('verified Camera AI builds a three-stage high-bit-depth pipeline', () => {
  const aiCaps = {
    ...caps,
    logicalCores: 16,
    ai: {
      ready: true,
      workerPath: 'D:\\runtime\\camx-ai.exe',
      modelPath: 'D:\\runtime\\enhancement_denoise.tflite',
      model: 'CamX Camera Enhancement Denoise',
      modelSha256: '64484177de04aa5d1ba3435ac3920bf366e58ec55ca2b1568f3258f51fd75c1c',
      engine: 'LiteRT CPU'
    }
  };
  const plan = buildPlan({ profileId: 'sdr-master', quality: 'maximum', aiEnhance: true }, media, aiCaps, 'D:\\out.mov');
  assert.equal(plan.operation, 'enhance-ffmpeg');
  assert.equal(plan.ai.enabled, true);
  assert.ok(plan.decoderArgs.includes('rgb48le'));
  assert.ok(plan.encoderArgs.includes('hevc_amf'));
  assert.ok(plan.encoderArgs.includes('p010le'));
  assert.ok(!plan.encoderArgs.includes('-shortest'));
  assert.ok(plan.processorArgs.includes(aiCaps.ai.modelPath));
});

test('validated GPU compute is routed through every rendered enhancement stage without changing RGB48', () => {
  const acceleratedCaps = withCanonicalRuntime({
    ...caps,
    logicalCores: 16,
    compute: {
      ready: true, version: 'CAMX-WGSL-COMPUTE-v1', engine: 'WebGPU/WGSL Vulkan',
      backend: 'Vulkan', adapter: 'Test GPU', maximumCodeDelta: 1,
      kernels: ['MFSR fusion', 'NIV99/OmniClarity', 'AI guidance', 'NDR/NIVUKX delivery'],
      continuum: {
        version: 'NIVUKX-CONTINUUM-v1', deviceResident: true,
        persistentResources: true, batchedMfsrSubmission: true, residentTemporalState: true
      },
      frameGraphs: [{ version: 'NIVUKX-CONTINUUM-v1', submissions: 1, fullFrameReadbacks: 1 }]
    },
    ai: {
      ready: true, accelerated: true, workerPath: 'D:\\runtime\\camx-ai.exe',
      modelPath: 'D:\\runtime\\enhancement_denoise.tflite',
      onnxModelPath: 'D:\\runtime\\enhancement_denoise.onnx',
      model: 'CamX Camera Enhancement Denoise', modelSha256: 'camera-model',
      engine: 'ONNX Runtime DirectML'
    }
  });
  const plan = buildPlan({
    profileId: 'ndr10-pq-prores4444xq', quality: 'maximum', executionMode: 'cpu-master',
    aiEnhance: true, mfsrEnhance: true
  }, media, { ...acceleratedCaps, encoders: { prores: true } }, 'D:\\gpu-compute.mov');
  assert.equal(plan.operation, 'enhance-ffmpeg');
  assert.equal(plan.compute.ready, true);
  assert.equal(plan.compute.continuum.version, 'NIVUKX-CONTINUUM-v1');
  assert.match(plan.engine, /NIVUKX-CONTINUUM-v1/);
  assert.equal(plan.gpu, true);
  assert.deepEqual(plan.processorArgs.slice(plan.processorArgs.indexOf('--compute-backend'),
    plan.processorArgs.indexOf('--compute-backend') + 2), ['--compute-backend', 'gpu']);
  assert.ok(plan.processorArgs.includes('--onnx-model'));
  assert.ok(plan.decoderArgs.includes('rgb48le'));
  assert.ok(plan.encoderArgs.includes('yuv444p12le'));
  assert.match(plan.execution.enhancements, /WebGPU\/WGSL Vulkan MFSR RGB48/);
  assert.match(plan.execution.enhancements, /ONNX Runtime DirectML/);
});

test('full-sensor processing uses a single bounded I/O frame on an 8 GiB system', () => {
  const lowMemoryCaps = withCanonicalRuntime({
    ...caps,
    logicalCores: 8,
    memoryBytes: 8 * 1024 ** 3,
    compute: { ready: true, engine: 'WebGPU/WGSL Vulkan', backend: 'Vulkan' },
    ai: { ready: false }
  });
  const raw = {
    ...media, filePath: 'D:\\clips\\source.npraw', kind: 'npraw', raw: true,
    width: 4096, height: 3072, pixelFormat: 'bayer_bggr16le'
  };
  const plan = buildPlan({
    profileId: 'ndr10-pq-hevc420', quality: 'maximum', mfsrEnhance: true
  }, raw, lowMemoryCaps, 'D:\\bounded.mov');
  const option = plan.processorArgs.indexOf('--io-memory-mib');
  assert.ok(option >= 0);
  assert.equal(plan.processorArgs[option + 1], '144');
  assert.deepEqual(plan.decoderArgs.slice(plan.decoderArgs.indexOf('-filter_threads'),
    plan.decoderArgs.indexOf('-filter_threads') + 2), ['-filter_threads', '1']);
  assert.deepEqual(plan.decoderArgs.slice(plan.decoderArgs.indexOf('-filter_buffered_frames'),
    plan.decoderArgs.indexOf('-filter_buffered_frames') + 2), ['-filter_buffered_frames', '2']);
});

test('offline MFSR is available for every rendered-video delivery and bypasses identity RAW outputs', () => {
  const mfsrCaps = {
    ...caps,
    logicalCores: 16,
    encoders: { prores: true, r210: true, v210: true },
    mfsr: canonicalRuntime
  };
  for (const profileId of [
    'sdr-master', 'display-p3-master', 'bt2020-sdr-master', 'ndr10-master',
    'nivukx-master', 'hevc422-master', 'neolog-master',
    'prores-422-hq', 'prores-4444', 'prores-archive', 'rgb10-archive', 'v210-archive'
  ]) {
    const plan = buildPlan({ profileId, quality: 'production', mfsrEnhance: true }, media, mfsrCaps, 'D:\\out.mov');
    assert.equal(plan.operation, 'enhance-ffmpeg', profileId);
    assert.equal(plan.mfsr.enabled, true, profileId);
    assert.ok(plan.processorArgs.includes('--mfsr'), profileId);
    assert.ok(plan.decoderArgs.includes('rgb48le'), profileId);
  }
  const raw = { ...media, kind: 'npraw', raw: true, pixelFormat: 'bayer_rggb16le' };
  const dng = buildPlan({ profileId: 'cinemadng-sequence', quality: 'maximum', mfsrEnhance: true }, raw, mfsrCaps, 'D:\\sequence');
  const preserve = buildPlan({ profileId: 'raw-preserve', quality: 'maximum', mfsrEnhance: true }, raw, mfsrCaps, 'D:\\raw.npraw');
  assert.equal(dng.operation, 'cinemadng');
  assert.equal(preserve.operation, 'copy');
});

test('Continuum routes SDR, RAW Log and RAW NDR while RAW identity remains untouched', () => {
  const continuumCaps = withCanonicalRuntime({
    ...caps,
    logicalCores: 16,
    encoders: { libx265: true, prores: true, r210: true, v210: true },
    compute: {
      ready: true, version: 'CAMX-WGSL-COMPUTE-v1', engine: 'WebGPU/WGSL Vulkan',
      backend: 'Vulkan', adapter: 'Test GPU', maximumCodeDelta: 1,
      kernels: ['MFSR motion registration', 'MFSR fusion', 'NIV99/OmniClarity',
        'AI guidance', 'NDR/NIVUKX delivery'],
      continuum: {
        version: 'NIVUKX-CONTINUUM-v1', deviceResident: true,
        persistentResources: true, batchedMfsrSubmission: true, residentTemporalState: true
      },
      frameGraphs: [{ version: 'NIVUKX-CONTINUUM-v1', submissions: 1, fullFrameReadbacks: 1 }]
    },
    ai: { ready: false }
  });
  const raw = { ...media, filePath: 'D:\\clips\\source.npraw', kind: 'npraw', raw: true,
    pixelFormat: 'bayer_rggb16le' };
  const rendered = [
    buildPlan({ profileId: 'rec709-sdr-hevc420', quality: 'maximum', mfsrEnhance: true }, media,
      continuumCaps, 'D:\\sdr.mov'),
    buildPlan({ profileId: 'neolog-prores4444xq', quality: 'maximum', mfsrEnhance: true }, raw,
      continuumCaps, 'D:\\log.mov'),
    buildPlan({ profileId: 'ndr10-pq-hevc420', quality: 'maximum', mfsrEnhance: true }, raw,
      continuumCaps, 'D:\\ndr.mov')
  ];
  for (const plan of rendered) {
    assert.equal(plan.operation, 'enhance-ffmpeg');
    assert.equal(plan.compute.continuum.version, 'NIVUKX-CONTINUUM-v1');
    assert.ok(plan.processorArgs.includes('--compute-backend'));
    assert.ok(plan.processorArgs.includes('--mfsr'));
  }
  assert.equal(rendered[0].rawPipeline, null);
  assert.ok(rendered[1].rawPipeline);
  assert.ok(rendered[2].rawPipeline);
  assert.equal(rendered[2].colorPipeline.exactCameraMath, true);

  const preserve = buildPlan({ profileId: 'raw-preserve', quality: 'maximum' }, raw,
    continuumCaps, 'D:\\source.npraw');
  const cinemaDng = buildPlan({ profileId: 'cinemadng-sequence', quality: 'maximum' }, raw,
    continuumCaps, 'D:\\sequence');
  assert.equal(preserve.operation, 'copy');
  assert.equal(cinemaDng.operation, 'cinemadng');
  assert.equal(preserve.execution.enhancements, 'bypassed');
  assert.equal(cinemaDng.execution.enhancements, 'bypassed');
});

test('GPU-auto preserves the complete conversion on CPU when acceleration is unavailable', () => {
  const fallbackCaps = withCanonicalRuntime({
    preferredGpuEncoder: null,
    logicalCores: 8,
    memoryBytes: 8 * 1024 ** 3,
    encoders: { libx265: true, prores: true, r210: true, v210: true },
    compute: { ready: false, engine: 'CPU reference fallback', backend: 'CPU', error: 'No compatible adapter' },
    ai: { ready: false }
  });
  const plan = buildPlan({
    profileId: 'ndr10-pq-hevc420', quality: 'maximum', mfsrEnhance: true,
    aiEnhance: false, executionMode: 'gpu-auto'
  }, media, fallbackCaps, 'D:\\fallback.mov');
  assert.equal(plan.operation, 'enhance-ffmpeg');
  assert.deepEqual(plan.processorArgs.slice(plan.processorArgs.indexOf('--compute-backend'),
    plan.processorArgs.indexOf('--compute-backend') + 2), ['--compute-backend', 'cpu']);
  assert.ok(plan.encoderArgs.includes('libx265'));
  assert.equal(plan.execution.requested, 'gpu-auto');
  assert.equal(plan.execution.encode, 'CPU libx265');
  assert.equal(plan.gpu, false);
});

test('wide-gamut, proprietary PQ and high-end ProRes profiles carry distinct strict contracts', () => {
  const encoderCaps = { ...caps, encoders: { prores: true, r210: true, v210: true } };
  const p3 = buildPlan({ profileId: 'display-p3-master', quality: 'maximum' }, media, encoderCaps, 'D:\\p3.mov');
  const ndr10 = buildPlan({ profileId: 'ndr10-master', quality: 'maximum' }, media, withCanonicalRuntime(encoderCaps), 'D:\\ndr10.mov');
  const nivukx = buildPlan({ profileId: 'nivukx-master', quality: 'maximum' }, media, withCanonicalRuntime(encoderCaps), 'D:\\nivukx.mov');
  const prores422 = buildPlan({ profileId: 'prores-422-hq', quality: 'maximum' }, media, encoderCaps, 'D:\\422.mov');
  const prores4444 = buildPlan({ profileId: 'prores-4444', quality: 'maximum' }, media, encoderCaps, 'D:\\4444.mov');
  assert.ok(p3.args.includes('smpte432'));
  assert.ok(commandArgs(ndr10).includes('smpte2084'));
  assert.ok(commandArgs(nivukx).includes('smpte2084'));
  for (const [plan, peak] of [[ndr10, 5000], [nivukx, 10000]]) {
    const args = commandArgs(plan);
    const mastering = args.indexOf('-mastering_display:v:0');
    const contentLight = args.indexOf('-content_light:v:0');
    assert.ok(mastering >= 0 && mastering < args.indexOf('-i'));
    assert.match(args[mastering + 1], new RegExp(`L\\(${peak * 10000},1\\)`));
    assert.deepEqual(args.slice(contentLight, contentLight + 2),
      ['-content_light:v:0', `${peak},${Math.round(peak * 0.4)}`]);
  }
  assert.equal(prores422.args[prores422.args.indexOf('-profile:v') + 1], '3');
  assert.ok(prores422.args.includes('yuv422p10le'));
  assert.equal(prores4444.args[prores4444.args.indexOf('-profile:v') + 1], '4');
  assert.ok(prores4444.args.includes('yuv444p12le'));
});

test('ProRes profiles fail early when the bundled encoder is unavailable', () => {
  assert.throws(
    () => buildPlan({ profileId: 'prores-archive', quality: 'maximum' }, media, { ...caps, encoders: { prores: false } }, 'D:\\out.mov'),
    /does not provide ProRes/
  );
});

test('every delivery profile creates a deterministic safe file name', () => {
  for (const id of Object.keys(PROFILES)) {
    const name = outputName('D:\\camera\\Clip 01.npv10', id);
    assert.equal(path.basename(name), name);
    assert.ok(!name.includes(' '));
  }
  assert.match(outputName('D:\\camera\\Clip 01.npv10', 'neolog-ffv1rgb16', { logVariant: 'highlight' }),
    /NEOLOG_FFV1RGB16_HIGHLIGHT\.mov$/);
});

test('uncompressed and CinemaDNG profiles select honest output contracts', () => {
  const encoders = { r210: true, v210: true };
  const rgb = buildPlan({ profileId: 'rgb10-archive', quality: 'maximum' }, media, { ...caps, encoders }, 'D:\\rgb.mov');
  const yuv = buildPlan({ profileId: 'v210-archive', quality: 'maximum' }, media, { ...caps, encoders }, 'D:\\yuv.mov');
  assert.ok(rgb.args.includes('r210'));
  assert.ok(yuv.args.includes('v210'));
  const raw = { ...media, kind: 'npraw', raw: true, pixelFormat: 'bayer_rggb16le' };
  const dng = buildPlan({ profileId: 'cinemadng-sequence', quality: 'maximum' }, raw, caps, 'D:\\sequence');
  assert.equal(dng.operation, 'cinemadng');
  assert.equal(dng.profile.directory, true);
});

test('sensor-timed conversion preserves a microsecond encoder time base', () => {
  const sensorMedia = { ...media, kind: 'npraw', raw: true, timestamps: [1_000_000_000, 1_041_667_000] };
  const sensorCaps = {
    ...caps,
    mfsr: {
      ready: true, workerPath: 'D:\\camx-ai.exe', engine: 'NumPy CPU',
      algorithm: 'CAMX_OFFLINE_MFSR_V2'
    }
  };
  const plan = buildPlan(
    { profileId: 'sdr-master', quality: 'production', mfsrEnhance: true, aiEnhance: false },
    sensorMedia, sensorCaps, 'D:\\timed.mov'
  );
  const option = plan.encoderArgs.indexOf('-enc_time_base:v');
  assert.ok(option >= 0);
  assert.equal(plan.encoderArgs[option + 1], '1:1000000');
  assert.ok(plan.encoderArgs.includes('-fps_mode:v'));
});

test('the public workflow exposes only requested deliveries and lossless transport contracts', () => {
  const encoderCaps = {
    preferredGpuEncoder: 'hevc_nvenc', logicalCores: 16,
    encoders: { libx265: true, prores: true, ffv1: true, r210: true, v210: true }
  };
  assert.equal(CONVERSION_CATALOG.deliveries.length, 4);
  assert.deepEqual(CONVERSION_CATALOG.deliveries.map(item => item.id), [
    'rec709-sdr', 'ndr10-pq', 'nivukx-pq', 'neolog'
  ]);
  assert.equal(PROFILES['bt2100-hlg-hevc420'], undefined);
  assert.equal(PROFILES['hdr10-pq-hevc420'], undefined);
  assert.equal(PROFILES['hlg-master'], undefined);
  assert.equal(PROFILES['hdr10-master'], undefined);
  assert.deepEqual(CONVERSION_CATALOG.transports.map(item => item.id), [
    'ffv1rgb16', 'r210', 'v210', 'lossless420'
  ]);
  for (const delivery of CONVERSION_CATALOG.deliveries) {
    const profiles = CONVERSION_CATALOG.transports.map(transport =>
      PROFILES[`${delivery.id}-${transport.id}`]);
    assert.equal(profiles.filter(Boolean).length, 4, delivery.id);
    assert.deepEqual(new Set(profiles.map(profile => profile.chroma)), new Set(['444', '422', '420']));
    for (const profile of profiles) {
      assert.equal(profile.codecLossless, true, profile.id);
      const runtimeCaps = ['ndr', 'nivukx'].includes(profile.family)
        ? withCanonicalRuntime(encoderCaps) : encoderCaps;
      const plan = buildPlan({
        profileId: profile.id, quality: 'maximum', executionMode: 'cpu-master',
        aiEnhance: false, mfsrEnhance: false
      }, media, runtimeCaps, `D:\\${profile.id}.mov`);
      assert.equal(plan.profile.outputMode, profile.outputMode);
      assert.equal(plan.gpu, false);
    }
  }
});

test('lossless 4:2:0 uses only a hash-proven GPU encoder and otherwise keeps FFV1', () => {
  const baseCaps = {
    preferredGpuEncoder: 'hevc_amf', preferredLosslessGpuEncoder: null, logicalCores: 16,
    encoders: { libx265: true, ffv1: true, r210: true, v210: true }
  };
  const cpu = buildPlan({
    profileId: 'rec709-sdr-lossless420', quality: 'maximum', executionMode: 'gpu-auto',
    aiEnhance: false, mfsrEnhance: false
  }, media, baseCaps, 'D:\\lossless.mov');
  assert.ok(commandArgs(cpu).includes('ffv1'));
  assert.equal(cpu.losslessContract.codecLossless, true);
  assert.equal(cpu.losslessContract.chromaPreserving, false);
  assert.equal(cpu.losslessContract.gpuEncodingRuntimeProven, false);

  const gpuCaps = {
    ...baseCaps, preferredLosslessGpuEncoder: 'hevc_nvenc',
    losslessGpuEncoding: { ready: true, encoder: 'hevc_nvenc', proof: 'decoded-frame-sha256-equality' }
  };
  const gpu = buildPlan({
    profileId: 'rec709-sdr-lossless420', quality: 'maximum', executionMode: 'gpu-auto',
    aiEnhance: false, mfsrEnhance: false
  }, media, gpuCaps, 'D:\\lossless-gpu.mov');
  assert.ok(commandArgs(gpu).includes('hevc_nvenc'));
  assert.ok(commandArgs(gpu).includes('lossless'));
  assert.equal(gpu.losslessContract.gpuEncodingRuntimeProven, true);
  assert.throws(() => buildPlan({
    profileId: 'rec709-sdr-lossless420', quality: 'maximum', executionMode: 'gpu-encode',
    aiEnhance: false, mfsrEnhance: false
  }, media, baseCaps, 'D:\\strict.mov'), /pixel round-trip self-test/);
});

test('16-bit RGB FFV1 is pixel-lossless and keeps full chroma', () => {
  const plan = buildPlan({
    profileId: 'rec709-sdr-ffv1rgb16', quality: 'maximum',
    aiEnhance: false, mfsrEnhance: false
  }, media, { logicalCores: 12, encoders: { ffv1: true } }, 'D:\\rgb16.mov');
  assert.ok(commandArgs(plan).includes('ffv1'));
  assert.ok(commandArgs(plan).includes('gbrp16le'));
  assert.equal(plan.profile.resolvedEncoder, 'ffv1');
  assert.equal(plan.losslessContract.codecLossless, true);
  assert.equal(plan.losslessContract.chromaPreserving, true);
});

test('strict GPU encoding is fail-closed and never changes the selected chroma', () => {
  const gpuCaps = {
    preferredGpuEncoder: 'hevc_nvenc', logicalCores: 16,
    encoders: { libx265: true, prores: true, r210: true, v210: true }
  };
  const gpu = buildPlan({
    profileId: 'ndr10-pq-hevc420', quality: 'maximum', executionMode: 'gpu-encode',
    aiEnhance: false, mfsrEnhance: false
  }, media, withCanonicalRuntime(gpuCaps), 'D:\\gpu.mov');
  assert.equal(gpu.gpu, true);
  assert.ok(commandArgs(gpu).includes('hevc_nvenc'));
  assert.ok(commandArgs(gpu).includes('p010le'));
  assert.throws(() => buildPlan({
    profileId: 'ndr10-pq-hevc422', quality: 'maximum', executionMode: 'gpu-encode',
    aiEnhance: false, mfsrEnhance: false
  }, media, withCanonicalRuntime(gpuCaps), 'D:\\invalid.mov'), /only HEVC Main10 4:2:0/);
  assert.throws(() => buildPlan({
    profileId: 'ndr10-pq-hevc420', quality: 'maximum', executionMode: 'gpu-encode',
    aiEnhance: false, mfsrEnhance: false
  }, media, withCanonicalRuntime({ ...gpuCaps, preferredGpuEncoder: null }), 'D:\\invalid.mov'), /no tested HEVC Main10 hardware encoder/);
  const cpu = buildPlan({
    profileId: 'ndr10-pq-hevc420', quality: 'accelerated', executionMode: 'cpu-master',
    aiEnhance: false, mfsrEnhance: false
  }, media, withCanonicalRuntime(gpuCaps), 'D:\\cpu.mov');
  assert.equal(cpu.gpu, false);
  assert.ok(commandArgs(cpu).includes('libx265'));
});

test('HEVC codec tags are not attached to ProRes and uncompressed masters', () => {
  const encoderCaps = {
    preferredGpuEncoder: null, logicalCores: 16,
    encoders: { libx265: true, prores: true, r210: true, v210: true }
  };
  const runtimeCaps = withCanonicalRuntime(encoderCaps);
  const hevc = buildPlan({ profileId: 'ndr10-pq-hevc420', quality: 'maximum', aiEnhance: false, mfsrEnhance: false }, media, runtimeCaps, 'D:\\hevc.mov');
  const prores = buildPlan({ profileId: 'ndr10-pq-prores4444xq', quality: 'maximum', aiEnhance: false, mfsrEnhance: false }, media, runtimeCaps, 'D:\\prores.mov');
  const r210 = buildPlan({ profileId: 'ndr10-pq-r210', quality: 'maximum', aiEnhance: false, mfsrEnhance: false }, media, runtimeCaps, 'D:\\r210.mov');
  assert.ok(commandArgs(hevc).includes('hvc1'));
  assert.ok(!commandArgs(prores).includes('hvc1'));
  assert.ok(!commandArgs(r210).includes('hvc1'));
});
