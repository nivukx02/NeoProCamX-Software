'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const buildDirectory = path.resolve(__dirname, '..', 'build');

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, payload) {
  const name = Buffer.from(type, 'ascii');
  const output = Buffer.alloc(12 + payload.length);
  output.writeUInt32BE(payload.length, 0);
  name.copy(output, 4);
  payload.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, payload])), 8 + payload.length);
  return output;
}

function mix(left, right, amount) {
  return left.map((value, index) => Math.round(value + (right[index] - value) * amount));
}

function sampleMark(nx, ny) {
  const radius = Math.hypot(nx, ny);
  if (radius > 1) return [0, 0, 0, 0];
  let color;
  if (radius <= 0.11) color = [255, 255, 255];
  else if (radius <= 0.31) color = [21, 24, 33];
  else if (radius <= 0.58) color = [157, 81, 239];
  else if (radius <= 0.72) color = [207, 156, 255];
  else color = mix([111, 45, 194], [76, 26, 145], (radius - 0.72) / 0.28);
  // Match the in-app violet lens while retaining enough dimensionality at Windows icon sizes.
  const highlight = Math.max(0, 1 - Math.hypot(nx + 0.30, ny + 0.34) / 0.72);
  color = mix(color, [255, 255, 255], highlight * (radius > 0.11 && radius < 0.95 ? 0.13 : 0));
  return [...color, 255];
}

function makePng(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const center = (size - 1) / 2;
  const outerRadius = size * 0.405;
  const samples = 4;
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const accum = [0, 0, 0, 0];
      for (let sy = 0; sy < samples; sy += 1) for (let sx = 0; sx < samples; sx += 1) {
        const nx = (x + (sx + 0.5) / samples - center) / outerRadius;
        const ny = (y + (sy + 0.5) / samples - center) / outerRadius;
        const rgba = sampleMark(nx, ny);
        for (let channel = 0; channel < 4; channel += 1) accum[channel] += rgba[channel];
      }
      const offset = row + 1 + x * 4;
      for (let channel = 0; channel < 4; channel += 1) raw[offset + channel] = Math.round(accum[channel] / (samples * samples));
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function makeIco(png) {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header[6] = 0;
  header[7] = 0;
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, png]);
}

fs.mkdirSync(buildDirectory, { recursive: true });
const icon256 = makePng(256);
fs.writeFileSync(path.join(buildDirectory, 'icon-256.png'), icon256);
fs.writeFileSync(path.join(buildDirectory, 'icon.png'), makePng(512));
fs.writeFileSync(path.join(buildDirectory, 'icon.ico'), makeIco(icon256));
process.stdout.write(`${path.join(buildDirectory, 'icon.ico')}\n`);
