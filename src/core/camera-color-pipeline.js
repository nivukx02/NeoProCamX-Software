'use strict';

/**
 * Canonical desktop port of the camera's NdrToneOperator v4 and
 * NdrNivukxDeliveryEngine v1. Keep constants and operation order in lock-step
 * with the Android core-math implementation; these functions are golden-tested.
 */

const VERSION = 'NDR-TONE-OP-v4';
const CALIBRATION_VERSION = 'NDR-NIVUKX-PY-CAL-v4';
const DELIVERY_VERSION = 'NDR-NIVUKX-DELIVERY-v1';
const DIFFUSE_WHITE_NITS = 203;
const SENSOR_DIFFUSE_SCENE = 0.180;
const NDR10_PLUS_MASTER_PEAK_NITS = 5000;
const NIVUKX_VISION_MASTER_PEAK_NITS = 10000;
const HLG_REFERENCE_WHITE_SIGNAL = 0.75;
const EPS = 1e-8;

const ACESCG_TO_BT2020 = Object.freeze([
  1.02582, -0.02005, -0.00577,
  -0.00386, 1.01040, -0.00654,
  -0.01784, -0.07404, 1.09188
]);

const PARAMS = Object.freeze({
  NDR10_PLUS: Object.freeze({
    mode: 'NDR10_PLUS', signalGamma: 0.859937, toeWidth: 0.238882,
    toeAmount: 0.024780, diffuseWhiteNits: DIFFUSE_WHITE_NITS,
    peakNits: NDR10_PLUS_MASTER_PEAK_NITS, highlightDesat: 0.149718,
    shadowMidtoneLift: 0.167837, midtoneContrast: 0.100943,
    chromaBoost: 0.038361, skyChromaBonus: 0.062392,
    localDetailStrength: 0.4, localDetailLowerStops: -0.06,
    localDetailUpperStops: 0.085
  }),
  NIVUKX_VISION: Object.freeze({
    mode: 'NIVUKX_VISION', signalGamma: 0.800034, toeWidth: 0.289876,
    toeAmount: 0.031033, diffuseWhiteNits: DIFFUSE_WHITE_NITS,
    peakNits: NIVUKX_VISION_MASTER_PEAK_NITS, highlightDesat: 0.128953,
    shadowMidtoneLift: 0.232156, midtoneContrast: 0.174135,
    chromaBoost: 0.091565, skyChromaBonus: 0.08,
    localDetailStrength: 0.6, localDetailLowerStops: -0.085,
    localDetailUpperStops: 0.125
  })
});

function clamp(value, low = 0, high = 1) {
  return Math.min(high, Math.max(low, value));
}

function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) return value >= edge1 ? 1 : 0;
  const t = clamp((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function paramsFor(mode) {
  const key = String(mode || '').toUpperCase();
  const params = PARAMS[key];
  if (!params) throw new Error(`Unknown CamX delivery mode: ${mode || 'unset'}`);
  return params;
}

function signalReferenceSlope(params) {
  return params.signalGamma - params.toeAmount;
}

function luma(r, g, b) {
  return 0.2627 * r + 0.6780 * g + 0.0593 * b;
}

function signalShape(sceneNorm, params) {
  const x = Number(sceneNorm);
  if (!(x > 0)) return 0;
  if (x <= 1) {
    const gammaLift = x ** params.signalGamma;
    const toe = smoothstep(0, params.toeWidth, x) * params.toeAmount * (1 - x);
    return gammaLift + toe;
  }
  return 1 + signalReferenceSlope(params) * (x - 1);
}

function blackPreservingMidtoneLift(signal, params) {
  const x = Math.max(0, signal);
  if (x <= 0 || x >= 1) return x;
  const window = smoothstep(0.025, 0.20, x) * (1 - smoothstep(0.78, 1.20, x));
  return x + params.shadowMidtoneLift * Math.sqrt(x) * (1 - x) * window;
}

function profileMidtoneContrast(signal, params) {
  const x = Math.max(0, signal);
  if (x <= 0 || x >= 1) return x;
  const window = smoothstep(0.055, 0.24, x) * (1 - smoothstep(0.76, 1, x));
  const signedContrast = (x - 0.5) * 4 * x * (1 - x);
  return Math.max(0, x + params.midtoneContrast * signedContrast * window);
}

function signalToDisplayNits(signal, params) {
  const raw = Math.max(0, signal) * params.diffuseWhiteNits;
  if (raw <= params.diffuseWhiteNits) return raw;
  const range = params.peakNits - params.diffuseWhiteNits;
  return Math.min(params.peakNits,
    params.diffuseWhiteNits + range * (1 - Math.exp(-(raw - params.diffuseWhiteNits) / range)));
}

function displayNits(sceneNorm, params) {
  return signalToDisplayNits(
    profileMidtoneContrast(blackPreservingMidtoneLift(signalShape(sceneNorm, params), params), params),
    params
  );
}

function encodePqFromNits(nits) {
  const m1 = 2610 / 16384;
  const m2 = 2523 / 32;
  const c1 = 3424 / 4096;
  const c2 = 2413 / 128;
  const c3 = 2392 / 128;
  const normalized = clamp(nits / 10000);
  const power = normalized ** m1;
  return clamp(((c1 + c2 * power) / (1 + c3 * power)) ** m2);
}

function decodePqToNits(code) {
  const m1 = 2610 / 16384;
  const m2 = 2523 / 32;
  const c1 = 3424 / 4096;
  const c2 = 2413 / 128;
  const c3 = 2392 / 128;
  const power = clamp(code) ** (1 / m2);
  const normalized = (Math.max(0, power - c1) / Math.max(EPS, c2 - c3 * power)) ** (1 / m1);
  return normalized * 10000;
}

function mapRgbHuePreserving(r, g, b, params, warmSkinRedTame = 0) {
  const sr = Math.max(0, r);
  const sg = Math.max(0, g);
  const sb = Math.max(0, b);
  const y = Math.max(EPS, luma(sr, sg, sb));
  const mappedY = profileMidtoneContrast(
    blackPreservingMidtoneLift(signalShape(y, params), params), params
  );
  const scale = mappedY / y;
  let outR = sr * scale;
  let outG = sg * scale;
  let outB = sb * scale;

  const safeGreen = Math.max(EPS, sg);
  const redGreenRatio = sr / safeGreen;
  const blueGreenRatio = sb / safeGreen;
  const peak = Math.max(outR, outG, outB);
  const floor = Math.min(outR, outG, outB);
  const relativeChroma = (peak - floor) / Math.max(mappedY, 0.04);
  const colorConfidence = smoothstep(0.035, 0.22, relativeChroma);
  const skin = smoothstep(1.02, 1.16, redGreenRatio) *
    (1 - smoothstep(1.58, 2.10, redGreenRatio)) *
    (1 - smoothstep(0.98, 1.18, blueGreenRatio));
  const sky = smoothstep(1.03, 1.22, blueGreenRatio) *
    (1 - smoothstep(1.00, 1.22, redGreenRatio));
  const tonalWindow = smoothstep(0.035, 0.16, mappedY) *
    (1 - smoothstep(0.88, 1.65, mappedY));
  const skinProtection = 1 + (0.45 - 1) * skin;
  const chromaGain = 1 + (params.chromaBoost + params.skyChromaBonus * sky) *
    colorConfidence * tonalWindow * skinProtection;
  outR = mappedY + (outR - mappedY) * chromaGain;
  outG = mappedY + (outG - mappedY) * chromaGain;
  outB = mappedY + (outB - mappedY) * chromaGain;

  const desat = clamp(params.highlightDesat * smoothstep(0.55, 1, mappedY), 0, params.highlightDesat);
  if (desat > 0) {
    outR = mappedY + (outR - mappedY) * (1 - desat);
    outG = mappedY + (outG - mappedY) * (1 - desat);
    outB = mappedY + (outB - mappedY) * (1 - desat);
  }

  if (warmSkinRedTame > 0) {
    const originalY = Math.max(EPS, luma(outR, outG, outB));
    const moderateRed = smoothstep(1.18, 1.55, redGreenRatio) *
      (1 - smoothstep(2.80, 4.00, redGreenRatio));
    const bluePresent = smoothstep(0.28, 0.55, blueGreenRatio) *
      (1 - smoothstep(1.08, 1.35, blueGreenRatio));
    const exposureWindow = smoothstep(0.04, 0.16, mappedY) *
      (1 - smoothstep(6.5, 8.0, mappedY));
    const redOverflow = smoothstep(1.30, 2.10, redGreenRatio);
    const weight = clamp(warmSkinRedTame * moderateRed * bluePresent * exposureWindow *
      (0.45 + 0.55 * redOverflow), 0, warmSkinRedTame);
    if (weight > 0) {
      outR += (Math.min(outR, outG * 1.42) - outR) * weight;
      outB += (Math.max(outB, outG * 0.64) - outB) * (weight * 0.68);
      const restore = originalY / Math.max(EPS, luma(outR, outG, outB));
      outR *= restore;
      outG *= restore;
      outB *= restore;
    }
  }
  return [Math.max(0, outR), Math.max(0, outG), Math.max(0, outB)];
}

function compressToPeakColorVolume(rgbNits, luminanceNits, peakNits) {
  const peak = clamp(peakNits, DIFFUSE_WHITE_NITS, NIVUKX_VISION_MASTER_PEAK_NITS);
  const y = clamp(luminanceNits, 0, peak);
  const output = rgbNits.map(value => Math.max(0, value));
  const high = Math.max(...output);
  if (high <= peak || high <= y + EPS) return output;
  const chromaScale = clamp((peak - y) / (high - y));
  return output.map(value => clamp(y + (value - y) * chromaScale, 0, peak));
}

function deliverPq(r, g, b, mode, warmSkinRedTame = 0) {
  const params = paramsFor(mode);
  const shaped = mapRgbHuePreserving(r, g, b, params, warmSkinRedTame);
  const signalLuma = luma(...shaped);
  if (signalLuma <= EPS) return [0, 0, 0];
  const nits = signalToDisplayNits(signalLuma, params);
  const scaled = shaped.map(value => value * nits / signalLuma);
  return compressToPeakColorVolume(scaled, nits, params.peakNits).map(encodePqFromNits);
}

function deliverPqCodes(r, g, b, mode, bits = 10, warmSkinRedTame = 0) {
  if (!Number.isInteger(bits) || bits < 8 || bits > 16) throw new Error(`Unsupported NDR bit depth: ${bits}`);
  const maximum = 2 ** bits - 1;
  return deliverPq(r, g, b, mode, warmSkinRedTame)
    .map(value => clamp(Math.round(value * maximum), 0, maximum));
}

function acesCgToLinearBt2020(r, g, b) {
  return [
    ACESCG_TO_BT2020[0] * r + ACESCG_TO_BT2020[1] * g + ACESCG_TO_BT2020[2] * b,
    ACESCG_TO_BT2020[3] * r + ACESCG_TO_BT2020[4] * g + ACESCG_TO_BT2020[5] * b,
    ACESCG_TO_BT2020[6] * r + ACESCG_TO_BT2020[7] * g + ACESCG_TO_BT2020[8] * b
  ];
}

function hlgSignalToScene(signal) {
  const a = 0.17883277;
  const b = 0.28466892;
  const c = 0.55991073;
  const value = clamp(signal);
  return value <= 0.5 ? value * value / 3 : (Math.exp((value - c) / a) + b) / 12;
}

const HLG_REFERENCE_WHITE_SCENE = hlgSignalToScene(HLG_REFERENCE_WHITE_SIGNAL);

function diffuseWhiteSceneFor(media = {}) {
  if (media.raw) return SENSOR_DIFFUSE_SCENE;
  const sidecarTransfer = Number(media.developColor?.colorTransfer);
  const transfer = String(media.colorTransfer || media.metadataValues?.transfer || '').toLowerCase();
  if (sidecarTransfer === 1 || transfer.includes('hlg') || transfer === 'arib-std-b67') return HLG_REFERENCE_WHITE_SCENE;
  if (sidecarTransfer === 2 || transfer.includes('pq') || transfer === 'smpte2084') return DIFFUSE_WHITE_NITS / 10000;
  return 1;
}

module.exports = {
  VERSION, CALIBRATION_VERSION, DELIVERY_VERSION, DIFFUSE_WHITE_NITS,
  SENSOR_DIFFUSE_SCENE, NDR10_PLUS_MASTER_PEAK_NITS, NIVUKX_VISION_MASTER_PEAK_NITS,
  HLG_REFERENCE_WHITE_SIGNAL, HLG_REFERENCE_WHITE_SCENE, ACESCG_TO_BT2020, PARAMS,
  clamp, smoothstep, paramsFor, signalReferenceSlope, luma, signalShape,
  blackPreservingMidtoneLift, profileMidtoneContrast, signalToDisplayNits,
  displayNits, encodePqFromNits, decodePqToNits, mapRgbHuePreserving,
  compressToPeakColorVolume, deliverPq, deliverPqCodes, acesCgToLinearBt2020,
  hlgSignalToScene, diffuseWhiteSceneFor
};
