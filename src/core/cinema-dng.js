'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { once } = require('node:events');
const { rawFrameIterator } = require('./binary-formats');
const { rawCalibration } = require('./raw-develop');

const TYPE_BYTE = 1;
const TYPE_ASCII = 2;
const TYPE_SHORT = 3;
const TYPE_LONG = 4;
const TYPE_RATIONAL = 5;
const TYPE_SRATIONAL = 10;

const TAG = Object.freeze({
  NEW_SUBFILE_TYPE: 254, IMAGE_WIDTH: 256, IMAGE_LENGTH: 257, BITS_PER_SAMPLE: 258,
  COMPRESSION: 259, PHOTOMETRIC: 262, IMAGE_DESCRIPTION: 270, MAKE: 271, MODEL: 272,
  STRIP_OFFSETS: 273, ORIENTATION: 274, SAMPLES_PER_PIXEL: 277, ROWS_PER_STRIP: 278,
  STRIP_BYTE_COUNTS: 279, PLANAR_CONFIG: 284, SOFTWARE: 305,
  CFA_REPEAT_PATTERN_DIM: 33421, CFA_PATTERN: 33422, DNG_VERSION: 50706,
  DNG_BACKWARD_VERSION: 50707, UNIQUE_CAMERA_MODEL: 50708, CFA_PLANE_COLOR: 50710,
  CFA_LAYOUT: 50711, BLACK_LEVEL_REPEAT_DIM: 50713, BLACK_LEVEL: 50714,
  WHITE_LEVEL: 50717, COLOR_MATRIX_1: 50721, AS_SHOT_NEUTRAL: 50728,
  CALIBRATION_ILLUMINANT_1: 50778
});

function shortLe(value) {
  const output = Buffer.alloc(2);
  output.writeUInt16LE(Number(value) & 0xffff);
  return output;
}

function longLe(value) {
  const output = Buffer.alloc(4);
  output.writeUInt32LE(Math.max(0, Math.min(0xffffffff, Number(value))) >>> 0);
  return output;
}

function shortArray(values) {
  const output = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => output.writeUInt16LE(value & 0xffff, index * 2));
  return output;
}

function ascii(value) {
  return Buffer.from(`${String(value).replace(/[^\x20-\x7e]/g, '')}\0`, 'ascii');
}

function rational(value, denominator = 1_000_000, signed = false) {
  const output = Buffer.alloc(8);
  const numerator = Math.round(Number(value) * denominator);
  if (signed) output.writeInt32LE(Math.max(-0x80000000, Math.min(0x7fffffff, numerator)), 0);
  else output.writeUInt32LE(Math.max(0, Math.min(0xffffffff, numerator)) >>> 0, 0);
  output.writeUInt32LE(denominator >>> 0, 4);
  return output;
}

function rationalArray(values, signed = false) {
  return Buffer.concat(values.map(value => rational(value, 1_000_000, signed)));
}

function invert3x3(matrix) {
  if (!Array.isArray(matrix) || matrix.length !== 9 || matrix.some(value => !Number.isFinite(Number(value)))) {
    return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  }
  const [a, b, c, d, e, f, g, h, i] = matrix.map(Number);
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const inverse = 1 / determinant;
  return [
    (e * i - f * h) * inverse, (c * h - b * i) * inverse, (b * f - c * e) * inverse,
    (f * g - d * i) * inverse, (a * i - c * g) * inverse, (c * d - a * f) * inverse,
    (d * h - e * g) * inverse, (b * g - a * h) * inverse, (a * e - b * d) * inverse
  ];
}

function cfaPattern(pattern) {
  return Buffer.from([
    [0, 1, 1, 2],
    [1, 0, 2, 1],
    [1, 2, 0, 1],
    [2, 1, 1, 0]
  ][pattern] || [0, 1, 1, 2]);
}

function orientationTag(degrees) {
  const normalized = ((Math.round(Number(degrees) / 90) * 90) % 360 + 360) % 360;
  return normalized === 90 ? 6 : normalized === 180 ? 3 : normalized === 270 ? 8 : 1;
}

function physicalBlackLevels(calibration) {
  const semantic = calibration.blackLevels?.length === 4 ? calibration.blackLevels :
    [calibration.blackLevel, calibration.blackLevel, calibration.blackLevel, calibration.blackLevel];
  return Array.from({ length: 4 }, (_, physicalIndex) => {
    const semanticIndex = physicalIndex ^ calibration.bayerPattern;
    return Math.max(0, Number(semantic[semanticIndex] || 0));
  });
}

function asShotNeutral(calibration) {
  const gains = calibration.whiteBalance?.length === 4 ? calibration.whiteBalance : [1, 1, 1, 1];
  const red = gains[0] > 0 ? gains[0] : 1;
  const green = (gains[1] + gains[2]) / 2 > 0 ? (gains[1] + gains[2]) / 2 : 1;
  const blue = gains[3] > 0 ? gains[3] : 1;
  return [green / red, 1, green / blue];
}

function buildDngHeader(width, height, calibration, frame) {
  const fields = [];
  const add = (tag, type, count, data) => fields.push({ tag, type, count, data });
  add(TAG.NEW_SUBFILE_TYPE, TYPE_LONG, 1, longLe(0));
  add(TAG.IMAGE_WIDTH, TYPE_LONG, 1, longLe(width));
  add(TAG.IMAGE_LENGTH, TYPE_LONG, 1, longLe(height));
  add(TAG.BITS_PER_SAMPLE, TYPE_SHORT, 1, shortLe(16));
  add(TAG.COMPRESSION, TYPE_SHORT, 1, shortLe(1));
  add(TAG.PHOTOMETRIC, TYPE_SHORT, 1, shortLe(32803));
  add(TAG.IMAGE_DESCRIPTION, TYPE_ASCII, 1, ascii(`CamX CinemaDNG;frame=${frame.index};timestampNs=${frame.timestamp || 0};identityMosaic=true`));
  fields[fields.length - 1].count = fields[fields.length - 1].data.length;
  const make = ascii('CamX');
  const model = ascii('CamX Studio RAW');
  add(TAG.MAKE, TYPE_ASCII, make.length, make);
  add(TAG.MODEL, TYPE_ASCII, model.length, model);
  const stripOffset = { tag: TAG.STRIP_OFFSETS, type: TYPE_LONG, count: 1, data: longLe(0) };
  fields.push(stripOffset);
  add(TAG.ORIENTATION, TYPE_SHORT, 1, shortLe(orientationTag(calibration.orientation)));
  add(TAG.SAMPLES_PER_PIXEL, TYPE_SHORT, 1, shortLe(1));
  add(TAG.ROWS_PER_STRIP, TYPE_LONG, 1, longLe(height));
  add(TAG.STRIP_BYTE_COUNTS, TYPE_LONG, 1, longLe(width * height * 2));
  add(TAG.PLANAR_CONFIG, TYPE_SHORT, 1, shortLe(1));
  const software = ascii('CamX Studio CinemaDNG');
  add(TAG.SOFTWARE, TYPE_ASCII, software.length, software);
  add(TAG.CFA_REPEAT_PATTERN_DIM, TYPE_SHORT, 2, shortArray([2, 2]));
  add(TAG.CFA_PATTERN, TYPE_BYTE, 4, cfaPattern(calibration.bayerPattern));
  add(TAG.DNG_VERSION, TYPE_BYTE, 4, Buffer.from([1, 4, 0, 0]));
  add(TAG.DNG_BACKWARD_VERSION, TYPE_BYTE, 4, Buffer.from([1, 1, 0, 0]));
  const cameraModel = ascii('CamX Studio RAW');
  add(TAG.UNIQUE_CAMERA_MODEL, TYPE_ASCII, cameraModel.length, cameraModel);
  add(TAG.CFA_PLANE_COLOR, TYPE_BYTE, 3, Buffer.from([0, 1, 2]));
  add(TAG.CFA_LAYOUT, TYPE_SHORT, 1, shortLe(1));
  add(TAG.BLACK_LEVEL_REPEAT_DIM, TYPE_SHORT, 2, shortArray([2, 2]));
  add(TAG.BLACK_LEVEL, TYPE_RATIONAL, 4, rationalArray(physicalBlackLevels(calibration)));
  add(TAG.WHITE_LEVEL, TYPE_LONG, 1, longLe(calibration.whiteLevel));
  add(TAG.COLOR_MATRIX_1, TYPE_SRATIONAL, 9, rationalArray(invert3x3(calibration.sensorToXyz), true));
  add(TAG.AS_SHOT_NEUTRAL, TYPE_RATIONAL, 3, rationalArray(asShotNeutral(calibration)));
  add(TAG.CALIBRATION_ILLUMINANT_1, TYPE_SHORT, 1, shortLe(23));
  fields.sort((left, right) => left.tag - right.tag);

  const ifdStart = 8;
  const ifdSize = 2 + fields.length * 12 + 4;
  const offsets = new Map();
  let cursor = ifdStart + ifdSize;
  for (const field of fields) {
    if (field.data.length > 4) {
      if (cursor % 2) cursor += 1;
      offsets.set(field, cursor);
      cursor += field.data.length;
    }
  }
  if (cursor % 2) cursor += 1;
  stripOffset.data = longLe(cursor);
  const output = Buffer.alloc(cursor);
  output.write('II', 0, 'ascii');
  output.writeUInt16LE(42, 2);
  output.writeUInt32LE(ifdStart, 4);
  output.writeUInt16LE(fields.length, ifdStart);
  let entry = ifdStart + 2;
  for (const field of fields) {
    output.writeUInt16LE(field.tag, entry);
    output.writeUInt16LE(field.type, entry + 2);
    output.writeUInt32LE(field.count >>> 0, entry + 4);
    if (field.data.length <= 4) field.data.copy(output, entry + 8);
    else output.writeUInt32LE(offsets.get(field), entry + 8);
    entry += 12;
  }
  output.writeUInt32LE(0, entry);
  for (const field of fields) if (field.data.length > 4) field.data.copy(output, offsets.get(field));
  return output;
}

async function writeBuffer(stream, buffer) {
  if (!stream.write(buffer)) await once(stream, 'drain');
}

async function writeDngFrame(filePath, samples, width, height, calibration, frame) {
  if (!(samples instanceof Uint16Array) || samples.length !== width * height) throw new Error('CinemaDNG mosaic geometry does not match the source frame');
  const header = buildDngHeader(width, height, calibration, frame);
  const hash = crypto.createHash('sha256');
  const output = fs.createWriteStream(filePath, { flags: 'wx', highWaterMark: 4 * 1024 * 1024 });
  try {
    hash.update(header);
    await writeBuffer(output, header);
    const sampleBuffer = os.endianness() === 'LE'
      ? Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)
      : Buffer.from(samples.length * 2);
    if (os.endianness() !== 'LE') for (let index = 0; index < samples.length; index += 1) sampleBuffer.writeUInt16LE(samples[index], index * 2);
    const chunkBytes = 4 * 1024 * 1024;
    for (let offset = 0; offset < sampleBuffer.length; offset += chunkBytes) {
      const chunk = sampleBuffer.subarray(offset, Math.min(sampleBuffer.length, offset + chunkBytes));
      hash.update(chunk);
      await writeBuffer(output, chunk);
    }
    output.end();
    await once(output, 'finish');
  } catch (error) {
    output.destroy();
    throw error;
  }
  return { bytes: header.length + samples.byteLength, sha256: hash.digest('hex') };
}

function sequenceDigest(files) {
  return crypto.createHash('sha256').update(files.map(file => `${file.name}\t${file.bytes}\t${file.sha256}`).join('\n')).digest('hex');
}

async function writeDngSequence(directory, sourcePath, media, progress) {
  if (!media.raw || !['npv10', 'npraw'].includes(media.kind)) throw new Error('CinemaDNG export requires a CamX NPV10 RAW or NPRAW source');
  await fs.promises.mkdir(directory, { recursive: false });
  const files = [];
  let index = 0;
  for await (const frame of rawFrameIterator(sourcePath, media)) {
    const name = `frame_${String(index + 1).padStart(6, '0')}.dng`;
    const calibration = rawCalibration(media, frame);
    const result = await writeDngFrame(path.join(directory, name), frame.samples, media.width, media.height, calibration, frame);
    files.push({ name, ...result, timestampNs: frame.timestamp || null });
    index += 1;
    progress?.({ frame: index, frames: media.frames, ratio: media.frames ? index / media.frames : 0 });
  }
  if (!files.length) throw new Error('CinemaDNG export produced no frames');
  if (media.frames && files.length !== media.frames) throw new Error(`CinemaDNG frame mismatch: expected ${media.frames}, wrote ${files.length}`);
  const digest = sequenceDigest(files);
  const manifest = {
    schema: 'com.neoproc.camx.studio.cinemadng-sequence.v1',
    source: sourcePath,
    width: media.width,
    height: media.height,
    fps: media.fps,
    frames: files.length,
    identityMosaic: true,
    sequenceSha256: digest,
    files
  };
  await fs.promises.writeFile(path.join(directory, 'sequence.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return { ...manifest, bytes: files.reduce((sum, file) => sum + file.bytes, 0) };
}

function inspectDngHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 10 || buffer.toString('ascii', 0, 2) !== 'II' || buffer.readUInt16LE(2) !== 42) {
    throw new Error('Invalid little-endian TIFF/DNG header');
  }
  const ifd = buffer.readUInt32LE(4);
  const count = buffer.readUInt16LE(ifd);
  const tags = new Map();
  for (let index = 0; index < count; index += 1) {
    const offset = ifd + 2 + index * 12;
    tags.set(buffer.readUInt16LE(offset), {
      type: buffer.readUInt16LE(offset + 2), count: buffer.readUInt32LE(offset + 4), value: buffer.readUInt32LE(offset + 8)
    });
  }
  return { tags, width: tags.get(TAG.IMAGE_WIDTH)?.value, height: tags.get(TAG.IMAGE_LENGTH)?.value, photometric: tags.get(TAG.PHOTOMETRIC)?.value & 0xffff };
}

module.exports = { TAG, invert3x3, buildDngHeader, writeDngFrame, writeDngSequence, inspectDngHeader, sequenceDigest };
