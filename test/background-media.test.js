'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { crc32 } = require('../src/core/binary-formats');
const { runBackgroundTask, createBackgroundFrameStream } = require('../src/core/background-task-runner');
const { ConversionQueue } = require('../src/core/conversion-queue');

function i32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value);
  return buffer;
}

function i64(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigInt64BE(BigInt(value));
  return buffer;
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0);
  return buffer;
}

function npv10Fixture(filePath, { width, height, frames, raw = false }) {
  const format = raw ? 'RAW12_NPV10_PACKED' : 'P010_LE';
  const metadata = Buffer.from(`payloadFormat=${format}\npacketCodec=LEGACY_UNCOMPRESSED\n`, 'utf8');
  const header = Buffer.concat([
    Buffer.from('NPV10'), i32(2), i32(width), i32(height), i32(30), i32(raw ? 12 : 10), i32(metadata.length), metadata
  ]);
  const payloadBytes = raw
    ? width * height * 2
    : (width * height + 2 * Math.ceil(width / 2) * Math.ceil(height / 2)) * 2;
  const records = [];
  for (let index = 0; index < frames; index += 1) {
    const payload = Buffer.alloc(payloadBytes);
    for (let offset = 0; offset < payload.length; offset += 2) {
      payload.writeUInt16LE(((256 + index * 7 + (offset >>> 1)) & 0x0fff) << 4, offset);
    }
    const record = Buffer.concat([
      Buffer.from('FRM0'), i64(1_000_000_000 + index * 33_333_333),
      i32(width), i32(height), i32(payload.length), u32(crc32(payload)), payload
    ]);
    records.push(record);
  }
  fs.writeFileSync(filePath, Buffer.concat([header, ...records]));
}

test('custom media probing runs in a worker and retains the strict packet contract', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'camx-background-probe-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'NPV10_background.npv10');
  npv10Fixture(filePath, { width: 16, height: 8, frames: 3 });

  const media = await runBackgroundTask('probe-custom', { filePath }, { timeoutMs: 5000 });
  assert.equal(media.kind, 'npv10');
  assert.equal(media.frames, 3);
  assert.equal(media.logicalSize, fs.statSync(filePath).size);
  assert.equal(media.warnings.length, 0);
});

test('RAW development streams from a worker while the application event loop keeps ticking', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'camx-background-frames-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'NPV10_raw.npv10');
  npv10Fixture(filePath, { width: 256, height: 144, frames: 4, raw: true });
  const media = await runBackgroundTask('probe-custom', { filePath }, { timeoutMs: 5000 });

  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 5);
  let emittedFrames = 0;
  for await (const frame of createBackgroundFrameStream(filePath, media, { develop: true, quality: 'maximum' })) {
    assert.equal(frame.length, media.width * media.height * 6);
    emittedFrames += 1;
  }
  clearInterval(timer);
  assert.equal(emittedFrames, media.frames);
  assert.ok(ticks >= 3, `main event loop ticked only ${ticks} time(s)`);
});

test('conversion progress snapshots exclude heavyweight private media arrays', () => {
  const queue = new ConversionQueue({}, {}, () => {});
  const visible = queue.publicJob({
    id: 'job', state: 'running', progress: 0.5,
    media: { timestamps: Array.from({ length: 10000 }, (_, index) => index), audioSidecar: { packets: [{}] } },
    process: {}, frameStream: {}, temporaryPaths: [], governor: {}
  });
  assert.equal(visible.id, 'job');
  assert.equal(visible.progress, 0.5);
  assert.equal('media' in visible, false);
});
