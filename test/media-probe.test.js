'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CapabilityService } = require('../src/core/capabilities');
const { MediaProbe } = require('../src/core/media-probe');

test('media probe applies only a validated camera metadata companion', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'camx-probe-metadata-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'CAMX_metadata.mov');
  fs.copyFileSync(path.resolve(__dirname, '..', '.camx-prores-test.mov'), target);
  fs.writeFileSync(`${target}.metadata.json`, JSON.stringify({
    schema: 'NeoProCamX.MediaSidecar.v1',
    file: path.basename(target),
    workingSpace: 'ACEScg',
    colorStandard: 'BT2020',
    colorTransfer: 'ST2084',
    colorRange: 'LIMITED',
    masteringDisplay: { peakNits: 5000, minimumBlackNits: 0.0001 },
    description: 'hdrIntent=NDR10+;detailProfile=FOCUSED_DETAIL;snceWarmth=0.03'
  }));
  const media = await new MediaProbe(new CapabilityService()).probe(target);
  assert.equal(media.cameraMetadata.schema, 'NeoProCamX.MediaSidecar.v1');
  assert.equal(media.colorPrimaries, 'bt2020');
  assert.equal(media.colorTransfer, 'smpte2084');
  assert.equal(media.colorSpace, 'bt2020nc');
  assert.equal(media.colorRange, 'tv');
  assert.equal(media.metadataValues.detailprofile, 'FOCUSED_DETAIL');
  assert.equal(media.metadataValues.sncewarmth, '0.03');
});
