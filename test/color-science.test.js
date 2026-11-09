'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  D50, D65, D60, XYZ_TO_ACESCG, multiplyVector, multiply3x3, cat16Matrix,
  createViewingConditions, cam16Forward, cam16Inverse,
  transformSignalRgb, ensurePerceptualLut
} = require('../src/core/color-science');
const { xyzD50ToTargetMatrix } = require('../src/core/conversion-profiles');

test('CAT16 D65/D60 adaptation round-trips within floating-point tolerance', () => {
  const forward = cat16Matrix(D65, D60);
  const inverse = cat16Matrix(D60, D65);
  const roundTrip = multiply3x3(inverse, forward);
  const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  roundTrip.forEach((value, index) => assert.ok(Math.abs(value - identity[index]) < 1e-6));
});

test('RAW sensor colour follows the camera XYZ D50 to CAT16 D60 ACEScg route', () => {
  const expected = multiply3x3(XYZ_TO_ACESCG, cat16Matrix(D50, D60, 1));
  const actual = xyzD50ToTargetMatrix('acescg');
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-12));
  const incorrectD65Route = multiply3x3(XYZ_TO_ACESCG, cat16Matrix(D65, D60, 1));
  assert.ok(actual.some((value, index) => Math.abs(value - incorrectD65Route[index]) > 1e-4));
});

test('canonical CAM16 forward and inverse preserve a neutral sample', () => {
  const conditions = createViewingConditions(D60, 64, 20);
  const xyz = D60.map(value => value * 0.18);
  const appearance = cam16Forward(xyz, conditions);
  const restored = cam16Inverse(appearance.j, appearance.c, appearance.h, conditions);
  restored.forEach((value, index) => assert.ok(Math.abs(value - xyz[index]) < 2e-5));
});

test('perceptual output transform is bounded and keeps neutrals neutral', () => {
  for (const family of ['sdr', 'ndr', 'nivukx']) {
    for (const value of [0, 0.18, 0.5, 0.9, 1]) {
      const output = transformSignalRgb([value, value, value], family);
      output.forEach(channel => assert.ok(channel >= 0 && channel <= 1));
      assert.ok(Math.max(...output) - Math.min(...output) < 0.0002);
      assert.ok(Math.max(...output.map(channel => Math.abs(channel - value))) < 0.012);
    }
  }
});

test('33-cube colour pipeline is materialized with the expected sample count', () => {
  const target = ensurePerceptualLut('sdr');
  const lines = fs.readFileSync(target, 'utf8').split(/\r?\n/).filter(line => /^\d/.test(line));
  assert.equal(lines.length, 33 ** 3);
});
