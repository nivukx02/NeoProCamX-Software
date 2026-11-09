'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  repairDefects, temporalFuse, edgeDirectedDemosaic,
  rawCalibration, Niv99RawProcessor, NIV99_RAW_VERSION
} = require('../src/core/raw-develop');

const calibration = { noiseS: 0, noiseO: 0 };

test('RAW defect repair replaces only an isolated same-CFA outlier', () => {
  const width = 8; const height = 8;
  const source = new Uint16Array(width * height).fill(12000);
  source[4 * width + 4] = 65535;
  const result = repairDefects(source, width, height, calibration);
  assert.equal(result.repaired, 1);
  assert.equal(result.pixels[4 * width + 4], 12000);
  assert.equal(source[4 * width + 4], 65535);
});

test('RAW temporal fusion rejects motion and only blends stable samples', () => {
  const previous = new Uint16Array(128).fill(10000);
  const current = new Uint16Array(128).fill(10100);
  current[64] = 30000;
  const result = temporalFuse(current, previous, calibration, 'maximum');
  assert.ok(result.pixels[0] < current[0]);
  assert.equal(result.pixels[64], current[64]);
});

test('edge-directed CFA demosaic emits packed RGB48 at exact geometry', () => {
  const width = 8; const height = 8;
  const mosaic = new Uint16Array(width * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const slot = ((y & 1) << 1) | (x & 1);
    mosaic[y * width + x] = slot === 0 ? 50000 : slot === 3 ? 10000 : 30000;
  }
  const output = edgeDirectedDemosaic(mosaic, width, height, 0);
  assert.equal(output.length, width * height * 6);
  const center = (4 * width + 4) * 6;
  assert.equal(output.readUInt16LE(center), 50000);
  assert.ok(Math.abs(output.readUInt16LE(center + 2) - 30000) <= 1);
  assert.ok(Math.abs(output.readUInt16LE(center + 4) - 10000) <= 1);
});

test('camera NIV99 RAW filtering runs on copied sensor codes before RAW development', () => {
  const width = 8; const height = 8;
  const media = {
    width, height, fps: 30, bitDepth: 12, pixelFormat: 'bayer_rggb12',
    sidecar: {
      blackLevel: 64, whiteLevel: 4095, blackLevelRggb: [64, 64, 64, 64],
      whiteBalance: [2, 1, 1, 1.5], bayerPattern: 0,
      analogGain: 1, digitalGain: 1, noiseS: 0, noiseO: 0,
      lensShadingEnabled: false
    }
  };
  const calibration = rawCalibration(media);
  const sensor = new Uint16Array(width * height).fill(900);
  const outlier = 4 * width + 4;
  sensor[outlier] = 4000;
  const original = sensor.slice();
  const result = new Niv99RawProcessor(media).process(sensor, calibration, 0, 1_000_000_000);
  assert.equal(result.evidence.version, NIV99_RAW_VERSION);
  assert.equal(result.evidence.fullFrameSamples, width * height);
  assert.equal(result.evidence.correctedDefects, 1);
  assert.equal(result.pixels[outlier], 900);
  assert.deepEqual(sensor, original);
  assert.equal(result.evidence.capturedWhiteBalancePreserved, true);
});
