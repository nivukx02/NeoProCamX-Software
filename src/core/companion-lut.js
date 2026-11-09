'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_LUT_BYTES = 64 * 1024 * 1024;
const MIN_LUT_SIZE = 2;
const MAX_LUT_SIZE = 65;
const VIEWING_LUT_SUFFIX = '_NeoLog_to_Rec709.cube';

function sha256Buffer(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function companionLutPathFor(mediaPath) {
  const absolute = path.resolve(mediaPath);
  const extension = path.extname(absolute);
  return path.join(path.dirname(absolute), `${path.basename(absolute, extension)}${VIEWING_LUT_SUFFIX}`);
}

function numericTriplet(parts, directive) {
  if (parts.length !== 4) throw new Error(`${directive} must contain exactly three values`);
  const values = parts.slice(1).map(Number);
  if (!values.every(Number.isFinite)) throw new Error(`${directive} contains a non-finite value`);
  return values;
}

/** Strictly validate the camera's standard 3D .cube companion before FFmpeg consumes it. */
function parseCubeLut(text) {
  if (typeof text !== 'string' || !text.length || text.includes('\0')) throw new Error('Viewing LUT is empty or invalid');
  let size = null;
  let title = null;
  let domainMin = [0, 0, 0];
  let domainMax = [1, 1, 1];
  let samples = 0;
  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.match(/(?:"[^"]*"|\S+)/g) || [];
    const directive = String(parts[0] || '').toUpperCase();
    if (directive === 'TITLE') {
      title = line.slice(parts[0].length).trim().replace(/^"|"$/g, '');
    } else if (directive === 'LUT_3D_SIZE') {
      if (size !== null) throw new Error('Viewing LUT declares LUT_3D_SIZE more than once');
      size = Number(parts[1]);
      if (parts.length !== 2 || !Number.isInteger(size) || size < MIN_LUT_SIZE || size > MAX_LUT_SIZE) {
        throw new Error(`Viewing LUT size must be an integer from ${MIN_LUT_SIZE} to ${MAX_LUT_SIZE}`);
      }
    } else if (directive === 'LUT_1D_SIZE') {
      throw new Error('NeoLog viewing companion must be a 3D LUT');
    } else if (directive === 'DOMAIN_MIN') {
      domainMin = numericTriplet(parts, directive);
    } else if (directive === 'DOMAIN_MAX') {
      domainMax = numericTriplet(parts, directive);
    } else if (/^[+\-.0-9]/.test(line)) {
      if (parts.length !== 3 || !parts.map(Number).every(Number.isFinite)) {
        throw new Error(`Viewing LUT contains an invalid sample at row ${samples + 1}`);
      }
      samples += 1;
    }
  }
  if (size === null) throw new Error('Viewing LUT does not declare LUT_3D_SIZE');
  if (samples !== size ** 3) throw new Error(`Viewing LUT contains ${samples} samples; expected ${size ** 3}`);
  if (domainMin.some((value, index) => value >= domainMax[index])) throw new Error('Viewing LUT has an invalid domain');
  return { title, size, samples, domainMin, domainMax };
}

function receiptArtifactFor(receipt, lutPath) {
  const resolved = path.resolve(lutPath).toLowerCase();
  const name = path.basename(lutPath).toLowerCase();
  return (receipt?.companionArtifacts || []).find(artifact => {
    if (artifact?.kind !== 'neolog-rec709-viewing-lut') return false;
    const outputPath = String(artifact.outputPath || '');
    return (outputPath && path.resolve(outputPath).toLowerCase() === resolved) ||
      path.basename(outputPath).toLowerCase() === name;
  }) || null;
}

async function inspectCompanionPreviewLut(mediaPath) {
  const lutPath = companionLutPathFor(mediaPath);
  let stat;
  try { stat = await fs.promises.stat(lutPath); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_LUT_BYTES) {
    throw new Error(`Viewing LUT size is outside the supported range: ${path.basename(lutPath)}`);
  }
  const bytes = await fs.promises.readFile(lutPath);
  const cube = parseCubeLut(bytes.toString('utf8'));
  const sha256 = sha256Buffer(bytes);
  let receiptVerified = false;
  const receiptPath = `${path.resolve(mediaPath)}.json`;
  if (fs.existsSync(receiptPath)) {
    const receiptStat = await fs.promises.stat(receiptPath);
    if (receiptStat.isFile() && receiptStat.size > 0 && receiptStat.size <= 4 * 1024 * 1024) {
      const receipt = JSON.parse(await fs.promises.readFile(receiptPath, 'utf8'));
      const artifact = receiptArtifactFor(receipt, lutPath);
      if (artifact?.sha256) {
        if (String(artifact.sha256).toLowerCase() !== sha256) throw new Error('Viewing LUT SHA-256 does not match its conversion receipt');
        receiptVerified = true;
      }
    }
  }
  return {
    kind: 'neolog-rec709-viewing-lut', filePath: lutPath, name: path.basename(lutPath),
    bytes: stat.size, modifiedAt: stat.mtimeMs, sha256, receiptVerified, ...cube
  };
}

module.exports = {
  MAX_LUT_BYTES, MIN_LUT_SIZE, MAX_LUT_SIZE, VIEWING_LUT_SUFFIX,
  companionLutPathFor, parseCubeLut, inspectCompanionPreviewLut
};
