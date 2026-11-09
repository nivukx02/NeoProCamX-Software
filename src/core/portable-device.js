'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const {
  AdbUnavailableError, BRIDGE_TRANSPORT, CamxUsbBridge
} = require('./camx-usb-bridge');
const {
  classifyLibraryItem, buildImportManifest, IMPORT_MANIFEST_NAME
} = require('./library-classification');

const CAMX_LIBRARY_FOLDERS = new Set(['camx', 'neoprocamx', 'camxnpv10']);
const CAMX_MEDIA_EXTENSIONS = new Set([
  '.mov', '.mp4', '.mkv', '.mxf', '.avi', '.webm', '.m4v', '.hevc',
  '.npv10', '.npraw', '.dng', '.raw', '.nivukx'
]);
const CAMX_CAPTURE_PREFIX = /^(?:CAMX_|NPV10_)/i;
const RAW_SESSION_PREFIX = /^NEO_RADIANCE_RAW_/i;
const INCOMPLETE_MEDIA_NAME = /^\./;
const MTP_TRANSPORT = 'mtp';
const MTP_TRANSFER_SCHEMA = 'com.neoproc.camx.mtp-transfer.v1';

function safeSegment(value) {
  return String(value || 'phone-media').replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_').replace(/[. ]+$/g, '').slice(0, 100) || 'phone-media';
}

const RAW_EXTENSIONS = new Set(['.npv10', '.npraw', '.dng', '.raw']);

function portableSegments(item) {
  return Array.isArray(item?.segments)
    ? item.segments.map(segment => String(segment || '').trim()).filter(Boolean)
    : [];
}

function samePortableParent(item, companion) {
  if (!companion) return false;
  if (item.devicePath
    ? companion.devicePath !== item.devicePath
    : String(companion.deviceName || '').toLowerCase() !== String(item.deviceName || '').toLowerCase()) return false;
  const media = portableSegments(item);
  const sidecar = portableSegments(companion);
  if (media.length < 2 || sidecar.length !== media.length) return false;
  return media.slice(0, -1).every((segment, index) =>
    segment.localeCompare(sidecar[index], undefined, { sensitivity: 'accent' }) === 0);
}

function isCamXMetadataCompanion(item, companion) {
  if (!companion) return false;
  if (item.devicePath
    ? companion.devicePath !== item.devicePath
    : String(companion.deviceName || '').toLowerCase() !== String(item.deviceName || '').toLowerCase()) return false;
  const media = portableSegments(item);
  const sidecar = portableSegments(companion);
  const roots = new Set(['dcim', 'movies', 'videos', 'pictures', 'documents', 'download', 'downloads']);
  const mediaRoot = media.findIndex(segment => roots.has(segment.toLowerCase()));
  if (sidecar.length < 4) return false;
  const expected = [
    ...(mediaRoot > 0 ? media.slice(0, mediaRoot) : []),
    'Documents', 'CamX', 'Metadata'
  ];
  const parent = sidecar.slice(0, -1);
  return parent.length === expected.length && parent.every((segment, index) =>
    segment.localeCompare(expected[index], undefined, { sensitivity: 'accent' }) === 0);
}

function validCompanion(item, companion, expectedName, metadataAllowed = false) {
  if (!companion) return true;
  if (String(companion.name || '').localeCompare(expectedName, undefined, { sensitivity: 'accent' }) !== 0) return false;
  const segments = portableSegments(companion);
  if (!segments.length || String(segments.at(-1)).localeCompare(expectedName, undefined, { sensitivity: 'accent' }) !== 0) return false;
  return samePortableParent(item, companion) || (metadataAllowed && isCamXMetadataCompanion(item, companion));
}

function hasSafeCompanions(item) {
  const base = path.basename(item.name, path.extname(item.name));
  return validCompanion(item, item.audioSidecar, `${item.name}.audio.npv10a`) &&
    validCompanion(item, item.developColorSidecar, `${item.name}.devcolor`, true) &&
    validCompanion(item, item.previewLutSidecar, `${base}_NeoLog_to_Rec709.cube`, true) &&
    validCompanion(item, item.cameraMetadataSidecar, `${item.name}.metadata.json`, true) &&
    validCompanion(item, item.conversionCertificateSidecar, `${base}.elite-conversion-certificate.txt`, true);
}

function isRawSessionItem(item) {
  const segments = portableSegments(item);
  const parent = segments.at(-2) || '';
  const sidecar = item?.sidecar;
  return String(item?.name || '').toLowerCase() === 'stream.npraw' &&
    RAW_SESSION_PREFIX.test(parent) &&
    String(sidecar?.name || '').toLowerCase() === 'develop.meta' &&
    samePortableParent(item, sidecar);
}

/**
 * Desktop mirror of CameraMediaLibraryQueryPolicy. Folder identities are exact
 * segments (so MyCamX is not owned), while CAMX_/NPV10_ preserve the camera's
 * legacy filename fallback. RAW sessions fail closed unless develop.meta is
 * present beside stream.npraw.
 */
function isCamXPipelineItem(item) {
  if (!item || typeof item.name !== 'string') return false;
  if (INCOMPLETE_MEDIA_NAME.test(path.basename(item.name))) return false;
  const extension = String(item.extension || path.extname(item.name)).toLowerCase();
  if (!CAMX_MEDIA_EXTENSIONS.has(extension)) return false;
  const segments = portableSegments(item);
  const directories = segments.length ? segments.slice(0, -1) : [];
  const ownedFolder = directories.some(segment => CAMX_LIBRARY_FOLDERS.has(segment.toLowerCase()));
  const ownedName = CAMX_CAPTURE_PREFIX.test(path.basename(item.name));
  if (extension === '.npraw') return ownedFolder && isRawSessionItem(item);
  return ownedFolder || ownedName;
}

function filterCamXPipelineItems(items) {
  const seen = new Set();
  return (Array.isArray(items) ? items : []).filter(item => {
    if (!isCamXPipelineItem(item)) return false;
    const identity = String(item.id || `${item.devicePath || item.deviceName || ''}::${portableSegments(item).join('/')}`);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function categorizePortableItem(item) {
  const extension = String(item?.extension || path.extname(item?.name || '')).toLowerCase();
  const categorized = { ...item, transport: item?.transport || MTP_TRANSPORT, extension };
  const classification = classifyLibraryItem(categorized);
  return { ...categorized, category: classification.mediaCategory, ...classification };
}

function portableArtifacts(item) {
  return [
    item,
    item?.sidecar,
    item?.audioSidecar,
    item?.developColorSidecar,
    item?.previewLutSidecar,
    item?.cameraMetadataSidecar,
    item?.conversionCertificateSidecar
  ].filter(Boolean);
}

function mtpTransferIdentity(items) {
  const artifacts = items.flatMap((item, itemIndex) => portableArtifacts(item).map((artifact, artifactIndex) => ({
    itemIndex,
    artifactIndex,
    id: String(artifact.id || ''),
    devicePath: String(artifact.devicePath || ''),
    segments: portableSegments(artifact),
    name: String(artifact.name || ''),
        size: Number(artifact.size || 0),
        modifiedAtEpochMs: Number(artifact.modifiedAtEpochMs || 0),
        libraryKind: item.libraryKind || classifyLibraryItem(item).libraryKind
  })));
  const canonical = JSON.stringify({ schema: MTP_TRANSFER_SCHEMA, artifacts });
  return {
    schema: MTP_TRANSFER_SCHEMA,
    key: createHash('sha256').update(canonical).digest('hex').slice(0, 24),
    canonical,
    artifacts
  };
}

function consumePortableOutput(state, chunk, onProgress) {
  state.buffer += String(chunk);
  const lines = state.buffer.split(/\r?\n/);
  state.buffer = lines.pop() || '';
  for (const line of lines) {
    if (line.startsWith('#PROGRESS#')) {
      try { onProgress?.(JSON.parse(line.slice(10))); } catch { /* Ignore malformed progress without corrupting the result payload. */ }
    } else if (line.trim()) {
      state.payload.push(line);
    }
  }
}

function finishPortableOutput(state) {
  if (state.buffer.trim()) state.payload.push(state.buffer);
  state.buffer = '';
  return state.payload.join('\n').trim();
}

class PortableDeviceService {
  constructor(options = {}) {
    this.allowAdbFallback = options.allowAdbFallback === true;
    this.bridge = options.bridge || new CamxUsbBridge({
      allowDevelopmentCertificate: options.allowDevelopmentCertificate === true,
      trustedCertificates: options.trustedCertificates
    });
  }

  scriptPath() {
    const packaged = process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'portable-device.ps1'));
    return packaged ? path.join(process.resourcesPath, 'portable-device.ps1') : path.resolve(__dirname, '..', '..', 'scripts', 'portable-device.ps1');
  }

  run(request, onProgress) {
    return new Promise((resolve, reject) => {
      const encoded = Buffer.from(JSON.stringify(request), 'utf8').toString('base64');
      const child = spawn('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', this.scriptPath(), '-RequestBase64', encoded
      ], { windowsHide: true });
      const timeoutMs = request.action === 'copy' ? 12 * 60 * 60 * 1000 :
        request.action === 'devices' ? 15000 : 2 * 60 * 1000;
      let settled = false;
      let lastActivityAt = Date.now();
      let idleTimer = null;
      const rejectOnce = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (idleTimer) clearInterval(idleTimer);
        reject(error);
      };
      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        rejectOnce(new Error(request.action === 'copy' ? 'Phone transfer timed out.' : 'Phone scan timed out. Unlock the phone and reconnect USB File transfer.'));
      }, timeoutMs);
      const output = { buffer: '', payload: [] };
      let stderr = '';
      if (request.action === 'copy') {
        idleTimer = setInterval(() => {
          if (Date.now() - lastActivityAt < 120000) return;
          child.kill('SIGKILL');
          rejectOnce(new Error('Phone transfer stalled for 120 seconds. Reconnect USB and retry; completed MTP chunks were preserved.'));
        }, 1000);
      }
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { lastActivityAt = Date.now(); consumePortableOutput(output, chunk, onProgress); });
      child.stderr.on('data', chunk => { lastActivityAt = Date.now(); stderr += chunk; });
      child.on('error', rejectOnce);
      child.on('close', code => {
        if (settled) return;
        clearTimeout(timeout);
        if (idleTimer) clearInterval(idleTimer);
        const stdout = finishPortableOutput(output);
        if (code !== 0) return rejectOnce(new Error(stderr.trim() || `Portable-device helper exited with code ${code}`));
        try {
          const result = JSON.parse(stdout || '{}');
          settled = true;
          resolve(result);
        } catch {
          rejectOnce(new Error(`Portable-device helper returned invalid data: ${stdout.slice(-500)}`));
        }
      });
    });
  }

  async scan() {
    if (process.platform !== 'win32') return { devices: [], files: [], warnings: ['USB/MTP discovery is currently available on Windows only.'] };
    let mtpResult = null;
    try {
      // Phone inventory is clip-oriented. Individual DNG/RAW still frames are intentionally not
      // enumerated as videos; a RAW video is represented by its atomic stream.npraw master.
      mtpResult = await this.run({ action: 'list', extensions: ['mov', 'mp4', 'mkv', 'mxf', 'avi', 'webm', 'm4v', 'hevc', 'npv10', 'npraw', 'nivukx'] });
      const files = filterCamXPipelineItems(mtpResult.files).map(categorizePortableItem);
      const devices = (mtpResult.devices || []).map(device => ({ ...device, transport: MTP_TRANSPORT }));
      if (devices.length && !(mtpResult.warnings || []).length) {
        return { ...mtpResult, devices, files, authoritative: true };
      }
      mtpResult = { ...mtpResult, devices, files };
    } catch (error) {
      mtpResult = { devices: [], files: [], warnings: [`USB File Transfer discovery failed: ${error.message}`] };
    }
    if (!this.allowAdbFallback) return mtpResult;
    let bridgeResult = null;
    try {
      bridgeResult = await this.bridge.scan();
      if (bridgeResult.authoritative) return bridgeResult;
    } catch (error) {
      if (!(error instanceof AdbUnavailableError)) throw error;
    }
    const warnings = [...(mtpResult.warnings || [])];
    if (!mtpResult.devices?.length && bridgeResult?.warnings?.length) warnings.push(...bridgeResult.warnings);
    return { ...mtpResult, warnings };
  }

  async detectDevices() {
    if (process.platform !== 'win32') return { devices: [], warnings: ['USB/MTP discovery is currently available on Windows only.'] };
    try {
      const result = await this.run({ action: 'devices' });
      if (result.devices?.length) {
        return {
          devices: result.devices.map(device => ({ ...device, transport: MTP_TRANSPORT })),
          warnings: result.warnings || [],
          authoritative: true
        };
      }
    } catch { /* Fall through only when the explicitly enabled compatibility bridge is available. */ }
    if (!this.allowAdbFallback) {
      return { devices: [], warnings: ['No phone found. Unlock Android and select USB File transfer / Android Auto.'] };
    }
    try {
      const bridgeResult = await this.bridge.detectDevices();
      if (bridgeResult.devices.length) return bridgeResult;
    } catch (error) {
      if (!(error instanceof AdbUnavailableError)) throw error;
    }
    return { devices: [], warnings: ['No phone found. Unlock Android and select USB File transfer / Android Auto.'] };
  }

  async importFiles(request, onProgress) {
    if (typeof request?.destination !== 'string' || !request.destination.trim() || !Array.isArray(request?.items) || request.items.length === 0) {
      throw new Error('No phone files selected or destination is missing');
    }
    const bridgeItems = request.items.filter(item => item?.transport === BRIDGE_TRANSPORT);
    if (bridgeItems.length) {
      if (!this.allowAdbFallback) {
        throw new Error('USB debugging transfers are disabled; reconnect with Android USB File Transfer');
      }
      if (bridgeItems.length !== request.items.length) {
        throw new Error('A phone import cannot mix secure CamX bridge and legacy MTP items');
      }
      return this.bridge.importFiles(request, onProgress);
    }
    if (request.items.some(item => !isCamXPipelineItem(item) || !hasSafeCompanions(item))) {
      throw new Error('Phone import rejected media that is not a verified CamX pipeline item');
    }
    const destination = path.resolve(request.destination);
    await fs.promises.mkdir(destination, { recursive: true });
    const identity = mtpTransferIdentity(request.items);
    const cacheRoot = path.join(destination, '.camx-transfer-cache');
    const stagingFolder = path.join(cacheRoot, identity.key);
    const statePath = path.join(stagingFolder, '.transfer.json');
    await fs.promises.mkdir(stagingFolder, { recursive: true });
    const expectedState = JSON.stringify({ schema: identity.schema, key: identity.key, artifacts: identity.artifacts });
    try {
      const existingState = await fs.promises.readFile(statePath, 'utf8');
      if (existingState !== expectedState) throw new Error('Saved MTP transfer identity does not match the selected CamX media');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await fs.promises.writeFile(statePath, expectedState, { encoding: 'utf8', flag: 'wx' });
    }
    const importedRelativePaths = [];
    try {
      for (let index = 0; index < request.items.length; index += 1) {
        const item = request.items[index];
        const stem = safeSegment(path.basename(item.name, item.extension) || item.name);
        const itemFolder = `${String(index + 1).padStart(3, '0')}_${stem}`;
        const targetFolder = path.join(stagingFolder, itemFolder);
        await fs.promises.mkdir(targetFolder, { recursive: true });
        onProgress?.({ state: 'starting', index, total: request.items.length, name: item.name, ratio: index / request.items.length });
        const result = await this.run({ action: 'copy', item, destination: targetFolder }, progress => {
          onProgress?.({ ...progress, index, total: request.items.length, overallRatio: (index + (progress.ratio || 0)) / request.items.length });
        });
        if (!result.localPath || !fs.existsSync(result.localPath)) throw new Error(`Phone transfer did not produce ${item.name}`);
        importedRelativePaths.push(path.relative(stagingFolder, result.localPath));
        if (item.extension === '.npraw' && item.sidecar) {
          await this.run({ action: 'copy', item: item.sidecar, destination: targetFolder }, progress => onProgress?.({ ...progress, index, total: request.items.length }));
        }
        if (item.extension === '.npv10' && item.audioSidecar) {
          await this.run({ action: 'copy', item: item.audioSidecar, destination: targetFolder }, progress => onProgress?.({ ...progress, index, total: request.items.length }));
        }
        if (item.developColorSidecar) {
          await this.run({ action: 'copy', item: item.developColorSidecar, destination: targetFolder }, progress => onProgress?.({ ...progress, index, total: request.items.length }));
        }
        if (item.previewLutSidecar) {
          await this.run({ action: 'copy', item: item.previewLutSidecar, destination: targetFolder }, progress => onProgress?.({ ...progress, index, total: request.items.length }));
        }
        if (item.cameraMetadataSidecar) {
          await this.run({ action: 'copy', item: item.cameraMetadataSidecar, destination: targetFolder }, progress => onProgress?.({ ...progress, index, total: request.items.length }));
        }
        if (item.conversionCertificateSidecar) {
          await this.run({ action: 'copy', item: item.conversionCertificateSidecar, destination: targetFolder }, progress => onProgress?.({ ...progress, index, total: request.items.length }));
        }
        const manifest = `${JSON.stringify(buildImportManifest(item, result.localPath), null, 2)}\n`;
        const manifestPath = path.join(targetFolder, IMPORT_MANIFEST_NAME);
        const existingManifest = await fs.promises.readFile(manifestPath, 'utf8').catch(error => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (existingManifest !== null && existingManifest !== manifest) {
          throw new Error(`Saved import classification does not match ${item.name}`);
        }
        if (existingManifest === null) {
          await fs.promises.writeFile(manifestPath, manifest, { encoding: 'utf8', flag: 'wx' });
        }
      }
    } catch (error) {
      throw new Error(`${error.message} Transfer progress was preserved; reconnect the phone and retry the same selection.`, { cause: error });
    }
    await fs.promises.rm(statePath, { force: true });
    const batch = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    const batchFolder = path.join(destination, `Phone Import ${batch}`);
    await fs.promises.rename(stagingFolder, batchFolder);
    await fs.promises.rmdir(cacheRoot).catch(() => {});
    const imported = importedRelativePaths.map(relativePath => path.join(batchFolder, relativePath));
    const importedItems = imported.map((filePath, index) => ({
      filePath,
      ...classifyLibraryItem(request.items[index]),
      phoneSourceId: request.items[index].id
    }));
    onProgress?.({ state: 'complete', ratio: 1, overallRatio: 1, total: request.items.length });
    return { imported, importedItems };
  }
}

module.exports = {
  PortableDeviceService, safeSegment, categorizePortableItem, consumePortableOutput, finishPortableOutput,
  isCamXPipelineItem, filterCamXPipelineItems, mtpTransferIdentity, portableArtifacts
};
