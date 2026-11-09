'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { crc32 } = require('../src/core/binary-formats');
const {
  MAGIC, FORMAT_VERSION, INSTRUCTION_VERSION, RECORD_BYTES,
  stableFingerprint, fingerprintId, inspectQualityCache
} = require('../src/core/quality-cache');
const { SustainedConversionGovernor } = require('../src/core/conversion-governor');

test('NQIS cache accepts only the exact fingerprint, record count and CRC', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'camx-nqis-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, '.clip.npv10.nqis');
  const fingerprint = stableFingerprint({
    sourceLength: 4096, sourceLastModified: 1234, sourceSha256: 'a'.repeat(64),
    width: 4, height: 4, signalFamily: 'HDR', detailProfile: 'FOCUSED_DETAIL',
    stageFlags: { niv99: true }, stageScales: { quality: 'maximum' }, frameCount: 2
  });
  const header = Buffer.from(JSON.stringify({
    instructionVersion: INSTRUCTION_VERSION, fingerprint, fingerprintId: fingerprintId(fingerprint)
  }), 'utf8');
  const fixed = Buffer.alloc(20);
  MAGIC.copy(fixed, 0);
  fixed.writeUInt32BE(FORMAT_VERSION, 8);
  fixed.writeUInt32BE(header.length, 12);
  fixed.writeUInt32BE(2, 16);
  const records = Buffer.alloc(RECORD_BYTES * 2);
  records.writeUInt32BE(0, 0);
  records.writeUInt32BE(1, RECORD_BYTES);
  const body = Buffer.concat([fixed, header, records]);
  const trailer = Buffer.alloc(8);
  trailer.writeBigUInt64BE(BigInt(crc32(body)));
  fs.writeFileSync(target, Buffer.concat([body, trailer]));
  assert.equal(inspectQualityCache(target, fingerprint).recordCount, 2);
  assert.equal(inspectQualityCache(target, { ...fingerprint, width: 8 }), null);
  const damaged = fs.readFileSync(target); damaged[damaged.length - 9] ^= 1; fs.writeFileSync(target, damaged);
  assert.equal(inspectQualityCache(target, fingerprint), null);
});

test('sustained conversion evidence reports deterministic p50/p95/p99 without quality controls', () => {
  let now = 0n;
  const governor = new SustainedConversionGovernor({ route: 'enhance-ffmpeg', width: 4, height: 4, sourceFps: 30 }, {
    logicalCores: 8, startedNs: 0n, clock: () => now
  });
  for (const [frame, nanos] of [[1, 10n], [2, 30n], [3, 60n], [4, 100n]]) {
    now = nanos;
    governor.recordFrames(frame);
  }
  governor.recordStageLatency('niv99', 2.5);
  governor.recordStageLatency('niv99', 4.5);
  const result = governor.summary();
  assert.equal(result.p50FrameNanos, 20);
  assert.equal(result.p95FrameNanos, 40);
  assert.equal(result.p99FrameNanos, 40);
  assert.equal(result.workerLimit, 7);
  assert.equal(result.qualityInvariant, true);
  assert.equal(result.stageLatency.niv99.p50Ms, 2.5);
  assert.equal(Object.hasOwn(result, 'resolutionScale'), false);
  assert.equal(Object.hasOwn(result, 'bitrateScale'), false);
});
