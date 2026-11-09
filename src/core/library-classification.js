'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LIBRARY_KIND = Object.freeze({
  SAVED: 'saved',
  CONVERSION: 'conversion'
});
const IMPORT_MANIFEST_SCHEMA = 'com.neoproc.camx.desktop-import.v1';
const IMPORT_MANIFEST_NAME = '.camx-library.json';
const RAW_VIDEO_EXTENSIONS = new Set(['.npv10', '.npraw']);
const DEVELOP_MASTER_NAME = /^DEV(?:SDR|NDR)_/i;

function segmentsOf(item) {
  return Array.isArray(item?.segments)
    ? item.segments.map(segment => String(segment || '').trim()).filter(Boolean)
    : [];
}

function normalizedExtension(item) {
  return String(item?.extension || path.extname(item?.name || item?.filePath || '')).toLowerCase();
}

function hasExactDirectory(item, expected) {
  const wanted = String(expected).toLowerCase();
  return segmentsOf(item).slice(0, -1).some(segment => segment.toLowerCase() === wanted);
}

function hasConversionRoot(item) {
  const directories = segmentsOf(item).slice(0, -1).map(segment => segment.toLowerCase());
  const camx = directories.findIndex(segment => segment === 'camx' || segment === 'neoprocamx');
  return camx >= 0 && directories.slice(camx + 1).some(segment =>
    ['conversion', 'conversionmasters', 'conversion-masters'].includes(segment));
}

function isCompleteNprawMaster(item) {
  const segments = segmentsOf(item);
  const parent = String(segments.at(-2) || '');
  return normalizedExtension(item) === '.npraw' &&
    String(item?.name || '').toLowerCase() === 'stream.npraw' &&
    /^NEO_RADIANCE_RAW_/i.test(parent) &&
    String(item?.sidecar?.name || '').toLowerCase() === 'develop.meta';
}

/**
 * Classifies by the camera's storage contract, not by SDR/RAW colour family.
 * Gallery deliveries are Saved; only intact Cinema Cam acquisition/develop masters
 * are eligible for another render.
 */
function classifyLibraryItem(item = {}) {
  const extension = normalizedExtension(item);
  const name = String(item.name || path.basename(item.filePath || ''));
  const origin = String(item.origin || '').toLowerCase();
  const privateNpv10 = origin === 'camx-private-verified-npv10';
  const privateDevelop = origin === 'camx-private-develop-master';
  const npraw = isCompleteNprawMaster(item) || (extension === '.npraw' && item.kind === 'npraw');
  const npv10 = extension === '.npv10' && (
    privateNpv10 || hasConversionRoot(item) || hasExactDirectory(item, 'CamXNPV10') || item.kind === 'npv10'
  );
  const develop = extension === '.mov' && DEVELOP_MASTER_NAME.test(name) && (
    privateDevelop || hasConversionRoot(item) || Boolean(item.developColorSidecar) || Boolean(item.developColor)
  );
  const conversionEligible = Boolean(npraw || npv10 || develop);
  let conversionKind = null;
  if (npraw) conversionKind = 'npraw';
  else if (npv10) conversionKind = 'npv10';
  else if (develop) conversionKind = /^DEVNDR_/i.test(name) ? 'ndr-master' : 'sdr-master';
  return {
    libraryKind: conversionEligible ? LIBRARY_KIND.CONVERSION : LIBRARY_KIND.SAVED,
    conversionEligible,
    conversionKind,
    mediaCategory: RAW_VIDEO_EXTENSIONS.has(extension) ? 'raw' : 'sdr'
  };
}

function importManifestPath(filePath) {
  return path.join(path.dirname(filePath), IMPORT_MANIFEST_NAME);
}

async function readImportClassification(filePath, stat) {
  try {
    const payload = JSON.parse(await fs.promises.readFile(importManifestPath(filePath), 'utf8'));
    if (payload?.schema !== IMPORT_MANIFEST_SCHEMA || payload.primaryFile !== path.basename(filePath) ||
        ![LIBRARY_KIND.SAVED, LIBRARY_KIND.CONVERSION].includes(payload.libraryKind) ||
        typeof payload.conversionEligible !== 'boolean') return null;
    if (Number.isSafeInteger(payload.sourceBytes) && payload.sourceBytes > 0 && stat?.size !== payload.sourceBytes) return null;
    if (payload.conversionEligible !== (payload.libraryKind === LIBRARY_KIND.CONVERSION)) return null;
    return {
      libraryKind: payload.libraryKind,
      conversionEligible: payload.conversionEligible,
      conversionKind: typeof payload.conversionKind === 'string' ? payload.conversionKind : null,
      phoneSourceId: typeof payload.sourceId === 'string' ? payload.sourceId : null
    };
  } catch {
    return null;
  }
}

function buildImportManifest(item, localPath) {
  const classification = classifyLibraryItem(item);
  return {
    schema: IMPORT_MANIFEST_SCHEMA,
    primaryFile: path.basename(localPath),
    sourceId: String(item.id || ''),
    sourceName: String(item.name || path.basename(localPath)),
    sourceBytes: Number(item.size || 0),
    sourceModifiedAtEpochMs: Number(item.modifiedAtEpochMs || 0),
    libraryKind: classification.libraryKind,
    conversionEligible: classification.conversionEligible,
    conversionKind: classification.conversionKind
  };
}

module.exports = {
  LIBRARY_KIND, IMPORT_MANIFEST_SCHEMA, IMPORT_MANIFEST_NAME,
  classifyLibraryItem, readImportClassification, buildImportManifest
};
