'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { crc32 } = require('./binary-formats');

const MAGIC = Buffer.from('NQISCACH', 'ascii');
const FORMAT_VERSION = 1;
const INSTRUCTION_VERSION = 2;
const RECORD_BYTES = 56;
const FIXED_HEADER_BYTES = MAGIC.length + 12;
const TRAILER_BYTES = 8;

function stableFingerprint(value) {
  return {
    sourceLength: Number(value.sourceLength),
    sourceLastModified: Math.trunc(Number(value.sourceLastModified)),
    sourceSha256: String(value.sourceSha256 || '').toLowerCase(),
    width: Number(value.width),
    height: Number(value.height),
    signalFamily: String(value.signalFamily || ''),
    detailProfile: String(value.detailProfile || ''),
    stageFlags: value.stageFlags || {},
    stageScales: value.stageScales || {},
    frameCount: Number(value.frameCount)
  };
}

function serializeFingerprint(value) {
  return JSON.stringify(stableFingerprint(value));
}

function fingerprintId(value) {
  return crypto.createHash('sha256').update(serializeFingerprint(value)).digest('hex');
}

function cacheFileFor(sourcePath) {
  const absolute = path.resolve(sourcePath);
  return path.join(path.dirname(absolute), `.${path.basename(absolute)}.nqis`);
}

function inspectQualityCache(filePath, expectedFingerprint = null) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const bytes = fs.readFileSync(filePath);
    if (bytes.length < FIXED_HEADER_BYTES + TRAILER_BYTES || !bytes.subarray(0, 8).equals(MAGIC)) return null;
    const version = bytes.readUInt32BE(8);
    const headerLength = bytes.readUInt32BE(12);
    const recordCount = bytes.readUInt32BE(16);
    if (version !== FORMAT_VERSION || headerLength < 2 || headerLength > 1024 * 1024) return null;
    const bodyBytes = FIXED_HEADER_BYTES + headerLength + recordCount * RECORD_BYTES;
    if (bodyBytes + TRAILER_BYTES !== bytes.length) return null;
    const storedCrc = Number(bytes.readBigUInt64BE(bodyBytes) & 0xffffffffn);
    if (crc32(bytes.subarray(0, bodyBytes)) !== storedCrc) return null;
    const header = JSON.parse(bytes.subarray(FIXED_HEADER_BYTES, FIXED_HEADER_BYTES + headerLength).toString('utf8'));
    if (header.instructionVersion !== INSTRUCTION_VERSION || !header.fingerprint) return null;
    const expectedId = expectedFingerprint ? fingerprintId(expectedFingerprint) : header.fingerprintId;
    if (header.fingerprintId !== expectedId || fingerprintId(header.fingerprint) !== header.fingerprintId) return null;
    if (recordCount !== Number(header.fingerprint.frameCount)) return null;
    return {
      filePath, version, instructionVersion: header.instructionVersion,
      fingerprint: header.fingerprint, fingerprintId: header.fingerprintId,
      recordCount, crc32: storedCrc, bytes: bytes.length
    };
  } catch {
    return null;
  }
}

async function publishQualityCache(temporaryPath, sourcePath, expectedFingerprint) {
  const validated = inspectQualityCache(temporaryPath, expectedFingerprint);
  if (!validated) return { written: false, reason: 'worker cache failed validation' };
  const target = cacheFileFor(sourcePath);
  const staged = `${target}-${process.pid}-${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.copyFile(temporaryPath, staged, fs.constants.COPYFILE_EXCL);
    const handle = await fs.promises.open(staged, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    await fs.promises.rm(target, { force: true });
    await fs.promises.rename(staged, target);
    return { written: true, path: target, ...inspectQualityCache(target, expectedFingerprint) };
  } catch (error) {
    await fs.promises.rm(staged, { force: true }).catch(() => {});
    return { written: false, reason: error.message };
  }
}

module.exports = {
  MAGIC, FORMAT_VERSION, INSTRUCTION_VERSION, RECORD_BYTES,
  stableFingerprint, serializeFingerprint, fingerprintId, cacheFileFor,
  inspectQualityCache, publishQualityCache
};
