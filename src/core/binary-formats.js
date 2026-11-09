'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buffer) {
  // Electron 44 ships a native zlib CRC32 implementation. Large CamX frames
  // are tens of megabytes, so the native path avoids spending hundreds of
  // milliseconds in a JavaScript byte loop for every frame.
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buffer) >>> 0;
  let crc = 0xffffffff;
  for (const value of buffer) crc = CRC_TABLE[(crc ^ value) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function readExact(handle, position, length, context) {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) throw new Error(`Truncated ${context}`);
    offset += bytesRead;
  }
  return buffer;
}

function parseMetadata(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index > 0) values[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return values;
}

function payloadBytes(width, height, format) {
  if (/^RAW(12|14)_NPV10_PACKED$/.test(format)) return width * height * 2;
  return (width * height + 2 * Math.ceil(width / 2) * Math.ceil(height / 2)) * 2;
}

function storedBytes(decodedBytes, codec) {
  if (codec === 'PACKED_P010_10_LE_V1') return Math.ceil((decodedBytes / 2) * 10 / 8);
  if (codec === 'CHUNKED_SPLIT_P010_10_LZ4_V2') {
    const samples = decodedBytes / 2;
    const chunks = Math.ceil(samples / 262144);
    return 32 + chunks * 12 + Math.ceil(samples * 10 / 8);
  }
  return decodedBytes;
}

function minimumStoredBytes(decodedBytes, codec) {
  if (codec !== 'CHUNKED_SPLIT_P010_10_LZ4_V2') return storedBytes(decodedBytes, codec);
  const chunks = Math.ceil((decodedBytes / 2) / 262144);
  return 32 + chunks * 13;
}

function validStoredBytes(actual, decodedBytes, codec) {
  return actual >= minimumStoredBytes(decodedBytes, codec) && actual <= storedBytes(decodedBytes, codec);
}

function unpackTenBitPacket(encoded, decodedBytes) {
  const sampleCount = decodedBytes / 2;
  const output = Buffer.allocUnsafe(decodedBytes);
  let sourceOffset = 0;
  let sample = 0;
  while (sample + 3 < sampleCount) {
    const b0 = encoded[sourceOffset++];
    const b1 = encoded[sourceOffset++];
    const b2 = encoded[sourceOffset++];
    const b3 = encoded[sourceOffset++];
    const b4 = encoded[sourceOffset++];
    output.writeUInt16LE((b0 | ((b1 & 0x03) << 8)) << 6, sample++ * 2);
    output.writeUInt16LE(((b1 >>> 2) | ((b2 & 0x0f) << 6)) << 6, sample++ * 2);
    output.writeUInt16LE(((b2 >>> 4) | ((b3 & 0x3f) << 4)) << 6, sample++ * 2);
    output.writeUInt16LE(((b3 >>> 6) | (b4 << 2)) << 6, sample++ * 2);
  }
  let accumulator = 0n;
  let bits = 0n;
  while (sample < sampleCount) {
    while (bits < 10n) {
      if (sourceOffset >= encoded.length) throw new Error('Packed NPV10 packet is truncated');
      accumulator |= BigInt(encoded[sourceOffset++]) << bits;
      bits += 8n;
    }
    output.writeUInt16LE(Number(accumulator & 0x3ffn) << 6, sample++ * 2);
    accumulator >>= 10n;
    bits -= 10n;
  }
  if (sourceOffset !== encoded.length || accumulator !== 0n) throw new Error('Packed NPV10 packet has trailing data');
  return output;
}

function lz4Decompress(encoded, offset, length, expectedBytes) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || length <= 0 ||
      offset < 0 || offset + length > encoded.length || expectedBytes < 0) {
    throw new Error('Invalid NLC2 LZ4 range');
  }
  const output = Buffer.alloc(expectedBytes);
  let input = offset;
  const inputEnd = offset + length;
  let target = 0;
  while (input < inputEnd) {
    const token = encoded[input++];
    let literalLength = token >>> 4;
    if (literalLength === 15) {
      let next;
      do {
        if (input >= inputEnd) throw new Error('Truncated NLC2 literal length');
        next = encoded[input++];
        literalLength += next;
      } while (next === 255);
    }
    if (input + literalLength > inputEnd || target + literalLength > output.length) {
      throw new Error('Invalid NLC2 literal range');
    }
    encoded.copy(output, target, input, input + literalLength);
    input += literalLength;
    target += literalLength;
    if (input === inputEnd) break;
    if (input + 2 > inputEnd) throw new Error('Truncated NLC2 match offset');
    const distance = encoded[input] | (encoded[input + 1] << 8);
    input += 2;
    if (distance < 1 || distance > target) throw new Error('Invalid NLC2 match distance');
    let matchLength = (token & 0x0f) + 4;
    if ((token & 0x0f) === 15) {
      let next;
      do {
        if (input >= inputEnd) throw new Error('Truncated NLC2 match length');
        next = encoded[input++];
        matchLength += next;
      } while (next === 255);
    }
    if (target + matchLength > output.length) throw new Error('NLC2 match exceeds chunk');
    const reference = target - distance;
    // LZ4 matches deliberately permit overlap, so Buffer.copy is not sufficient here.
    for (let index = 0; index < matchLength; index += 1) output[target + index] = output[reference + index];
    target += matchLength;
  }
  if (input !== inputEnd || target !== expectedBytes) throw new Error('NLC2 chunk decoded length mismatch');
  return output;
}

function joinSplitTenBit(split, samples, target, targetOffset) {
  const expectedBytes = Math.ceil(samples * 10 / 8);
  if (split.length !== expectedBytes) throw new Error('NLC2 split chunk size mismatch');
  const highOffset = samples;
  let sample = 0;
  let output = targetOffset;
  while (sample + 4 <= samples) {
    const c0 = split[sample] | ((split[highOffset + (sample >>> 2)] & 0x03) << 8);
    const c1 = split[sample + 1] | (((split[highOffset + (sample >>> 2)] >>> 2) & 0x03) << 8);
    const c2 = split[sample + 2] | (((split[highOffset + (sample >>> 2)] >>> 4) & 0x03) << 8);
    const c3 = split[sample + 3] | (((split[highOffset + (sample >>> 2)] >>> 6) & 0x03) << 8);
    target[output++] = c0;
    target[output++] = (c0 >>> 8) | (c1 << 2);
    target[output++] = (c1 >>> 6) | (c2 << 4);
    target[output++] = (c2 >>> 4) | (c3 << 6);
    target[output++] = c3 >>> 2;
    sample += 4;
  }
  if (sample < samples) {
    let accumulator = 0n;
    let bits = 0n;
    for (; sample < samples; sample += 1) {
      const high = (split[highOffset + (sample >>> 2)] >>> ((sample & 3) * 2)) & 0x03;
      accumulator |= BigInt(split[sample] | (high << 8)) << bits;
      bits += 10n;
      while (bits >= 8n) {
        target[output++] = Number(accumulator & 0xffn);
        accumulator >>= 8n;
        bits -= 8n;
      }
    }
    if (bits > 0n) target[output++] = Number(accumulator & 0xffn);
  }
  if (output !== targetOffset + expectedBytes) throw new Error('NLC2 packed chunk length mismatch');
}

/** Decode the camera's independently chunked, bit-exact NLC2 P010 packet. */
function decodeNlc2Packet(encoded, decodedBytes) {
  if (!Buffer.isBuffer(encoded) || decodedBytes < 0 || decodedBytes % 2 !== 0 || encoded.length < 32) {
    throw new Error('NLC2 packet is truncated');
  }
  if (encoded.subarray(0, 4).toString('ascii') !== 'NLC2') throw new Error('Invalid NLC2 packet magic');
  const version = encoded.readUInt32BE(4);
  const expectedPackedBytes = encoded.readUInt32BE(8);
  const declaredDecodedBytes = encoded.readUInt32BE(12);
  const sampleCount = encoded.readUInt32BE(16);
  const chunkSamples = encoded.readUInt32BE(20);
  const expectedChunks = encoded.readUInt32BE(24);
  const expectedPackedCrc = encoded.readUInt32BE(28);
  if (version !== 1) throw new Error(`Unsupported NLC2 packet version ${version}`);
  if (declaredDecodedBytes !== decodedBytes) throw new Error('NLC2 decoded byte count mismatch');
  if (sampleCount !== decodedBytes / 2) throw new Error('NLC2 sample count mismatch');
  if (chunkSamples !== 262144) throw new Error('Unsupported NLC2 chunk geometry');
  if (expectedChunks !== Math.ceil(sampleCount / chunkSamples)) throw new Error('NLC2 chunk count mismatch');
  if (expectedPackedBytes !== Math.ceil(sampleCount * 10 / 8)) throw new Error('NLC2 packed byte count mismatch');

  const packed = Buffer.alloc(expectedPackedBytes);
  let inputOffset = 32;
  let outputOffset = 0;
  let decodedSamples = 0;
  for (let chunk = 0; chunk < expectedChunks; chunk += 1) {
    if (inputOffset + 12 > encoded.length) throw new Error('NLC2 chunk header is truncated');
    const flags = encoded.readUInt32BE(inputOffset);
    const samples = encoded.readUInt32BE(inputOffset + 4);
    const bodyBytes = encoded.readUInt32BE(inputOffset + 8);
    inputOffset += 12;
    const requiredSamples = Math.min(chunkSamples, sampleCount - decodedSamples);
    if (samples !== requiredSamples || bodyBytes < 1 || inputOffset + bodyBytes > encoded.length) {
      throw new Error('NLC2 chunk shape is invalid');
    }
    const packedChunkBytes = Math.ceil(samples * 10 / 8);
    if (flags === 0) {
      if (bodyBytes !== packedChunkBytes) throw new Error('NLC2 raw chunk size mismatch');
      encoded.copy(packed, outputOffset, inputOffset, inputOffset + bodyBytes);
    } else if (flags === 1) {
      const split = lz4Decompress(encoded, inputOffset, bodyBytes, packedChunkBytes);
      joinSplitTenBit(split, samples, packed, outputOffset);
    } else {
      throw new Error(`Unsupported NLC2 chunk flags: ${flags}`);
    }
    inputOffset += bodyBytes;
    outputOffset += packedChunkBytes;
    decodedSamples += samples;
  }
  if (inputOffset !== encoded.length) throw new Error('NLC2 packet has trailing bytes');
  if (outputOffset !== packed.length || decodedSamples !== sampleCount) throw new Error('NLC2 packet is incomplete');
  if (crc32(packed) !== expectedPackedCrc) throw new Error('NLC2 decoded packed-P010 CRC mismatch');
  return unpackTenBitPacket(packed, decodedBytes);
}

function unpackNpvRawSamples(payload, bitDepth) {
  if (payload.length % 2 !== 0) throw new Error('NPV10 RAW payload has an odd byte count');
  const output = new Uint16Array(payload.length / 2);
  for (let offset = 0; offset < payload.length; offset += 2) {
    const word = payload.readUInt16LE(offset);
    const sample = bitDepth === 12
      ? ((word >>> 6) << 2) | ((word >>> 4) & 0x03)
      : ((word >>> 6) << 4) | ((word >>> 2) & 0x0f);
    output[offset / 2] = sample;
  }
  return output;
}

function unpackNpvRawWords(payload, bitDepth) {
  const samples = unpackNpvRawSamples(payload, bitDepth);
  const output = Buffer.allocUnsafe(samples.length * 2);
  const shift = 16 - bitDepth;
  for (let index = 0; index < samples.length; index += 1) output.writeUInt16LE(samples[index] << shift, index * 2);
  return output;
}

function bayerPixelFormat(value) {
  const key = String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (key.includes('grbg') || key === '1') return 'bayer_grbg16le';
  if (key.includes('gbrg') || key === '2') return 'bayer_gbrg16le';
  if (key.includes('bggr') || key === '3') return 'bayer_bggr16le';
  return 'bayer_rggb16le';
}

async function probeNpv10(filePath) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const prefix = await readExact(handle, 0, 29, 'NPV10 header');
    if (prefix.subarray(0, 5).toString('ascii') !== 'NPV10') throw new Error('Invalid NPV10 file header');
    const version = prefix.readInt32BE(5);
    if (version < 1 || version > 2) throw new Error(`Unsupported NPV10 version ${version}`);
    const width = prefix.readInt32BE(9);
    const height = prefix.readInt32BE(13);
    const fps = prefix.readInt32BE(17);
    const bitDepth = prefix.readInt32BE(21);
    const metadataLength = prefix.readInt32BE(25);
    if (width <= 0 || height <= 0 || fps <= 0 || metadataLength < 0 || metadataLength > 4 * 1024 * 1024) {
      throw new Error('Invalid NPV10 geometry or metadata length');
    }
    const metadata = (await readExact(handle, 29, metadataLength, 'NPV10 metadata')).toString('utf8');
    const values = parseMetadata(metadata);
    const format = String(values.payloadformat || values.format || '').toUpperCase();
    const codec = String(values.packetcodec || 'LEGACY_UNCOMPRESSED').toUpperCase();
    const decodedBytes = payloadBytes(width, height, format);
    if (!['LEGACY_UNCOMPRESSED', 'PACKED_P010_10_LE_V1', 'CHUNKED_SPLIT_P010_10_LZ4_V2'].includes(codec)) {
      throw new Error(`Unsupported NPV10 packet codec ${codec}`);
    }
    const expectedStoredBytes = storedBytes(decodedBytes, codec);
    let position = 29 + metadataLength;
    let frames = 0;
    let firstTimestamp = null;
    let lastTimestamp = null;
    let previousTimestamp = null;
    let lastPositiveDurationNs = null;
    const timestamps = [];
    const warnings = [];
    while (position < stat.size) {
      try {
        const record = await readExact(handle, position, 28, 'NPV10 frame header');
        if (record.subarray(0, 4).toString('ascii') !== 'FRM0') throw new Error(`Invalid NPV10 frame marker at ${position}`);
        const timestamp = Number(record.readBigInt64BE(4));
        const frameWidth = record.readInt32BE(12);
        const frameHeight = record.readInt32BE(16);
        const size = record.readInt32BE(20);
        if (frameWidth !== width || frameHeight !== height || !validStoredBytes(size, decodedBytes, codec) ||
            position + 28 + size > stat.size) {
          throw new Error(`Invalid NPV10 frame ${frames + 1} geometry or payload size`);
        }
        const payload = await readExact(handle, position + 28, size, 'NPV10 frame payload');
        if (crc32(payload) !== record.readUInt32BE(24)) throw new Error(`NPV10 CRC mismatch at frame ${frames + 1}`);
        if (firstTimestamp === null) firstTimestamp = timestamp;
        if (previousTimestamp !== null && timestamp <= previousTimestamp) {
          throw new Error(`NPV10 timestamps are not strictly increasing at frame ${frames + 1}`);
        }
        if (previousTimestamp !== null) {
          const normalizedUs = Math.floor((timestamp - firstTimestamp) / 1000);
          const previousUs = Math.floor((previousTimestamp - firstTimestamp) / 1000);
          if (normalizedUs <= previousUs) throw new Error(`NPV10 timestamps collapse at microsecond precision at frame ${frames + 1}`);
          lastPositiveDurationNs = timestamp - previousTimestamp;
        }
        lastTimestamp = timestamp;
        previousTimestamp = timestamp;
        timestamps.push(timestamp);
        frames += 1;
        position += 28 + size;
      } catch (error) {
        if (frames === 0) throw error;
        warnings.push(`Recovered ${frames} CRC-valid frame(s); ignored ${stat.size - position} trailing byte(s): ${error.message}`);
        break;
      }
    }
    const nominalDurationNs = Math.round(1e9 / fps);
    const durationNs = frames > 1
      ? (lastTimestamp - firstTimestamp) + (lastPositiveDurationNs || nominalDurationNs)
      : nominalDurationNs;
    const duration = durationNs / 1e9;
    const isRaw = format.startsWith('RAW');
    const orientation = Number(values.orientationhintdegrees || 0);
    return {
      kind: 'npv10', container: 'NPV10', filePath, size: stat.size, version, width, height, fps,
      bitDepth, frames, duration, metadata, metadataValues: values, payloadFormat: format,
      packetCodec: codec, decodedBytes, storedBytes: expectedStoredBytes,
      pixelFormat: isRaw ? bayerPixelFormat(values.bayerpattern || values['raw.bayerpattern']) :
        format === 'P010_LE' ? 'p010le' : 'yuv420p10le',
      raw: isRaw, orientation, rotation: orientation, timestamps,
      timingAuthority: 'sensor-nanoseconds', variableFrameRate: frames > 1,
      warnings,
      logicalSize: position, recovered: position !== stat.size
    };
  } finally {
    await handle.close();
  }
}

async function* npv10Frames(filePath, info, progress) {
  const handle = await fs.promises.open(filePath, 'r');
  let position = 29 + Buffer.byteLength(info.metadata, 'utf8');
  try {
    for (let index = 0; index < info.frames; index += 1) {
      const record = await readExact(handle, position, 28, 'NPV10 frame header');
      const size = record.readInt32BE(20);
      const expectedCrc = record.readUInt32BE(24);
      const encoded = await readExact(handle, position + 28, size, 'NPV10 frame payload');
      if (crc32(encoded) !== expectedCrc) throw new Error(`NPV10 CRC mismatch at frame ${index + 1}`);
      let frame;
      if (info.packetCodec === 'PACKED_P010_10_LE_V1') frame = unpackTenBitPacket(encoded, info.decodedBytes);
      else if (info.packetCodec === 'CHUNKED_SPLIT_P010_10_LZ4_V2') frame = decodeNlc2Packet(encoded, info.decodedBytes);
      else frame = encoded;
      if (info.raw) frame = unpackNpvRawWords(frame, info.payloadFormat.includes('12') ? 12 : 14);
      progress?.({ frame: index + 1, frames: info.frames, ratio: (index + 1) / info.frames });
      yield frame;
      position += 28 + size;
    }
  } finally {
    await handle.close();
  }
}

async function* npv10RawFrames(filePath, info) {
  if (!info.raw) throw new Error('NPV10 source is not a RAW mosaic stream');
  const handle = await fs.promises.open(filePath, 'r');
  let position = 29 + Buffer.byteLength(info.metadata, 'utf8');
  try {
    for (let index = 0; index < info.frames; index += 1) {
      const record = await readExact(handle, position, 28, 'NPV10 frame header');
      const timestamp = Number(record.readBigInt64BE(4));
      const size = record.readInt32BE(20);
      const expectedCrc = record.readUInt32BE(24);
      const payload = await readExact(handle, position + 28, size, 'NPV10 RAW frame payload');
      if (crc32(payload) !== expectedCrc) throw new Error(`NPV10 CRC mismatch at frame ${index + 1}`);
      if (info.packetCodec !== 'LEGACY_UNCOMPRESSED') throw new Error('A RAW NPV10 stream cannot use a P010 packet codec');
      const bitDepth = info.payloadFormat.includes('12') ? 12 : 14;
      yield { samples: unpackNpvRawSamples(payload, bitDepth), bitDepth, timestamp, index };
      position += 28 + size;
    }
  } finally {
    await handle.close();
  }
}

function readJavaUtf(buffer, cursor) {
  const length = buffer.readUInt16BE(cursor.offset); cursor.offset += 2;
  const value = buffer.subarray(cursor.offset, cursor.offset + length).toString('utf8');
  cursor.offset += length;
  return value;
}

function parseRawSidecar(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const bytes = fs.readFileSync(filePath);
  if (bytes.length < 20 || bytes.subarray(0, 8).toString('ascii') !== 'NRAWMETA') throw new Error('Invalid develop.meta sidecar');
  const body = bytes.subarray(0, bytes.length - 8);
  const stored = Number(bytes.readBigUInt64BE(bytes.length - 8) & 0xffffffffn);
  if (crc32(body) !== stored) throw new Error('develop.meta CRC mismatch');
  const cursor = { offset: 8 };
  const i32 = () => { const v = bytes.readInt32BE(cursor.offset); cursor.offset += 4; return v; };
  const f32 = () => { const v = bytes.readFloatBE(cursor.offset); cursor.offset += 4; return v; };
  const i64 = () => { const v = Number(bytes.readBigInt64BE(cursor.offset)); cursor.offset += 8; return v; };
  const version = i32();
  const result = {
    version, width: i32(), height: i32(), storageBitDepth: i32(), sensorWhiteLevel: i32(),
    blackLevel: i32(), whiteLevel: i32(), bayerPattern: i32(),
    whiteBalance: [f32(), f32(), f32(), f32()], exposureTimeNs: i64(),
    analogGain: f32(), digitalGain: f32(), noiseS: f32(), noiseO: f32(),
    sensorToXyz: Array.from({ length: 9 }, f32)
  };
  result.fps = i32();
  result.colorProfileTag = readJavaUtf(bytes, cursor);
  result.maximumResolution = version >= 2 ? Boolean(bytes[cursor.offset++]) : false;
  result.orientation = version >= 3 ? i32() : 0;
  if (version >= 4) {
    result.blackLevelRggb = Array.from({ length: 4 }, f32);
    result.lensShadingGrid = Array.from({ length: 36 }, f32);
    result.lensShadingEnabled = Boolean(bytes[cursor.offset++]);
  }
  return result;
}

function nprawCoding(mode) {
  return { predictive: ![0, 5, 10].includes(mode), deflated: ![0, 5, 10].includes(mode) };
}

function unpack12(data, count) {
  const output = new Uint16Array(count);
  let input = 0;
  for (let index = 0; index < count; index += 2) {
    const b0 = data[input++] || 0;
    const b1 = data[input++] || 0;
    output[index] = b0 | ((b1 & 0x0f) << 8);
    if (index + 1 < count) output[index + 1] = ((b1 >>> 4) & 0x0f) | ((data[input++] || 0) << 4);
  }
  return output;
}

function unpack16(data, count) {
  const output = new Uint16Array(count);
  for (let index = 0; index < count; index += 1) output[index] = data.readUInt16LE(index * 2);
  return output;
}

function decodePredictive(data, width, height, bitDepth) {
  const count = width * height;
  const output = new Uint16Array(count);
  const max = (2 ** Math.min(Math.max(bitDepth, 1), 16)) - 1;
  let offset = 0;
  const nextVarInt = () => {
    let value = 0;
    let shift = 0;
    while (offset < data.length && shift <= 28) {
      const byte = data[offset++];
      value |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value >>> 0;
      shift += 7;
    }
    throw new Error('Invalid NPRAW predictive varint');
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const encoded = nextVarInt();
      const residual = (encoded >>> 1) ^ -(encoded & 1);
      let predictor = 0;
      if (x === 0 && y > 0) predictor = output[index - width];
      else if (y === 0 && x > 0) predictor = output[index - 1];
      else if (x > 0 && y > 0) predictor = Math.min(max, Math.max(0, output[index - 1] + output[index - width] - output[index - width - 1]));
      output[index] = Math.min(max, Math.max(0, predictor + residual));
    }
  }
  return output;
}

function decodeBlockRangePayload(payload, width, height, sensorBitDepth, sensorWhiteLevel) {
  if (sensorBitDepth < 1 || sensorBitDepth > 12 || sensorWhiteLevel < 1 || sensorWhiteLevel > 0x0fff) {
    throw new Error(`Invalid block-range sensor domain bits=${sensorBitDepth} white=${sensorWhiteLevel}`);
  }
  if (payload.length < 12) throw new Error('Block-range NPRAW payload is truncated');
  if (payload.subarray(0, 4).toString('ascii') !== 'NBR1') throw new Error('Block-range NPRAW payload has bad magic');
  const tileWidth = payload.readUInt16LE(4);
  const tileHeight = payload.readUInt16LE(6);
  if (tileWidth !== 64 || tileHeight !== 4) {
    throw new Error(`Unsupported block-range tile geometry ${tileWidth}x${tileHeight}`);
  }
  const expectedTiles = Math.ceil(width / tileWidth) * Math.ceil(height / tileHeight);
  if (payload.readUInt32LE(8) !== expectedTiles) {
    throw new Error(`Block-range NPRAW tile count ${payload.readUInt32LE(8)} != ${expectedTiles}`);
  }
  const samples = new Uint16Array(width * height);
  let payloadOffset = 12;
  for (let tileY = 0; tileY < height; tileY += tileHeight) {
    const blockHeight = Math.min(tileHeight, height - tileY);
    for (let tileX = 0; tileX < width; tileX += tileWidth) {
      const blockWidth = Math.min(tileWidth, width - tileX);
      if (payloadOffset > payload.length - 3) throw new Error('Block-range NPRAW tile header is truncated');
      const base = payload.readUInt16LE(payloadOffset);
      const bits = payload[payloadOffset + 2];
      payloadOffset += 3;
      if (base > sensorWhiteLevel || bits > sensorBitDepth) {
        throw new Error(`Invalid block-range tile base=${base} bits=${bits} sensorBits=${sensorBitDepth}`);
      }
      const blockSamples = blockWidth * blockHeight;
      const packedBytes = Math.ceil(blockSamples * bits / 8);
      const packedEnd = payloadOffset + packedBytes;
      if (!Number.isSafeInteger(packedEnd) || packedEnd > payload.length) {
        throw new Error('Block-range NPRAW tile payload is truncated');
      }
      let inputOffset = payloadOffset;
      // The decoder never holds more than 19 bits here: residuals are at most
      // 12 bits and fewer than 12 bits remain before the next byte is loaded.
      // A Number accumulator is therefore exact and avoids one BigInt
      // allocation/shift for every sensor sample in a 4K RAW frame.
      let accumulator = 0;
      let accumulatorBits = 0;
      const residualMask = bits === 0 ? 0 : (1 << bits) - 1;
      for (let localY = 0; localY < blockHeight; localY += 1) {
        const outputRow = (tileY + localY) * width + tileX;
        for (let localX = 0; localX < blockWidth; localX += 1) {
          while (accumulatorBits < bits) {
            if (inputOffset >= packedEnd) throw new Error('Block-range NPRAW residual stream is truncated');
            accumulator |= payload[inputOffset++] << accumulatorBits;
            accumulatorBits += 8;
          }
          const residual = bits === 0 ? 0 : accumulator & residualMask;
          if (bits !== 0) {
            accumulator >>>= bits;
            accumulatorBits -= bits;
          }
          const sample = base + residual;
          if (sample > sensorWhiteLevel) {
            throw new Error(`Block-range NPRAW sample ${sample} exceeds white level ${sensorWhiteLevel}`);
          }
          samples[outputRow + localX] = sample;
        }
      }
      if (inputOffset !== packedEnd || accumulator !== 0) {
        throw new Error('Block-range NPRAW tile has non-canonical padding');
      }
      payloadOffset = packedEnd;
    }
  }
  if (payloadOffset !== payload.length) throw new Error('Block-range NPRAW payload contains trailing bytes');
  return samples;
}

const compandingCache = new Map();
function inverseCompanding(white, bits) {
  const key = `${white}:${bits}`;
  if (compandingCache.has(key)) return compandingCache.get(key);
  const targetMax = (2 ** bits) - 1;
  if (bits >= 16 || white <= targetMax) return null;
  const ratio = white / targetMax;
  const muRatio = mu => mu / Math.log1p(mu);
  let lo = 0.001;
  let hi = 1;
  while (muRatio(hi) < ratio && hi < 1e9) hi *= 2;
  for (let i = 0; i < 100; i += 1) {
    const mid = (lo + hi) / 2;
    if (muRatio(mid) < ratio) lo = mid; else hi = mid;
  }
  const mu = (lo + hi) / 2;
  const denom = Math.log1p(mu);
  const first = new Int32Array(targetMax + 1).fill(-1);
  const last = new Int32Array(targetMax + 1).fill(-1);
  for (let sample = 0; sample <= white; sample += 1) {
    const code = Math.min(targetMax, Math.max(0, Math.round(Math.log1p(mu * sample / white) / denom * targetMax)));
    if (first[code] < 0) first[code] = sample;
    last[code] = sample;
  }
  const inverse = new Uint16Array(targetMax + 1);
  for (let code = 0; code <= targetMax; code += 1) {
    inverse[code] = first[code] >= 0 ? Math.floor((first[code] + last[code]) / 2) : Math.round(code / targetMax * white);
  }
  compandingCache.set(key, inverse);
  return inverse;
}

async function readNprawHeader(handle, position, allowEof = false) {
  const first = Buffer.alloc(42);
  const result = await handle.read(first, 0, 42, position);
  if (result.bytesRead === 0 && allowEof) return null;
  if (result.bytesRead !== 42) throw new Error('Truncated NPRAW header');
  if (first.subarray(0, 5).toString('ascii') !== 'NPRAW') throw new Error(`Invalid NPRAW frame marker at ${position}`);
  const version = first[5];
  if (version < 2 || version > 4) throw new Error(`Unsupported NPRAW version ${version}`);
  const header = {
    version, mode: first.readInt32BE(6), width: first.readInt32BE(10), height: first.readInt32BE(14),
    rowStride: first.readInt32BE(18), pixelStride: first.readInt32BE(22), timestamp: Number(first.readBigInt64BE(26)),
    originalSize: first.readInt32BE(34), compressedSize: first.readInt32BE(38)
  };
  const suffixLength = version >= 3 ? 36 : 28;
  const suffix = await readExact(handle, position + 42, suffixLength, 'NPRAW metadata');
  header.bitDepth = suffix.readInt32BE(0);
  header.blackLevel = suffix.readInt32BE(4);
  header.whiteLevel = suffix.readInt32BE(8);
  header.dynamicRangeStops = suffix.readFloatBE(12);
  header.noiseEstimate = suffix.readFloatBE(16);
  header.crc = Number(suffix.readBigUInt64BE(20) & 0xffffffffn);
  header.compandingType = version >= 3 ? suffix.readInt32BE(28) : 0;
  header.sensorWhiteLevel = version >= 3 ? suffix.readInt32BE(32) : header.whiteLevel;
  header.headerBytes = 42 + suffixLength;
  if (header.width <= 0 || header.height <= 0 || header.width > 16384 || header.height > 16384 || header.compressedSize < 0) {
    throw new Error('Invalid NPRAW frame geometry');
  }
  return header;
}

async function probeNpraw(filePath) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    let position = 0;
    let frames = 0;
    let first;
    let firstTimestamp;
    let lastTimestamp;
    let previousTimestamp;
    let lastPositiveDurationNs = null;
    const timestamps = [];
    const warnings = [];
    while (position < stat.size) {
      try {
        const header = await readNprawHeader(handle, position, true);
        if (!header) break;
        if (!first) { first = header; firstTimestamp = header.timestamp; }
        if (header.width !== first.width || header.height !== first.height) throw new Error('Variable NPRAW geometry is not supported');
        if (previousTimestamp !== undefined && header.timestamp <= previousTimestamp) {
          throw new Error(`NPRAW timestamps are not strictly increasing at frame ${frames + 1}`);
        }
        if (previousTimestamp !== undefined) {
          const normalizedUs = Math.floor((header.timestamp - firstTimestamp) / 1000);
          const previousUs = Math.floor((previousTimestamp - firstTimestamp) / 1000);
          if (normalizedUs <= previousUs) throw new Error(`NPRAW timestamps collapse at microsecond precision at frame ${frames + 1}`);
          lastPositiveDurationNs = header.timestamp - previousTimestamp;
        }
        if (position + header.headerBytes + header.compressedSize > stat.size) throw new Error('Truncated NPRAW payload');
        const payload = await readExact(handle, position + header.headerBytes, header.compressedSize, 'NPRAW payload');
        if (crc32(payload) !== header.crc) throw new Error(`NPRAW CRC mismatch at frame ${frames + 1}`);
        lastTimestamp = header.timestamp;
        previousTimestamp = header.timestamp;
        timestamps.push(header.timestamp);
        position += header.headerBytes + header.compressedSize;
        frames += 1;
      } catch (error) {
        if (frames === 0) throw error;
        warnings.push(`Recovered ${frames} CRC-valid frame(s); ignored ${stat.size - position} trailing byte(s): ${error.message}`);
        break;
      }
    }
    if (!first) throw new Error('NPRAW file contains no frames');
    const sidecarPath = path.join(path.dirname(filePath), 'develop.meta');
    let sidecar = null;
    try { sidecar = parseRawSidecar(sidecarPath); } catch (error) { warnings.push(error.message); }
    if (!sidecar) warnings.push('develop.meta not found; default RGGB calibration will be used');
    const fps = sidecar?.fps || (frames > 1 && lastTimestamp > firstTimestamp ? Math.round((frames - 1) * 1e9 / (lastTimestamp - firstTimestamp)) : 30);
    const nominalDurationNs = Math.round(1e9 / fps);
    const durationNs = frames > 1 ? (lastTimestamp - firstTimestamp) + (lastPositiveDurationNs || nominalDurationNs) : nominalDurationNs;
    const orientation = sidecar?.orientation || 0;
    return {
      kind: 'npraw', container: 'NPRAW', filePath, size: stat.size, version: first.version,
      width: first.width, height: first.height, fps, bitDepth: first.bitDepth, frames,
      duration: durationNs / 1e9, raw: true, pixelFormat: bayerPixelFormat(sidecar?.bayerPattern),
      sidecar, orientation, rotation: orientation, timestamps, timingAuthority: 'sensor-nanoseconds', warnings,
      logicalSize: position, recovered: position !== stat.size
    };
  } finally {
    await handle.close();
  }
}

const CFA_CHANNEL_MAPS = Object.freeze([
  Object.freeze([0, 1, 2, 3]), // RGGB
  Object.freeze([1, 0, 3, 2]), // GRBG
  Object.freeze([2, 3, 0, 1]), // GBRG
  Object.freeze([3, 2, 1, 0])  // BGGR
]);

function cfaChannel(x, y, pattern) {
  const slot = ((y & 1) << 1) | (x & 1);
  return (CFA_CHANNEL_MAPS[pattern] || CFA_CHANNEL_MAPS[0])[slot];
}

function shadingGain(grid, channel, x, y, width, height) {
  if (!grid || grid.length !== 36) return 1;
  const gx = width > 1 ? x * 2 / (width - 1) : 0;
  const gy = height > 1 ? y * 2 / (height - 1) : 0;
  const x0 = Math.floor(gx); const y0 = Math.floor(gy);
  const x1 = Math.min(2, x0 + 1); const y1 = Math.min(2, y0 + 1);
  const tx = gx - x0; const ty = gy - y0;
  const at = (xx, yy) => Number(grid[(yy * 3 + xx) * 4 + channel] || 1);
  return (at(x0, y0) * (1 - tx) + at(x1, y0) * tx) * (1 - ty) +
    (at(x0, y1) * (1 - tx) + at(x1, y1) * tx) * ty;
}

function samplesToBayer16(samples, black, white, sidecar, width, height) {
  const output = Buffer.allocUnsafe(samples.length * 2);
  const pattern = Number(sidecar?.bayerPattern || 0);
  const blackLevels = sidecar?.blackLevelRggb?.length === 4 ? sidecar.blackLevelRggb : [black, black, black, black];
  const gains = sidecar?.whiteBalance?.length === 4 ? sidecar.whiteBalance : [1, 1, 1, 1];
  for (let index = 0; index < samples.length; index += 1) {
    const x = index % width; const y = Math.floor(index / width);
    const channel = cfaChannel(x, y, pattern);
    const floor = Math.max(0, Number(blackLevels[channel] || black || 0));
    const ceiling = Math.max(floor + 1, white || 65535);
    const shading = sidecar?.lensShadingEnabled ? shadingGain(sidecar.lensShadingGrid, channel, x, y, width, height) : 1;
    const linear = (samples[index] - floor) / (ceiling - floor) * Number(gains[channel] || 1) * shading;
    const normalized = Math.min(65535, Math.max(0, Math.round(linear * 65535)));
    output.writeUInt16LE(normalized, index * 2);
  }
  return output;
}

async function* nprawFrames(filePath, info, progress) {
  const handle = await fs.promises.open(filePath, 'r');
  let position = 0;
  try {
    for (let index = 0; index < info.frames; index += 1) {
      const header = await readNprawHeader(handle, position);
      const payload = await readExact(handle, position + header.headerBytes, header.compressedSize, 'NPRAW payload');
      if (crc32(payload) !== header.crc) throw new Error(`NPRAW CRC mismatch at frame ${index + 1}`);
      const samples = decodeNprawSamples(payload, header);
      const black = info.sidecar?.blackLevel ?? header.blackLevel;
      const white = info.sidecar?.whiteLevel ?? header.sensorWhiteLevel ?? header.whiteLevel;
      progress?.({ frame: index + 1, frames: info.frames, ratio: (index + 1) / info.frames });
      yield samplesToBayer16(samples, black, white, info.sidecar, header.width, header.height);
      position += header.headerBytes + header.compressedSize;
    }
  } finally {
    await handle.close();
  }
}

function decodeNprawSamples(payload, header) {
  if (header.version === 4) {
    return decodeBlockRangePayload(
      payload, header.width, header.height, header.bitDepth, header.sensorWhiteLevel
    );
  }
  const coding = nprawCoding(header.mode);
  const decoded = coding.deflated ? zlib.inflateSync(payload) : payload;
  const count = header.width * header.height;
  let samples = coding.predictive ? decodePredictive(decoded, header.width, header.height, header.bitDepth) :
    header.bitDepth <= 12 ? unpack12(decoded, count) : unpack16(decoded, count);
  if (header.compandingType === 1) {
    const inverse = inverseCompanding(header.sensorWhiteLevel, header.bitDepth);
    if (inverse) {
      const restored = new Uint16Array(samples.length);
      for (let i = 0; i < samples.length; i += 1) restored[i] = inverse[samples[i]];
      samples = restored;
    }
  }
  return samples;
}

async function* nprawRawFrames(filePath, info) {
  const handle = await fs.promises.open(filePath, 'r');
  let position = 0;
  try {
    for (let index = 0; index < info.frames; index += 1) {
      const header = await readNprawHeader(handle, position);
      const payload = await readExact(handle, position + header.headerBytes, header.compressedSize, 'NPRAW payload');
      if (crc32(payload) !== header.crc) throw new Error(`NPRAW CRC mismatch at frame ${index + 1}`);
      yield {
        samples: decodeNprawSamples(payload, header),
        bitDepth: header.bitDepth,
        blackLevel: header.blackLevel,
        whiteLevel: header.sensorWhiteLevel || header.whiteLevel,
        noiseEstimate: header.noiseEstimate,
        timestamp: header.timestamp,
        index
      };
      position += header.headerBytes + header.compressedSize;
    }
  } finally {
    await handle.close();
  }
}

function rawFrameIterator(filePath, info) {
  if (info.kind === 'npv10' && info.raw) return npv10RawFrames(filePath, info);
  if (info.kind === 'npraw') return nprawRawFrames(filePath, info);
  throw new Error(`Cinema RAW frames are unavailable for ${info.kind}`);
}

function createFrameStream(filePath, info, progress) {
  // Readable.from() otherwise defaults to object mode and interprets the byte
  // high-water mark as a frame count, defeating backpressure for large RAW clips.
  const options = { objectMode: false, highWaterMark: 8 * 1024 * 1024 };
  if (info.kind === 'npv10') return Readable.from(npv10Frames(filePath, info, progress), options);
  if (info.kind === 'npraw') return Readable.from(nprawFrames(filePath, info, progress), options);
  throw new Error(`No custom frame reader for ${info.kind}`);
}

module.exports = {
  crc32, parseMetadata, payloadBytes, storedBytes, minimumStoredBytes, validStoredBytes,
  unpackTenBitPacket, decodeNlc2Packet, unpackNpvRawSamples, unpackNpvRawWords, decodeBlockRangePayload,
  parseRawSidecar, probeNpv10, probeNpraw, createFrameStream, rawFrameIterator, bayerPixelFormat
};
