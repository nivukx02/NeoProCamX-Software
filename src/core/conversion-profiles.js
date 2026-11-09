'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { tempDirectory } = require('./runtime-paths');
const {
  D50, D65, D60, RGB_TO_XYZ, XYZ_TO_RGB, ACESCG_TO_XYZ, XYZ_TO_ACESCG,
  multiply3x3, cat16Matrix, ensurePerceptualLut
} = require('./color-science');
const {
  VERSION: NDR_TONE_VERSION,
  CALIBRATION_VERSION: NDR_CALIBRATION_VERSION,
  DELIVERY_VERSION: NDR_DELIVERY_VERSION,
  ACESCG_TO_BT2020,
  diffuseWhiteSceneFor
} = require('./camera-color-pipeline');

const DELIVERY_DEFINITIONS = Object.freeze([
  Object.freeze({ id: 'rec709-sdr', mode: 'sdr', label: 'Rec.709 SDR', family: 'sdr', suffix: 'REC709_SDR' }),
  // Kept internally so an older receipt can still be inspected/replayed. These
  // are intentionally absent from the current CamX conversion catalogue.
  Object.freeze({ id: 'display-p3-sdr', mode: 'sdr', label: 'Display P3 SDR', family: 'p3-sdr', suffix: 'P3_SDR', legacy: true }),
  Object.freeze({ id: 'bt2020-sdr', mode: 'sdr', label: 'BT.2020 SDR', family: 'bt2020-sdr', suffix: 'BT2020_SDR', legacy: true }),
  Object.freeze({ id: 'ndr10-pq', mode: 'hdr', label: 'NDR10+ PQ', family: 'ndr', suffix: 'NDR10', peakNits: 5000 }),
  Object.freeze({ id: 'nivukx-pq', mode: 'hdr', label: 'NIVUKX Vision PQ', family: 'nivukx', suffix: 'NIVUKX', peakNits: 10000 }),
  Object.freeze({ id: 'neolog', mode: 'log', label: 'NeoLog', family: 'log', suffix: 'NEOLOG' })
]);

const TRANSPORT_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'ffv1rgb16', chroma: '444', label: 'FFV1 RGB 16-bit Lossless', encoder: 'ffv1',
    outputMode: 'rgb16', bitDepth: 16, extension: '.mov', codecLossless: true,
    chromaPreserving: true, losslessScope: 'Post-transform RGB pixels are preserved exactly'
  }),
  Object.freeze({
    id: 'r210', chroma: '444', label: 'Uncompressed RGB r210', encoder: 'r210',
    outputMode: 'rgb10', bitDepth: 10, extension: '.mov', codecLossless: true,
    chromaPreserving: true, losslessScope: 'Post-transform 10-bit RGB code values are uncompressed'
  }),
  Object.freeze({
    id: 'v210', chroma: '422', label: 'Uncompressed YUV v210', encoder: 'v210',
    outputMode: 'yuv422', bitDepth: 10, extension: '.mov', codecLossless: true,
    chromaPreserving: false, losslessScope: 'Lossless after explicit 4:2:2 chroma sampling'
  }),
  Object.freeze({
    id: 'lossless420', chroma: '420', label: 'Lossless 4:2:0 10-bit', encoder: 'lossless420',
    outputMode: 'yuv420', bitDepth: 10, extension: '.mov', codecLossless: true,
    chromaPreserving: false, losslessScope: 'Lossless after explicit 4:2:0 chroma sampling'
  }),
  // Legacy transports stay addressable for existing receipts and automation,
  // but are not offered by the no-loss desktop workflow.
  Object.freeze({ id: 'prores4444xq', chroma: '444', label: 'ProRes 4444 XQ', encoder: 'prores', outputMode: 'yuv444', bitDepth: 12, proresProfile: 5, proresName: '4444 XQ', bitsPerMb: 8192, legacy: true }),
  Object.freeze({ id: 'prores422hq', chroma: '422', label: 'ProRes 422 HQ', encoder: 'prores', outputMode: 'yuv422', bitDepth: 10, proresProfile: 3, proresName: '422 HQ', bitsPerMb: 8000, legacy: true }),
  Object.freeze({ id: 'hevc422', chroma: '422', label: 'HEVC Main 4:2:2 10', encoder: 'hevc', outputMode: 'yuv422', bitDepth: 10, hevcProfile: 'main422-10', legacy: true }),
  Object.freeze({ id: 'hevc420', chroma: '420', label: 'HEVC Main10', encoder: 'hevc', outputMode: 'yuv420', bitDepth: 10, hevcProfile: 'main10', legacy: true })
]);

function matrixProfile(delivery, transport) {
  return Object.freeze({
    ...delivery, ...transport,
    id: `${delivery.id}-${transport.id}`,
    deliveryId: delivery.id,
    transportId: transport.id,
    label: `${delivery.label} / ${transport.label}`,
    suffix: `${delivery.suffix}_${transport.id.toUpperCase()}`,
    extension: transport.extension || '.mov'
  });
}

const MATRIX_PROFILES = Object.freeze(Object.fromEntries(
  DELIVERY_DEFINITIONS.flatMap(delivery => TRANSPORT_DEFINITIONS.map(transport => {
    const profile = matrixProfile(delivery, transport);
    return [profile.id, profile];
  }))
));

// Legacy IDs remain valid for existing receipts, scripts and saved UI state. New UI selections
// use the explicit delivery/transport matrix above so chroma is never inferred or downgraded.
const LEGACY_PROFILES = {
  'sdr-master': { ...MATRIX_PROFILES['rec709-sdr-hevc420'], id: 'sdr-master', suffix: 'SDR_MASTER' },
  'display-p3-master': { ...MATRIX_PROFILES['display-p3-sdr-hevc420'], id: 'display-p3-master', suffix: 'P3_SDR_MASTER' },
  'bt2020-sdr-master': { ...MATRIX_PROFILES['bt2020-sdr-hevc420'], id: 'bt2020-sdr-master', suffix: 'BT2020_SDR_MASTER' },
  'ndr10-master': { ...MATRIX_PROFILES['ndr10-pq-hevc420'], id: 'ndr10-master', suffix: 'NDR10_MASTER' },
  'nivukx-master': { ...MATRIX_PROFILES['nivukx-pq-hevc420'], id: 'nivukx-master', suffix: 'NIVUKX_MASTER' },
  'hevc422-master': { ...MATRIX_PROFILES['rec709-sdr-hevc422'], id: 'hevc422-master', suffix: 'HEVC422_MASTER' },
  'neolog-master': { ...MATRIX_PROFILES['neolog-prores4444xq'], id: 'neolog-master', suffix: 'NEOLOG_MASTER' },
  'prores-422-hq': { id: 'prores-422-hq', label: 'ProRes 422 HQ Archive', suffix: 'PRORES_422_HQ', extension: '.mov', mode: 'archive', family: 'archive-video', encoder: 'prores', outputMode: 'yuv422', chroma: '422', bitDepth: 10, proresProfile: 3, proresName: '422 HQ', bitsPerMb: 8000 },
  'prores-4444': { id: 'prores-4444', label: 'ProRes 4444 Archive', suffix: 'PRORES_4444', extension: '.mov', mode: 'archive', family: 'archive-video', encoder: 'prores', outputMode: 'yuv444', chroma: '444', bitDepth: 12, proresProfile: 4, proresName: '4444', bitsPerMb: 8000 },
  'prores-archive': { id: 'prores-archive', label: 'ProRes 4444 XQ Archive', suffix: 'PRORES_XQ', extension: '.mov', mode: 'archive', family: 'archive-video', encoder: 'prores', outputMode: 'yuv444', chroma: '444', bitDepth: 12, proresProfile: 5, proresName: '4444 XQ', bitsPerMb: 8192 },
  'rgb10-archive': { id: 'rgb10-archive', label: 'RGB 10-bit Archive', suffix: 'RGB10_R210', extension: '.mov', mode: 'archive', family: 'rgb10', encoder: 'r210', outputMode: 'rgb10', chroma: '444', bitDepth: 10 },
  'v210-archive': { id: 'v210-archive', label: 'YUV 4:2:2 10-bit Archive', suffix: 'YUV10_V210', extension: '.mov', mode: 'archive', family: 'yuv10', encoder: 'v210', outputMode: 'yuv422', chroma: '422', bitDepth: 10 },
  'cinemadng-sequence': { id: 'cinemadng-sequence', label: 'CinemaDNG Sequence', suffix: 'CINEMADNG', extension: '', mode: 'raw', family: 'cinemadng', directory: true },
  'raw-preserve': { id: 'raw-preserve', label: 'RAW Verified Preserve', suffix: 'VERIFIED', extension: null, mode: 'raw', family: 'raw-copy' }
};

const PROFILES = Object.freeze({ ...MATRIX_PROFILES, ...LEGACY_PROFILES });

const EXPOSED_DELIVERY_IDS = new Set(['rec709-sdr', 'ndr10-pq', 'nivukx-pq', 'neolog']);
const EXPOSED_TRANSPORT_IDS = new Set(['ffv1rgb16', 'r210', 'v210', 'lossless420']);
const PUBLIC_PROFILE_IDS = new Set([
  ...[...EXPOSED_DELIVERY_IDS].flatMap(deliveryId =>
    [...EXPOSED_TRANSPORT_IDS].map(transportId => `${deliveryId}-${transportId}`)),
  'cinemadng-sequence', 'raw-preserve'
]);

const CONVERSION_CATALOG = Object.freeze({
  modes: Object.freeze([
    Object.freeze({ id: 'sdr', label: 'SDR' }),
    Object.freeze({ id: 'hdr', label: 'CamX HDR' }),
    Object.freeze({ id: 'log', label: 'NeoLog' }),
    Object.freeze({ id: 'raw', label: 'RAW' })
  ]),
  deliveries: Object.freeze(DELIVERY_DEFINITIONS.filter(item => EXPOSED_DELIVERY_IDS.has(item.id))),
  transports: Object.freeze(TRANSPORT_DEFINITIONS.filter(item => EXPOSED_TRANSPORT_IDS.has(item.id))),
  rawProfiles: Object.freeze([
    Object.freeze({ id: 'cinemadng-sequence', label: 'CinemaDNG', description: 'Identity sensor mosaic sequence' }),
    Object.freeze({ id: 'raw-preserve', label: 'RAW Preserve', description: 'Bit-exact verified camera original' })
  ])
});

const AI_SUPPORTED_FAMILIES = new Set(['sdr', 'p3-sdr', 'bt2020-sdr', 'ndr', 'nivukx', 'log']);
const MFSR_SUPPORTED_FAMILIES = new Set([
  'sdr', 'p3-sdr', 'bt2020-sdr', 'ndr', 'nivukx',
  'log', 'archive-video', 'rgb10', 'yuv10'
]);
const NIV99_SUPPORTED_FAMILIES = new Set(MFSR_SUPPORTED_FAMILIES);

const COLOR_TARGETS = Object.freeze({
  sdr: Object.freeze({ target: 'bt709', primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', lutFamily: 'sdr', peakNits: 100 }),
  'p3-sdr': Object.freeze({ target: 'p3d65', primaries: 'smpte432', transfer: 'iec61966-2-1', matrix: 'bt709', lutFamily: 'p3-sdr', peakNits: 100 }),
  'bt2020-sdr': Object.freeze({ target: 'bt2020', primaries: 'bt2020', transfer: 'bt2020-10', matrix: 'bt2020nc', lutFamily: 'bt2020-sdr', peakNits: 100 }),
  hlg: Object.freeze({ target: 'bt2020', primaries: 'bt2020', transfer: 'arib-std-b67', matrix: 'bt2020nc', lutFamily: 'hlg', peakNits: 1000 }),
  hdr10: Object.freeze({ target: 'bt2020', primaries: 'bt2020', transfer: 'smpte2084', matrix: 'bt2020nc', lutFamily: 'hdr10', peakNits: 1000 }),
  ndr: Object.freeze({ target: 'bt2020', primaries: 'bt2020', transfer: 'smpte2084', matrix: 'bt2020nc', lutFamily: 'ndr', peakNits: 5000 }),
  nivukx: Object.freeze({ target: 'bt2020', primaries: 'bt2020', transfer: 'smpte2084', matrix: 'bt2020nc', lutFamily: 'nivukx', peakNits: 10000 })
});

const NEOLOG = Object.freeze({
  base: { toeCut: 0.010, toeHeight: 0.080000, logDensity: 120.0, logScale: 0.137099, c1: 0.080000, c3: -0.436788, c4: 0.789056, c5: -0.352269, xMax: 6.843034 },
  shadow: { toeCut: 0.004, toeHeight: 0.040000, logDensity: 70.0, logScale: 0.177657, c1: 0.040000, c3: -0.045940, c4: 0.082136, c5: -0.036196, xMax: 3.164296 },
  highlight: { toeCut: 0.005, toeHeight: 0.060000, logDensity: 260.0, logScale: 0.114598, c1: 0.060000, c3: -0.452743, c4: 0.816510, c5: -0.363766, xMax: 14.041075 },
  cinema: { toeCut: 0.008, toeHeight: 0.080000, logDensity: 110.0, logScale: 0.140385, c1: 0.080000, c3: -0.228513, c4: 0.413487, c5: -0.184974, xMax: 6.377367 }
});
const NEOLOG_VERSION = 'NEOLOG-v5';
const NEOLOG_PIPELINE_VERSION = 'NEOLOG-ACESCG-PIPELINE-v2';

function encodeNeoLog(linear, variant = 'base') {
  const p = NEOLOG[variant] || NEOLOG.base;
  const x = Math.min(p.xMax, Math.max(0, linear));
  if (x >= p.toeCut) return Math.min(1, Math.max(0, p.toeHeight + p.logScale * Math.log(1 + p.logDensity * (x - p.toeCut))));
  const t = x / p.toeCut;
  return Math.min(1, Math.max(0, p.c1 * t + p.c3 * t ** 3 + p.c4 * t ** 4 + p.c5 * t ** 5));
}

function ensureNeoLogLut(variant = 'base') {
  const selected = NEOLOG[variant] ? variant : 'base';
  const parameters = NEOLOG[selected];
  const directory = path.join(tempDirectory(), 'luts');
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `neolog-v5-${selected}-scene-linear-v2.cube`);
  if (fs.existsSync(target)) return target;
  const size = 16384;
  const lines = [
    `TITLE \"CamX NeoLog v5 ${selected}\"`,
    `LUT_1D_SIZE ${size}`,
    'DOMAIN_MIN 0.0 0.0 0.0',
    `DOMAIN_MAX ${parameters.xMax} ${parameters.xMax} ${parameters.xMax}`
  ];
  for (let index = 0; index < size; index += 1) {
    const value = encodeNeoLog(parameters.xMax * index / (size - 1), selected).toFixed(9);
    lines.push(`${value} ${value} ${value}`);
  }
  fs.writeFileSync(target, `${lines.join('\n')}\n`, 'utf8');
  return target;
}

function decodeNeoLog(encoded, variant = 'base') {
  const selected = NEOLOG[variant] ? variant : 'base';
  const target = Math.min(1, Math.max(0, Number(encoded) || 0));
  let low = 0;
  let high = NEOLOG[selected].xMax;
  for (let iteration = 0; iteration < 36; iteration += 1) {
    const middle = (low + high) / 2;
    if (encodeNeoLog(middle, selected) < target) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

function encodeSrgb(linear) {
  const value = Math.min(1, Math.max(0, linear));
  return value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
}

function ensureNeoLogViewingLut(variant = 'base') {
  const selected = NEOLOG[variant] ? variant : 'base';
  const directory = path.join(tempDirectory(), 'luts');
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `neolog-v5-${selected}-acescg-to-rec709-v1.cube`);
  if (fs.existsSync(target)) return target;
  const size = 33;
  const matrix = [
    1.70505, -0.62179, -0.08326,
    -0.13026, 1.14080, -0.01055,
    -0.02400, -0.12897, 1.15297
  ];
  const lines = [
    `TITLE "CamX NeoLog v5 ${selected} (ACEScg) to Rec.709"`,
    `LUT_3D_SIZE ${size}`,
    'DOMAIN_MIN 0.0 0.0 0.0',
    'DOMAIN_MAX 1.0 1.0 1.0'
  ];
  const denominator = size - 1;
  for (let blue = 0; blue < size; blue += 1) {
    const b = decodeNeoLog(blue / denominator, selected);
    for (let green = 0; green < size; green += 1) {
      const g = decodeNeoLog(green / denominator, selected);
      for (let red = 0; red < size; red += 1) {
        const r = decodeNeoLog(red / denominator, selected);
        const output = [
          matrix[0] * r + matrix[1] * g + matrix[2] * b,
          matrix[3] * r + matrix[4] * g + matrix[5] * b,
          matrix[6] * r + matrix[7] * g + matrix[8] * b
        ].map(encodeSrgb);
        lines.push(output.map(value => value.toFixed(9)).join(' '));
      }
    }
  }
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${lines.join('\n')}\n`, { encoding: 'utf8', flag: 'wx' });
  try { fs.renameSync(temporary, target); } catch (error) {
    if (!fs.existsSync(target)) throw error;
    fs.rmSync(temporary, { force: true });
  }
  return target;
}

function fileSha256Sync(filePath) {
  const digest = crypto.createHash('sha256');
  digest.update(fs.readFileSync(filePath));
  return digest.digest('hex');
}

function ensureNeoLogManifest(variant = 'base', profile = {}) {
  const selected = NEOLOG[variant] ? variant : 'base';
  const parameters = NEOLOG[selected];
  const viewingLut = ensureNeoLogViewingLut(selected);
  const outputMode = String(profile.outputMode || 'rgb16');
  const directory = path.join(tempDirectory(), 'luts');
  fs.mkdirSync(directory, { recursive: true });
  const rgb = ['rgb10', 'rgb16'].includes(outputMode);
  const manifest = {
    schema: 'com.neoproc.camx.neolog-manifest.v1',
    technology: 'NeoLog',
    proprietary: true,
    thirdPartyStandardClaim: false,
    version: NEOLOG_VERSION,
    pipelineVersion: NEOLOG_PIPELINE_VERSION,
    variant: selected,
    sceneEncoding: {
      primaries: 'ACEScg AP1', whitePoint: 'D60', reference: 'scene-linear',
      transfer: `${NEOLOG_VERSION}-${selected}`,
      formula: {
        highlight: 'toeHeight + logScale * ln(1 + logDensity * (x - toeCut))',
        toe: 'c1*t + c3*t^3 + c4*t^4 + c5*t^5; t=x/toeCut',
        clamp: [0, parameters.xMax], outputRange: [0, 1], parameters
      },
      acescgToXyzD60: ACESCG_TO_XYZ
    },
    containerSignaling: {
      colorPrimaries: 'unspecified (private AP1/D60 identity is authoritative here)',
      transferCharacteristics: 'unspecified (private NeoLog curve)',
      matrixCoefficients: rgb ? 'GBR identity' : 'BT.2020 non-constant-luminance storage matrix',
      range: rgb ? 'full' : 'limited'
    },
    transport: {
      outputMode,
      chromaSampling: profile.chroma ? profile.chroma.split('').join(':') : null,
      bitDepth: Number(profile.bitDepth || 0) || null,
      codecLossless: Boolean(profile.codecLossless),
      chromaPreserving: Boolean(profile.chromaPreserving),
      losslessScope: profile.losslessScope || null
    },
    viewingTransform: {
      companionSuffix: '_NeoLog_to_Rec709.cube',
      interpolation: 'tetrahedral',
      cubeSize: 33,
      sha256: fileSha256Sync(viewingLut),
      target: 'Rec.709/sRGB display preview'
    }
  };
  const encoded = `${JSON.stringify(manifest, null, 2)}\n`;
  const identity = crypto.createHash('sha256').update(encoded).digest('hex').slice(0, 16);
  const target = path.join(directory, `neolog-v5-${selected}-${outputMode}-manifest-v1-${identity}.json`);
  if (fs.existsSync(target)) return target;
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, encoded, { encoding: 'utf8', flag: 'wx' });
  try { fs.renameSync(temporary, target); } catch (error) {
    if (!fs.existsSync(target)) throw error;
    fs.rmSync(temporary, { force: true });
  }
  return target;
}

function filterFilePath(filePath) {
  return filePath.replace(/\\/g, '/').replace(':', '\\:').replace(/'/g, "\\'");
}

function isHdr(media) {
  const transfer = String(media.colorTransfer || media.metadataValues?.transfer || '').toLowerCase();
  return media.developColor?.colorTransfer === 1 || media.developColor?.colorTransfer === 2 ||
    transfer.includes('smpte2084') || transfer.includes('arib-std-b67') || transfer.includes('pq') || transfer.includes('hlg');
}

function inputColor(media) {
  const primaries = ['bt2020', 'bt709', 'smpte432', 'smpte431'].includes(String(media.colorPrimaries).toLowerCase())
    ? String(media.colorPrimaries).toLowerCase() : 'bt709';
  const rawTransfer = String(media.colorTransfer || '').toLowerCase();
  const transfer = ['smpte2084', 'arib-std-b67', 'iec61966-2-1', 'bt2020-10', 'bt2020-12'].includes(rawTransfer)
    ? rawTransfer : 'bt709';
  const rawMatrix = String(media.colorSpace || '').toLowerCase();
  const matrix = ['bt2020nc', 'bt2020c', 'bt709', 'smpte170m'].includes(rawMatrix) ? rawMatrix : 'bt709';
  const range = String(media.colorRange).toLowerCase() === 'pc' ? 'full' : 'limited';
  return `primariesin=${primaries}:transferin=${transfer}:matrixin=${matrix}:rangein=${range}`;
}

function multiply3(a, b) {
  const output = new Array(9).fill(0);
  for (let row = 0; row < 3; row += 1) for (let col = 0; col < 3; col += 1) {
    for (let k = 0; k < 3; k += 1) output[row * 3 + col] += a[row * 3 + k] * b[k * 3 + col];
  }
  return output;
}

const XYZ_D65_TO_ACESCG = Object.freeze(multiply3x3(XYZ_TO_ACESCG, cat16Matrix(D65, D60, 1)));
const XYZ_D50_TO_ACESCG = Object.freeze(multiply3x3(XYZ_TO_ACESCG, cat16Matrix(D50, D60, 1)));
const ACESCG_TO_XYZ_D65 = Object.freeze(multiply3x3(cat16Matrix(D60, D65, 1), ACESCG_TO_XYZ));

function xyzToTargetMatrix(target) {
  if (target === 'bt2020') return XYZ_TO_RGB.bt2020;
  if (target === 'p3d65') return XYZ_TO_RGB.p3d65;
  if (target === 'acescg') return XYZ_D65_TO_ACESCG;
  return XYZ_TO_RGB.bt709;
}

// Camera sensor matrices are XYZ(D50), not XYZ(D65). Preserve the camera route:
// sensor -> XYZ(D50) -> CAT16 D60 -> ACEScg, then the canonical delivery matrix.
function xyzD50ToTargetMatrix(target) {
  if (target === 'acescg') return XYZ_D50_TO_ACESCG;
  if (target === 'bt2020') return multiply3(ACESCG_TO_BT2020, XYZ_D50_TO_ACESCG);
  const targetMatrix = target === 'p3d65' ? XYZ_TO_RGB.p3d65 : XYZ_TO_RGB.bt709;
  return multiply3(multiply3(targetMatrix, ACESCG_TO_XYZ_D65), XYZ_D50_TO_ACESCG);
}

function zscalePrimaries(target) {
  if (target === 'p3d65') return 'smpte432';
  return target === 'acescg' ? null : target;
}

function matrixFilter(matrix) {
  const names = ['rr', 'rg', 'rb', 'gr', 'gg', 'gb', 'br', 'bg', 'bb'];
  return `colorchannelmixer=${names.map((name, index) => `${name}=${Math.max(-4, Math.min(4, matrix[index])).toFixed(9)}`).join(':')}`;
}

function rawMatrixFilter(media, target) {
  const sensor = media.sidecar?.sensorToXyz || media.rawCalibration?.sensorToXyz;
  if (!Array.isArray(sensor) || sensor.length !== 9 || sensor.every(value => Math.abs(value) < 1e-8)) return null;
  return matrixFilter(multiply3(xyzD50ToTargetMatrix(target), sensor));
}

function orientationFilters(media) {
  const customContainer = ['npv10', 'npraw'].includes(media.kind);
  const sidecarOnlyRotation = Boolean(media.developColor && !Number(media.containerRotation || 0));
  if (!customContainer && !sidecarOnlyRotation) return [];
  const rotation = ((Number(media.orientation || 0) % 360) + 360) % 360;
  if (rotation === 90) return ['transpose=clock'];
  if (rotation === 180) return ['hflip', 'vflip'];
  if (rotation === 270) return ['transpose=cclock'];
  return [];
}

function timelineFilters(media, syntheticInput = false) {
  if (!media.videoTimelinePath) return [];
  if (!syntheticInput && !['npv10', 'npraw'].includes(media.kind)) return [];
  return [
    'settb=expr=1/1000000',
    `sendcmd=f='${filterFilePath(media.videoTimelinePath)}'`,
    'setpts@camx_video=PTS'
  ];
}

function developColorMatrixFilter(media, target) {
  const develop = media.developColor;
  if (!develop || !Array.isArray(develop.workingRgbToXyz) || develop.workingRgbToXyz.length !== 9) return null;
  const gains = [
    Number(develop.whiteBalance?.[0] || 1),
    (Number(develop.whiteBalance?.[1] || 1) + Number(develop.whiteBalance?.[2] || 1)) / 2,
    Number(develop.whiteBalance?.[3] || 1)
  ];
  const matrix = multiply3(xyzToTargetMatrix(target), develop.workingRgbToXyz)
    .map((value, index) => value * gains[index % 3]);
  return matrixFilter(matrix);
}

function sourceFilterPrefix(media, target = 'bt709') {
  const filters = [...timelineFilters(media), ...orientationFilters(media)];
  if (media.raw) {
    filters.push('format=gbrpf32le');
    const matrix = rawMatrixFilter(media, target);
    if (matrix) filters.push(matrix);
  } else if (media.developColor) {
    const sourcePrimaries = media.developColor.colorSpace === 1 ? 'bt2020' : 'bt709';
    const sourceTransfer = media.developColor.colorTransfer === 1 ? 'arib-std-b67' :
      media.developColor.colorTransfer === 2 ? 'smpte2084' : 'bt709';
    filters.push(
      `zscale=primariesin=${sourcePrimaries}:transferin=${sourceTransfer}:matrixin=${sourcePrimaries === 'bt2020' ? 'bt2020nc' : 'bt709'}:rangein=limited:primaries=${sourcePrimaries}:transfer=linear:matrix=gbr:range=full:npl=${Math.max(1, Number(media.developColor.adaptingLuminance || 100))}`,
      'format=gbrpf32le'
    );
    const matrix = developColorMatrixFilter(media, target);
    if (matrix) filters.push(matrix);
  }
  return filters;
}

function appendSignalFinish(filters, config, outputMode = 'yuv420', perceptual = true) {
  filters.push('format=gbrpf32le');
  if (perceptual) {
    const lut = filterFilePath(ensurePerceptualLut(config.lutFamily));
    filters.push(`lut3d=file='${lut}':interp=tetrahedral`);
  }
  if (outputMode === 'rgb48') {
    filters.push('format=rgb48le',
      `setparams=range=full:color_primaries=${config.primaries}:color_trc=${config.transfer}:colorspace=gbr`);
  } else if (outputMode === 'rgb16') {
    filters.push('format=gbrp16le',
      `setparams=range=full:color_primaries=${config.primaries}:color_trc=${config.transfer}:colorspace=gbr`);
  } else if (outputMode === 'rgb10') {
    filters.push('format=gbrp10le',
      `setparams=range=full:color_primaries=${config.primaries}:color_trc=${config.transfer}:colorspace=gbr`);
  } else {
    const pixelFormat = outputMode === 'yuv444' ? 'yuv444p12le' :
      outputMode === 'yuv422' ? 'yuv422p10le' : 'yuv420p10le';
    filters.push(
      `zscale=primariesin=${config.primaries}:transferin=${config.transfer}:matrixin=gbr:rangein=full:` +
      `primaries=${config.primaries}:transfer=${config.transfer}:matrix=${config.matrix}:range=limited:dither=error_diffusion`,
      `format=${pixelFormat}`,
      `setparams=range=limited:color_primaries=${config.primaries}:color_trc=${config.transfer}:colorspace=${config.matrix}`
    );
  }
  return filters.join(',');
}

function displayFilters(media, family, outputMode = 'yuv420') {
  const config = COLOR_TARGETS[family];
  if (!config) throw new Error(`Unknown display color family ${family}`);
  const filters = sourceFilterPrefix(media, config.target);
  const sourceIsLinear = Boolean(media.raw || media.developColor);
  if (isHdr(media) && !['hlg', 'hdr10', 'ndr', 'nivukx'].includes(family)) {
    if (!sourceIsLinear) {
      filters.push(`zscale=${inputColor(media)}:primaries=${config.primaries}:transfer=linear:matrix=gbr:range=full:npl=100`);
    }
    filters.push(
      'format=gbrpf32le', 'tonemap=mobius:param=0.30:desat=0.0',
      `zscale=primariesin=${config.primaries}:transferin=linear:matrixin=gbr:rangein=full:` +
      `primaries=${config.primaries}:transfer=${config.transfer}:matrix=gbr:range=full:npl=${config.peakNits}`
    );
  } else if (sourceIsLinear) {
    filters.push(
      `zscale=primariesin=${config.primaries}:transferin=linear:matrixin=gbr:rangein=full:` +
      `primaries=${config.primaries}:transfer=${config.transfer}:matrix=gbr:range=full:npl=${config.peakNits}`
    );
  } else {
    filters.push(
      `zscale=${inputColor(media)}:primaries=${config.primaries}:transfer=${config.transfer}:matrix=gbr:range=full:npl=${config.peakNits}`
    );
  }
  return appendSignalFinish(filters, config, outputMode, true);
}

/**
 * Feed the camera delivery engine scene-linear BT.2020 without applying a
 * generic display LUT or PQ OETF. The worker performs the canonical NDR v4
 * transfer after MFSR/NIV99 so highlight and colour-volume math stays ordered.
 */
function canonicalDeliveryInputFilters(media) {
  const filters = sourceFilterPrefix(media, 'bt2020');
  if (!media.raw && !media.developColor) {
    filters.push(
      `zscale=${inputColor(media)}:primaries=bt2020:transfer=linear:matrix=gbr:range=full:npl=10000`,
      'format=gbrpf32le'
    );
  }
  filters.push('format=rgb48le', 'setparams=range=full:color_primaries=bt2020:color_trc=linear:colorspace=gbr');
  return filters.join(',');
}

function sdrFilters(media, outputMode = 'yuv420') {
  return displayFilters(media, 'sdr', outputMode);
}

function pqFilters(media, peakNits, family, outputMode = 'yuv420') {
  const config = COLOR_TARGETS[family];
  if (!config || config.transfer !== 'smpte2084' || config.peakNits !== peakNits) {
    throw new Error(`Invalid PQ delivery contract ${family}/${peakNits}`);
  }
  return displayFilters(media, family, outputMode);
}

function standardToAcescgFilters(media) {
  const d65Bt2020ToAcescg = multiply3(XYZ_D65_TO_ACESCG, RGB_TO_XYZ.bt2020);
  return [
    `zscale=${inputColor(media)}:primaries=bt2020:transfer=linear:matrix=gbr:range=full:npl=100`,
    'format=gbrpf32le',
    matrixFilter(d65Bt2020ToAcescg)
  ];
}

function logFilters(media, variant, outputMode = 'yuv444') {
  const filters = sourceFilterPrefix(media, 'acescg');
  const lut = filterFilePath(ensureNeoLogLut(variant));
  if (!media.raw && !media.developColor) filters.push(...standardToAcescgFilters(media));
  filters.push('format=gbrpf32le', `lut1d=file='${lut}':interp=cubic`);
  if (outputMode === 'rgb48' || outputMode === 'rgb16' || outputMode === 'rgb10') filters.push(
    `format=${outputMode === 'rgb48' ? 'rgb48le' : outputMode === 'rgb16' ? 'gbrp16le' : 'gbrp10le'}`,
    'setparams=range=full:color_primaries=unknown:color_trc=unknown:colorspace=gbr');
  else {
    const pixelFormat = outputMode === 'yuv444' ? 'yuv444p12le' :
      outputMode === 'yuv422' ? 'yuv422p10le' : 'yuv420p10le';
    filters.push(
      'zscale=primariesin=bt2020:transferin=linear:matrixin=gbr:rangein=full:primaries=bt2020:transfer=linear:matrix=bt2020nc:range=limited:dither=error_diffusion',
      `format=${pixelFormat}`,
      'setparams=range=limited:color_primaries=unknown:color_trc=unknown:colorspace=bt2020nc'
    );
  }
  return filters.join(',');
}

function archiveColorConfig(media) {
  if (media.developColor) {
    const family = media.developColor.colorSpace === 1
      ? (media.developColor.colorTransfer === 1 ? 'hlg' : media.developColor.colorTransfer === 2 ? 'hdr10' : 'bt2020-sdr')
      : 'sdr';
    return COLOR_TARGETS[family];
  }
  const primaries = String(media.colorPrimaries || '').toLowerCase();
  const transfer = String(media.colorTransfer || '').toLowerCase();
  if (transfer === 'arib-std-b67') return COLOR_TARGETS.hlg;
  if (transfer === 'smpte2084') return COLOR_TARGETS.hdr10;
  if (primaries === 'bt2020') return COLOR_TARGETS['bt2020-sdr'];
  if (['smpte432', 'display-p3', 'display_p3'].includes(primaries)) return COLOR_TARGETS['p3-sdr'];
  return COLOR_TARGETS.sdr;
}

function archiveFilters(media, outputMode = 'yuv444') {
  if (media.raw) return logFilters(media, 'highlight', outputMode);
  const config = archiveColorConfig(media);
  const filters = sourceFilterPrefix(media, config.target);
  if (media.developColor) {
    filters.push(
      `zscale=primariesin=${config.primaries}:transferin=linear:matrixin=gbr:rangein=full:` +
      `primaries=${config.primaries}:transfer=${config.transfer}:matrix=gbr:range=full:npl=${config.peakNits}`
    );
  } else {
    filters.push(
      `zscale=${inputColor(media)}:primaries=${config.primaries}:transfer=${config.transfer}:matrix=gbr:range=full:npl=${config.peakNits}`
    );
  }
  return appendSignalFinish(filters, config, outputMode, false);
}

function gpuEncoderArgs(encoder, qp, queueDepth = 32) {
  const depth = String(Math.max(2, Math.min(32, Math.trunc(Number(queueDepth) || 32))));
  if (encoder === 'hevc_amf') return ['-c:v', encoder, '-usage', 'transcoding', '-quality', 'quality', '-profile:v', 'main10', '-bitdepth', '10', '-rc', 'cqp', '-qp_i', String(qp), '-qp_p', String(qp + 2), '-high_motion_quality_boost_enable', 'true', '-async_depth', depth, '-pix_fmt', 'p010le'];
  if (encoder === 'hevc_nvenc') return ['-c:v', encoder, '-preset', 'p7', '-tune', 'hq', '-rc', 'constqp', '-qp', String(qp), '-profile:v', 'main10', '-surfaces', depth, '-pix_fmt', 'p010le'];
  if (encoder === 'hevc_qsv') return ['-c:v', encoder, '-global_quality', String(qp), '-preset', 'veryslow', '-profile:v', 'main10', '-async_depth', depth, '-pix_fmt', 'p010le'];
  throw new Error(`Unsupported hardware encoder: ${encoder || 'unset'}`);
}

function gpuLosslessEncoderArgs(encoder, queueDepth = 32) {
  const depth = String(Math.max(2, Math.min(32, Math.trunc(Number(queueDepth) || 32))));
  if (encoder === 'hevc_nvenc') return [
    '-c:v', encoder, '-preset', 'p7', '-tune', 'lossless', '-rc', 'constqp', '-qp', '0',
    '-profile:v', 'main10', '-surfaces', depth, '-pix_fmt', 'p010le'
  ];
  throw new Error(`Unsupported verified lossless GPU encoder: ${encoder || 'unset'}`);
}

function ffv1EncoderArgs(outputMode, capabilities = {}) {
  const pixelFormat = outputMode === 'rgb16' ? 'gbrp16le' :
    outputMode === 'yuv422' ? 'yuv422p10le' :
      outputMode === 'yuv444' ? 'yuv444p12le' : 'yuv420p10le';
  return [
    '-c:v', 'ffv1', '-level', '3', '-coder', '1', '-context', '1',
    '-slicecrc', '1', '-slices', '16', '-threads', String(Math.max(1, Number(capabilities.logicalCores || 1))),
    '-pix_fmt', pixelFormat
  ];
}

function gpuEncoderQueueDepth(media, capabilities) {
  const width = Math.max(1, Number(media?.width) || 3840);
  const height = Math.max(1, Number(media?.height) || 2160);
  // P010 surfaces consume approximately three bytes per luma pixel.  Limit
  // queued surfaces to 20% of the selected adapter's reported memory so an
  // integrated GPU can run MFSR/NIV99/DirectML concurrently without starving
  // AMF/QSV.  Discrete high-memory adapters retain the full depth of 32.
  const surfaceBytes = width * height * 3;
  const reportedBytes = Math.max(0, ...(capabilities?.gpu || []).map(item => Number(item.memoryBytes) || 0));
  if (!reportedBytes) return 8;
  return Math.max(2, Math.min(32, Math.floor((reportedBytes * 0.20) / surfaceBytes)));
}

function encoderArgs(profile, quality, capabilities, executionMode = null, media = null) {
  const strictGpu = executionMode === 'gpu-encode';
  const automaticGpu = executionMode == null || executionMode === 'gpu-auto';
  if (profile.encoder === 'prores') {
    if (strictGpu) throw new Error('Strict GPU encode is unavailable for the selected ProRes transport');
    const pixelFormat = profile.outputMode === 'yuv422' ? 'yuv422p10le' : 'yuv444p12le';
    return [
      '-c:v', 'prores_ks', '-profile:v', String(profile.proresProfile), '-vendor', 'apl0',
      '-bits_per_mb', String(profile.bitsPerMb || 8000), '-pix_fmt', pixelFormat
    ];
  }
  if (profile.encoder === 'ffv1') {
    if (strictGpu) throw new Error('Strict GPU encode is unavailable for FFV1; GPU image processing remains enabled');
    return ffv1EncoderArgs(profile.outputMode, capabilities);
  }
  if (profile.encoder === 'r210') {
    if (strictGpu) throw new Error('Strict GPU encode is unavailable for uncompressed r210; GPU image processing remains enabled');
    return ['-c:v', 'r210', '-pix_fmt', 'gbrp10le'];
  }
  if (profile.encoder === 'v210') {
    if (strictGpu) throw new Error('Strict GPU encode is unavailable for uncompressed v210; GPU image processing remains enabled');
    return ['-c:v', 'v210', '-pix_fmt', 'yuv422p10le'];
  }
  if (profile.encoder === 'lossless420') {
    const verifiedGpuEncoder = capabilities.preferredLosslessGpuEncoder || null;
    if (strictGpu && !verifiedGpuEncoder) {
      throw new Error('Strict lossless GPU encode requires an NVIDIA NVENC adapter that passed the pixel round-trip self-test');
    }
    if (verifiedGpuEncoder && (strictGpu || automaticGpu)) {
      return gpuLosslessEncoderArgs(verifiedGpuEncoder, gpuEncoderQueueDepth(media, capabilities));
    }
    return ffv1EncoderArgs('yuv420', capabilities);
  }
  if (profile.encoder !== 'hevc') throw new Error(`Unsupported video encoder contract: ${profile.encoder || 'unset'}`);
  const gpuEligible = profile.outputMode === 'yuv420';
  if (strictGpu && !gpuEligible) {
    throw new Error('Strict GPU encode supports only HEVC Main10 4:2:0; this codec/chroma selection requires the CPU master path');
  }
  if (strictGpu && !capabilities.preferredGpuEncoder) {
    throw new Error('Strict GPU encode was requested, but no tested HEVC Main10 hardware encoder is available');
  }
  const useGpu = gpuEligible && Boolean(capabilities.preferredGpuEncoder) && (strictGpu || automaticGpu);
  if (useGpu) {
    const encoder = capabilities.preferredGpuEncoder;
    const qp = quality === 'maximum' ? 10 : quality === 'production' ? 12 : 14;
    return gpuEncoderArgs(encoder, qp, gpuEncoderQueueDepth(media, capabilities));
  }
  const preset = quality === 'maximum' ? 'veryslow' : quality === 'production' ? 'slower' : 'slow';
  const crf = quality === 'maximum' ? '8' : quality === 'production' ? '12' : '14';
  const peak = ['hdr10', 'ndr', 'nivukx'].includes(profile.family) ? COLOR_TARGETS[profile.family].peakNits : 0;
  const hdr = peak ? `:hdr10=1:hdr10-opt=1:master-display=G(8500,39850)B(6550,2300)R(35400,14600)WP(15635,16450)L(${peak * 10000},1):max-cll=${peak},${Math.round(peak * 0.4)}` : '';
  const pixelFormat = profile.outputMode === 'yuv422' ? 'yuv422p10le' : 'yuv420p10le';
  const hevcProfile = profile.hevcProfile || 'main10';
  const vui = {
    bt709: { primaries: 1, transfer: 1, matrix: 1 },
    'p3-sdr': { primaries: 12, transfer: 13, matrix: 1 },
    'bt2020-sdr': { primaries: 9, transfer: 14, matrix: 9 },
    hlg: { primaries: 9, transfer: 18, matrix: 9 },
    hdr10: { primaries: 9, transfer: 16, matrix: 9 },
    ndr: { primaries: 9, transfer: 16, matrix: 9 },
    nivukx: { primaries: 9, transfer: 16, matrix: 9 }
  }[profile.family] || { primaries: 1, transfer: 1, matrix: 1 };
  return ['-c:v', 'libx265', '-threads', String(Math.max(0, Number(capabilities.logicalCores || 0))),
    '-preset', preset, '-crf', crf, '-profile:v', hevcProfile, '-pix_fmt', pixelFormat,
    '-x265-params', `pools=*:pmode=1:pme=1:aq-mode=3:aq-strength=0.85:rd=6:rdoq-level=2:psy-rd=1.6:psy-rdoq=1.0:deblock=-1,-1:strong-intra-smoothing=0:rect=1:amp=1:repeat-headers=1:colorprim=${vui.primaries}:transfer=${vui.transfer}:colormatrix=${vui.matrix}:range=limited${hdr}`];
}

function sourceArgs(media, rawPipeline = null, includeCameraAudio = true) {
  const args = ['-hide_banner', '-y', '-nostdin'];
  if (media.kind === 'npv10' || media.kind === 'npraw') {
    const pixelFormat = media.raw && rawPipeline ? rawPipeline.pixelFormat : media.pixelFormat;
    args.push('-f', 'rawvideo', '-pixel_format', pixelFormat, '-video_size', `${media.width}x${media.height}`, '-framerate', String(media.fps), '-i', 'pipe:0');
    if (includeCameraAudio && media.audioInputPath) args.push('-f', 'aac', '-i', media.audioInputPath);
  } else {
    args.push('-i', media.filePath);
  }
  return args;
}

function cameraAudioFilter(media) {
  if (!media.audioTimelinePath) return null;
  return `asettb=expr=1/1000000,asendcmd=f='${filterFilePath(media.audioTimelinePath)}',asetpts@camx_audio=PTS,aresample=async=0:first_pts=0`;
}

function deliveryFilter(profile, media, job, outputMode = 'delivery') {
  const rgbOutput = outputMode === 'processor' ? 'rgb48' : null;
  const deliveryMode = rgbOutput || profile.outputMode || 'yuv420';
  if (outputMode === 'processor' && ['ndr', 'nivukx'].includes(profile.family)) {
    return canonicalDeliveryInputFilters(media);
  }
  if (COLOR_TARGETS[profile.family]) return displayFilters(media, profile.family, deliveryMode);
  if (profile.family === 'log') return logFilters(media, job.logVariant || 'base', deliveryMode);
  if (profile.family === 'archive-video') return archiveFilters(media, deliveryMode);
  if (profile.family === 'rgb10') return sdrFilters(media, rgbOutput || 'rgb10');
  if (profile.family === 'yuv10') return sdrFilters(media, rgbOutput || 'yuv422');
  return null;
}

function appendDeliveryMetadata(args, profile, job, resolvedEncoder = null) {
  const rgb = profile.outputMode === 'rgb10' || profile.outputMode === 'rgb16';
  const appendHevcTag = () => {
    if (profile.encoder === 'hevc' || String(resolvedEncoder || '').startsWith('hevc_')) args.push('-tag:v', 'hvc1');
  };
  const transportMarker = profile.encoder === 'ffv1'
    ? `FFV1 ${profile.outputMode === 'rgb16' ? 'RGB 16-bit' : 'lossless'}; range=${rgb ? 'pc' : 'tv'}`
    : profile.encoder === 'lossless420'
      ? 'lossless 4:2:0 10-bit; range=tv'
      : profile.encoder === 'r210'
    ? 'r210 RGB full-range; range=pc'
    : profile.encoder === 'v210' ? 'v210 YUV 4:2:2 limited-range; range=tv' : null;
  if (COLOR_TARGETS[profile.family]) {
    const config = COLOR_TARGETS[profile.family];
    args.push('-color_primaries', config.primaries, '-color_trc', config.transfer);
    if (!rgb) args.push('-colorspace', config.matrix);
    args.push('-color_range', rgb ? 'pc' : 'tv');
    appendHevcTag();
    if (['hdr10', 'ndr', 'nivukx'].includes(profile.family)) {
      const peak = config.peakNits;
      args.push('-metadata:s:v:0', `mastering-display=G(8500,39850)B(6550,2300)R(35400,14600)WP(15635,16450)L(${peak * 10000},1)`,
        '-metadata:s:v:0', `max-cll=${peak},${Math.round(peak * 0.4)}`);
    }
    const description = `${profile.label} master`;
    const proprietary = profile.family === 'ndr'
      ? `; technology=NDR10_PLUS; tone=${NDR_TONE_VERSION}; calibration=${NDR_CALIBRATION_VERSION}; delivery=${NDR_DELIVERY_VERSION}; diffuse-white=203; peak=5000`
      : profile.family === 'nivukx'
        ? `; technology=NIVUKX_VISION; tone=${NDR_TONE_VERSION}; calibration=${NDR_CALIBRATION_VERSION}; delivery=${NDR_DELIVERY_VERSION}; diffuse-white=203; peak=10000`
        : '';
    args.push('-metadata', `comment=CamX Studio ${description}${transportMarker ? `; ${transportMarker}` : ''}${proprietary}`);
  } else if (['rgb10', 'yuv10'].includes(profile.family)) {
    const legacyRgb = profile.family === 'rgb10';
    args.push('-color_primaries', 'bt709', '-color_trc', 'bt709');
    if (!legacyRgb) args.push('-colorspace', 'bt709');
    args.push('-color_range', legacyRgb ? 'pc' : 'tv', '-metadata',
      legacyRgb
        ? 'comment=CamX Studio r210 RGB full-range archive; range=pc'
        : 'comment=CamX Studio v210 YUV 4:2:2 limited-range archive; range=tv');
  } else if (profile.family === 'log') {
    // AP1/D60 and NeoLog have no ISO/IEC container enum. Advertising BT.2020
    // or BT.709 here makes colour-managed applications apply the wrong math.
    args.push('-color_primaries', 'unknown', '-color_trc', 'unknown');
    if (!rgb) args.push('-colorspace', 'bt2020nc');
    args.push('-color_range', rgb ? 'pc' : 'tv');
    appendHevcTag();
    args.push('-metadata:s:v:0', `com.neoproc.transfer=NEOLOG-v5-${job.logVariant || 'base'}`,
      '-metadata:s:v:0', 'com.neoproc.primaries=ACEScg_AP1_D60',
      '-metadata', `comment=CamX Studio scene-referred NeoLog ${job.logVariant || 'base'} master; private AP1/D60 identity in companion manifest; use the companion Rec.709 viewing LUT${transportMarker ? `; ${transportMarker}` : ''}`);
  } else if (profile.family === 'archive-video') {
    const config = job.media?.raw
      ? { primaries: 'bt2020', transfer: 'bt709', matrix: 'bt2020nc' }
      : archiveColorConfig(job.media || {});
    args.push('-color_primaries', config.primaries, '-color_trc', config.transfer,
      '-colorspace', config.matrix, '-color_range', 'tv',
      '-metadata', `comment=CamX Studio ProRes ${profile.proresName || 'archive'} preservation master`);
  }
}

function insertPqInputMetadata(args, profile) {
  if (!['hdr10', 'ndr', 'nivukx'].includes(profile.family)) return;
  const inputIndex = args.indexOf('-i');
  if (inputIndex < 0) throw new Error(`PQ profile ${profile.id} has no video input`);
  const peak = COLOR_TARGETS[profile.family].peakNits;
  args.splice(inputIndex, 0,
    '-mastering_display:v:0',
    `G(8500,39850)B(6550,2300)R(35400,14600)WP(15635,16450)L(${peak * 10000},1)`,
    '-content_light:v:0', `${peak},${Math.round(peak * 0.4)}`);
}

function processorEncodeFilter(profile, media) {
  const timing = timelineFilters(media, true);
  if (COLOR_TARGETS[profile.family]) {
    const config = COLOR_TARGETS[profile.family];
    if (profile.outputMode === 'rgb10' || profile.outputMode === 'rgb16') {
      return [...timing, `format=${profile.outputMode === 'rgb16' ? 'gbrp16le' : 'gbrp10le'}`,
        `setparams=range=full:color_primaries=${config.primaries}:color_trc=${config.transfer}:colorspace=gbr`].join(',');
    }
    const pixelFormat = profile.outputMode === 'yuv444' ? 'yuv444p12le' :
      profile.outputMode === 'yuv422' ? 'yuv422p10le' : 'yuv420p10le';
    const finish = `zscale=matrixin=gbr:primariesin=${config.primaries}:transferin=${config.transfer}:rangein=full:` +
      `matrix=${config.matrix}:primaries=${config.primaries}:transfer=${config.transfer}:range=limited:dither=error_diffusion,format=${pixelFormat},` +
      `setparams=range=limited:color_primaries=${config.primaries}:color_trc=${config.transfer}:colorspace=${config.matrix}`;
    return [...timing, finish].join(',');
  }
  if (profile.family === 'log' || (profile.family === 'archive-video' && media.raw)) {
    if (profile.outputMode === 'rgb10' || profile.outputMode === 'rgb16') return [...timing,
      `format=${profile.outputMode === 'rgb16' ? 'gbrp16le' : 'gbrp10le'}`,
      `setparams=range=full:color_primaries=${profile.family === 'log' ? 'unknown' : 'bt2020'}:` +
      `color_trc=${profile.family === 'log' ? 'unknown' : 'bt709'}:colorspace=gbr`].join(',');
    const pixelFormat = profile.outputMode === 'yuv444' ? 'yuv444p12le' :
      profile.outputMode === 'yuv422' ? 'yuv422p10le' : 'yuv420p10le';
    const finish = 'zscale=matrixin=gbr:primariesin=bt2020:transferin=linear:rangein=full:matrix=bt2020nc:' +
      `primaries=bt2020:transfer=linear:range=limited:dither=error_diffusion,format=${pixelFormat},` +
      `setparams=range=limited:color_primaries=${profile.family === 'log' ? 'unknown' : 'bt2020'}:` +
      `color_trc=${profile.family === 'log' ? 'unknown' : 'bt709'}:colorspace=bt2020nc`;
    return [...timing, finish].join(',');
  }
  if (profile.family === 'archive-video') {
    const config = archiveColorConfig(media);
    const pixelFormat = profile.outputMode === 'yuv422' ? 'yuv422p10le' : 'yuv444p12le';
    return [...timing,
      `zscale=matrixin=gbr:primariesin=${config.primaries}:transferin=${config.transfer}:rangein=full:` +
      `matrix=${config.matrix}:primaries=${config.primaries}:transfer=${config.transfer}:range=limited:dither=error_diffusion,format=${pixelFormat},` +
      `setparams=range=limited:color_primaries=${config.primaries}:color_trc=${config.transfer}:colorspace=${config.matrix}`
    ].join(',');
  }
  if (profile.family === 'rgb10') return [...timing, 'format=gbrp10le',
    'setparams=range=full:color_primaries=bt709:color_trc=bt709:colorspace=gbr'].join(',');
  if (profile.family === 'yuv10') {
    const finish = 'zscale=matrixin=gbr:primariesin=bt709:transferin=bt709:rangein=full:matrix=bt709:primaries=bt709:transfer=bt709:range=limited:dither=error_diffusion,format=yuv422p10le,' +
      'setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709';
    return [...timing, finish].join(',');
  }
  throw new Error(`No RGB48 processor output contract for ${profile.family}`);
}

function aiSettings(quality) {
  if (quality === 'maximum') return { strength: 0.52, interval: 4, temporalStrength: 0.16 };
  if (quality === 'accelerated') return { strength: 0.38, interval: 16, temporalStrength: 0.06 };
  return { strength: 0.46, interval: 8, temporalStrength: 0.11 };
}

function mfsrSettings(quality) {
  if (quality === 'maximum') return { frames: 8, strength: 0.62, sceneThreshold: 0.095, memoryMiB: 1024 };
  if (quality === 'accelerated') return { frames: 3, strength: 0.34, sceneThreshold: 0.11, memoryMiB: 384 };
  return { frames: 5, strength: 0.50, sceneThreshold: 0.10, memoryMiB: 768 };
}

function sourceDetailProfile(media) {
  const value = String(media.developColor?.detailProfileTag || media.metadataValues?.detailprofile ||
    media.metadataValues?.videodetailprofile || 'FOCUSED_DETAIL').trim().toUpperCase().replace(/[ -]+/g, '_');
  return ['NATURAL_DETAIL', 'FOCUSED_DETAIL', 'EXTREME_DETAIL'].includes(value) ? value : 'FOCUSED_DETAIL';
}

function sourceWhiteBalanceAuthority(media) {
  const values = media.metadataValues || {};
  const truthy = value => ['true', '1', 'yes', 'on'].includes(String(value || '').toLowerCase());
  if (truthy(values.awblockactive)) return 'LOCKED';
  if (truthy(values.manualwhitebalanceactive) || String(values.whitebalanceauthority || '').toUpperCase() === 'MANUAL') return 'MANUAL';
  if (String(values.whitebalanceauthority || '').toUpperCase() === 'AUTO' &&
      !truthy(values.awblockactive) && !truthy(values.manualwhitebalanceactive)) return 'AUTO';
  return 'UNKNOWN';
}

function boundedMetadataNumber(media, keys, fallback, low, high) {
  for (const key of keys) {
    const value = Number(media.metadataValues?.[key]);
    if (Number.isFinite(value)) return Math.min(high, Math.max(low, value));
  }
  return fallback;
}

function hasCanonicalDeliveryRuntime(capabilities) {
  const contract = capabilities.mfsr?.canonicalDelivery;
  const metadata = contract?.dynamicMetadata;
  return Boolean(capabilities.mfsr?.ready && contract?.ready &&
    contract.toneOperator === NDR_TONE_VERSION &&
    contract.calibration === NDR_CALIBRATION_VERSION &&
    contract.engine === NDR_DELIVERY_VERSION &&
    Number(contract.diffuseWhiteNits) === 203 &&
    Array.isArray(contract.peaks) && contract.peaks.includes(5000) && contract.peaks.includes(10000) &&
    metadata?.schema === 'com.neoproc.camx.dynamic-delivery.v1' &&
    metadata.measuredContentLight === true && metadata.appearanceAnalysis === 'JZAZBZ_FP64_ANALYSIS' &&
    Array.isArray(metadata.tiers) && ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']
      .every(tier => metadata.tiers.includes(tier)));
}

function isPublicProfile(profileId) {
  return PUBLIC_PROFILE_IDS.has(profileId);
}

function assertPublicConversionRoute(profile, media) {
  if (!profile || !PUBLIC_PROFILE_IDS.has(profile.id)) {
    throw new Error('This legacy conversion profile is not available in the current lossless workflow');
  }
  if (['raw-copy', 'cinemadng'].includes(profile.family)) {
    if (!media?.raw) throw new Error('RAW identity output requires a RAW source');
    return;
  }
  if (!media?.raw && profile.family !== 'sdr') {
    throw new Error('SDR sources can only use the SDR to SDR conversion route');
  }
  if (media?.raw && !['sdr', 'ndr', 'nivukx', 'log'].includes(profile.family)) {
    throw new Error('RAW sources support RAW, SDR, NDR10+, NIVUKX Vision, or NeoLog output only');
  }
}

function activeGpuEncoderForArgs(args, capabilities) {
  return [capabilities.preferredLosslessGpuEncoder, capabilities.preferredGpuEncoder]
    .filter(Boolean).find(encoder => args.includes(encoder)) || null;
}

function resolvedEncoderForArgs(profile, args, activeGpuEncoder) {
  if (activeGpuEncoder) return activeGpuEncoder;
  if (profile.encoder === 'lossless420' || profile.encoder === 'ffv1') return 'ffv1';
  if (profile.encoder === 'prores') return 'prores_ks';
  if (profile.encoder === 'hevc') return 'libx265';
  return profile.encoder;
}

function losslessContract(profile, resolvedEncoder, capabilities = {}) {
  if (!profile.codecLossless) return {
    codecLossless: false,
    scope: 'Lossy delivery codec',
    chromaSampling: profile.chroma ? profile.chroma.split('').join(':') : null,
    chromaPreserving: false,
    gpuEncodingRuntimeProven: false,
    resolvedEncoder
  };
  const gpuVerified = resolvedEncoder === capabilities.preferredLosslessGpuEncoder &&
    Boolean(capabilities.losslessGpuEncoding?.ready);
  return {
    codecLossless: true,
    scope: profile.losslessScope,
    chromaSampling: profile.chroma.split('').join(':'),
    chromaPreserving: Boolean(profile.chromaPreserving),
    processingPrecision: 'RGB48 / 16-bit integer interchange',
    resolvedEncoder,
    gpuEncodingRuntimeProven: gpuVerified,
    gpuRoundTrip: gpuVerified ? capabilities.losslessGpuEncoding : null,
    noSilentFallback: true
  };
}

function colorPipelineContract(profile, job, media) {
  if (['ndr', 'nivukx'].includes(profile.family)) return {
    exactCameraMath: true,
    parityStatus: 'version-locked-and-code-value-tested',
    toneOperator: NDR_TONE_VERSION,
    calibration: NDR_CALIBRATION_VERSION,
    deliveryEngine: NDR_DELIVERY_VERSION,
    mode: profile.family === 'nivukx' ? 'NIVUKX_VISION' : 'NDR10_PLUS',
    diffuseWhiteNits: 203,
    masteringPeakNits: COLOR_TARGETS[profile.family].peakNits,
    inputDiffuseWhiteScene: diffuseWhiteSceneFor(media),
    precision: 'scene-linear BT.2020 RGB48 -> float64 canonical delivery -> RGB48 PQ',
    metadata: {
      schema: 'com.neoproc.camx.dynamic-delivery.v1',
      privateTechnology: true,
      vendorCertificationClaimed: false,
      contentLight: 'measured from final PQ code values and embedded after render'
    }
  };
  if (profile.family === 'log') return {
    exactCameraMath: true,
    parityStatus: 'version-locked-formula',
    pipeline: 'sensor XYZ(D50) -> CAT16 D60 -> ACEScg AP1 -> NeoLog v5',
    technology: 'NEOLOG',
    transferVersion: NEOLOG_VERSION,
    pipelineVersion: NEOLOG_PIPELINE_VERSION,
    logVariant: NEOLOG[job.logVariant] ? job.logVariant : 'base',
    workingPrimaries: 'ACEScg AP1',
    whitePoint: 'D60',
    standardContainerTransfer: null,
    precision: 'float32 ACEScg transform and 16,384-entry cubic transfer LUT'
  };
  return {
    exactCameraMath: false,
    parityStatus: 'desktop-high-precision-render; no versioned camera SDR reference claim',
    pipeline: 'CAT16 CAM16 ACEScg v2',
    precision: 'float32 colour transform with tetrahedral perceptual LUT'
  };
}

function stageExecutionReport({ profile, media, computeReady, computeEngine, aiReady, aiEngine,
  mfsrReady, niv99Ready, canonicalDeliveryRequired, activeGpuEncoder, encoderName }) {
  const stages = [];
  if (media.raw) stages.push({ id: 'raw-develop', owner: 'CPU', accelerated: false,
    reason: 'deterministic sensor unpack, calibration and edge-directed CFA development' });
  stages.push({ id: 'decode-color-preparation', owner: 'CPU', accelerated: false,
    reason: 'FFmpeg high-precision decode and RGB48 interchange' });
  if (mfsrReady) stages.push({ id: 'mfsr', owner: computeReady ? 'GPU' : 'CPU', accelerated: computeReady,
    engine: computeReady ? computeEngine : 'NumPy CPU' });
  if (niv99Ready) stages.push({ id: 'niv99-omniclarity', owner: computeReady ? 'GPU' : 'CPU', accelerated: computeReady,
    engine: computeReady ? computeEngine : 'NumPy CPU' });
  if (aiReady) stages.push({ id: 'ai-guidance', owner: String(aiEngine || '').toLowerCase().includes('directml') ? 'GPU' : 'CPU',
    accelerated: String(aiEngine || '').toLowerCase().includes('directml'), engine: aiEngine });
  if (canonicalDeliveryRequired) stages.push({ id: 'canonical-delivery', owner: computeReady ? 'GPU' : 'CPU',
    accelerated: computeReady, engine: computeReady ? computeEngine : 'NumPy CPU' });
  stages.push({ id: 'encode-pack', owner: activeGpuEncoder ? 'GPU' : 'CPU', accelerated: Boolean(activeGpuEncoder),
    engine: activeGpuEncoder || encoderName });
  stages.push({ id: 'integrity-validation', owner: 'CPU', accelerated: false,
    reason: 'full decode and checksums remain CPU/I/O validation work' });
  const enabled = stages.filter(stage => !['decode-color-preparation', 'integrity-validation'].includes(stage.id));
  const gpuStages = stages.filter(stage => stage.owner === 'GPU');
  return {
    stages,
    plannedGpuStages: gpuStages.length,
    plannedProcessingStages: enabled.length,
    fixedUtilizationGuarantee: false,
    utilizationNote: 'GPU occupancy is hardware, driver, frame-size and codec dependent; stage ownership is reported instead of a fabricated percentage.'
  };
}

function buildPlan(job, media, capabilities, outputPath) {
  const profile = PROFILES[job.profileId];
  if (!profile) throw new Error(`Unknown conversion profile: ${job.profileId || 'unset'}`);
  if (profile.family === 'raw-copy') {
    if (!media.raw) throw new Error('RAW Preserve requires a RAW source');
    return {
      operation: 'copy', profile, outputPath, gpu: false,
      losslessContract: {
        codecLossless: true, sourceBitExact: true, chromaSampling: 'native CFA',
        chromaPreserving: true, scope: 'Bit-exact source file copy', resolvedEncoder: 'identity-copy',
        gpuEncodingRuntimeProven: false, noSilentFallback: true
      },
      execution: { requested: 'identity', decodeAndColor: 'bypassed', enhancements: 'bypassed', encode: 'bypassed' }
    };
  }
  if (profile.family === 'cinemadng') {
    if (!media.raw || !['npv10', 'npraw'].includes(media.kind)) throw new Error('CinemaDNG requires a CamX NPV10 RAW or NPRAW source');
    return {
      operation: 'cinemadng', profile, outputPath, gpu: false, engine: 'CinemaDNG identity writer',
      losslessContract: {
        codecLossless: true, sourceBitExact: true, chromaSampling: 'native CFA',
        chromaPreserving: true, scope: 'Original sensor samples in CinemaDNG frames', resolvedEncoder: 'cinemadng',
        gpuEncodingRuntimeProven: false, noSilentFallback: true
      },
      execution: { requested: 'identity', decodeAndColor: 'CPU identity extraction', enhancements: 'bypassed', encode: 'bypassed' }
    };
  }
  if ((profile.encoder === 'ffv1' || profile.encoder === 'lossless420') &&
      capabilities.encoders && capabilities.encoders.ffv1 === false) {
    throw new Error('The bundled FFmpeg runtime does not provide the required FFV1 lossless encoder');
  }
  if (profile.encoder === 'r210' && capabilities.encoders && capabilities.encoders.r210 === false) throw new Error('The bundled FFmpeg runtime does not provide r210');
  if (profile.encoder === 'v210' && capabilities.encoders && capabilities.encoders.v210 === false) throw new Error('The bundled FFmpeg runtime does not provide v210');
  if (profile.encoder === 'prores' && capabilities.encoders && capabilities.encoders.prores === false) throw new Error(`The bundled FFmpeg runtime does not provide ProRes ${profile.proresName || ''}`.trim());
  const rawPipeline = media.raw && ['npv10', 'npraw'].includes(media.kind) ? {
    pixelFormat: 'rgb48le', demosaic: 'edge-directed-cfa-v1',
    defectCorrection: true, temporalFusion: job.quality !== 'accelerated', calibration: 'develop.meta'
  } : null;
  const customContainer = ['npv10', 'npraw'].includes(media.kind);
  const hasAudioSource = customContainer ? Boolean(media.audioInputPath) : Boolean(media.audio);
  const companionArtifacts = profile.family === 'log' ? [{
    kind: 'neolog-rec709-viewing-lut',
    sourcePath: ensureNeoLogViewingLut(job.logVariant || 'base'),
    suffix: '_NeoLog_to_Rec709.cube'
  }, {
    kind: 'neolog-color-identity-manifest',
    sourcePath: ensureNeoLogManifest(job.logVariant || 'base', profile),
    suffix: '_NeoLog_Manifest.json'
  }] : [];
  const args = sourceArgs(media, rawPipeline, true);
  insertPqInputMetadata(args, profile);
  args.push('-map', '0:v:0');
  if (hasAudioSource) args.push('-map', customContainer ? '1:a:0' : '0:a?');
  const filter = deliveryFilter(profile, media, job, 'delivery');

  const aiReady = Boolean(job.aiEnhance && capabilities.ai?.ready && AI_SUPPORTED_FAMILIES.has(profile.family));
  const mfsrRequested = Boolean(job.mfsrEnhance && MFSR_SUPPORTED_FAMILIES.has(profile.family));
  if (mfsrRequested && !capabilities.mfsr?.ready) {
    throw new Error(`Offline MFSR runtime is unavailable: ${capabilities.mfsr?.error || 'worker self-test failed'}`);
  }
  const mfsrReady = Boolean(mfsrRequested && capabilities.mfsr?.ready);
  const niv99Required = (customContainer || Boolean(media.developColor)) && NIV99_SUPPORTED_FAMILIES.has(profile.family);
  if (niv99Required && !capabilities.mfsr?.ready) {
    throw new Error(`Mandatory NIV99 conversion runtime is unavailable: ${capabilities.mfsr?.error || 'worker self-test failed'}`);
  }
  const niv99Ready = Boolean(capabilities.mfsr?.ready && NIV99_SUPPORTED_FAMILIES.has(profile.family));
  const canonicalDeliveryRequired = ['ndr', 'nivukx'].includes(profile.family);
  if (canonicalDeliveryRequired && !hasCanonicalDeliveryRuntime(capabilities)) {
    throw new Error(`Canonical ${profile.label} runtime is unavailable: ${capabilities.mfsr?.error || 'worker self-test failed'}`);
  }
  if (aiReady || mfsrReady || niv99Ready) {
    const rotated = Math.abs(Number(media.rotation || 0)) % 180 === 90;
    const width = rotated ? media.height : media.width;
    const height = rotated ? media.width : media.height;
    const fps = Number(media.fps) > 0 ? Number(media.fps) : 30;
    const decoderFilter = deliveryFilter(profile, media, job, 'processor');
    const decoderMedia = media.videoTimelinePath ? { ...media, videoTimelinePath: null } : media;
    const decoderArgs = sourceArgs(decoderMedia, rawPipeline, false);
    // A full-sensor RGB48 filter worker can reserve several 72 MiB frames. The
    // enhancement GPU is the throughput limiter, so one decoder filter thread
    // removes avoidable host-memory pressure without changing a pixel.
    decoderArgs.push('-filter_threads', '1', '-filter_complex_threads', '1', '-filter_buffered_frames', '2',
      '-map', '0:v:0', '-an', '-vf', decoderFilter, '-pix_fmt', 'rgb48le',
      '-fps_mode:v', 'passthrough', '-f', 'rawvideo', 'pipe:1');
    const encoderPlan = encoderArgs(profile, job.quality || 'maximum', capabilities, job.executionMode, media);
    const activeGpuEncoder = activeGpuEncoderForArgs(encoderPlan, capabilities);
    const resolvedEncoder = resolvedEncoderForArgs(profile, encoderPlan, activeGpuEncoder);
    const encoderInput = ['-hide_banner', '-y', '-nostdin', '-f', 'rawvideo', '-pixel_format', 'rgb48le',
      '-video_size', `${width}x${height}`, '-framerate', String(fps), '-i', 'pipe:0'];
    insertPqInputMetadata(encoderInput, profile);
    if (hasAudioSource) {
      if (customContainer) encoderInput.push('-f', 'aac', '-i', media.audioInputPath);
      else encoderInput.push('-i', media.filePath);
    }
    encoderInput.push('-map', '0:v:0');
    if (hasAudioSource) encoderInput.push('-map', '1:a?');
    encoderInput.push('-vf', processorEncodeFilter(profile, media), ...encoderPlan);
    if (hasAudioSource) {
      const audioFilter = customContainer ? cameraAudioFilter(media) : null;
      if (customContainer && media.audioSidecar) {
        // Camera AAC access units are already the authoritative master. Packet-copy avoids a
        // needless decode/re-encode while the validator proves packet hashes and configuration.
        encoderInput.push('-c:a', 'copy', '-bsf:a', 'aac_adtstoasc');
      } else {
        if (audioFilter) encoderInput.push('-af', audioFilter);
        encoderInput.push('-c:a', 'pcm_s24le');
      }
    }
    encoderInput.push('-map_metadata', hasAudioSource && !customContainer ? '1' : '0');
    appendDeliveryMetadata(encoderInput, profile, job, resolvedEncoder);
    const hasExactTimeline = Array.isArray(media.timestamps) && media.timestamps.length;
    if (media.variableFrameRate || hasExactTimeline) encoderInput.push('-fps_mode:v', 'vfr');
    if (hasExactTimeline) {
      encoderInput.push('-enc_time_base:v', '1:1000000', '-video_track_timescale', '1000000');
    }
    encoderInput.push('-movflags', '+faststart+write_colr', '-progress', 'pipe:1', '-nostats', outputPath);
    const settings = aiSettings(job.quality || 'maximum');
    const reconstruction = mfsrSettings(job.quality || 'maximum');
    const systemMemoryMiB = Math.floor(Number(capabilities.memoryBytes || 0) / (1024 * 1024));
    const defaultIoMemoryMiB = systemMemoryMiB > 0
      ? Math.max(64, Math.min(512, Math.floor(systemMemoryMiB * 0.04))) : 256;
    const rgb48FrameMiB = Math.ceil((width * height * 3 * 2) / (1024 * 1024));
    // On an 8 GiB class machine, two queued 12.6 MP RGB48 frames on each side
    // of the worker consume ~288 MiB before active processing begins.  Depth
    // one still overlaps I/O and frees that memory for the shared GPU heap.
    const ioMemoryMiB = systemMemoryMiB > 0 && systemMemoryMiB < 12 * 1024
      ? Math.max(64, Math.min(defaultIoMemoryMiB, rgb48FrameMiB * 2))
      : defaultIoMemoryMiB;
    const processorArgs = ['--width', String(width), '--height', String(height),
      '--threads', String(Math.max(1, Number(capabilities.logicalCores || 1))),
      '--compute-backend', capabilities.compute?.ready ? 'gpu' : 'cpu',
      '--io-memory-mib', String(ioMemoryMiB)];
    if (aiReady) {
      processorArgs.push('--model', capabilities.ai.modelPath, '--strength', String(settings.strength),
      '--interval', String(settings.interval), '--temporal-strength', String(settings.temporalStrength));
      if (capabilities.ai.onnxModelPath && capabilities.ai.accelerated) {
        processorArgs.push('--onnx-model', capabilities.ai.onnxModelPath);
      }
    } else processorArgs.push('--no-ai');
    if (mfsrReady) processorArgs.push('--mfsr', '--mfsr-frames', String(reconstruction.frames),
      '--mfsr-strength', String(reconstruction.strength), '--mfsr-scene-threshold', String(reconstruction.sceneThreshold),
      '--mfsr-memory-mib', String(reconstruction.memoryMiB));
    if (niv99Ready) {
      const signalFamily = ['hlg', 'hdr10', 'ndr', 'nivukx'].includes(profile.family) ? 'HDR' : profile.family === 'log' ? 'LOG' : 'SDR';
      processorArgs.push('--niv99', '--riven', '--detail-profile', sourceDetailProfile(media),
        '--signal-family', signalFamily, '--quality', job.quality || 'maximum',
        '--saturation', String(boundedMetadataNumber(media, ['sncesaturation', 'saturation'], 1, 0.90, 1.10)),
        '--warmth', String(boundedMetadataNumber(media, ['sncewarmth', 'warmth'], 0, -0.10, 0.10)),
        '--wb-authority', sourceWhiteBalanceAuthority(media));
    }
    if (canonicalDeliveryRequired) {
      processorArgs.push(
        '--delivery-transform', profile.family === 'nivukx' ? 'NIVUKX_VISION' : 'NDR10_PLUS',
        '--delivery-reference', String(diffuseWhiteSceneFor(media)),
        '--warm-skin-red-tame', String(boundedMetadataNumber(media,
          ['warmskinredtame', 'warmskinredtamestrength'], 0.50, 0, 1))
      );
    }
    const encoderName = profile.encoder === 'r210' ? 'r210' : profile.encoder === 'v210' ? 'v210' :
      profile.encoder === 'ffv1' || profile.encoder === 'lossless420' ? resolvedEncoder :
      profile.encoder === 'prores' ? `prores_ks ${profile.proresName}` :
        activeGpuEncoder || 'libx265';
    const computeEngine = capabilities.compute?.ready ? capabilities.compute.engine : 'CPU RGB48';
    const continuumEngine = capabilities.compute?.ready && capabilities.compute?.continuum?.version
      ? capabilities.compute.continuum.version : null;
    const stages = [continuumEngine, mfsrReady && `Offline MFSR (${computeEngine})`, niv99Ready && `NIV99/OmniClarity (${computeEngine})`,
      aiReady && `CamX AI (${capabilities.ai.engine})`, encoderName].filter(Boolean);
    return {
      operation: 'enhance-ffmpeg', profile: { ...profile, resolvedEncoder }, outputPath,
      decoderArgs, encoderArgs: encoderInput, companionArtifacts,
      processorPath: capabilities.mfsr?.workerPath || capabilities.ai?.workerPath,
      processorArgs,
      compute: capabilities.compute?.ready ? {
        ready: true, version: capabilities.compute.version, engine: capabilities.compute.engine,
        backend: capabilities.compute.backend, adapter: capabilities.compute.adapter,
        maximumCodeDelta: capabilities.compute.maximumCodeDelta,
        kernels: capabilities.compute.kernels,
        continuum: capabilities.compute.continuum || null,
        frameGraphs: capabilities.compute.frameGraphs || []
      } : { ready: false, engine: 'NumPy CPU', backend: 'CPU', error: capabilities.compute?.error || null },
      ai: aiReady ? { enabled: true, model: capabilities.ai.model, modelSha256: capabilities.ai.modelSha256, engine: capabilities.ai.engine,
        guardrail: 'scene-cut reset + confidence gate + edge/highlight protection', ...settings } : { enabled: false },
      mfsr: mfsrReady ? { enabled: true, algorithm: capabilities.mfsr.algorithm, engine: capabilities.mfsr.engine,
        precision: 'RGB48', outputScale: 1,
        guardrail: 'sub-pixel registration + 3-sigma ghost veto + scene-cut reset + bounded native-grid detail', ...reconstruction } : { enabled: false },
      niv99: niv99Ready ? {
        enabled: true, version: 'NIV99_OFFLINE_RGB48_V2', detailProfile: sourceDetailProfile(media),
        signalFamily: ['hlg', 'hdr10', 'ndr', 'nivukx'].includes(profile.family) ? 'HDR' : profile.family === 'log' ? 'LOG' : 'SDR',
        whiteBalanceAuthority: sourceWhiteBalanceAuthority(media),
        stages: ['scene analysis', 'edge-aware luma/chroma denoise', 'multi-scale detail', 'halo/highlight guard', 'Riven motion deblur', 'SNCE residual color']
      } : { enabled: false },
      rawPipeline,
      losslessContract: losslessContract(profile, resolvedEncoder, capabilities),
      colorPipeline: colorPipelineContract(profile, job, media),
      gpu: Boolean(activeGpuEncoder || capabilities.compute?.ready || (aiReady && capabilities.ai?.accelerated)),
      engine: stages.join(' + '),
      execution: {
        requested: job.executionMode || 'gpu-auto',
        decodeAndColor: 'CPU exact decode/color + RGB48 GPU upload',
        enhancements: [mfsrReady && `${computeEngine} MFSR RGB48`, niv99Ready && `${computeEngine} NIV99 RGB48`,
          aiReady && capabilities.ai.engine, continuumEngine && `${continuumEngine} resident frame graph`]
          .filter(Boolean).join(' + ') || 'bypassed',
        encode: activeGpuEncoder ? `GPU ${activeGpuEncoder}` : `CPU ${encoderName}`,
        ...stageExecutionReport({
          profile, media, computeReady: Boolean(capabilities.compute?.ready), computeEngine,
          aiReady, aiEngine: capabilities.ai?.engine, mfsrReady, niv99Ready,
          canonicalDeliveryRequired, activeGpuEncoder, encoderName
        })
      }
    };
  }

  if (filter) args.push('-vf', filter);
  const selectedEncoderArgs = encoderArgs(profile, job.quality || 'maximum', capabilities, job.executionMode, media);
  const activeGpuEncoder = activeGpuEncoderForArgs(selectedEncoderArgs, capabilities);
  const resolvedEncoder = resolvedEncoderForArgs(profile, selectedEncoderArgs, activeGpuEncoder);
  args.push(...selectedEncoderArgs);
  if (hasAudioSource) {
    const audioFilter = customContainer ? cameraAudioFilter(media) : null;
    if (customContainer && media.audioSidecar) args.push('-c:a', 'copy', '-bsf:a', 'aac_adtstoasc');
    else {
      if (audioFilter) args.push('-af', audioFilter);
      args.push('-c:a', 'pcm_s24le');
    }
  }
  args.push('-map_metadata', '0');
  appendDeliveryMetadata(args, profile, job, resolvedEncoder);
  const hasExactTimeline = Array.isArray(media.timestamps) && media.timestamps.length;
  if (media.variableFrameRate || hasExactTimeline) args.push('-fps_mode:v', 'vfr');
  if (hasExactTimeline) {
    args.push('-enc_time_base:v', '1:1000000', '-video_track_timescale', '1000000');
  }
  args.push('-movflags', '+faststart+write_colr', '-progress', 'pipe:1', '-nostats', outputPath);
  const encoderName = profile.encoder === 'r210' ? 'r210' : profile.encoder === 'v210' ? 'v210' :
    profile.encoder === 'ffv1' || profile.encoder === 'lossless420' ? resolvedEncoder :
      activeGpuEncoder || (profile.encoder === 'prores' ? `prores_ks ${profile.proresName}` : 'libx265');
  return {
    operation: 'ffmpeg', profile: { ...profile, resolvedEncoder }, outputPath, args, companionArtifacts,
    rawPipeline,
    losslessContract: losslessContract(profile, resolvedEncoder, capabilities),
    colorPipeline: colorPipelineContract(profile, job, media),
    gpu: Boolean(activeGpuEncoder),
    engine: encoderName,
    execution: {
      requested: job.executionMode || 'gpu-auto',
      decodeAndColor: 'CPU high-precision filter graph',
      enhancements: 'bypassed',
      encode: activeGpuEncoder ? `GPU ${activeGpuEncoder}` : `CPU ${encoderName}`,
      ...stageExecutionReport({
        profile, media, computeReady: false, computeEngine: null, aiReady: false,
        aiEngine: null, mfsrReady: false, niv99Ready: false,
        canonicalDeliveryRequired: false, activeGpuEncoder, encoderName
      })
    }
  };
}

function outputName(sourcePath, profileId, options = {}) {
  const profile = PROFILES[profileId] || PROFILES['rec709-sdr-ffv1rgb16'];
  const extension = profile.directory ? '' : profile.extension ?? path.extname(sourcePath);
  const base = path.basename(sourcePath, path.extname(sourcePath)).replace(/[^a-zA-Z0-9._-]+/g, '_');
  const logVariant = profile.family === 'log'
    ? `_${String(options.logVariant || 'base').toUpperCase().replace(/[^A-Z0-9_-]+/g, '_')}`
    : '';
  return `${base}_${profile.suffix}${logVariant}${extension}`;
}

module.exports = {
  PROFILES, CONVERSION_CATALOG, DELIVERY_DEFINITIONS, TRANSPORT_DEFINITIONS,
  PUBLIC_PROFILE_IDS, isPublicProfile, assertPublicConversionRoute,
  NEOLOG, COLOR_TARGETS, AI_SUPPORTED_FAMILIES, MFSR_SUPPORTED_FAMILIES, NIV99_SUPPORTED_FAMILIES,
  encodeNeoLog, decodeNeoLog, ensureNeoLogLut, ensureNeoLogViewingLut, ensureNeoLogManifest, encoderArgs,
  gpuEncoderArgs, gpuLosslessEncoderArgs, ffv1EncoderArgs, gpuEncoderQueueDepth,
  displayFilters, canonicalDeliveryInputFilters, xyzD50ToTargetMatrix, cameraAudioFilter, buildPlan, outputName
};
