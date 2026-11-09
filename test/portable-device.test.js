'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  PortableDeviceService, categorizePortableItem, consumePortableOutput, finishPortableOutput,
  isCamXPipelineItem, filterCamXPipelineItems, mtpTransferIdentity
} = require('../src/core/portable-device');
const { BRIDGE_TRANSPORT } = require('../src/core/camx-usb-bridge');

function legacyOnlyBridge() {
  return {
    scan: async () => ({ authoritative: false, devices: [], files: [], warnings: [], legacyDetected: true }),
    detectDevices: async () => ({ authoritative: false, devices: [], warnings: [] })
  };
}

function phoneItem(name, segments = ['Internal shared storage', 'DCIM', 'CamX', name], extra = {}) {
  return {
    id: `phone::${segments.join('/')}`,
    deviceName: 'CamX Test Phone',
    devicePath: 'mtp://camx-test-phone',
    name,
    extension: path.extname(name).toLowerCase(),
    segments,
    ...extra
  };
}

test('phone media is classified into RAW and SDR conversion categories', () => {
  assert.equal(categorizePortableItem({ name: 'clip.npv10', extension: '.npv10' }).category, 'raw');
  assert.equal(categorizePortableItem({ name: 'clip.npraw', extension: '.npraw' }).category, 'raw');
  assert.equal(categorizePortableItem({ name: 'clip.mp4', extension: '.mp4' }).category, 'sdr');
  assert.equal(categorizePortableItem({ name: 'clip.hevc' }).category, 'sdr');
});

test('phone discovery mirrors the camera ownership policy and excludes ordinary storage videos', () => {
  const accepted = [
    phoneItem('take.mov'),
    phoneItem('legacy.mp4', ['Internal shared storage', 'Movies', 'NeoProCamX', 'legacy.mp4']),
    phoneItem('export.mov', ['Internal shared storage', 'Movies', 'CamXNPV10', 'export.mov']),
    phoneItem('CAMX_named_only.mov', ['Internal shared storage', 'Download', 'CAMX_named_only.mov']),
    phoneItem('NPV10_named_only.npv10', ['Internal shared storage', 'Download', 'NPV10_named_only.npv10'])
  ];
  const rejected = [
    phoneItem('holiday.mp4', ['Internal shared storage', 'DCIM', 'Camera', 'holiday.mp4']),
    phoneItem('wedding.mov', ['Internal shared storage', 'Movies', 'wedding.mov']),
    phoneItem('lookalike.mov', ['Internal shared storage', 'Movies', 'MyCamX', 'lookalike.mov']),
    phoneItem('camx-no-prefix.mov', ['Internal shared storage', 'Download', 'camx-no-prefix.mov']),
    phoneItem('.pending-123-CamX 06092026.mov'),
    phoneItem('CAMX_document.txt', ['Internal shared storage', 'Download', 'CAMX_document.txt'])
  ];
  accepted.forEach(item => assert.equal(isCamXPipelineItem(item), true, item.name));
  rejected.forEach(item => assert.equal(isCamXPipelineItem(item), false, item.name));
  assert.deepEqual(filterCamXPipelineItems([...accepted, ...rejected, accepted[0]]), accepted);
});

test('RAW phone discovery requires an exact complete CamX session pair', () => {
  const segments = ['Internal shared storage', 'Documents', 'CamX', 'NEO_RADIANCE_RAW_123', 'stream.npraw'];
  const valid = phoneItem('stream.npraw', segments, {
    sidecar: phoneItem('develop.meta', [...segments.slice(0, -1), 'develop.meta'], { extension: '.meta' })
  });
  assert.equal(isCamXPipelineItem(valid), true);
  assert.equal(isCamXPipelineItem(phoneItem('stream.npraw', segments)), false);
  assert.equal(isCamXPipelineItem(phoneItem('other.npraw', [...segments.slice(0, -1), 'other.npraw'], { sidecar: valid.sidecar })), false);
  assert.equal(isCamXPipelineItem(phoneItem('stream.npraw', ['Internal shared storage', 'Documents', 'CamX', 'Other', 'stream.npraw'], { sidecar: valid.sidecar })), false);
  const wrongParent = { ...valid, sidecar: phoneItem('develop.meta', ['Internal shared storage', 'Documents', 'CamX', 'Other', 'develop.meta'], { extension: '.meta' }) };
  assert.equal(isCamXPipelineItem(wrongParent), false);
});

test('chunked MTP output keeps progress separate from the final JSON payload', () => {
  const state = { buffer: '', payload: [] };
  const progress = [];
  consumePortableOutput(state, '#PROGRESS#{"ratio":0.5}\r\n{"files":[{"name":"clip', event => progress.push(event));
  consumePortableOutput(state, '.npraw"}],"warnings":[]}\r\n', event => progress.push(event));
  assert.deepEqual(progress, [{ ratio: 0.5 }]);
  assert.deepEqual(JSON.parse(finishPortableOutput(state)), {
    files: [{ name: 'clip.npraw' }], warnings: []
  });
});

test('desktop scan applies a second CamX-only boundary to helper results', async () => {
  class MockScanService extends PortableDeviceService {
    constructor() { super({ bridge: legacyOnlyBridge() }); }
    async run() {
      return {
        devices: [{ name: 'Phone' }], warnings: [],
        files: [
          phoneItem('CAMX_owned.mov'),
          phoneItem('unrelated.mov', ['Internal shared storage', 'DCIM', 'Camera', 'unrelated.mov'])
        ]
      };
    }
  }
  const result = await new MockScanService().scan();
  assert.deepEqual(result.files.map(item => item.name), ['CAMX_owned.mov']);
  assert.equal(result.files[0].category, 'sdr');
});

test('authoritative CamX bridge inventory is used without enumerating general MTP storage', async () => {
  const bridgeFile = {
    id: 'camx-bridge:item', transport: BRIDGE_TRANSPORT, name: 'CAMX_secure.mov',
    extension: '.mov', category: 'sdr', size: 42
  };
  const bridge = {
    scan: async () => ({
      authoritative: true,
      devices: [{ name: 'CamX Phone', path: 'adb://secure' }],
      files: [bridgeFile],
      warnings: []
    }),
    detectDevices: async () => ({ devices: [{ name: 'CamX Phone', path: 'adb://secure' }], warnings: [] })
  };
  class BridgeFirstService extends PortableDeviceService {
    constructor() { super({ bridge, allowAdbFallback: true }); }
    async run() { throw new Error('MTP storage must not be enumerated'); }
  }
  const service = new BridgeFirstService();
  assert.deepEqual((await service.scan()).files, [bridgeFile]);
  assert.deepEqual((await service.detectDevices()).devices, [{ name: 'CamX Phone', path: 'adb://secure' }]);
});

test('USB File Transfer inventory is preferred and does not require the ADB bridge', async () => {
  let bridgeScans = 0;
  const bridge = {
    scan: async () => { bridgeScans += 1; throw new Error('ADB must not be used when MTP is ready'); },
    detectDevices: async () => { bridgeScans += 1; throw new Error('ADB must not be used when MTP is ready'); }
  };
  class MtpFirstService extends PortableDeviceService {
    constructor() { super({ bridge }); }
    async run(request) {
      if (request.action === 'devices') return { devices: [{ name: 'MTP CamX' }], warnings: [] };
      return { devices: [{ name: 'MTP CamX' }], warnings: [], files: [phoneItem('CAMX_usb.mov')] };
    }
  }
  const service = new MtpFirstService();
  const inventory = await service.scan();
  const devices = await service.detectDevices();
  assert.equal(inventory.files[0].transport, 'mtp');
  assert.equal(devices.devices[0].transport, 'mtp');
  assert.equal(bridgeScans, 0);
});

test('MTP resume identity changes when source size or modification time changes', () => {
  const base = phoneItem('CAMX_clip.mov', undefined, { size: 1024, modifiedAtEpochMs: 10 });
  const first = mtpTransferIdentity([base]);
  assert.equal(first.key, mtpTransferIdentity([{ ...base }]).key);
  assert.notEqual(first.key, mtpTransferIdentity([{ ...base, size: 2048 }]).key);
  assert.notEqual(first.key, mtpTransferIdentity([{ ...base, modifiedAtEpochMs: 11 }]).key);
});

test('older CamX builds without the provider keep the filtered MTP fallback', async () => {
  class LegacyFallbackService extends PortableDeviceService {
    constructor() { super({ bridge: legacyOnlyBridge() }); }
    async run() {
      return {
        devices: [{ name: 'Legacy CamX' }], warnings: [],
        files: [
          phoneItem('CAMX_legacy.mov'),
          phoneItem('holiday.mov', ['Internal shared storage', 'DCIM', 'Camera', 'holiday.mov'])
        ]
      };
    }
  }
  const result = await new LegacyFallbackService().scan();
  assert.deepEqual(result.files.map(item => item.name), ['CAMX_legacy.mov']);
});

test('secure bridge imports are delegated and cannot be mixed with MTP selections', async () => {
  let delegated = null;
  const bridge = {
    importFiles: async request => { delegated = request; return { imported: ['verified.mov'] }; }
  };
  const service = new PortableDeviceService({ bridge, allowAdbFallback: true });
  const secure = { id: 'secure', transport: BRIDGE_TRANSPORT };
  const request = { destination: 'D:\\output', items: [secure] };
  assert.deepEqual(await service.importFiles(request), { imported: ['verified.mov'] });
  assert.equal(delegated, request);
  await assert.rejects(
    service.importFiles({ destination: 'D:\\output', items: [secure, phoneItem('CAMX_other.mov')] }),
    /cannot mix secure CamX bridge and legacy MTP/
  );
});

test('phone imports isolate equal file names and publish both into one batch', async t => {
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'camx-phone-'));
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  class MockPortableService extends PortableDeviceService {
    async run(request) {
      const localPath = path.join(request.destination, request.item.name);
      await fs.promises.writeFile(localPath, request.item.id);
      return { localPath };
    }
  }
  const service = new MockPortableService();
  const result = await service.importFiles({
    destination,
    items: [
      phoneItem('CAMX_clip.mov', ['Internal shared storage', 'DCIM', 'CamX', 'one', 'CAMX_clip.mov'], { id: 'one' }),
      phoneItem('CAMX_clip.mov', ['Internal shared storage', 'DCIM', 'CamX', 'two', 'CAMX_clip.mov'], { id: 'two' })
    ]
  });
  assert.equal(result.imported.length, 2);
  assert.notEqual(path.dirname(result.imported[0]), path.dirname(result.imported[1]));
  assert.equal(fs.readFileSync(result.imported[0], 'utf8'), 'one');
  assert.equal(fs.readFileSync(result.imported[1], 'utf8'), 'two');
});

test('phone import keeps camera color, viewing and audit companions beside its video', async t => {
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'camx-phone-lut-'));
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  class MockPortableService extends PortableDeviceService {
    async run(request) {
      const localPath = path.join(request.destination, request.item.name);
      await fs.promises.writeFile(localPath, request.item.id);
      return { localPath };
    }
  }
  const service = new MockPortableService();
  const metadataRoot = ['Internal shared storage', 'Documents', 'CamX', 'Metadata'];
  const result = await service.importFiles({
    destination,
    items: [{
      ...phoneItem('CAMX_take.mov', undefined, { id: 'video' }),
      developColorSidecar: phoneItem('CAMX_take.mov.devcolor', [...metadataRoot, 'CAMX_take.mov.devcolor'], { id: 'color', extension: '.devcolor' }),
      previewLutSidecar: phoneItem('CAMX_take_NeoLog_to_Rec709.cube', [...metadataRoot, 'CAMX_take_NeoLog_to_Rec709.cube'], { id: 'lut', extension: '.cube' }),
      cameraMetadataSidecar: phoneItem('CAMX_take.mov.metadata.json', [...metadataRoot, 'CAMX_take.mov.metadata.json'], { id: 'metadata', extension: '.json' }),
      conversionCertificateSidecar: phoneItem('CAMX_take.elite-conversion-certificate.txt', [...metadataRoot, 'CAMX_take.elite-conversion-certificate.txt'], { id: 'certificate', extension: '.txt' })
    }]
  });
  assert.equal(result.imported.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(result.imported[0]), 'CAMX_take.mov.devcolor'), 'utf8'), 'color');
  assert.equal(fs.readFileSync(path.join(path.dirname(result.imported[0]), 'CAMX_take_NeoLog_to_Rec709.cube'), 'utf8'), 'lut');
  assert.equal(fs.readFileSync(path.join(path.dirname(result.imported[0]), 'CAMX_take.mov.metadata.json'), 'utf8'), 'metadata');
  assert.equal(fs.readFileSync(path.join(path.dirname(result.imported[0]), 'CAMX_take.elite-conversion-certificate.txt'), 'utf8'), 'certificate');
});

test('phone import rejects items outside the CamX camera pipeline', async t => {
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'camx-phone-policy-'));
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  const service = new PortableDeviceService();
  await assert.rejects(service.importFiles({
    destination,
    items: [phoneItem('holiday.mov', ['Internal shared storage', 'DCIM', 'Camera', 'holiday.mov'])]
  }), /not a verified CamX pipeline item/);
  assert.deepEqual(fs.readdirSync(destination), []);
});

test('phone import rejects a companion redirected outside the CamX metadata contract', async t => {
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'camx-phone-sidecar-policy-'));
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  const service = new PortableDeviceService();
  const item = phoneItem('CAMX_take.mov', undefined, {
    previewLutSidecar: phoneItem(
      'CAMX_take_NeoLog_to_Rec709.cube',
      ['Internal shared storage', 'Download', 'CAMX_take_NeoLog_to_Rec709.cube']
    )
  });
  await assert.rejects(service.importFiles({ destination, items: [item] }), /not a verified CamX pipeline item/);
  assert.deepEqual(fs.readdirSync(destination), []);
});

test('failed MTP batches preserve isolated resumable progress and publish nothing', async t => {
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'camx-phone-rollback-'));
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  class FailingPortableService extends PortableDeviceService {
    constructor() { super(); this.calls = 0; }
    async run(request) {
      this.calls += 1;
      if (this.calls === 2) throw new Error('simulated disconnect');
      const localPath = path.join(request.destination, request.item.name);
      await fs.promises.writeFile(localPath, 'partial');
      return { localPath };
    }
  }
  const service = new FailingPortableService();
  await assert.rejects(service.importFiles({
    destination,
    items: [
      phoneItem('CAMX_one.mov', undefined, { id: 'one' }),
      phoneItem('CAMX_two.mov', undefined, { id: 'two' })
    ]
  }), /simulated disconnect.*progress was preserved/i);
  assert.deepEqual(fs.readdirSync(destination), ['.camx-transfer-cache']);
  assert.equal(fs.readdirSync(destination).some(name => name.startsWith('Phone Import ')), false);
  const resumed = await service.importFiles({
    destination,
    items: [
      phoneItem('CAMX_one.mov', undefined, { id: 'one' }),
      phoneItem('CAMX_two.mov', undefined, { id: 'two' })
    ]
  });
  assert.equal(resumed.imported.length, 2);
  assert.equal(fs.readdirSync(destination).some(name => name.startsWith('Phone Import ')), true);
});
