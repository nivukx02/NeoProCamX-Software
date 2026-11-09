'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const BRIDGE_AUTHORITY = 'com.neoproc.neoproccamx.desktopbridge';
const BRIDGE_PACKAGE = 'com.neoproc.neoproccamx';
const BRIDGE_SCHEMA = 'com.neoproc.camx.desktop-bridge.catalog.v1';
const DIGEST_SCHEMA = 'com.neoproc.camx.desktop-bridge.digest.v1';
const BRIDGE_AUTHENTICATION = 'ADB_RSA_ANDROID_DUMP_PERMISSION';
const BRIDGE_PROTOCOL_VERSION = 1;
const BRIDGE_TRANSPORT = 'camx-adb-provider-v1';
const CATALOG_URI = `content://${BRIDGE_AUTHORITY}/catalog`;
const HEX_256 = /^[a-f0-9]{64}$/;
const SAFE_SERIAL = /^[^\x00-\x20]{1,255}$/;
const PRIMARY_EXTENSIONS = new Set([
  '.mov', '.mp4', '.mkv', '.mxf', '.avi', '.webm', '.m4v', '.hevc',
  '.npv10', '.npraw', '.dng', '.raw', '.nivukx'
]);
const RAW_EXTENSIONS = new Set(['.npv10', '.npraw', '.dng', '.raw']);
const ORIGINS = new Set(['camx-owned-mediastore', 'camx-private-verified-npv10']);
const COMPANION_ROLES = new Set([
  'audio', 'raw-metadata', 'develop-color', 'preview-lut',
  'camera-metadata', 'conversion-certificate'
]);
const TRUSTED_CAMX_CERTIFICATES = new Set([
  // Camera repository NEOPROCAMX_ALLOWED_CERT_SHA256 (release/upload signing identity).
  '5ce08b183cf0d83bf5beff580a30f5c146d9c5966c6a38b3fcdde66381c58e3c',
  // Exact signing identity of the paired debug APK built and device-tested in this workspace.
  '1facfe087589cdb017c306aafccf01a3eb66ca5375edef52a40ea4135f9b9809'
]);

class CamxBridgeProtocolError extends Error {
  constructor(message) {
    super(`CamX secure bridge rejected: ${message}`);
    this.name = 'CamxBridgeProtocolError';
  }
}

class AdbCommandError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'AdbCommandError';
    Object.assign(this, details);
  }
}

class AdbUnavailableError extends AdbCommandError {
  constructor(message, details = {}) {
    super(message, details);
    this.name = 'AdbUnavailableError';
  }
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function requireRecord(value, label) {
  if (!isRecord(value)) throw new CamxBridgeProtocolError(`${label} must be an object`);
  return value;
}

function requireExactKeys(value, allowed, label) {
  const expected = new Set(allowed);
  const keys = Object.keys(value);
  const unknown = keys.filter(key => !expected.has(key));
  const missing = [...expected].filter(key => !Object.prototype.hasOwnProperty.call(value, key));
  if (unknown.length || missing.length) {
    throw new CamxBridgeProtocolError(
      `${label} fields are invalid${missing.length ? `; missing ${missing.join(', ')}` : ''}` +
      `${unknown.length ? `; unknown ${unknown.join(', ')}` : ''}`
    );
  }
}

function requireString(value, label, maximum = 512) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw new CamxBridgeProtocolError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireSafeInteger(value, label, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
    throw new CamxBridgeProtocolError(`${label} must be a ${positive ? 'positive ' : ''}safe integer`);
  }
  return value;
}

function requireFileName(value, label) {
  const name = requireString(value, label, 255);
  if (path.win32.basename(name) !== name || path.posix.basename(name) !== name ||
      /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || name === '.' || name === '..') {
    throw new CamxBridgeProtocolError(`${label} is not a safe file name`);
  }
  const stem = name.split('.')[0].toUpperCase();
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) {
    throw new CamxBridgeProtocolError(`${label} uses a reserved Windows file name`);
  }
  return name;
}

function artifactUri(id) {
  return `content://${BRIDGE_AUTHORITY}/artifact/${id}`;
}

function digestUri(id) {
  return `content://${BRIDGE_AUTHORITY}/digest/${id}`;
}

function categoryForExtension(extension) {
  return RAW_EXTENSIONS.has(extension) ? 'raw' : 'sdr';
}

function expectedCompanionName(media, companion) {
  const base = media.name.slice(0, media.name.length - media.extension.length);
  switch (companion.role) {
    case 'audio': return `${media.name}.audio.npv10a`;
    case 'raw-metadata': return 'develop.meta';
    case 'develop-color': return `${media.name}.devcolor`;
    case 'camera-metadata': return `${media.name}.metadata.json`;
    case 'preview-lut': return `${base}_NeoLog_to_Rec709.cube`;
    case 'conversion-certificate': return `${base}.elite-conversion-certificate.txt`;
    default: return null;
  }
}

function validateArtifact(value, label, { companion = false } = {}) {
  const descriptor = requireRecord(value, label);
  const keys = companion
    ? ['id', 'name', 'extension', 'size', 'modifiedAtEpochMs', 'mimeType', 'role', 'contentUri', 'digestUri']
    : ['id', 'name', 'extension', 'size', 'modifiedAtEpochMs', 'mimeType', 'category', 'origin', 'contentUri', 'digestUri', 'companions'];
  requireExactKeys(descriptor, keys, label);
  if (!HEX_256.test(descriptor.id)) throw new CamxBridgeProtocolError(`${label}.id is not a canonical SHA-256 id`);
  requireFileName(descriptor.name, `${label}.name`);
  const extension = requireString(descriptor.extension, `${label}.extension`, 32);
  if (extension !== extension.toLowerCase() || extension !== path.extname(descriptor.name).toLowerCase()) {
    throw new CamxBridgeProtocolError(`${label}.extension does not match its file name`);
  }
  requireSafeInteger(descriptor.size, `${label}.size`, { positive: true });
  requireSafeInteger(descriptor.modifiedAtEpochMs, `${label}.modifiedAtEpochMs`);
  requireString(descriptor.mimeType, `${label}.mimeType`, 160);
  if (descriptor.contentUri !== artifactUri(descriptor.id) || descriptor.digestUri !== digestUri(descriptor.id)) {
    throw new CamxBridgeProtocolError(`${label} contains a substituted content URI`);
  }
  if (companion) {
    if (!COMPANION_ROLES.has(descriptor.role)) throw new CamxBridgeProtocolError(`${label}.role is unsupported`);
  } else {
    if (!PRIMARY_EXTENSIONS.has(extension)) throw new CamxBridgeProtocolError(`${label}.extension is unsupported`);
    if (!['raw', 'sdr'].includes(descriptor.category) || descriptor.category !== categoryForExtension(extension)) {
      throw new CamxBridgeProtocolError(`${label}.category does not match its media type`);
    }
    if (!ORIGINS.has(descriptor.origin)) throw new CamxBridgeProtocolError(`${label}.origin is not authoritative`);
    if (descriptor.origin === 'camx-private-verified-npv10' && extension !== '.npv10') {
      throw new CamxBridgeProtocolError(`${label} claims an invalid private-master origin`);
    }
    if (!Array.isArray(descriptor.companions) || descriptor.companions.length > 16) {
      throw new CamxBridgeProtocolError(`${label}.companions is invalid`);
    }
  }
  return descriptor;
}

function catalogFingerprint(items) {
  const canonical = [...items].sort((left, right) => left.id.localeCompare(right.id)).map(item => {
    let row = [
      item.id, item.name, String(item.size), String(item.modifiedAtEpochMs), item.category, item.origin
    ].join('\0');
    const companions = [...item.companions].sort((left, right) =>
      left.role.localeCompare(right.role) || left.id.localeCompare(right.id));
    for (const companion of companions) {
      row += `\0${companion.role}\0${companion.id}\0${companion.name}\0${companion.size}`;
    }
    return row;
  }).join('\n');
  return sha256Hex(Buffer.from(canonical, 'utf8'));
}

function validateCatalog(payload, options = {}) {
  let parsed;
  try {
    const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
    if (!text || text.charCodeAt(0) === 0xfeff) throw new Error('empty or BOM-prefixed payload');
    parsed = JSON.parse(text);
  } catch (error) {
    throw new CamxBridgeProtocolError(`catalogue is not canonical JSON (${error.message})`);
  }
  const catalog = requireRecord(parsed, 'catalogue');
  requireExactKeys(catalog, [
    'schema', 'protocolVersion', 'authentication', 'packageName', 'versionName', 'versionCode',
    'signingCertificateSha256', 'deviceIdSha256', 'generatedAtEpochMs', 'catalogFingerprint', 'items'
  ], 'catalogue');
  if (catalog.schema !== BRIDGE_SCHEMA || catalog.protocolVersion !== BRIDGE_PROTOCOL_VERSION ||
      catalog.authentication !== BRIDGE_AUTHENTICATION || catalog.packageName !== BRIDGE_PACKAGE) {
    throw new CamxBridgeProtocolError('catalogue identity or protocol does not match CamX');
  }
  requireString(catalog.versionName, 'catalogue.versionName', 100);
  requireSafeInteger(catalog.versionCode, 'catalogue.versionCode');
  requireSafeInteger(catalog.generatedAtEpochMs, 'catalogue.generatedAtEpochMs', { positive: true });
  if (!HEX_256.test(catalog.signingCertificateSha256) || !HEX_256.test(catalog.deviceIdSha256) ||
      !HEX_256.test(catalog.catalogFingerprint)) {
    throw new CamxBridgeProtocolError('catalogue fingerprints are not canonical SHA-256 values');
  }
  const trusted = new Set([...(options.trustedCertificates || TRUSTED_CAMX_CERTIFICATES)]
    .map(value => String(value).toLowerCase()));
  if (!options.allowDevelopmentCertificate && !trusted.has(catalog.signingCertificateSha256)) {
    throw new CamxBridgeProtocolError('Android signing certificate is not trusted by this CamX Studio build');
  }
  if (!Array.isArray(catalog.items) || catalog.items.length > 100000) {
    throw new CamxBridgeProtocolError('catalogue items must be a bounded array');
  }
  const ids = new Set();
  catalog.items.forEach((item, index) => {
    validateArtifact(item, `catalogue.items[${index}]`);
    if (ids.has(item.id)) throw new CamxBridgeProtocolError('catalogue contains duplicate artifact ids');
    ids.add(item.id);
    const roles = new Set();
    const names = new Set([item.name.toLowerCase()]);
    item.companions.forEach((companion, companionIndex) => {
      validateArtifact(companion, `catalogue.items[${index}].companions[${companionIndex}]`, { companion: true });
      if (ids.has(companion.id)) throw new CamxBridgeProtocolError('catalogue contains duplicate artifact ids');
      ids.add(companion.id);
      if (roles.has(companion.role)) throw new CamxBridgeProtocolError('media contains duplicate companion roles');
      roles.add(companion.role);
      if (names.has(companion.name.toLowerCase())) throw new CamxBridgeProtocolError('media contains colliding file names');
      names.add(companion.name.toLowerCase());
      if (companion.name !== expectedCompanionName(item, companion)) {
        throw new CamxBridgeProtocolError(`companion ${companion.role} does not match the camera naming contract`);
      }
    });
    if (item.extension === '.npraw' && !roles.has('raw-metadata')) {
      throw new CamxBridgeProtocolError('NPRAW media is missing develop.meta');
    }
    if (roles.has('raw-metadata') && item.extension !== '.npraw') {
      throw new CamxBridgeProtocolError('raw metadata is attached to a non-NPRAW item');
    }
    if (roles.has('audio') && item.extension !== '.npv10') {
      throw new CamxBridgeProtocolError('NPV10 audio is attached to a different media type');
    }
  });
  if (catalogFingerprint(catalog.items) !== catalog.catalogFingerprint) {
    throw new CamxBridgeProtocolError('catalogue fingerprint does not match its contents');
  }
  return catalog;
}

function validateDigest(payload, expectedArtifact) {
  let digest;
  try {
    digest = JSON.parse(Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload));
  } catch (error) {
    throw new CamxBridgeProtocolError(`digest is not valid JSON (${error.message})`);
  }
  requireRecord(digest, 'digest');
  requireExactKeys(digest, ['schema', 'artifactId', 'bytes', 'sha256'], 'digest');
  if (digest.schema !== DIGEST_SCHEMA || digest.artifactId !== expectedArtifact.id ||
      !HEX_256.test(digest.sha256)) {
    throw new CamxBridgeProtocolError('digest identity is invalid');
  }
  requireSafeInteger(digest.bytes, 'digest.bytes', { positive: true });
  if (digest.bytes !== expectedArtifact.size) {
    throw new CamxBridgeProtocolError('digest byte count differs from the catalogue');
  }
  return digest;
}

function parseAdbDevices(output) {
  const devices = [];
  String(output || '').split(/\r?\n/).forEach(rawLine => {
    const line = rawLine.trim();
    if (!line || line.startsWith('List of devices') || line.startsWith('*')) return;
    const match = /^(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(line);
    if (!match || !SAFE_SERIAL.test(match[1])) return;
    const properties = {};
    const propertyPattern = /([A-Za-z0-9_.-]+):([^\s]+)/g;
    let property;
    while ((property = propertyPattern.exec(match[3] || '')) !== null) properties[property[1]] = property[2];
    devices.push({ serial: match[1], state: match[2], properties });
  });
  return devices;
}

function adbDisplayName(device) {
  const raw = device.properties.model || device.properties.device || device.properties.product || 'Android phone';
  return raw.replace(/_/g, ' ');
}

function resolveAdbPath() {
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'android-platform-tools', 'adb.exe'));
  candidates.push(path.resolve(__dirname, '..', '..', 'vendor', 'android-platform-tools', 'adb.exe'));
  for (const variable of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) {
    if (process.env[variable]) candidates.push(path.join(process.env[variable], 'platform-tools', 'adb.exe'));
  }
  return candidates.find(candidate => fs.existsSync(candidate)) || 'adb.exe';
}

class AdbProcessRunner {
  constructor(adbPath = resolveAdbPath(), spawnImpl = spawn) {
    this.adbPath = adbPath;
    this.spawnImpl = spawnImpl;
  }

  spawn(args) {
    return this.spawnImpl(this.adbPath, args, {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  }

  capture(args, options = {}) {
    const timeoutMs = options.timeoutMs || 30000;
    const maxBytes = options.maxBytes || 16 * 1024 * 1024;
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawn(args);
      } catch (error) {
        return reject(new AdbUnavailableError(`Android bridge tools could not start: ${error.message}`, { cause: error }));
      }
      const stdout = [];
      const stderr = [];
      let stdoutBytes = 0;
      let settled = false;
      let terminalError = null;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => {
        terminalError = new AdbCommandError('Android bridge command timed out', { args });
        child.kill('SIGKILL');
      }, timeoutMs);
      child.stdout.on('data', chunk => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxBytes) {
          terminalError = new AdbCommandError('Android bridge response exceeded its safety limit', { args });
          child.kill('SIGKILL');
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on('data', chunk => {
        if (stderr.reduce((total, part) => total + part.length, 0) < 256 * 1024) stderr.push(chunk);
      });
      child.on('error', error => finish(
        error.code === 'ENOENT'
          ? new AdbUnavailableError('Bundled Android bridge tools are unavailable', { cause: error, args })
          : new AdbCommandError(`Android bridge command failed to start: ${error.message}`, { cause: error, args })
      ));
      child.on('close', (code, signal) => {
        if (terminalError) return finish(terminalError);
        const output = Buffer.concat(stdout);
        const errorText = Buffer.concat(stderr).toString('utf8').trim();
        if (code !== 0) {
          return finish(new AdbCommandError(
            errorText || `Android bridge command exited with code ${code}`,
            { args, code, signal, stdout: output, stderr: errorText }
          ));
        }
        finish(null, output);
      });
    });
  }

  async stream(args, targetPath, options = {}) {
    const timeoutMs = options.timeoutMs || 12 * 60 * 60 * 1000;
    const maximum = options.maxBytes;
    let child;
    let timer;
    let timedOut = false;
    let byteCount = 0;
    const hash = createHash('sha256');
    const stderr = [];
    try {
      try {
        child = this.spawn(args);
      } catch (error) {
        throw new AdbUnavailableError(`Android bridge tools could not start: ${error.message}`, { cause: error, args });
      }
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.stderr.on('data', chunk => {
        if (stderr.reduce((total, part) => total + part.length, 0) < 256 * 1024) stderr.push(chunk);
      });
      const meter = new Transform({
        transform(chunk, _encoding, callback) {
          byteCount += chunk.length;
          if (Number.isSafeInteger(maximum) && byteCount > maximum) {
            child.kill('SIGKILL');
            callback(new CamxBridgeProtocolError('artifact stream exceeded the catalogue byte count'));
            return;
          }
          hash.update(chunk);
          try { options.onChunk?.(byteCount); } catch (error) { callback(error); return; }
          callback(null, chunk);
        }
      });
      const exitPromise = new Promise((resolve, reject) => {
        child.once('error', error => reject(
          error.code === 'ENOENT'
            ? new AdbUnavailableError('Bundled Android bridge tools are unavailable', { cause: error, args })
            : new AdbCommandError(`Android bridge transfer failed to start: ${error.message}`, { cause: error, args })
        ));
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
      // `flush` fsyncs before the stream closes. Keeping a FileHandle stream open here would make
      // pipeline wait forever for a close event after ADB had already delivered every byte.
      const output = fs.createWriteStream(targetPath, { flags: 'wx', flush: true });
      const pipePromise = pipeline(child.stdout, meter, output)
        .catch(error => { child.kill('SIGKILL'); throw error; });
      const [pipeResult, exitResult] = await Promise.allSettled([pipePromise, exitPromise]);
      if (timedOut) throw new AdbCommandError('CamX phone transfer timed out', { args });
      if (pipeResult.status === 'rejected') throw pipeResult.reason;
      if (exitResult.status === 'rejected') throw exitResult.reason;
      if (exitResult.value.code !== 0) {
        const errorText = Buffer.concat(stderr).toString('utf8').trim();
        throw new AdbCommandError(errorText || 'CamX phone transfer was interrupted', {
          args, code: exitResult.value.code, signal: exitResult.value.signal, stderr: errorText
        });
      }
      return { bytes: byteCount, sha256: hash.digest('hex') };
    } finally {
      clearTimeout(timer);
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }
}

function unavailableProviderMessage(value) {
  return /(?:no content provider|could(?: not|n't) find provider|unknown authority|provider .* not found)/i.test(String(value || ''));
}

function bridgeDevice(device, catalog = null) {
  return {
    id: catalog ? `camx:${catalog.deviceIdSha256}` : `adb:${device.serial}`,
    name: adbDisplayName(device),
    path: `adb://${device.serial}`,
    serial: device.serial,
    transport: BRIDGE_TRANSPORT,
    authorized: device.state === 'device',
    camxVersion: catalog?.versionName || null
  };
}

function bridgeMediaItem(device, catalog, item) {
  const originLabel = item.origin === 'camx-private-verified-npv10' ? 'Verified private NPV10 master' : 'CamX published library';
  return {
    id: `camx-bridge:${catalog.deviceIdSha256}:${item.id}`,
    transport: BRIDGE_TRANSPORT,
    bridgeSerial: device.serial,
    bridgeDeviceId: catalog.deviceIdSha256,
    bridgeArtifactId: item.id,
    deviceName: adbDisplayName(device),
    devicePath: `adb://${device.serial}`,
    name: item.name,
    extension: item.extension,
    size: item.size,
    modifiedAtEpochMs: item.modifiedAtEpochMs,
    mimeType: item.mimeType,
    category: item.category,
    origin: item.origin,
    displayPath: `${originLabel} / secure ADB bridge`
  };
}

function safeFolderSegment(value) {
  return String(value || 'camx-media').replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_')
    .replace(/[. ]+$/g, '').slice(0, 100) || 'camx-media';
}

class CamxUsbBridge {
  constructor(options = {}) {
    this.runner = options.runner || new AdbProcessRunner(options.adbPath);
    this.allowDevelopmentCertificate = options.allowDevelopmentCertificate === true;
    this.trustedCertificates = options.trustedCertificates || TRUSTED_CAMX_CERTIFICATES;
    this.deviceIdentityBySerial = new Map();
  }

  async adbDevices() {
    const output = await this.runner.capture(['devices', '-l'], { timeoutMs: 15000, maxBytes: 1024 * 1024 });
    return parseAdbDevices(output.toString('utf8'));
  }

  async hasCamxPackage(serial) {
    try {
      const result = await this.runner.capture(
        ['-s', serial, 'shell', 'pm', 'path', BRIDGE_PACKAGE],
        { timeoutMs: 10000, maxBytes: 64 * 1024 }
      );
      return /^package:/m.test(result.toString('utf8'));
    } catch {
      return false;
    }
  }

  async relevantDevices() {
    const listed = await this.adbDevices();
    const result = [];
    for (const device of listed) {
      if (device.state !== 'device') {
        result.push({ ...device, hasCamx: null });
      } else if (await this.hasCamxPackage(device.serial)) {
        result.push({ ...device, hasCamx: true });
      }
    }
    return result.sort((left, right) => {
      const leftNetwork = left.serial.includes(':') ? 1 : 0;
      const rightNetwork = right.serial.includes(':') ? 1 : 0;
      return leftNetwork - rightNetwork || left.serial.localeCompare(right.serial);
    });
  }

  validateCatalog(payload) {
    return validateCatalog(payload, {
      trustedCertificates: this.trustedCertificates,
      allowDevelopmentCertificate: this.allowDevelopmentCertificate
    });
  }

  async readCatalog(serial, { legacyAllowed = false } = {}) {
    let payload;
    try {
      payload = await this.runner.capture(
        ['-s', serial, 'exec-out', 'content', 'read', '--uri', CATALOG_URI],
        { timeoutMs: 120000, maxBytes: 64 * 1024 * 1024 }
      );
    } catch (error) {
      if (legacyAllowed && unavailableProviderMessage(`${error.message}\n${error.stderr || ''}`)) return null;
      throw error;
    }
    const text = payload.toString('utf8');
    if (legacyAllowed && unavailableProviderMessage(text)) return null;
    return this.validateCatalog(payload);
  }

  async detectDevices() {
    const devices = await this.relevantDevices();
    const warnings = devices.some(device => device.state === 'unauthorized')
      ? ['Authorize this computer for USB debugging on the CamX phone.']
      : devices.some(device => device.state !== 'device')
        ? ['The CamX phone is visible to ADB but is not ready.'] : [];
    const seen = new Set();
    const detected = [];
    for (const device of devices) {
      const cached = this.deviceIdentityBySerial.get(device.serial);
      const identity = cached?.deviceIdSha256 || `serial:${device.serial}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      detected.push(bridgeDevice(device, cached));
    }
    return { devices: detected, warnings, authoritative: false };
  }

  async scan() {
    const candidates = await this.relevantDevices();
    const warnings = [];
    const devices = [];
    const files = [];
    const seenDeviceIds = new Set();
    let legacyDetected = false;
    for (const device of candidates) {
      if (device.state !== 'device') {
        if (device.state === 'unauthorized') warnings.push('Authorize USB debugging on the CamX phone to use the secure library.');
        continue;
      }
      const catalog = await this.readCatalog(device.serial, { legacyAllowed: true });
      if (!catalog) {
        legacyDetected = true;
        continue;
      }
      this.deviceIdentityBySerial.set(device.serial, {
        deviceIdSha256: catalog.deviceIdSha256,
        versionName: catalog.versionName
      });
      if (seenDeviceIds.has(catalog.deviceIdSha256)) continue;
      seenDeviceIds.add(catalog.deviceIdSha256);
      devices.push(bridgeDevice(device, catalog));
      files.push(...catalog.items.map(item => bridgeMediaItem(device, catalog, item)));
    }
    return {
      devices,
      files,
      warnings: devices.length ? [] : warnings,
      authoritative: devices.length > 0,
      legacyDetected
    };
  }

  async transferArtifact(serial, artifact, targetPath, onProgress) {
    const partialPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${randomUUID()}.partial`);
    try {
      let lastUpdate = 0;
      const streamed = await this.runner.stream(
        ['-s', serial, 'exec-out', 'content', 'read', '--uri', artifact.contentUri],
        partialPath,
        {
          timeoutMs: 12 * 60 * 60 * 1000,
          maxBytes: artifact.size,
          onChunk: bytes => {
            const now = Date.now();
            if (bytes === artifact.size || now - lastUpdate >= 100) {
              lastUpdate = now;
              onProgress?.(bytes);
            }
          }
        }
      );
      if (streamed.bytes !== artifact.size) {
        throw new CamxBridgeProtocolError(`artifact ${artifact.name} ended before its catalogue byte count`);
      }
      onProgress?.(artifact.size, 'verifying');
      const digestPayload = await this.runner.capture(
        ['-s', serial, 'exec-out', 'content', 'read', '--uri', artifact.digestUri],
        { timeoutMs: 12 * 60 * 60 * 1000, maxBytes: 1024 * 1024 }
      );
      const digest = validateDigest(digestPayload, artifact);
      if (streamed.sha256 !== digest.sha256) {
        throw new CamxBridgeProtocolError(`SHA-256 verification failed for ${artifact.name}`);
      }
      await fs.promises.rename(partialPath, targetPath);
      return targetPath;
    } catch (error) {
      await fs.promises.rm(partialPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async resolveImportItems(requestItems) {
    const listed = await this.adbDevices();
    const ready = new Map(listed.filter(device => device.state === 'device').map(device => [device.serial, device]));
    const catalogBySerial = new Map();
    const selected = [];
    const seen = new Set();
    for (const request of requestItems) {
      if (!isRecord(request) || request.transport !== BRIDGE_TRANSPORT ||
          !SAFE_SERIAL.test(request.bridgeSerial || '') || !HEX_256.test(request.bridgeDeviceId || '') ||
          !HEX_256.test(request.bridgeArtifactId || '')) {
        throw new CamxBridgeProtocolError('desktop import request is malformed');
      }
      if (!ready.has(request.bridgeSerial)) throw new Error('The selected CamX phone is no longer connected or authorized');
      if (seen.has(request.id)) throw new CamxBridgeProtocolError('desktop import request contains duplicate media');
      seen.add(request.id);
      if (!catalogBySerial.has(request.bridgeSerial)) {
        if (!await this.hasCamxPackage(request.bridgeSerial)) throw new Error('CamX is no longer installed on the selected phone');
        catalogBySerial.set(request.bridgeSerial, await this.readCatalog(request.bridgeSerial));
      }
      const catalog = catalogBySerial.get(request.bridgeSerial);
      if (catalog.deviceIdSha256 !== request.bridgeDeviceId ||
          request.id !== `camx-bridge:${catalog.deviceIdSha256}:${request.bridgeArtifactId}`) {
        throw new CamxBridgeProtocolError('desktop import request does not belong to this phone');
      }
      const item = catalog.items.find(candidate => candidate.id === request.bridgeArtifactId);
      if (!item) throw new Error('The selected CamX video is no longer published on the phone');
      selected.push({ serial: request.bridgeSerial, item });
    }
    return selected;
  }

  async importFiles(request, onProgress) {
    if (typeof request?.destination !== 'string' || !request.destination.trim() ||
        !Array.isArray(request?.items) || request.items.length === 0) {
      throw new Error('No CamX phone files selected or destination is missing');
    }
    const selected = await this.resolveImportItems(request.items);
    const destination = path.resolve(request.destination);
    await fs.promises.mkdir(destination, { recursive: true });
    const batch = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    const batchFolder = path.join(destination, `Phone Import ${batch}`);
    await fs.promises.mkdir(batchFolder, { recursive: true });
    const totalBytes = selected.reduce((sum, entry) =>
      sum + entry.item.size + entry.item.companions.reduce((part, artifact) => part + artifact.size, 0), 0);
    let completedBytes = 0;
    const imported = [];
    try {
      for (let index = 0; index < selected.length; index += 1) {
        const { serial, item } = selected[index];
        const itemFolder = `${String(index + 1).padStart(3, '0')}_${safeFolderSegment(
          path.basename(item.name, item.extension) || item.name
        )}`;
        const targetFolder = path.join(batchFolder, itemFolder);
        await fs.promises.mkdir(targetFolder, { recursive: true });
        const artifacts = [item, ...item.companions];
        const itemBytes = artifacts.reduce((sum, artifact) => sum + artifact.size, 0);
        let itemCompleted = 0;
        for (const artifact of artifacts) {
          const targetPath = path.join(targetFolder, artifact.name);
          onProgress?.({
            state: 'starting', index, total: selected.length, name: artifact.name,
            ratio: itemCompleted / itemBytes, overallRatio: completedBytes / totalBytes
          });
          await this.transferArtifact(serial, artifact, targetPath, (bytes, stage) => {
            onProgress?.({
              state: stage === 'verifying' ? 'verifying' : 'copying',
              index,
              total: selected.length,
              name: artifact.name,
              bytes,
              artifactBytes: artifact.size,
              ratio: (itemCompleted + bytes) / itemBytes,
              overallRatio: (completedBytes + bytes) / totalBytes
            });
          });
          itemCompleted += artifact.size;
          completedBytes += artifact.size;
          if (artifact.id === item.id) imported.push(targetPath);
        }
      }
    } catch (error) {
      await fs.promises.rm(batchFolder, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    onProgress?.({ state: 'complete', ratio: 1, overallRatio: 1, total: selected.length });
    return { imported };
  }
}

module.exports = {
  AdbCommandError,
  AdbProcessRunner,
  AdbUnavailableError,
  BRIDGE_AUTHORITY,
  BRIDGE_PACKAGE,
  BRIDGE_SCHEMA,
  BRIDGE_TRANSPORT,
  CamxBridgeProtocolError,
  CamxUsbBridge,
  DIGEST_SCHEMA,
  TRUSTED_CAMX_CERTIFICATES,
  artifactUri,
  catalogFingerprint,
  digestUri,
  parseAdbDevices,
  resolveAdbPath,
  validateCatalog,
  validateDigest
};
