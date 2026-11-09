'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { deliverPqCodes } = require('../src/core/camera-color-pipeline');

const root = path.resolve(__dirname, '..');

function makeFrame(width, height, shiftX, noiseSeed) {
  const frame = Buffer.alloc(width * height * 3 * 2);
  let seed = noiseSeed >>> 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.max(0, Math.min(width - 1, x - shiftX));
      const texture = ((sourceX * 977 + y * 619 + ((sourceX ^ y) & 7) * 1703) % 42000) + 9000;
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const noise = ((seed >>> 24) - 128) * 2;
      const values = [texture + noise, texture * 0.82 + noise, texture * 0.63 + noise];
      const pixel = (y * width + x) * 6;
      for (let channel = 0; channel < 3; channel += 1) {
        frame.writeUInt16LE(Math.max(0, Math.min(65535, Math.round(values[channel]))), pixel + channel * 2);
      }
    }
  }
  return frame;
}

test('offline MFSR preserves cadence, warms up safely, and fuses registered RGB48 frames', () => {
  const width = 48;
  const height = 32;
  const frames = [
    makeFrame(width, height, 0, 1),
    makeFrame(width, height, 1, 2),
    makeFrame(width, height, -1, 3),
    makeFrame(width, height, 0, 4),
    makeFrame(width, height, 1, 5)
  ];
  const pythonPath = path.join(root, '.ai-dev');
  const result = spawnSync('python', [
    path.join(root, 'scripts', 'ai_worker.py'), '--no-ai', '--mfsr',
    '--width', String(width), '--height', String(height), '--mfsr-frames', '3',
    '--mfsr-strength', '0.6', '--mfsr-scene-threshold', '0.25', '--mfsr-memory-mib', '128'
  ], {
    cwd: root,
    env: { ...process.env, PYTHONPATH: [pythonPath, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) },
    input: Buffer.concat(frames),
    encoding: null,
    maxBuffer: 32 * 1024 * 1024
  });
  assert.equal(result.status, 0, result.stderr.toString('utf8'));
  assert.equal(result.stdout.length, Buffer.concat(frames).length);
  assert.deepEqual(result.stdout.subarray(0, frames[0].length), frames[0]);
  assert.match(result.stderr.toString('utf8'), /"event":"mfsr"/);
  assert.match(result.stderr.toString('utf8'), /"fused":true/);
  const finalOutput = result.stdout.subarray(frames[0].length * 4);
  assert.notDeepEqual(finalOutput, frames[4]);
});

test('NIV99 applies bounded full-frame detail processing without changing cadence or geometry', () => {
  const width = 32;
  const height = 24;
  const frame = makeFrame(width, height, 0, 91);
  const pythonPath = path.join(root, '.ai-dev');
  const result = spawnSync('python', [
    path.join(root, 'scripts', 'ai_worker.py'), '--no-ai', '--niv99', '--riven',
    '--width', String(width), '--height', String(height), '--detail-profile', 'EXTREME_DETAIL',
    '--signal-family', 'SDR', '--quality', 'maximum', '--wb-authority', 'MANUAL'
  ], {
    cwd: root,
    env: { ...process.env, PYTHONPATH: [pythonPath, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) },
    input: frame,
    encoding: null,
    maxBuffer: 32 * 1024 * 1024
  });
  assert.equal(result.status, 0, result.stderr.toString('utf8'));
  assert.equal(result.stdout.length, frame.length);
  assert.notDeepEqual(result.stdout, frame);
  let maximumDelta = 0;
  for (let offset = 0; offset < frame.length; offset += 2) {
    maximumDelta = Math.max(maximumDelta, Math.abs(result.stdout.readUInt16LE(offset) - frame.readUInt16LE(offset)));
  }
  assert.ok(maximumDelta <= 525, `NIV99 exceeded its cumulative detail budget: ${maximumDelta}`);
  assert.match(result.stderr.toString('utf8'), /"event":"niv99"/);
  assert.match(result.stderr.toString('utf8'), /"niv99Frames":1/);
});

test('NIV99 quality cache can be reused without changing its runtime metrics contract', t => {
  const width = 24;
  const height = 16;
  const frames = [makeFrame(width, height, 0, 101), makeFrame(width, height, 1, 102)];
  const input = Buffer.concat(frames);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'camx-worker-cache-'));
  const cachePath = path.join(directory, 'quality.nqis');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const pythonPath = path.join(root, '.ai-dev');
  const fingerprint = JSON.stringify({
    sourceLength: input.length, sourceLastModified: 1, sourceSha256: 'a'.repeat(64),
    width, height, signalFamily: 'SDR', detailProfile: 'FOCUSED_DETAIL',
    stageFlags: { niv99: true }, stageScales: { quality: 'maximum' }, frameCount: frames.length
  });
  const common = [
    path.join(root, 'scripts', 'ai_worker.py'), '--no-ai', '--niv99',
    '--width', String(width), '--height', String(height), '--signal-family', 'SDR',
    '--quality-cache-fingerprint', fingerprint, '--quality-cache-frames', String(frames.length)
  ];
  const environment = { ...process.env, PYTHONPATH: [pythonPath, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) };
  const written = spawnSync('python', [...common, '--quality-cache-write', cachePath], {
    cwd: root, env: environment, input, encoding: null, maxBuffer: 8 * 1024 * 1024
  });
  assert.equal(written.status, 0, written.stderr.toString('utf8'));
  assert.equal(written.stdout.length, input.length);
  assert.equal(fs.existsSync(cachePath), true);
  const reused = spawnSync('python', [...common, '--quality-cache-read', cachePath], {
    cwd: root, env: environment, input, encoding: null, maxBuffer: 8 * 1024 * 1024
  });
  assert.equal(reused.status, 0, reused.stderr.toString('utf8'));
  assert.equal(reused.stdout.length, input.length);
  assert.match(reused.stderr.toString('utf8'), /"qualityCache":"hit"/);
  assert.doesNotMatch(reused.stderr.toString('utf8'), /"event":"fatal"/);
});

test('worker aborts ordered pipe resources and removes an incomplete quality cache', t => {
  const width = 16;
  const height = 12;
  const frameBytes = width * height * 3 * 2;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'camx-worker-abort-'));
  const cachePath = path.join(directory, 'incomplete.nqis');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const pythonPath = path.join(root, '.ai-dev');
  const fingerprint = JSON.stringify({
    sourceLength: frameBytes * 2, sourceLastModified: 1, sourceSha256: 'b'.repeat(64),
    width, height, signalFamily: 'SDR', detailProfile: 'FOCUSED_DETAIL',
    stageFlags: { niv99: true }, stageScales: { quality: 'maximum' }, frameCount: 2
  });
  const result = spawnSync('python', [
    path.join(root, 'scripts', 'ai_worker.py'), '--no-ai', '--niv99', '--compute-backend', 'cpu',
    '--width', String(width), '--height', String(height), '--signal-family', 'SDR',
    '--quality-cache-write', cachePath, '--quality-cache-fingerprint', fingerprint,
    '--quality-cache-frames', '2'
  ], {
    cwd: root,
    env: { ...process.env, PYTHONPATH: [pythonPath, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) },
    input: Buffer.alloc(frameBytes + 1),
    encoding: null,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 15000
  });
  assert.equal(result.status, 1, result.stderr.toString('utf8'));
  assert.match(result.stderr.toString('utf8'), /Incomplete RGB48 frame/);
  assert.equal(fs.existsSync(cachePath), false, 'partial NQIS cache must be removed');
});

test('Python RGB48 delivery is code-value equivalent to the camera math port', () => {
  const width = 3; const height = 1;
  const pixels = [
    [0, 0, 0],
    [0.18, 0.18, 0.18],
    [0.288, 0.09, 0.0324]
  ];
  const input = Buffer.alloc(width * height * 6);
  pixels.forEach((pixel, x) => pixel.forEach((value, channel) =>
    input.writeUInt16LE(Math.round(value * 65535), x * 6 + channel * 2)));
  const pythonPath = path.join(root, '.ai-dev');
  for (const mode of ['NDR10_PLUS', 'NIVUKX_VISION']) {
    const result = spawnSync('python', [
      path.join(root, 'scripts', 'ai_worker.py'), '--no-ai',
      '--width', String(width), '--height', String(height),
      '--delivery-transform', mode, '--delivery-reference', '0.18', '--warm-skin-red-tame', '0'
    ], {
      cwd: root,
      env: { ...process.env, PYTHONPATH: [pythonPath, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) },
      input,
      encoding: null,
      maxBuffer: 4 * 1024 * 1024
    });
    assert.equal(result.status, 0, result.stderr.toString('utf8'));
    const events = result.stderr.toString('utf8').split(/\r?\n/)
      .filter(line => line.startsWith('#CAMX_AI#'))
      .map(line => JSON.parse(line.slice('#CAMX_AI#'.length)));
    const ready = events.find(event => event.event === 'ready');
    const delivery = events.find(event => event.event === 'delivery');
    const complete = events.find(event => event.event === 'complete');
    assert.equal(ready.dynamicMetadata.schema, 'com.neoproc.camx.dynamic-delivery.v1');
    assert.equal(delivery.tiers.T3.appearanceSpace, 'JZAZBZ_FP64_ANALYSIS');
    assert.equal(delivery.tiers.T7.filter, 'SCALAR_KALMAN_CUT_AWARE_V1');
    assert.equal(complete.measuredContentLight.framesMeasured, 1);
    assert.ok(complete.measuredContentLight.signalledMaxCLL > 0);
    assert.ok(complete.measuredContentLight.signalledMaxFALL <= complete.measuredContentLight.signalledMaxCLL);
    pixels.forEach((pixel, x) => {
      const quantizedInput = pixel.map(value => Math.round(value * 65535) / 65535 / 0.18);
      const expected = deliverPqCodes(...quantizedInput, mode, 16, 0);
      expected.forEach((value, channel) => {
        const actual = result.stdout.readUInt16LE(x * 6 + channel * 2);
        assert.ok(Math.abs(actual - value) <= 1, `${mode} pixel ${x}/${channel}: ${actual} != ${value}`);
      });
    });
  }
});
