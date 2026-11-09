'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { expectedFrameCount, updateJobProgress } = require('../src/core/conversion-queue');
const { previewKey, parsePreviewProgress } = require('../src/core/preview-service');

test('conversion telemetry reports frames, processed FPS, elapsed time and ETA', () => {
  const startedAt = new Date(Date.now() - 2000).toISOString();
  const job = {
    startedAt,
    expectedFrames: 100,
    processedFrames: 0,
    processingFps: 0,
    conversionProgress: 0,
    progress: 0,
    media: { duration: 4, fps: 25 }
  };
  updateJobProgress(job, { frame: 50, fps: 25, outTimeSeconds: 2, speed: '1.0x' });
  assert.equal(job.processedFrames, 50);
  assert.equal(job.processingFps, 25);
  assert.equal(job.conversionProgress, 0.5);
  assert.equal(job.progress, 0.46);
  assert.equal(job.etaSeconds, 2);
  assert.ok(job.elapsedSeconds >= 1.9);
  assert.equal(expectedFrameCount({ duration: 2, fps: 23.976 }), 48);
});

test('preview cache identity is deterministic and preview progress is parsed', async () => {
  const media = { filePath: 'D:\\clips\\one.npv10', size: 1234, modifiedAt: 99, kind: 'npv10', raw: true, width: 64, height: 32, duration: 10 };
  assert.equal(previewKey(media), previewKey({ ...media }));
  assert.notEqual(previewKey(media), previewKey({ ...media, modifiedAt: 100 }));
  const stream = new PassThrough();
  const events = [];
  parsePreviewProgress(stream, media, event => events.push(event));
  stream.end('out_time_us=2500000\nprogress=continue\nout_time_us=10000000\nprogress=end\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events[0].ratio, 0.25);
  assert.equal(events.at(-1).ratio, 1);
  assert.equal(events.at(-1).stage, 'Ready');
});
