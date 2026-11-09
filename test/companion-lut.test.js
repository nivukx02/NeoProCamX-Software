'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  companionLutPathFor, parseCubeLut, inspectCompanionPreviewLut
} = require('../src/core/companion-lut');
const { previewKey, previewVideoFilter } = require('../src/core/preview-service');

function cube2() {
  return [
    'TITLE "NeoProCamX NeoLog (ACEScg) -> Rec.709"',
    'LUT_3D_SIZE 2', 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1',
    '0 0 0', '1 0 0', '0 1 0', '1 1 0',
    '0 0 1', '1 0 1', '0 1 1', '1 1 1', ''
  ].join('\n');
}

test('NeoLog companion LUT is strictly validated, hashed and receipt-checked', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'camx-lut-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const mediaPath = path.join(directory, 'take.mov');
  const lutPath = companionLutPathFor(mediaPath);
  fs.writeFileSync(mediaPath, 'video');
  fs.writeFileSync(lutPath, cube2());
  const digest = crypto.createHash('sha256').update(fs.readFileSync(lutPath)).digest('hex');
  fs.writeFileSync(`${mediaPath}.json`, JSON.stringify({
    companionArtifacts: [{ kind: 'neolog-rec709-viewing-lut', outputPath: lutPath, sha256: digest }]
  }));
  const result = await inspectCompanionPreviewLut(mediaPath);
  assert.equal(result.size, 2);
  assert.equal(result.samples, 8);
  assert.equal(result.sha256, digest);
  assert.equal(result.receiptVerified, true);
});

test('preview identity includes LUT hash and applies it with tetrahedral interpolation', () => {
  const base = { filePath: 'D:\\take.mov', size: 20, modifiedAt: 1, kind: 'video', width: 1920, height: 1080 };
  const withLut = { ...base, previewLut: { filePath: 'D:\\take_NeoLog_to_Rec709.cube', sha256: 'a'.repeat(64), size: 33 } };
  assert.notEqual(previewKey(base), previewKey(withLut));
  const filter = previewVideoFilter(withLut);
  assert.match(filter, /lut3d=file='D\\:\/take_NeoLog_to_Rec709\.cube':interp=tetrahedral/);
  assert.match(filter, /color_trc=bt709/);
});

test('malformed or incomplete cube data fails closed', () => {
  assert.throws(() => parseCubeLut('LUT_3D_SIZE 2\n0 0 0\n'), /contains 1 samples; expected 8/);
  assert.throws(() => parseCubeLut('LUT_1D_SIZE 2\n0 0 0\n1 1 1\n'), /must be a 3D LUT/);
});
