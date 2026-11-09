'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  presentationTimeUsForFrame, validateDynamicDeliveryMetadataFile
} = require('../src/core/conversion-queue');

function chain(records) {
  let previous = '0'.repeat(64);
  return records.map(record => {
    const recordSha256 = crypto.createHash('sha256').update(previous, 'hex')
      .update(JSON.stringify(record), 'utf8').digest('hex');
    const encoded = { ...record, previousRecordSha256: previous, recordSha256 };
    previous = recordSha256;
    return encoded;
  });
}

test('private T0-T7 delivery metadata is ordered and hash chained', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'camx-dynamic-metadata-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'metadata.jsonl');
  const tiers = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`T${index}`, { role: `tier-${index}` }]));
  const records = chain([
    {
      recordType: 'header', schema: 'com.neoproc.camx.dynamic-delivery.v1',
      privateTechnology: true, vendorCertificationClaimed: false, definitions: { tiers }
    },
    {
      recordType: 'frame', schema: 'com.neoproc.camx.dynamic-delivery.v1', frame: 1,
      presentationTimeUs: 0, tiers: { T1: {}, T3: {}, T4: {}, T5: {}, T6: {}, T7: {} }
    },
    {
      recordType: 'footer', schema: 'com.neoproc.camx.dynamic-delivery.v1', frames: 1,
      measuredContentLight: { framesMeasured: 1, signalledMaxCLL: 500, signalledMaxFALL: 100 }
    }
  ]);
  fs.writeFileSync(filePath, `${records.map(JSON.stringify).join('\n')}\n`);
  const result = await validateDynamicDeliveryMetadataFile(filePath, 1, records.at(-1).recordSha256);
  assert.equal(result.frames, 1);
  assert.equal(result.finalHash, records.at(-1).recordSha256);

  records[1].tiers.T4.maxCLLNits = 9999;
  fs.writeFileSync(filePath, `${records.map(JSON.stringify).join('\n')}\n`);
  await assert.rejects(validateDynamicDeliveryMetadataFile(filePath, 1), /hash-chain mismatch/);
});

test('dynamic metadata timing follows exact sensor timestamps when present', () => {
  const media = { fps: 30, timestamps: [9_000_000_000, 9_041_667_000, 9_083_333_000] };
  assert.equal(presentationTimeUsForFrame(media, 1), 0);
  assert.equal(presentationTimeUsForFrame(media, 2), 41667);
  assert.equal(presentationTimeUsForFrame({ fps: 25 }, 3), 80000);
});
