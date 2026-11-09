'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  expectedContract, expectedHdrMetadata, inspectHdrMetadata, validateHdrMetadata,
  validateProprietaryDeliveryMetadata, validateNeoLogSignaling, detectedBitDepth, effectiveColorRange
} = require('../src/core/output-validator');

test('delivery contracts require the intended codec, precision and colour signaling', () => {
  assert.deepEqual(expectedContract({ family: 'sdr' }), {
    codec: 'hevc', bitDepth: 10, pixelFormat: 'yuv420p10le', primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv'
  });
  assert.equal(expectedContract({ family: 'nivukx' }).transfer, 'smpte2084');
  assert.equal(expectedContract({ family: 'ndr' }).transfer, 'smpte2084');
  assert.equal(expectedContract({ family: 'p3-sdr' }).primaries, 'smpte432');
  assert.equal(expectedContract({ family: 'bt2020-sdr' }).transfer, 'bt2020-10');
  assert.equal(expectedContract({ family: 'archive-video', outputMode: 'yuv422', proresProfile: 3 }).proresProfile, 'HQ');
  assert.equal(expectedContract({ family: 'rgb10' }).codec, 'r210');
  assert.equal(expectedContract({ family: 'rgb10' }).matrix, 'gbr');
  assert.equal(expectedContract({ family: 'yuv10' }).codec, 'v210');
  assert.equal(expectedContract({ family: 'yuv10' }).matrix, 'bt709');
  assert.equal(expectedContract(
    { family: 'archive-video', outputMode: 'yuv444', proresProfile: 5 },
    { raw: true }
  ).primaries, 'bt2020');
  assert.equal(detectedBitDepth({ pix_fmt: 'yuv444p12le' }), 12);
  assert.equal(detectedBitDepth({ pix_fmt: 'gbrp10le' }), 10);
  assert.deepEqual(expectedContract({
    family: 'sdr', encoder: 'ffv1', resolvedEncoder: 'ffv1', outputMode: 'rgb16'
  }), {
    codec: 'ffv1', bitDepth: 16, pixelFormat: 'gbrp16le',
    primaries: 'bt709', transfer: 'bt709', matrix: 'gbr', range: 'pc'
  });
  assert.equal(expectedContract({
    family: 'sdr', encoder: 'lossless420', resolvedEncoder: 'hevc_nvenc', outputMode: 'yuv420'
  }).pixelFormat, 'p010le');
});

test('uncompressed MOV range is accepted only with the matching codec contract marker', () => {
  assert.deepEqual(
    effectiveColorRange(
      { codec_name: 'r210', pix_fmt: 'gbrp10le' },
      { format: { tags: { comment: 'CamX Studio r210 RGB full-range archive; range=pc' } } }
    ),
    { value: 'pc', authority: 'r210-coding-convention+camx-marker' }
  );
  assert.deepEqual(
    effectiveColorRange(
      { codec_name: 'v210', pix_fmt: 'yuv422p10le' },
      { format: { tags: { comment: 'CamX Studio v210 YUV 4:2:2 limited-range archive; range=tv' } } }
    ),
    { value: 'tv', authority: 'v210-coding-convention+camx-marker' }
  );
  assert.equal(effectiveColorRange({ codec_name: 'r210', pix_fmt: 'gbrp10le' }, { format: {} }).value, '');
});

test('matrix contracts preserve selected codec, chroma, precision and colour family', () => {
  assert.deepEqual(expectedContract({
    family: 'ndr', encoder: 'r210', outputMode: 'rgb10'
  }), {
    codec: 'r210', bitDepth: 10, pixelFormat: 'gbrp10le',
    primaries: 'bt2020', transfer: 'smpte2084', matrix: 'gbr', range: 'pc'
  });
  assert.equal(expectedContract({
    family: 'p3-sdr', encoder: 'prores', outputMode: 'yuv444', proresProfile: 5
  }).pixelFormat, 'yuv444p12le');
  assert.equal(expectedContract({
    family: 'log', encoder: 'v210', outputMode: 'yuv422'
  }).pixelFormat, 'yuv422p10le');
  assert.equal(expectedContract({
    family: 'nivukx', encoder: 'hevc', outputMode: 'yuv420'
  }).pixelFormat, 'yuv420p10le');
});

test('proprietary PQ contracts require real mastering-display and content-light side data', () => {
  const video = { side_data_list: [
    {
      side_data_type: 'Mastering display metadata',
      red_x: '35400/50000', red_y: '14600/50000',
      green_x: '8500/50000', green_y: '39850/50000',
      blue_x: '6550/50000', blue_y: '2300/50000',
      white_point_x: '15635/50000', white_point_y: '16450/50000',
      min_luminance: '1/10000', max_luminance: '50000000/10000'
    },
    { side_data_type: 'Content light level metadata', max_content: 5000, max_average: 2000 }
  ] };
  assert.equal(expectedHdrMetadata({ family: 'ndr' }).maxLuminance, 5000);
  assert.equal(inspectHdrMetadata(video).contentLight.maxAverage, 2000);
  const errors = [];
  validateHdrMetadata(video, { family: 'ndr', peakNits: 5000 }, errors);
  assert.deepEqual(errors, []);
  const missing = [];
  validateHdrMetadata({}, { family: 'nivukx', peakNits: 10000 }, missing);
  assert.deepEqual(missing, ['mastering-display metadata is missing', 'content-light metadata is missing']);
});

test('measured final-pixel MaxCLL and MaxFALL replace mastering-envelope placeholders', () => {
  const measured = { signalledMaxCLL: 1834, signalledMaxFALL: 426 };
  const expected = expectedHdrMetadata({ family: 'ndr', peakNits: 5000 }, measured);
  assert.equal(expected.maxLuminance, 5000);
  assert.equal(expected.maxContent, 1834);
  assert.equal(expected.maxAverage, 426);
  assert.equal(expected.contentLightAuthority, 'measured-final-pq-pixels');
  const video = { side_data_list: [
    {
      side_data_type: 'Mastering display metadata',
      red_x: '35400/50000', red_y: '14600/50000',
      green_x: '8500/50000', green_y: '39850/50000',
      blue_x: '6550/50000', blue_y: '2300/50000',
      white_point_x: '15635/50000', white_point_y: '16450/50000',
      min_luminance: '1/10000', max_luminance: '50000000/10000'
    },
    { side_data_type: 'Content light level metadata', max_content: 1834, max_average: 426 }
  ] };
  const errors = [];
  const actual = validateHdrMetadata(video, { family: 'ndr', peakNits: 5000 }, errors, measured);
  assert.deepEqual(errors, []);
  assert.equal(actual.contentLightAuthority, 'measured-final-pq-pixels');
});

test('NeoLog rejects misleading standard gamut and transfer declarations', () => {
  const clean = [];
  const identity = validateNeoLogSignaling({}, { family: 'log' }, clean);
  assert.equal(identity.authoritativeIdentity.includes('AP1'), true);
  assert.deepEqual(clean, []);
  const errors = [];
  validateNeoLogSignaling({ color_primaries: 'bt2020', color_transfer: 'bt709' }, { family: 'log' }, errors);
  assert.equal(errors.length, 2);
});

test('proprietary lossless masters carry self-identifying NDR/NIVUKX camera metadata', () => {
  const errors = [];
  const result = validateProprietaryDeliveryMetadata({ format: { tags: { comment:
    'CamX Studio master; technology=NDR10_PLUS; tone=NDR-TONE-OP-v4; ' +
    'calibration=NDR-NIVUKX-PY-CAL-v4; delivery=NDR-NIVUKX-DELIVERY-v1; diffuse-white=203; peak=5000'
  } } }, { family: 'ndr' }, errors);
  assert.equal(result.complete, true);
  assert.deepEqual(errors, []);
  const missing = [];
  validateProprietaryDeliveryMetadata({ format: { tags: { comment: '' } } }, { family: 'nivukx' }, missing);
  assert.equal(missing.length, 1);
});
