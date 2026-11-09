'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const {
  crc32, probeNpv10, probeNpraw, createFrameStream, rawFrameIterator,
  unpackTenBitPacket, decodeNlc2Packet, unpackNpvRawWords
} = require('../src/core/binary-formats');

function packTenBit(codes) {
  let accumulator = 0n;
  let bits = 0n;
  const bytes = [];
  for (const code of codes) {
    accumulator |= BigInt(code & 0x3ff) << bits;
    bits += 10n;
    while (bits >= 8n) {
      bytes.push(Number(accumulator & 0xffn));
      accumulator >>= 8n;
      bits -= 8n;
    }
  }
  if (bits > 0n) bytes.push(Number(accumulator & 0xffn));
  return Buffer.from(bytes);
}

function i32(value) { const b = Buffer.alloc(4); b.writeInt32BE(value); return b; }
function i64(value) { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(value)); return b; }
function u32le(value) { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; }
function u16le(value) { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b; }

async function collect(stream) {
  const chunks = [];
  stream.on('data', chunk => chunks.push(chunk));
  await once(stream, 'end');
  return Buffer.concat(chunks);
}

test('packed P010 codec round-trips ten-bit values into canonical words', () => {
  const codes = [0, 1, 255, 512, 777, 1023];
  const result = unpackTenBitPacket(packTenBit(codes), codes.length * 2);
  assert.deepEqual(Array.from({ length: codes.length }, (_, index) => result.readUInt16LE(index * 2) >>> 6), codes);
});

test('NPV10 reader validates header, packets, CRC and yields P010', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-npv10-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'fixture.npv10');
  const metadata = Buffer.from('payloadFormat=P010_LE\npacketCodec=PACKED_P010_10_LE_V1\nsourceFormat=YCBCR_P010\nsourceBitDepth=10\nstorageBitDepth=10\nexactSelectedResolution=true\n', 'utf8');
  const codes = [64, 128, 256, 512, 512, 512];
  const payload = packTenBit(codes);
  const header = Buffer.concat([Buffer.from('NPV10'), i32(2), i32(2), i32(2), i32(24), i32(10), i32(metadata.length), metadata]);
  const frameHeader = Buffer.concat([Buffer.from('FRM0'), i64(1_000_000_000), i32(2), i32(2), i32(payload.length), i32(crc32(payload) | 0)]);
  fs.writeFileSync(target, Buffer.concat([header, frameHeader, payload]));
  const info = await probeNpv10(target);
  assert.equal(info.frames, 1);
  assert.equal(info.pixelFormat, 'p010le');
  const decoded = await collect(createFrameStream(target, info));
  assert.deepEqual(Array.from({ length: codes.length }, (_, index) => decoded.readUInt16LE(index * 2) >>> 6), codes);
});

test('NPV10 RAW12 words decode to full-range Bayer words', () => {
  const samples = [0, 1, 2048, 4095];
  const packed = Buffer.alloc(samples.length * 2);
  samples.forEach((raw, index) => {
    const crc4 = (raw ^ (raw >>> 4) ^ (raw >>> 8)) & 0x0f;
    packed.writeUInt16LE(((raw >>> 2) << 6) | ((raw & 3) << 4) | crc4, index * 2);
  });
  const output = unpackNpvRawWords(packed, 12);
  assert.deepEqual(Array.from(samples, (sample, index) => output.readUInt16LE(index * 2)), samples.map(value => value << 4));
});

test('current NLC2/LZ4 NPV10 packet decodes bit-exact P010 and validates inner CRC', () => {
  const samples = 12;
  const packed = Buffer.alloc(Math.ceil(samples * 10 / 8));
  // One zero literal followed by a distance-one match of the remaining 14 bytes.
  const lz4 = Buffer.from([0x1a, 0x00, 0x01, 0x00]);
  const header = Buffer.alloc(32);
  header.write('NLC2', 0, 'ascii');
  header.writeUInt32BE(1, 4);
  header.writeUInt32BE(packed.length, 8);
  header.writeUInt32BE(samples * 2, 12);
  header.writeUInt32BE(samples, 16);
  header.writeUInt32BE(262144, 20);
  header.writeUInt32BE(1, 24);
  header.writeUInt32BE(crc32(packed), 28);
  const chunk = Buffer.alloc(12);
  chunk.writeUInt32BE(1, 0);
  chunk.writeUInt32BE(samples, 4);
  chunk.writeUInt32BE(lz4.length, 8);
  const packet = Buffer.concat([header, chunk, lz4]);
  assert.deepEqual(decodeNlc2Packet(packet, samples * 2), Buffer.alloc(samples * 2));
  const damaged = Buffer.from(packet);
  damaged.writeUInt32BE(1, 28);
  assert.throws(() => decodeNlc2Packet(damaged, samples * 2), /CRC mismatch/);
});

test('NPV10 probe recovers only the CRC-valid prefix of an interrupted reservation', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-npv10-recovery-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'interrupted.npv10');
  const metadata = Buffer.from('payloadFormat=P010_LE\npacketCodec=PACKED_P010_10_LE_V1\n', 'utf8');
  const payload = packTenBit([64, 128, 256, 512, 512, 512]);
  const header = Buffer.concat([Buffer.from('NPV10'), i32(2), i32(2), i32(2), i32(24), i32(10), i32(metadata.length), metadata]);
  const frame = Buffer.concat([
    Buffer.from('FRM0'), i64(1_000_000_000), i32(2), i32(2), i32(payload.length), i32(crc32(payload) | 0), payload
  ]);
  fs.writeFileSync(target, Buffer.concat([header, frame, Buffer.alloc(4096)]));
  const info = await probeNpv10(target);
  assert.equal(info.frames, 1);
  assert.equal(info.recovered, true);
  assert.match(info.warnings[0], /CRC-valid frame/);
  assert.equal((await collect(createFrameStream(target, info))).length, 12);
});

test('NPRAW realtime reader streams lossless Bayer frames', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-npraw-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'stream.npraw');
  const payload = Buffer.alloc(8);
  [0, 256, 512, 1023].forEach((sample, index) => payload.writeUInt16LE(sample, index * 2));
  const suffix = Buffer.alloc(28);
  suffix.writeInt32BE(16, 0); suffix.writeInt32BE(0, 4); suffix.writeInt32BE(1023, 8);
  suffix.writeFloatBE(10, 12); suffix.writeFloatBE(0.01, 16); suffix.writeBigUInt64BE(BigInt(crc32(payload)), 20);
  const prefix = Buffer.concat([Buffer.from('NPRAW'), Buffer.from([2]), i32(10), i32(2), i32(2), i32(4), i32(2), i64(1_000_000_000), i32(8), i32(8)]);
  fs.writeFileSync(target, Buffer.concat([prefix, suffix, payload]));
  const info = await probeNpraw(target);
  assert.equal(info.frames, 1);
  assert.equal(info.pixelFormat, 'bayer_rggb16le');
  const decoded = await collect(createFrameStream(target, info));
  assert.equal(decoded.length, 8);
  assert.equal(decoded.readUInt16LE(6), 65535);
});

test('current NPRAW v4 block-range stream restores exact sensor samples', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-npraw-v4-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'block-range.npraw');
  const payload = Buffer.concat([
    Buffer.from('NBR1'), u16le(64), u16le(4), u32le(1),
    u16le(100), Buffer.from([2, 0xe4])
  ]);
  const suffix = Buffer.alloc(36);
  suffix.writeInt32BE(12, 0); suffix.writeInt32BE(64, 4); suffix.writeInt32BE(4095, 8);
  suffix.writeFloatBE(12, 12); suffix.writeFloatBE(0.005, 16);
  suffix.writeBigUInt64BE(BigInt(crc32(payload)), 20);
  suffix.writeInt32BE(0, 28); suffix.writeInt32BE(4095, 32);
  const prefix = Buffer.concat([
    Buffer.from('NPRAW'), Buffer.from([4]), i32(10), i32(2), i32(2), i32(4), i32(2),
    i64(1_000_000_000), i32(8), i32(payload.length)
  ]);
  fs.writeFileSync(target, Buffer.concat([prefix, suffix, payload]));
  const info = await probeNpraw(target);
  const iterator = rawFrameIterator(target, info);
  const result = await iterator.next();
  assert.deepEqual(Array.from(result.value.samples), [100, 101, 102, 103]);
});

test('NPRAW probe ignores damaged preallocation only after a valid committed frame', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-npraw-recovery-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'interrupted.npraw');
  const payload = Buffer.alloc(8);
  const suffix = Buffer.alloc(28);
  suffix.writeInt32BE(16, 0); suffix.writeInt32BE(0, 4); suffix.writeInt32BE(1023, 8);
  suffix.writeBigUInt64BE(BigInt(crc32(payload)), 20);
  const prefix = Buffer.concat([Buffer.from('NPRAW'), Buffer.from([2]), i32(10), i32(2), i32(2), i32(4), i32(2), i64(1), i32(8), i32(8)]);
  fs.writeFileSync(target, Buffer.concat([prefix, suffix, payload, Buffer.alloc(1024)]));
  const info = await probeNpraw(target);
  assert.equal(info.frames, 1);
  assert.equal(info.recovered, true);
  assert.match(info.warnings[0], /CRC-valid frame/);
});
