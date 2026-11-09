'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { crc32 } = require('./binary-formats');

const AUDIO_MAGIC = Buffer.from([0x4e, 0x50, 0x56, 0x31, 0x30, 0x41, 0x31, 0x00]);
const AUDIO_PACKET_MAGIC = Buffer.from('AAC0', 'ascii');
const AUDIO_FOOTER_MAGIC = Buffer.from('AEND', 'ascii');
const AAC_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
const CAMERA_METADATA_SCHEMA = 'NeoProCamX.MediaSidecar.v1';

function parseDescriptionFields(description) {
  const values = Object.create(null);
  for (const field of String(description || '').split(';')) {
    const separator = field.indexOf('=');
    if (separator <= 0) continue;
    const key = field.slice(0, separator).trim().toLowerCase();
    if (key && values[key] === undefined) values[key] = field.slice(separator + 1).trim();
  }
  return values;
}

function parseCameraMetadataSidecar(filePath, expectedMediaName = path.basename(filePath).replace(/\.metadata\.json$/i, '')) {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size < 2 || stat.size > 1024 * 1024) throw new Error('Camera metadata sidecar has an invalid size');
  let payload;
  try { payload = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error('Camera metadata sidecar is not valid JSON'); }
  if (!payload || Array.isArray(payload) || payload.schema !== CAMERA_METADATA_SCHEMA) {
    throw new Error('Camera metadata sidecar schema is not supported');
  }
  if (typeof payload.file !== 'string' || payload.file.localeCompare(path.basename(expectedMediaName), undefined, { sensitivity: 'accent' }) !== 0) {
    throw new Error('Camera metadata sidecar does not identify this video');
  }
  const allowed = {
    colorStandard: new Set(['BT709', 'BT2020']),
    colorTransfer: new Set(['SDR_VIDEO', 'LINEAR', 'ST2084', 'HLG']),
    colorRange: new Set(['LIMITED', 'FULL'])
  };
  for (const [field, values] of Object.entries(allowed)) {
    if (!values.has(payload[field])) throw new Error(`Camera metadata sidecar has an invalid ${field}`);
  }
  if (typeof payload.workingSpace !== 'string' || !payload.workingSpace.trim() || payload.workingSpace.length > 64 ||
      typeof payload.description !== 'string' || payload.description.length > 256 * 1024) {
    throw new Error('Camera metadata sidecar has invalid color-description fields');
  }
  const peakNits = Number(payload.masteringDisplay?.peakNits);
  const minimumBlackNits = Number(payload.masteringDisplay?.minimumBlackNits);
  if (!Number.isFinite(peakNits) || peakNits < 1 || peakNits > 10000 ||
      !Number.isFinite(minimumBlackNits) || minimumBlackNits < 0 || minimumBlackNits > 10) {
    throw new Error('Camera metadata sidecar has invalid mastering luminance');
  }
  return {
    schema: payload.schema,
    file: payload.file,
    workingSpace: payload.workingSpace.trim(),
    colorStandard: payload.colorStandard,
    colorTransfer: payload.colorTransfer,
    colorRange: payload.colorRange,
    masteringPeakNits: peakNits,
    minimumBlackNits,
    description: payload.description,
    metadataValues: parseDescriptionFields(payload.description)
  };
}

async function readExact(handle, position, length, label) {
  const buffer = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const result = await handle.read(buffer, read, length - read, position + read);
    if (!result.bytesRead) throw new Error(`Truncated ${label}`);
    read += result.bytesRead;
  }
  return buffer;
}

function readJavaUtf(buffer, cursor) {
  if (cursor.offset + 2 > buffer.length) throw new Error('Truncated Java UTF field');
  const length = buffer.readUInt16BE(cursor.offset);
  cursor.offset += 2;
  if (cursor.offset + length > buffer.length) throw new Error('Truncated Java UTF payload');
  const value = buffer.subarray(cursor.offset, cursor.offset + length).toString('utf8');
  cursor.offset += length;
  return value;
}

function parseDevelopColor(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const bytes = fs.readFileSync(filePath);
  if (bytes.length < 20) throw new Error('Develop-color sidecar is truncated');
  const bodyLength = bytes.length - 8;
  if (bytes.subarray(0, 8).toString('ascii') !== 'NEOVDEV1') throw new Error('Invalid develop-color sidecar magic');
  const storedCrc = Number(bytes.readBigUInt64BE(bodyLength) & 0xffffffffn);
  if (crc32(bytes.subarray(0, bodyLength)) !== storedCrc) throw new Error('Develop-color sidecar CRC mismatch');
  const cursor = { offset: 8 };
  const i32 = () => {
    if (cursor.offset + 4 > bodyLength) throw new Error('Develop-color sidecar is truncated');
    const value = bytes.readInt32BE(cursor.offset); cursor.offset += 4; return value;
  };
  const f32 = () => {
    if (cursor.offset + 4 > bodyLength) throw new Error('Develop-color sidecar is truncated');
    const value = bytes.readFloatBE(cursor.offset); cursor.offset += 4; return value;
  };
  const version = i32();
  if (version < 1 || version > 3) throw new Error(`Unsupported develop-color sidecar version ${version}`);
  const result = {
    version, width: i32(), height: i32(), storageBitDepth: i32(), fps: i32(),
    whiteBalance: [f32(), f32(), f32(), f32()],
    workingRgbToXyz: Array.from({ length: 9 }, f32),
    adaptingLuminance: f32(), cctKelvin: f32(), tint: f32(),
    colorSpace: i32(), colorTransfer: i32()
  };
  result.colorProfileTag = readJavaUtf(bytes.subarray(0, bodyLength), cursor);
  result.detailProfileTag = version >= 2 ? readJavaUtf(bytes.subarray(0, bodyLength), cursor) : '';
  result.orientation = version >= 3 ? i32() : 0;
  result.orientation = ((result.orientation % 360) + 360) % 360;
  if (result.orientation % 90 !== 0 || cursor.offset !== bodyLength) throw new Error('Invalid develop-color sidecar payload');
  if (result.width <= 0 || result.height <= 0 || result.fps <= 0 || result.storageBitDepth < 8 || result.storageBitDepth > 16 ||
      result.whiteBalance.some(value => !Number.isFinite(value) || value <= 0) ||
      result.workingRgbToXyz.some(value => !Number.isFinite(value))) {
    throw new Error('Invalid develop-color sidecar values');
  }
  return result;
}

async function probeNpv10Audio(masterPath) {
  const sidecarPath = `${masterPath}.audio.npv10a`;
  const handle = await fs.promises.open(sidecarPath, 'r');
  try {
    const stat = await handle.stat();
    const fixed = await readExact(handle, 0, 36, 'NPV10 audio header');
    if (!fixed.subarray(0, 8).equals(AUDIO_MAGIC)) throw new Error('Invalid NPV10 audio sidecar magic');
    const version = fixed.readUInt32BE(8);
    const sampleRate = fixed.readInt32BE(12);
    const channelCount = fixed.readInt32BE(16);
    const bitRate = fixed.readInt32BE(20);
    const videoOriginSensorTimestampNs = Number(fixed.readBigInt64BE(24));
    const configBytes = fixed.readInt32BE(32);
    if (version !== 1) throw new Error(`Unsupported NPV10 audio sidecar version ${version}`);
    if (sampleRate <= 0 || channelCount <= 0 || bitRate <= 0 || videoOriginSensorTimestampNs <= 0 ||
        configBytes < 1 || configBytes > 4096) throw new Error('Invalid NPV10 audio sidecar header');
    const codecConfig = await readExact(handle, 36, configBytes, 'NPV10 AAC codec configuration');
    let position = 36 + configBytes;
    let payloadBytes = 0;
    let previousPts = -1;
    const packets = [];
    const payloadDigest = crypto.createHash('sha256');
    let footer = null;
    while (position < stat.size) {
      const marker = await readExact(handle, position, 4, 'NPV10 audio packet marker');
      position += 4;
      if (marker.equals(AUDIO_FOOTER_MAGIC)) {
        const bytes = await readExact(handle, position, 24, 'NPV10 audio footer');
        position += 24;
        footer = {
          packetCount: Number(bytes.readBigUInt64BE(0)),
          finalPresentationTimeUs: Number(bytes.readBigInt64BE(8)),
          payloadBytes: Number(bytes.readBigUInt64BE(16))
        };
        break;
      }
      if (!marker.equals(AUDIO_PACKET_MAGIC)) throw new Error('Invalid NPV10 audio packet marker');
      const packetHeader = await readExact(handle, position, 20, 'NPV10 audio packet header');
      position += 20;
      const presentationTimeUs = Number(packetHeader.readBigInt64BE(0));
      const flags = packetHeader.readInt32BE(8);
      const size = packetHeader.readInt32BE(12);
      const expectedCrc = packetHeader.readUInt32BE(16);
      if (!Number.isSafeInteger(presentationTimeUs) || presentationTimeUs < 0 || presentationTimeUs <= previousPts) {
        throw new Error('NPV10 AAC PTS is not strictly monotonic');
      }
      if (size < 1 || size > 1024 * 1024 || position + size > stat.size) throw new Error('Invalid NPV10 AAC packet size');
      const payload = await readExact(handle, position, size, 'NPV10 AAC packet');
      if (crc32(payload) !== expectedCrc) throw new Error(`NPV10 AAC packet CRC mismatch at packet ${packets.length + 1}`);
      const packetSha256 = crypto.createHash('sha256').update(payload).digest('hex');
      payloadDigest.update(payload);
      packets.push({ presentationTimeUs, flags, offset: position, size, sha256: packetSha256 });
      previousPts = presentationTimeUs;
      payloadBytes += size;
      position += size;
    }
    if (!footer || position !== stat.size) throw new Error('NPV10 audio sidecar is missing a valid durable footer');
    if (!packets.length || footer.packetCount !== packets.length || footer.payloadBytes !== payloadBytes ||
        footer.finalPresentationTimeUs <= previousPts) throw new Error('NPV10 audio footer audit mismatch');
    const parsedConfig = parseAudioSpecificConfig(codecConfig, sampleRate, channelCount);
    return {
      sidecarPath, version, sampleRate, channelCount, bitRate, videoOriginSensorTimestampNs,
      codecConfig, packets, packetCount: packets.length, payloadBytes,
      firstPresentationTimeUs: packets[0].presentationTimeUs,
      finalPresentationTimeUs: footer.finalPresentationTimeUs,
      crcValidated: true, monotonicPts: true,
      codec: 'aac', audioObjectType: parsedConfig.profile + 1,
      codecConfigSha256: crypto.createHash('sha256').update(codecConfig).digest('hex'),
      payloadSha256: payloadDigest.digest('hex')
    };
  } finally {
    await handle.close();
  }
}

function parseAudioSpecificConfig(config, fallbackSampleRate, fallbackChannels) {
  if (ArrayBuffer.isView(config) && !Buffer.isBuffer(config)) {
    config = Buffer.from(config.buffer, config.byteOffset, config.byteLength);
  }
  if (!Buffer.isBuffer(config) || config.length < 2) throw new Error('AAC AudioSpecificConfig is missing');
  let objectType = config[0] >>> 3;
  let frequencyIndex = ((config[0] & 0x07) << 1) | (config[1] >>> 7);
  let channelConfig = (config[1] >>> 3) & 0x0f;
  if (objectType === 31 || frequencyIndex === 15) {
    // The camera records AAC-LC at a standard sampling rate. Explicit-frequency/extended object
    // configurations cannot be represented safely by a seven-byte ADTS header.
    throw new Error('Unsupported extended AAC AudioSpecificConfig');
  }
  const expectedFrequencyIndex = AAC_SAMPLE_RATES.indexOf(fallbackSampleRate);
  if (expectedFrequencyIndex < 0) throw new Error(`AAC sample rate ${fallbackSampleRate} cannot be represented in ADTS`);
  if (AAC_SAMPLE_RATES[frequencyIndex] !== fallbackSampleRate) frequencyIndex = expectedFrequencyIndex;
  if (!channelConfig) channelConfig = fallbackChannels;
  if (objectType < 1 || objectType > 4 || channelConfig < 1 || channelConfig > 7) {
    throw new Error('Unsupported AAC profile or channel configuration');
  }
  return { profile: objectType - 1, frequencyIndex, channelConfig };
}

function adtsHeader(payloadBytes, config) {
  const frameBytes = payloadBytes + 7;
  if (payloadBytes < 1 || frameBytes > 0x1fff) throw new Error(`AAC access unit is too large for ADTS: ${payloadBytes}`);
  const header = Buffer.allocUnsafe(7);
  header[0] = 0xff;
  header[1] = 0xf1;
  header[2] = (config.profile << 6) | (config.frequencyIndex << 2) | (config.channelConfig >>> 2);
  header[3] = ((config.channelConfig & 3) << 6) | (frameBytes >>> 11);
  header[4] = (frameBytes >>> 3) & 0xff;
  header[5] = ((frameBytes & 7) << 5) | 0x1f;
  header[6] = 0xfc;
  return header;
}

async function writeAll(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.write(buffer, offset, buffer.length - offset);
    if (!result.bytesWritten) throw new Error('Unable to write conversion companion');
    offset += result.bytesWritten;
  }
}

function commandTime(index, fps) {
  if (index === 0) return '0.000000000';
  // Place the command just before its exact rawvideo input timestamp so rational rates cannot
  // round a command onto the following frame.
  return Math.max(0, index / fps - 0.0000005).toFixed(9);
}

async function prepareConversionCompanions(job) {
  const temporaryPaths = [];
  try {
    if (Array.isArray(job.media.timestamps) && job.media.timestamps.length) {
      const first = job.media.timestamps[0];
      const lines = job.media.timestamps.map((timestamp, index) => {
        const presentationUs = Math.floor((timestamp - first) / 1000);
        return `${commandTime(index, job.media.fps)} setpts@camx_video expr ${presentationUs}/(1000000*TB);`;
      });
      const target = `${job.partialPath}.video-timeline.sendcmd`;
      temporaryPaths.push(target);
      await fs.promises.writeFile(target, `${lines.join('\n')}\n`, { encoding: 'utf8', flag: 'wx' });
      job.media.videoTimelinePath = target;
      job.media.variableFrameRate = true;
    }
    if (job.media.kind === 'npv10' && job.media.audioSidecar) {
      const audio = job.media.audioSidecar;
      const aacPath = `${job.partialPath}.audio.aac`;
      const commandPath = `${job.partialPath}.audio-timeline.sendcmd`;
      temporaryPaths.push(aacPath);
      const source = await fs.promises.open(audio.sidecarPath, 'r');
      let output;
      try {
        output = await fs.promises.open(aacPath, 'wx');
        const config = parseAudioSpecificConfig(audio.codecConfig, audio.sampleRate, audio.channelCount);
        for (const packet of audio.packets) {
          const payload = await readExact(source, packet.offset, packet.size, 'NPV10 AAC packet');
          await writeAll(output, adtsHeader(payload.length, config));
          await writeAll(output, payload);
        }
        await output.sync();
      } finally {
        await Promise.allSettled([source.close(), output?.close()]);
      }
      temporaryPaths.push(commandPath);
      const lines = audio.packets.map((packet, index) => {
        const nominal = index * 1024 / audio.sampleRate;
        return `${Math.max(0, nominal - (index ? 0.0000005 : 0)).toFixed(9)} asetpts@camx_audio expr ${packet.presentationTimeUs}/(1000000*TB);`;
      });
      await fs.promises.writeFile(commandPath, `${lines.join('\n')}\n`, { encoding: 'utf8', flag: 'wx' });
      job.media.audioInputPath = aacPath;
      job.media.audioTimelinePath = commandPath;
    }
    return temporaryPaths;
  } catch (error) {
    await Promise.all(temporaryPaths.map(filePath => fs.promises.rm(filePath, { force: true }).catch(() => {})));
    throw error;
  }
}

module.exports = {
  parseDevelopColor, parseCameraMetadataSidecar, probeNpv10Audio,
  parseAudioSpecificConfig, adtsHeader, prepareConversionCompanions
};
