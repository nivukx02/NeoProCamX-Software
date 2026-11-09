'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CapabilityService, selectPreferredGpuEncoder, gpuEncoderLabel } = require('../src/core/capabilities');
const { gpuEncoderArgs, gpuLosslessEncoderArgs, gpuEncoderQueueDepth } = require('../src/core/conversion-profiles');

test('GPU selection covers NVIDIA, AMD and Intel hardware encoders', () => {
  assert.equal(selectPreferredGpuEncoder(
    [{ name: 'NVIDIA GeForce RTX 4070', memoryBytes: 12_000 }, { name: 'Intel UHD Graphics', memoryBytes: 2_000 }],
    { hevcNvenc: true, hevcAmf: false, hevcQsv: true }
  ), 'hevc_nvenc');
  assert.equal(selectPreferredGpuEncoder(
    [{ name: 'AMD Radeon RX 7800 XT', memoryBytes: 16_000 }],
    { hevcNvenc: false, hevcAmf: true, hevcQsv: false }
  ), 'hevc_amf');
  assert.equal(selectPreferredGpuEncoder(
    [{ name: 'Intel Arc A770', memoryBytes: 16_000 }],
    { hevcNvenc: false, hevcAmf: false, hevcQsv: true }
  ), 'hevc_qsv');
  assert.equal(selectPreferredGpuEncoder([], { hevcNvenc: false, hevcAmf: false, hevcQsv: false }), null);
});

test('hybrid-PC GPU selection prefers the validated backend on the largest adapter', () => {
  const selected = selectPreferredGpuEncoder([
    { name: 'Intel UHD Graphics', memoryBytes: 2_000 },
    { name: 'AMD Radeon RX 7900 XTX', memoryBytes: 24_000 }
  ], { hevcNvenc: false, hevcAmf: true, hevcQsv: true });
  assert.equal(selected, 'hevc_amf');
  assert.equal(gpuEncoderLabel(selected), 'AMD AMF');
});

test('hardware encoder plans use high-throughput queues without changing Main10 precision', () => {
  const nvenc = gpuEncoderArgs('hevc_nvenc', 10);
  const amf = gpuEncoderArgs('hevc_amf', 10);
  const qsv = gpuEncoderArgs('hevc_qsv', 10);
  assert.deepEqual(nvenc.slice(nvenc.indexOf('-surfaces'), nvenc.indexOf('-surfaces') + 2), ['-surfaces', '32']);
  assert.deepEqual(amf.slice(amf.indexOf('-async_depth'), amf.indexOf('-async_depth') + 2), ['-async_depth', '32']);
  assert.deepEqual(qsv.slice(qsv.indexOf('-async_depth'), qsv.indexOf('-async_depth') + 2), ['-async_depth', '32']);
  for (const args of [nvenc, amf, qsv]) {
    assert.ok(args.includes('main10'));
    assert.ok(args.includes('p010le'));
  }
});

test('hardware encoder queues are memory bounded for full-sensor video on an integrated GPU', () => {
  const depth = gpuEncoderQueueDepth(
    { width: 4096, height: 3072 },
    { gpu: [{ name: 'AMD Radeon Graphics', memoryBytes: 512 * 1024 ** 2 }] }
  );
  assert.equal(depth, 2);
  const amf = gpuEncoderArgs('hevc_amf', 10, depth);
  assert.deepEqual(amf.slice(amf.indexOf('-async_depth'), amf.indexOf('-async_depth') + 2), ['-async_depth', '2']);
});

test('the optional GPU lossless route is explicit NVENC lossless rather than QP-zero guessing', () => {
  const args = gpuLosslessEncoderArgs('hevc_nvenc', 8);
  assert.deepEqual(args.slice(args.indexOf('-tune'), args.indexOf('-tune') + 2), ['-tune', 'lossless']);
  assert.deepEqual(args.slice(args.indexOf('-qp'), args.indexOf('-qp') + 2), ['-qp', '0']);
  assert.deepEqual(args.slice(args.indexOf('-surfaces'), args.indexOf('-surfaces') + 2), ['-surfaces', '8']);
  assert.throws(() => gpuLosslessEncoderArgs('hevc_amf'), /Unsupported verified lossless GPU encoder/);
  assert.throws(() => gpuLosslessEncoderArgs('hevc_qsv'), /Unsupported verified lossless GPU encoder/);
});

test('validated capabilities are reused across launches without repeating heavyweight self-tests', async t => {
  const cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'camx-capability-cache-'));
  t.after(() => fs.rmSync(cacheDirectory, { recursive: true, force: true }));
  const expected = {
    ready: true,
    ai: { ready: true },
    mfsr: { ready: true },
    compute: { ready: true },
    encoders: { libx265: true }
  };
  const first = new CapabilityService({ cacheDirectory });
  first.detectUncached = async () => expected;
  assert.deepEqual(await first.detect(), expected);

  const second = new CapabilityService({ cacheDirectory });
  second.detectUncached = async () => { throw new Error('self-test should have been served by the cache'); };
  assert.deepEqual(await second.detect(), expected);
});
