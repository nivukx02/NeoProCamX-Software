'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  LIBRARY_KIND,
  classifyLibraryItem,
  buildImportManifest
} = require('../src/core/library-classification');

function phoneItem(name, segments, extra = {}) {
  return {
    id: `phone::${segments.join('/')}`,
    name,
    extension: path.extname(name).toLowerCase(),
    segments,
    ...extra
  };
}

test('direct CamX gallery deliveries are Saved and never conversion eligible', () => {
  const item = phoneItem(
    'CamX 06092026.mov',
    ['Internal storage', 'DCIM', 'CamX', 'CamX 06092026.mov']
  );
  assert.deepEqual(classifyLibraryItem(item), {
    libraryKind: LIBRARY_KIND.SAVED,
    conversionEligible: false,
    conversionKind: null,
    mediaCategory: 'sdr'
  });
});

test('only a complete Cinema Cam NPRAW pair is a conversion master', () => {
  const segments = [
    'Internal storage', 'Documents', 'CamX', 'NEO_RADIANCE_RAW_123', 'stream.npraw'
  ];
  const complete = phoneItem('stream.npraw', segments, {
    sidecar: phoneItem('develop.meta', [...segments.slice(0, -1), 'develop.meta'])
  });
  const classification = classifyLibraryItem(complete);
  assert.equal(classification.libraryKind, LIBRARY_KIND.CONVERSION);
  assert.equal(classification.conversionEligible, true);
  assert.equal(classification.conversionKind, 'npraw');

  const incomplete = classifyLibraryItem(phoneItem('stream.npraw', segments));
  assert.equal(incomplete.libraryKind, LIBRARY_KIND.SAVED);
  assert.equal(incomplete.conversionEligible, false);
});

test('public NPV10 and develop masters require a Cinema Cam conversion root', () => {
  const root = ['Internal storage', 'Documents', 'CamX', 'Conversion'];
  const npv10 = classifyLibraryItem(phoneItem('NPV10_take.npv10', [...root, 'NPV10_take.npv10']));
  const sdr = classifyLibraryItem(phoneItem('DEVSDR_take.mov', [...root, 'DEVSDR_take.mov']));
  const ndr = classifyLibraryItem(phoneItem('DEVNDR_take.mov', [...root, 'DEVNDR_take.mov']));
  assert.equal(npv10.conversionKind, 'npv10');
  assert.equal(sdr.conversionKind, 'sdr-master');
  assert.equal(ndr.conversionKind, 'ndr-master');
  assert.ok([npv10, sdr, ndr].every(item => item.conversionEligible));

  const galleryLookalike = classifyLibraryItem(phoneItem(
    'DEVSDR_take.mov',
    ['Internal storage', 'DCIM', 'CamX', 'DEVSDR_take.mov']
  ));
  assert.equal(galleryLookalike.conversionEligible, false);
});

test('download manifest preserves the phone-side rendering boundary', () => {
  const source = phoneItem(
    'CamX saved.mov',
    ['Internal storage', 'DCIM', 'CamX', 'CamX saved.mov'],
    { size: 1234, modifiedAtEpochMs: 5678 }
  );
  const manifest = buildImportManifest(source, 'D:\\Media\\CamX saved.mov');
  assert.equal(manifest.libraryKind, LIBRARY_KIND.SAVED);
  assert.equal(manifest.conversionEligible, false);
  assert.equal(manifest.sourceBytes, 1234);
});
