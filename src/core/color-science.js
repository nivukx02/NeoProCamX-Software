'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { tempDirectory } = require('./runtime-paths');

const EPSILON = 1e-10;
// Camera RAW ColorMatrix data is explicitly XYZ(D50), matching DNG.
const D50 = Object.freeze([0.96422, 1, 0.82521]);
const D65 = Object.freeze([0.9504559271, 1, 1.0890577508]);
const D60 = Object.freeze([0.9526460746, 1, 1.0088251844]);

// Canonical CAT16 sharpened cone-response matrix and inverse.
const CAT16 = Object.freeze([
  0.401288, 0.650173, -0.051461,
  -0.250268, 1.204414, 0.045854,
  -0.002079, 0.048952, 0.953127
]);
const CAT16_INVERSE = Object.freeze([
  1.86206786, -1.01125463, 0.14918678,
  0.38752654, 0.62144744, -0.00897398,
  -0.01584150, -0.03412294, 1.04996444
]);

const RGB_TO_XYZ = Object.freeze({
  bt709: Object.freeze([
    0.4123907993, 0.3575843394, 0.1804807884,
    0.2126390059, 0.7151686788, 0.0721923154,
    0.0193308187, 0.1191947798, 0.9505321522
  ]),
  bt2020: Object.freeze([
    0.6369580483, 0.1446169036, 0.1688809752,
    0.2627002120, 0.6779980715, 0.0593017165,
    0, 0.0280726930, 1.0609850577
  ]),
  p3d65: Object.freeze([
    0.4865709486, 0.2656676932, 0.1982172852,
    0.2289745641, 0.6917385218, 0.0792869141,
    0, 0.0451133819, 1.0439443689
  ])
});

const XYZ_TO_RGB = Object.freeze({
  bt709: Object.freeze([
    3.2409699419, -1.5373831776, -0.4986107603,
    -0.9692436363, 1.8759675015, 0.0415550574,
    0.0556300797, -0.2039769589, 1.0569715142
  ]),
  bt2020: Object.freeze([
    1.7166511880, -0.3556707838, -0.2533662814,
    -0.6666843518, 1.6164812366, 0.0157685458,
    0.0176398574, -0.0427706133, 0.9421031212
  ]),
  p3d65: Object.freeze([
    2.4934969119, -0.9313836179, -0.4027107845,
    -0.8294889696, 1.7626640603, 0.0236246858,
    0.0358458302, -0.0761723893, 0.9568845240
  ])
});

// ACES AP1 / ACEScg matrices, D60 white.
const ACESCG_TO_XYZ = Object.freeze([
  0.6624541811, 0.1340042065, 0.1561876870,
  0.2722287168, 0.6740817658, 0.0536895174,
  -0.0055746495, 0.0040607335, 1.0103391003
]);
const XYZ_TO_ACESCG = Object.freeze([
  1.6410233797, -0.3248032942, -0.2364246952,
  -0.6636628587, 1.6153315917, 0.0167563477,
  0.0117218943, -0.0082844420, 0.9883948585
]);

const STYLE = Object.freeze({
  sdr: Object.freeze({ chroma: 0.026, contrast: 0.014, shoulder: 0.012, adaptingLuminance: 32 }),
  'p3-sdr': Object.freeze({ chroma: 0.023, contrast: 0.012, shoulder: 0.012, adaptingLuminance: 32 }),
  'bt2020-sdr': Object.freeze({ chroma: 0.020, contrast: 0.011, shoulder: 0.012, adaptingLuminance: 32 }),
  hlg: Object.freeze({ chroma: 0.014, contrast: 0.006, shoulder: 0.007, adaptingLuminance: 64 }),
  hdr10: Object.freeze({ chroma: 0.014, contrast: 0.006, shoulder: 0.006, adaptingLuminance: 64 }),
  ndr: Object.freeze({ chroma: 0.014, contrast: 0.006, shoulder: 0.006, adaptingLuminance: 64 }),
  nivukx: Object.freeze({ chroma: 0.020, contrast: 0.008, shoulder: 0.008, adaptingLuminance: 96 })
});

function clamp(value, low = 0, high = 1) {
  return Math.min(high, Math.max(low, value));
}

function multiplyVector(matrix, vector) {
  return [
    matrix[0] * vector[0] + matrix[1] * vector[1] + matrix[2] * vector[2],
    matrix[3] * vector[0] + matrix[4] * vector[1] + matrix[5] * vector[2],
    matrix[6] * vector[0] + matrix[7] * vector[1] + matrix[8] * vector[2]
  ];
}

function multiply3x3(a, b) {
  const output = new Array(9).fill(0);
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      for (let k = 0; k < 3; k += 1) output[row * 3 + column] += a[row * 3 + k] * b[k * 3 + column];
    }
  }
  return output;
}

function cat16Matrix(sourceWhite, targetWhite, degree = 1) {
  const d = clamp(Number.isFinite(degree) ? degree : 0);
  if (d === 0) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const source = multiplyVector(CAT16, sourceWhite);
  const target = multiplyVector(CAT16, targetWhite);
  if (source.some(value => !Number.isFinite(value) || Math.abs(value) < EPSILON)) {
    return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  }
  const scale = source.map((value, index) => d * target[index] / value + 1 - d);
  const scaled = [
    CAT16[0] * scale[0], CAT16[1] * scale[0], CAT16[2] * scale[0],
    CAT16[3] * scale[1], CAT16[4] * scale[1], CAT16[5] * scale[1],
    CAT16[6] * scale[2], CAT16[7] * scale[2], CAT16[8] * scale[2]
  ];
  return multiply3x3(CAT16_INVERSE, scaled);
}

function postAdaptation(value, fl) {
  const magnitude = Math.pow(fl * Math.abs(value) / 100, 0.42);
  return Math.sign(value || 1) * 400 * magnitude / (magnitude + 27.13) + 0.1;
}

function inversePostAdaptation(value, fl) {
  const centered = value - 0.1;
  const magnitude = Math.abs(centered);
  const denominator = 400 - magnitude;
  if (denominator <= EPSILON) return Math.sign(centered || 1) * 1e4;
  return Math.sign(centered || 1) * 100 / fl * Math.pow(27.13 * magnitude / denominator, 1 / 0.42);
}

function createViewingConditions(whiteXyz = D60, adaptingLuminance = 64, backgroundLuminance = 20) {
  const white100 = whiteXyz.map(value => value * 100);
  const rgbWhite = multiplyVector(CAT16, white100);
  const la = Math.max(0, adaptingLuminance);
  const degree = clamp(1 - (1 / 3.6) * Math.exp((-la - 42) / 92));
  const dRgb = rgbWhite.map(value => degree * 100 / (Math.abs(value) < EPSILON ? EPSILON : value) + 1 - degree);
  const k = 1 / (5 * la + 1);
  const k4 = k ** 4;
  const fl = 0.2 * k4 * 5 * la + 0.1 * (1 - k4) ** 2 * Math.cbrt(5 * la);
  const n = clamp(backgroundLuminance / 100, EPSILON, 1);
  const z = 1.48 + Math.sqrt(n);
  const nbb = 0.725 * Math.pow(1 / n, 0.2);
  const rgbAdaptedWhite = rgbWhite.map((value, index) => postAdaptation(dRgb[index] * value, fl));
  const aw = (2 * rgbAdaptedWhite[0] + rgbAdaptedWhite[1] + 0.05 * rgbAdaptedWhite[2] - 0.305) * nbb;
  return {
    fl, n, z, nbb, ncb: nbb, aw, dRgb, c: 0.69, nc: 1,
    cz: 0.69 * z, flRoot: Math.pow(fl, 0.25),
    tExponentBase: Math.pow(1.64 - Math.pow(0.29, n), 0.73)
  };
}

function cam16Forward(xyz, vc) {
  const rgb = multiplyVector(CAT16, xyz.map(value => value * 100));
  const rgbA = rgb.map((value, index) => postAdaptation(vc.dRgb[index] * value, vc.fl));
  const a = rgbA[0] - 12 * rgbA[1] / 11 + rgbA[2] / 11;
  const b = (rgbA[0] + rgbA[1] - 2 * rgbA[2]) / 9;
  const hRad = Math.atan2(b, a);
  const h = ((hRad * 180 / Math.PI) % 360 + 360) % 360;
  const et = 0.25 * (Math.cos(hRad + 2) + 3.8);
  const achromatic = (2 * rgbA[0] + rgbA[1] + 0.05 * rgbA[2] - 0.305) * vc.nbb;
  const j = 100 * Math.pow(Math.max(0, achromatic / vc.aw), vc.cz);
  const denominator = rgbA[0] + rgbA[1] + 1.05 * rgbA[2] + 0.305;
  const t = denominator <= 0 ? 0 : (50000 / 13 * vc.nc * vc.ncb) * et * Math.hypot(a, b) / denominator;
  const sqrtJ = Math.sqrt(Math.max(0, j / 100));
  const c = Math.pow(Math.max(0, t), 0.9) * sqrtJ * vc.tExponentBase;
  return { j, c, h };
}

function cam16Inverse(j, chroma, hueDegrees, vc) {
  const hRad = (((hueDegrees % 360) + 360) % 360) * Math.PI / 180;
  const sqrtJ = Math.sqrt(Math.max(0, j / 100));
  const t = sqrtJ < EPSILON || vc.tExponentBase < EPSILON ? 0 :
    Math.pow(Math.max(0, chroma / (sqrtJ * vc.tExponentBase)), 1 / 0.9);
  const et = 0.25 * (Math.cos(hRad + 2) + 3.8);
  const achromatic = vc.aw * Math.pow(Math.max(0, j / 100), 1 / vc.cz);
  const p2 = achromatic / vc.nbb + 0.305;
  let a = 0;
  let b = 0;
  if (t >= EPSILON) {
    const p1 = (50000 / 13 * vc.nc * vc.ncb) * et / t;
    const sinH = Math.sin(hRad);
    const cosH = Math.cos(hRad);
    const p3 = 21 / 20;
    if (Math.abs(sinH) >= Math.abs(cosH)) {
      const safeSin = Math.abs(sinH) < EPSILON ? Math.sign(sinH || 1) * EPSILON : sinH;
      const p4 = p1 / safeSin;
      b = (p2 * (2 + p3) * (460 / 1403)) /
        (p4 + (2 + p3) * (220 / 1403) * (cosH / safeSin) - 27 / 1403 + p3 * 6300 / 1403);
      a = b * cosH / safeSin;
    } else {
      const safeCos = Math.abs(cosH) < EPSILON ? Math.sign(cosH || 1) * EPSILON : cosH;
      const p5 = p1 / safeCos;
      a = (p2 * (2 + p3) * (460 / 1403)) /
        (p5 + (2 + p3) * 220 / 1403 - (27 / 1403 - p3 * 6300 / 1403) * (sinH / safeCos));
      b = a * sinH / safeCos;
    }
  }
  const rgbA = [
    (460 * p2 + 451 * a + 288 * b) / 1403,
    (460 * p2 - 891 * a - 261 * b) / 1403,
    (460 * p2 - 220 * a - 6300 * b) / 1403
  ];
  const rgb = rgbA.map((value, index) => inversePostAdaptation(value, vc.fl) / vc.dRgb[index]);
  return multiplyVector(CAT16_INVERSE, rgb).map(value => value / 100);
}

function decodeBt709(value) {
  const x = clamp(value);
  return x < 0.081 ? x / 4.5 : Math.pow((x + 0.099) / 1.099, 1 / 0.45);
}

function encodeBt709(value) {
  const x = Math.max(0, value);
  return clamp(x < 0.018 ? 4.5 * x : 1.099 * Math.pow(x, 0.45) - 0.099);
}

function decodeSrgb(value) {
  const x = clamp(value);
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

function encodeSrgb(value) {
  const x = Math.max(0, value);
  return clamp(x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
}

function decodeHlg(value) {
  const a = 0.17883277;
  const b = 0.28466892;
  const c = 0.55991073;
  const x = clamp(value);
  return x <= 0.5 ? x * x / 3 : (Math.exp((x - c) / a) + b) / 12;
}

function encodeHlg(value) {
  const a = 0.17883277;
  const b = 0.28466892;
  const c = 0.55991073;
  const x = Math.max(0, value);
  return clamp(x <= 1 / 12 ? Math.sqrt(3 * x) : a * Math.log(12 * x - b) + c);
}

function decodePq(value) {
  const m1 = 2610 / 16384;
  const m2 = 2523 / 32;
  const c1 = 3424 / 4096;
  const c2 = 2413 / 128;
  const c3 = 2392 / 128;
  const power = Math.pow(clamp(value), 1 / m2);
  return Math.pow(Math.max(0, (power - c1) / Math.max(EPSILON, c2 - c3 * power)), 1 / m1);
}

function encodePq(value) {
  const m1 = 2610 / 16384;
  const m2 = 2523 / 32;
  const c1 = 3424 / 4096;
  const c2 = 2413 / 128;
  const c3 = 2392 / 128;
  const power = Math.pow(clamp(value), m1);
  return clamp(Math.pow((c1 + c2 * power) / (1 + c3 * power), m2));
}

function gamutSafeInverse(app, vc, xyzToRgb, maximumLinear) {
  let low = 0;
  let high = Math.max(0, app.c);
  let best = cam16Inverse(app.j, low, app.h, vc);
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const candidateChroma = iteration === 0 ? high : (low + high) / 2;
    const xyz = cam16Inverse(app.j, candidateChroma, app.h, vc);
    const rgb = multiplyVector(xyzToRgb, xyz);
    const valid = rgb.every(value => Number.isFinite(value) && value >= -1e-7 && value <= maximumLinear + 1e-7);
    if (valid) {
      low = candidateChroma;
      best = xyz;
      if (iteration === 0) break;
    } else {
      high = candidateChroma;
    }
  }
  return best;
}

/**
 * Bounded display transform used to bake the shipping 33^3 LUTs. It performs a
 * real CAT16 D65->D60 adaptation, ACEScg float working-space round-trip, and
 * CAM16 appearance-domain shaping. The transform never invents spatial detail.
 */
function transformSignalRgb(rgb, family = 'sdr') {
  const selected = STYLE[family] ? family : 'sdr';
  const style = STYLE[selected];
  const primaries = selected === 'p3-sdr' ? 'p3d65' : selected === 'sdr' ? 'bt709' : 'bt2020';
  const decode = selected === 'p3-sdr' ? decodeSrgb :
    ['sdr', 'bt2020-sdr'].includes(selected) ? decodeBt709 : selected === 'hlg' ? decodeHlg : decodePq;
  const encode = selected === 'p3-sdr' ? encodeSrgb :
    ['sdr', 'bt2020-sdr'].includes(selected) ? encodeBt709 : selected === 'hlg' ? encodeHlg : encodePq;
  const linear = rgb.map(decode);
  const xyzD65 = multiplyVector(RGB_TO_XYZ[primaries], linear);
  const d65ToD60 = cat16Matrix(D65, D60, 1);
  const d60ToD65 = cat16Matrix(D60, D65, 1);
  let xyzD60 = multiplyVector(d65ToD60, xyzD65);

  // Explicit ACEScg/AP1 32-bit-float working domain. This round-trip is kept
  // neutral; creative shaping is performed in CAM16 to preserve hue.
  const acescg = multiplyVector(XYZ_TO_ACESCG, xyzD60);
  xyzD60 = multiplyVector(ACESCG_TO_XYZ, acescg);

  const vc = createViewingConditions(D60, style.adaptingLuminance, 20);
  const appearance = cam16Forward(xyzD60, vc);
  const normalizedJ = clamp(appearance.j / 100);
  const midtone = Math.sin(Math.PI * normalizedJ);
  const contrastShape = (normalizedJ - 0.5) * (1 - Math.abs(2 * normalizedJ - 1));
  const highlight = clamp((normalizedJ - 0.78) / 0.22);
  const targetJ = Math.max(0, appearance.j + 100 * style.contrast * contrastShape - 100 * style.shoulder * highlight * highlight);
  const chromaScale = 1 + style.chroma * midtone * (1 - clamp(appearance.c / 120));
  const shaped = { j: targetJ, c: appearance.c * chromaScale, h: appearance.h };
  const maximumLinear = 1;
  const safeD60 = gamutSafeInverse(shaped, vc, multiply3x3(XYZ_TO_RGB[primaries], d60ToD65), maximumLinear);
  const outputD65 = multiplyVector(d60ToD65, safeD60);
  const outputLinear = multiplyVector(XYZ_TO_RGB[primaries], outputD65);
  return outputLinear.map(value => encode(clamp(value, 0, maximumLinear)));
}

function ensurePerceptualLut(family = 'sdr') {
  const selected = STYLE[family] ? family : 'sdr';
  const directory = path.join(tempDirectory(), 'luts');
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `camx-${selected}-cat16-cam16-acescg-v2.cube`);
  if (fs.existsSync(target)) return target;
  const size = 33;
  const lines = [
    `TITLE "CamX Studio ${selected.toUpperCase()} CAT16 CAM16 ACEScg v2"`,
    `LUT_3D_SIZE ${size}`,
    'DOMAIN_MIN 0.0 0.0 0.0',
    'DOMAIN_MAX 1.0 1.0 1.0'
  ];
  const denominator = size - 1;
  for (let blue = 0; blue < size; blue += 1) {
    for (let green = 0; green < size; green += 1) {
      for (let red = 0; red < size; red += 1) {
        const output = transformSignalRgb([red / denominator, green / denominator, blue / denominator], selected);
        lines.push(output.map(value => value.toFixed(9)).join(' '));
      }
    }
  }
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${lines.join('\n')}\n`, 'utf8');
  try { fs.renameSync(temporary, target); } catch (error) {
    if (!fs.existsSync(target)) throw error;
    fs.rmSync(temporary, { force: true });
  }
  return target;
}

module.exports = {
  D50, D65, D60, CAT16, CAT16_INVERSE, RGB_TO_XYZ, XYZ_TO_RGB, ACESCG_TO_XYZ, XYZ_TO_ACESCG,
  multiplyVector, multiply3x3, cat16Matrix, createViewingConditions,
  cam16Forward, cam16Inverse, transformSignalRgb, ensurePerceptualLut,
  decodeBt709, encodeBt709, decodeSrgb, encodeSrgb, decodeHlg, encodeHlg
};
