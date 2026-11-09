'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TAG, buildDngHeader, inspectDngHeader, invert3x3, sequenceDigest } = require('../src/core/cinema-dng');

const calibration = {
  blackLevel: 64,
  blackLevels: [64, 65, 66, 67],
  whiteLevel: 4095,
  whiteBalance: [2, 1, 1, 1.5],
  sensorToXyz: [0.7, 0.2, 0.1, 0.1, 0.8, 0.1, 0.02, 0.08, 0.9],
  bayerPattern: 0,
  orientation: 0
};

test('CinemaDNG header carries CFA identity and calibrated RAW tags', () => {
  const header = buildDngHeader(12, 8, calibration, { index: 3, timestamp: 99 });
  const inspected = inspectDngHeader(header);
  assert.equal(inspected.width, 12);
  assert.equal(inspected.height, 8);
  assert.equal(inspected.photometric, 32803);
  for (const tag of [TAG.CFA_PATTERN, TAG.BLACK_LEVEL, TAG.WHITE_LEVEL, TAG.COLOR_MATRIX_1, TAG.AS_SHOT_NEUTRAL]) {
    assert.ok(inspected.tags.has(tag));
  }
  assert.equal(inspected.tags.get(TAG.STRIP_BYTE_COUNTS).value, 12 * 8 * 2);
  assert.equal(inspected.tags.get(TAG.STRIP_OFFSETS).value, header.length);
});

test('CinemaDNG matrix inversion and sequence identity are deterministic', () => {
  const inverse = invert3x3([1, 0, 0, 0, 2, 0, 0, 0, 4]);
  assert.deepEqual(inverse, [1, 0, 0, 0, 0.5, 0, 0, 0, 0.25]);
  const files = [{ name: 'frame_000001.dng', bytes: 100, sha256: 'a' }, { name: 'frame_000002.dng', bytes: 100, sha256: 'b' }];
  assert.equal(sequenceDigest(files), sequenceDigest(files));
  assert.notEqual(sequenceDigest(files), sequenceDigest([...files].reverse()));
});

