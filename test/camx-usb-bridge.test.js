'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const {
  AdbProcessRunner,
  BRIDGE_SCHEMA,
  BRIDGE_TRANSPORT,
  CamxBridgeProtocolError,
  CamxUsbBridge,
  artifactUri,
  catalogFingerprint,
  digestUri,
  parseAdbDevices,
  validateCatalog
} = require('../src/core/camx-usb-bridge');

const CERTIFICATE = 'a'.repeat(64);
const DEVICE_ID = 'b'.repeat(64);
const SERIAL = 'CAMX123';

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function descriptor(name, bytes, role = null) {
  const id = hash(`${role || 'media'}:${name}`);
  const value = {
    id,
    name,
    extension: path.extname(name).toLowerCase(),
    size: bytes.length,
    modifiedAtEpochMs: 1788600000000,
    mimeType: 'application/octet-stream',
    contentUri: artifactUri(id),
    digestUri: digestUri(id)
  };
  if (role) value.role = role;
  return value;
}

function fixture() {
  const bytes = {
    media: Buffer.from('verified-camx-video'),
    audio: Buffer.from('verified-camera-audio')
  };
  const media = {
    ...descriptor('NPV10_fixture.npv10', bytes.media),
    category: 'raw',
    origin: 'camx-private-verified-npv10',
    companions: [descriptor('NPV10_fixture.npv10.audio.npv10a', bytes.audio, 'audio')]
  };
  const catalog = {
    schema: BRIDGE_SCHEMA,
    protocolVersion: 1,
    authentication: 'ADB_RSA_ANDROID_DUMP_PERMISSION',
    packageName: 'com.neoproc.neoproccamx',
    versionName: '19.11.2005',
    versionCode: 19112005,
    signingCertificateSha256: CERTIFICATE,
    deviceIdSha256: DEVICE_ID,
    generatedAtEpochMs: 1788600000000,
    catalogFingerprint: '',
    items: [media]
  };
  catalog.catalogFingerprint = catalogFingerprint(catalog.items);
  return { catalog, media, bytes };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function digestPayload(artifact, bytes, override = {}) {
  return Buffer.from(JSON.stringify({
    schema: 'com.neoproc.camx.desktop-bridge.digest.v1',
    artifactId: artifact.id,
    bytes: bytes.length,
    sha256: hash(bytes),
    ...override
  }));
}

class FixtureRunner {
  constructor(data, options = {}) {
    this.data = data;
    this.badDigestFor = options.badDigestFor || null;
    this.calls = [];
  }

  async capture(args) {
    this.calls.push(['capture', ...args]);
    if (args[0] === 'devices') {
      return Buffer.from(`List of devices attached\n${SERIAL} device product:camx model:CamX_Pro device:camx transport_id:7\n`);
    }
    if (args.includes('pm') && args.includes('path')) return Buffer.from('package:/data/app/camx/base.apk\n');
    const uri = args.at(-1);
    if (uri.endsWith('/catalog')) return Buffer.from(JSON.stringify(this.data.catalog));
    const artifact = [this.data.media, ...this.data.media.companions].find(value => value.digestUri === uri);
    if (artifact) {
      const key = artifact.role || 'media';
      return digestPayload(artifact, this.data.bytes[key],
        this.badDigestFor === artifact.id ? { sha256: 'f'.repeat(64) } : {});
    }
    throw new Error(`Unexpected fixture capture: ${args.join(' ')}`);
  }

  async stream(args, targetPath, options = {}) {
    this.calls.push(['stream', ...args]);
    const uri = args.at(-1);
    const artifact = [this.data.media, ...this.data.media.companions].find(value => value.contentUri === uri);
    if (!artifact) throw new Error(`Unexpected fixture stream: ${uri}`);
    const bytes = this.data.bytes[artifact.role || 'media'];
    await fs.promises.writeFile(targetPath, bytes, { flag: 'wx' });
    options.onChunk?.(bytes.length);
    return { bytes: bytes.length, sha256: hash(bytes) };
  }
}

test('ADB device parser preserves states and decodes model labels', () => {
  const devices = parseAdbDevices([
    'List of devices attached',
    'USB123 device product:i2405 model:CamX_Pro device:i2405 transport_id:3',
    '10.0.0.4:5555 unauthorized transport_id:4',
    'OFFLINE offline',
    ''
  ].join('\r\n'));
  assert.deepEqual(devices, [
    {
      serial: 'USB123', state: 'device',
      properties: { product: 'i2405', model: 'CamX_Pro', device: 'i2405', transport_id: '3' }
    },
    { serial: '10.0.0.4:5555', state: 'unauthorized', properties: { transport_id: '4' } },
    { serial: 'OFFLINE', state: 'offline', properties: {} }
  ]);
});

test('real ADB process runner flushes, closes and resolves an atomic staging stream', async t => {
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'camx-adb-stream-'));
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  const target = path.join(destination, 'artifact.partial');
  const payload = Buffer.alloc(1024 * 1024 + 17, 0x5a);
  const fakeSpawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.end(payload);
      child.stderr.end();
      child.exitCode = 0;
      child.emit('close', 0, null);
    });
    return child;
  };
  const runner = new AdbProcessRunner('fake-adb.exe', fakeSpawn);
  let timeout;
  const result = await Promise.race([
    runner.stream(['exec-out'], target, { maxBytes: payload.length }),
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('stream finalization timed out')), 3000);
    })
  ]).finally(() => clearTimeout(timeout));
  assert.deepEqual(result, { bytes: payload.length, sha256: hash(payload) });
  assert.deepEqual(fs.readFileSync(target), payload);
});

test('catalogue validation recomputes the fingerprint and enforces the signing identity', () => {
  const { catalog } = fixture();
  const valid = validateCatalog(JSON.stringify(catalog), { trustedCertificates: [CERTIFICATE] });
  assert.equal(valid.items[0].name, 'NPV10_fixture.npv10');

  const tampered = clone(catalog);
  tampered.items[0].size += 1;
  assert.throws(
    () => validateCatalog(JSON.stringify(tampered), { trustedCertificates: [CERTIFICATE] }),
    /catalogue fingerprint does not match/
  );
  assert.throws(
    () => validateCatalog(JSON.stringify(catalog), { trustedCertificates: ['c'.repeat(64)] }),
    /signing certificate is not trusted/
  );
});

test('catalogue validation rejects substituted paths, package identity and companion contracts', () => {
  const { catalog } = fixture();
  const pathAttack = clone(catalog);
  pathAttack.items[0].name = '..\\outside.npv10';
  pathAttack.items[0].extension = '.npv10';
  pathAttack.catalogFingerprint = catalogFingerprint(pathAttack.items);
  assert.throws(
    () => validateCatalog(JSON.stringify(pathAttack), { trustedCertificates: [CERTIFICATE] }),
    /safe file name/
  );

  const packageAttack = clone(catalog);
  packageAttack.packageName = 'com.example.fake';
  assert.throws(
    () => validateCatalog(JSON.stringify(packageAttack), { trustedCertificates: [CERTIFICATE] }),
    /identity or protocol/
  );

  const companionAttack = clone(catalog);
  companionAttack.items[0].companions[0].contentUri = artifactUri('d'.repeat(64));
  companionAttack.catalogFingerprint = catalogFingerprint(companionAttack.items);
  assert.throws(
    () => validateCatalog(JSON.stringify(companionAttack), { trustedCertificates: [CERTIFICATE] }),
    /substituted content URI/
  );
});

test('secure scan returns only provider catalogue items with opaque desktop references', async () => {
  const data = fixture();
  const runner = new FixtureRunner(data);
  const bridge = new CamxUsbBridge({ runner, trustedCertificates: [CERTIFICATE] });
  const result = await bridge.scan();
  assert.equal(result.authoritative, true);
  assert.deepEqual(result.devices.map(device => device.name), ['CamX Pro']);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].transport, BRIDGE_TRANSPORT);
  assert.equal(result.files[0].bridgeArtifactId, data.media.id);
  assert.equal(result.files[0].category, 'raw');
  assert.equal(Object.hasOwn(result.files[0], 'contentUri'), false);
});

test('USB and Wi-Fi ADB routes for one CamX installation stay deduplicated during polling', async () => {
  const data = fixture();
  class DualRouteRunner extends FixtureRunner {
    async capture(args) {
      if (args[0] === 'devices') {
        return Buffer.from([
          'List of devices attached',
          '10.0.0.4:5555 device product:camx model:CamX_Pro transport_id:8',
          'USB123 device product:camx model:CamX_Pro transport_id:7',
          ''
        ].join('\n'));
      }
      return super.capture(args);
    }
  }
  const bridge = new CamxUsbBridge({ runner: new DualRouteRunner(data), trustedCertificates: [CERTIFICATE] });
  const inventory = await bridge.scan();
  const polling = await bridge.detectDevices();
  assert.equal(inventory.devices.length, 1);
  assert.equal(polling.devices.length, 1);
  assert.equal(polling.devices[0].path, 'adb://USB123');
});

test('secure import publishes verified media and companions only after SHA-256 succeeds', async t => {
  const data = fixture();
  const runner = new FixtureRunner(data);
  const bridge = new CamxUsbBridge({ runner, trustedCertificates: [CERTIFICATE] });
  const inventory = await bridge.scan();
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'camx-bridge-success-'));
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  const progress = [];
  const result = await bridge.importFiles({ destination, items: inventory.files }, event => progress.push(event));
  assert.equal(result.imported.length, 1);
  assert.deepEqual(fs.readFileSync(result.imported[0]), data.bytes.media);
  assert.deepEqual(
    fs.readFileSync(path.join(path.dirname(result.imported[0]), data.media.companions[0].name)),
    data.bytes.audio
  );
  assert.ok(progress.some(event => event.state === 'verifying'));
  assert.equal(progress.at(-1).overallRatio, 1);
  assert.equal(fs.readdirSync(path.dirname(result.imported[0])).some(name => name.endsWith('.partial')), false);
});

test('checksum mismatch removes every partial and rolls back the import batch', async t => {
  const data = fixture();
  const runner = new FixtureRunner(data, { badDigestFor: data.media.id });
  const bridge = new CamxUsbBridge({ runner, trustedCertificates: [CERTIFICATE] });
  const inventory = await bridge.scan();
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'camx-bridge-reject-'));
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  await assert.rejects(
    bridge.importFiles({ destination, items: inventory.files }),
    error => error instanceof CamxBridgeProtocolError && /SHA-256 verification failed/.test(error.message)
  );
  assert.deepEqual(fs.readdirSync(destination), []);
});

test('secure import re-reads the catalogue and rejects a forged renderer selection', async t => {
  const data = fixture();
  const bridge = new CamxUsbBridge({ runner: new FixtureRunner(data), trustedCertificates: [CERTIFICATE] });
  const inventory = await bridge.scan();
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'camx-bridge-forged-'));
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  await assert.rejects(
    bridge.importFiles({
      destination,
      items: [{ ...inventory.files[0], bridgeArtifactId: 'e'.repeat(64) }]
    }),
    /does not belong to this phone/
  );
  assert.deepEqual(fs.readdirSync(destination), []);
});
