'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  VERSION, CALIBRATION_VERSION, DELIVERY_VERSION, DIFFUSE_WHITE_NITS,
  PARAMS, luma, signalShape, signalToDisplayNits, encodePqFromNits,
  decodePqToNits, mapRgbHuePreserving, deliverPq, deliverPqCodes
} = require('../src/core/camera-color-pipeline');

function dot(left, right) { return left.reduce((sum, value, index) => sum + value * right[index], 0); }
function norm(value) { return Math.sqrt(dot(value, value)); }

test('desktop locks the exact camera NDR/NIVUKX v4 constants and mastering anchors', () => {
  assert.equal(VERSION, 'NDR-TONE-OP-v4');
  assert.equal(CALIBRATION_VERSION, 'NDR-NIVUKX-PY-CAL-v4');
  assert.equal(DELIVERY_VERSION, 'NDR-NIVUKX-DELIVERY-v1');
  assert.deepEqual(PARAMS.NDR10_PLUS, {
    mode: 'NDR10_PLUS', signalGamma: 0.859937, toeWidth: 0.238882,
    toeAmount: 0.024780, diffuseWhiteNits: 203, peakNits: 5000,
    highlightDesat: 0.149718, shadowMidtoneLift: 0.167837,
    midtoneContrast: 0.100943, chromaBoost: 0.038361,
    skyChromaBonus: 0.062392, localDetailStrength: 0.4,
    localDetailLowerStops: -0.06, localDetailUpperStops: 0.085
  });
  assert.deepEqual(PARAMS.NIVUKX_VISION, {
    mode: 'NIVUKX_VISION', signalGamma: 0.800034, toeWidth: 0.289876,
    toeAmount: 0.031033, diffuseWhiteNits: 203, peakNits: 10000,
    highlightDesat: 0.128953, shadowMidtoneLift: 0.232156,
    midtoneContrast: 0.174135, chromaBoost: 0.091565,
    skyChromaBonus: 0.08, localDetailStrength: 0.6,
    localDetailLowerStops: -0.085, localDetailUpperStops: 0.125
  });
});

test('canonical camera transfer is black-safe, monotone and exactly 203-nit anchored', () => {
  for (const params of Object.values(PARAMS)) {
    assert.equal(signalShape(0, params), 0);
    assert.equal(signalShape(1, params), 1);
    assert.equal(signalToDisplayNits(1, params), DIFFUSE_WHITE_NITS);
    assert.equal(signalToDisplayNits(0.5, params), 101.5);
    let previous = -1;
    for (let index = 0; index <= 800; index += 1) {
      const pq = deliverPq(index / 100, index / 100, index / 100, params.mode)[0];
      assert.ok(pq >= previous - 1e-12, `${params.mode} is non-monotone at ${index / 100}`);
      previous = pq;
    }
    const diffuse = deliverPq(1, 1, 1, params.mode);
    diffuse.forEach(value => assert.ok(Math.abs(value - encodePqFromNits(203)) < 1e-12));
    assert.deepEqual(deliverPqCodes(1, 1, 1, params.mode), Array(3).fill(Math.round(encodePqFromNits(203) * 1023)));
  }
});

test('canonical camera delivery preserves highlight hue and exact profile peaks', () => {
  const input = [80, 0.15, 0.05];
  for (const params of Object.values(PARAMS)) {
    const shaped = mapRgbHuePreserving(...input, params);
    const shapedY = luma(...shaped);
    const output = deliverPq(...input, params.mode).map(decodePqToNits);
    const outputY = luma(...output);
    const expectedY = signalToDisplayNits(shapedY, params);
    assert.ok(Math.abs(outputY - expectedY) <= expectedY * 1e-6);
    const inputChroma = shaped.map(value => value - shapedY);
    const outputChroma = output.map(value => value - outputY);
    const cosine = dot(inputChroma, outputChroma) / (norm(inputChroma) * norm(outputChroma) + 1e-12);
    assert.ok(cosine > 0.999999);
    assert.ok(Math.max(...output) <= params.peakNits * 1.000001);
  }
  const ndr = decodePqToNits(Math.max(...deliverPq(30, 30, 30, 'NDR10_PLUS')));
  const nivukx = decodePqToNits(Math.max(...deliverPq(30, 30, 30, 'NIVUKX_VISION')));
  assert.ok(nivukx > ndr);
});
