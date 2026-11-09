'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const pythonPath = path.join(root, '.ai-dev');
const environment = {
  ...process.env,
  PYTHONPATH: [path.join(root, 'scripts'), pythonPath, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter)
};

function workerJson(args, timeout = 120000) {
  const result = spawnSync('python', [path.join(root, 'scripts', 'ai_worker.py'), ...args], {
    cwd: root, env: environment, encoding: 'utf8', timeout
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split(/\r?\n/).filter(Boolean).pop());
}

test('cross-vendor GPU kernels compile and remain within one RGB48 code value', t => {
  const result = workerJson(['--inspect-acceleration']);
  if (!result.ready) {
    t.skip(`No hardware compute adapter: ${result.error}`);
    return;
  }
  assert.equal(result.version, 'CAMX-WGSL-COMPUTE-v1');
  assert.ok(['Vulkan', 'Dx12', 'Metal'].includes(result.backend), result.backend);
  assert.ok(result.adapter);
  assert.ok(result.maximumCodeDelta <= 1);
  assert.equal(result.continuum.version, 'NIVUKX-CONTINUUM-v1');
  assert.equal(result.continuum.deviceResident, true);
  assert.equal(result.continuum.persistentResources, true);
  assert.equal(result.continuum.batchedMfsrSubmission, true);
  assert.equal(result.continuum.residentTemporalState, true);
  assert.equal(result.continuum.packedRgb48TemporalRing, true);
  assert.equal(result.continuum.lastMfsrGraph.submissions, 1);
  assert.equal(result.continuum.lastMfsrGraph.fullFrameReadbacks, 1);
  assert.equal(result.continuum.lastMfsrGraph.statisticsReadbackBytes, 4);
  assert.equal(result.continuum.lastMfsrGraph.motionRegistrationResident, true);
  assert.ok(result.kernelDeltas.continuumGraph <= 1);
  assert.equal(result.motionParity.maximumVectorDelta, 0);
  assert.ok(result.motionParity.maximumConfidenceDelta <= 1e-4);
  assert.equal(result.resourceReuse.ready, true);
  assert.equal(result.resourceReuse.steadyStateAllocations, 0);
  assert.ok(result.frameGraphs.some(graph => graph.version === 'NIVUKX-CONTINUUM-v1' &&
    graph.submissions === 1 && graph.fullFrameReadbacks === 1));
  assert.deepEqual(new Set(result.kernels), new Set([
    'MFSR motion registration', 'MFSR fusion', 'NIV99/OmniClarity',
    'AI guidance', 'NDR/NIVUKX delivery'
  ]));
});

test('DirectML graph preserves the camera LiteRT model within the strict parity budget', t => {
  if (process.platform !== 'win32') {
    t.skip('DirectML is a Windows backend');
    return;
  }
  const result = workerJson([
    '--inspect',
    '--model', path.join(root, 'vendor', 'ai', 'models', 'enhancement_denoise.tflite'),
    '--onnx-model', path.join(root, 'vendor', 'ai', 'models', 'enhancement_denoise.onnx'),
    '--threads', '4'
  ]);
  assert.equal(result.ready, true);
  assert.equal(result.accelerated, true);
  assert.equal(result.engine, 'ONNX Runtime DirectML');
  assert.ok(result.parity.maximumError <= 2e-5);
  assert.ok(result.parity.meanError <= 2e-6);
});
