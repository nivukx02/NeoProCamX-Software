'use strict';

const { Readable } = require('node:stream');
const { rawFrameIterator } = require('./binary-formats');

const UINT16_MAX = 65535;
const CFA_CHANNEL_MAPS = Object.freeze([
  Object.freeze([0, 1, 2, 3]), // RGGB
  Object.freeze([1, 0, 3, 2]), // GRBG
  Object.freeze([2, 3, 0, 1]), // GBRG
  Object.freeze([3, 2, 1, 0])  // BGGR
]);

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function parseNumberList(value, expected) {
  if (Array.isArray(value)) {
    const numbers = value.map(Number);
    return numbers.length === expected && numbers.every(Number.isFinite) ? numbers : null;
  }
  if (typeof value !== 'string') return null;
  const numbers = value.split(/[\s,;|]+/).filter(Boolean).map(Number);
  return numbers.length === expected && numbers.every(Number.isFinite) ? numbers : null;
}

function bayerPatternIndex(media) {
  const direct = Number(media.sidecar?.bayerPattern);
  if (Number.isInteger(direct) && direct >= 0 && direct <= 3) return direct;
  const text = String(media.metadataValues?.bayerpattern || media.metadataValues?.['raw.bayerpattern'] || media.pixelFormat || '').toLowerCase();
  if (text.includes('grbg')) return 1;
  if (text.includes('gbrg')) return 2;
  if (text.includes('bggr')) return 3;
  return 0;
}

function cfaChannel(x, y, pattern) {
  const slot = ((y & 1) << 1) | (x & 1);
  return (CFA_CHANNEL_MAPS[pattern] || CFA_CHANNEL_MAPS[0])[slot];
}

function colorOf(channel) {
  return channel === 0 ? 0 : channel === 3 ? 2 : 1;
}

function rawCalibration(media, frame = {}) {
  const sidecar = media.sidecar || {};
  const metadata = media.metadataValues || {};
  const bitDepth = Number(frame.bitDepth || media.bitDepth || sidecar.storageBitDepth || 16);
  const maximumCode = 2 ** clamp(bitDepth, 1, 16) - 1;
  const black = Number(sidecar.blackLevel ?? frame.blackLevel ?? metadata.blacklevel ?? metadata['raw.blacklevel'] ?? 0);
  const white = Number(sidecar.whiteLevel ?? frame.whiteLevel ?? metadata.whitelevel ?? metadata['raw.whitelevel'] ?? maximumCode);
  const blackLevels = parseNumberList(sidecar.blackLevelRggb, 4) || parseNumberList(metadata.blacklevelrggb, 4) ||
    [black, black, black, black];
  const whiteBalance = parseNumberList(sidecar.whiteBalance, 4) || parseNumberList(metadata.whitebalance, 4) || [1, 1, 1, 1];
  const sensorToXyz = parseNumberList(sidecar.sensorToXyz, 9) || parseNumberList(metadata.sensortoxyz, 9) || null;
  return {
    bitDepth,
    blackLevel: Number.isFinite(black) ? black : 0,
    whiteLevel: Number.isFinite(white) && white > black ? white : maximumCode,
    blackLevels,
    whiteBalance: whiteBalance.map(value => clamp(value, 0.125, 8)),
    sensorToXyz,
    bayerPattern: bayerPatternIndex(media),
    lensShadingGrid: parseNumberList(sidecar.lensShadingGrid, 36),
    lensShadingEnabled: Boolean(sidecar.lensShadingEnabled),
    noiseS: Math.max(0, Number(sidecar.noiseS || frame.noiseEstimate || 0)),
    noiseO: Math.max(0, Number(sidecar.noiseO || 0)),
    analogGain: Math.max(1, Number(sidecar.analogGain || 1)),
    digitalGain: Math.max(1, Number(sidecar.digitalGain || 1)),
    orientation: Number(sidecar.orientation || media.orientation || 0)
  };
}

function shadingGain(calibration, channel, x, y, width, height) {
  const grid = calibration.lensShadingGrid;
  if (!calibration.lensShadingEnabled || !grid || grid.length !== 36) return 1;
  const gx = width > 1 ? x * 2 / (width - 1) : 0;
  const gy = height > 1 ? y * 2 / (height - 1) : 0;
  const x0 = Math.floor(gx); const y0 = Math.floor(gy);
  const x1 = Math.min(2, x0 + 1); const y1 = Math.min(2, y0 + 1);
  const tx = gx - x0; const ty = gy - y0;
  const at = (xx, yy) => clamp(Number(grid[(yy * 3 + xx) * 4 + channel] || 1), 0.25, 4);
  return (at(x0, y0) * (1 - tx) + at(x1, y0) * tx) * (1 - ty) +
    (at(x0, y1) * (1 - tx) + at(x1, y1) * tx) * ty;
}

function normalizeMosaic(samples, calibration, width, height) {
  const output = new Uint16Array(samples.length);
  const channelMap = CFA_CHANNEL_MAPS[calibration.bayerPattern] || CFA_CHANNEL_MAPS[0];
  const floors = channelMap.map((_, channel) => Math.max(0, Number(calibration.blackLevels[channel] ?? calibration.blackLevel)));
  const ceilings = floors.map(floor => Math.max(floor + 1, calibration.whiteLevel));
  const whiteBalance = channelMap.map((_, channel) => calibration.whiteBalance[channel]);
  const lensShading = Boolean(calibration.lensShadingEnabled && calibration.lensShadingGrid?.length === 36);
  const grid = lensShading
    ? calibration.lensShadingGrid.map(value => clamp(Number(value || 1), 0.25, 4))
    : null;
  const x0s = lensShading ? new Uint8Array(width) : null;
  const x1s = lensShading ? new Uint8Array(width) : null;
  const txs = lensShading ? new Float64Array(width) : null;
  if (lensShading) {
    for (let x = 0; x < width; x += 1) {
      const gx = width > 1 ? x * 2 / (width - 1) : 0;
      const x0 = Math.floor(gx);
      x0s[x] = x0;
      x1s[x] = Math.min(2, x0 + 1);
      txs[x] = gx - x0;
    }
  }
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    const gy = lensShading && height > 1 ? y * 2 / (height - 1) : 0;
    const y0 = Math.floor(gy);
    const y1 = Math.min(2, y0 + 1);
    const ty = gy - y0;
    for (let x = 0; x < width; x += 1) {
      const index = row + x;
      const channel = channelMap[((y & 1) << 1) | (x & 1)];
      let shading = 1;
      if (lensShading) {
        const x0 = x0s[x]; const x1 = x1s[x]; const tx = txs[x];
        const top = grid[(y0 * 3 + x0) * 4 + channel] * (1 - tx) + grid[(y0 * 3 + x1) * 4 + channel] * tx;
        const bottom = grid[(y1 * 3 + x0) * 4 + channel] * (1 - tx) + grid[(y1 * 3 + x1) * 4 + channel] * tx;
        shading = top * (1 - ty) + bottom * ty;
      }
      const linear = (samples[index] - floors[channel]) / (ceilings[channel] - floors[channel]) *
        (whiteBalance[channel] * shading);
      output[index] = clamp(Math.round(linear * UINT16_MAX), 0, UINT16_MAX);
    }
  }
  return output;
}

function median4(a, b, c, d) {
  if (a > b) [a, b] = [b, a];
  if (c > d) [c, d] = [d, c];
  if (a > c) [a, c] = [c, a];
  if (b > d) [b, d] = [d, b];
  if (b > c) [b, c] = [c, b];
  return Math.round((b + c) / 2);
}

function repairDefects(source, width, height, calibration) {
  if (width < 5 || height < 5) return { pixels: source, repaired: 0 };
  const output = source.slice();
  let repaired = 0;
  for (let y = 2; y < height - 2; y += 1) {
    const row = y * width;
    for (let x = 2; x < width - 2; x += 1) {
      const index = row + x;
      const center = source[index];
      const left = source[index - 2];
      const right = source[index + 2];
      const above = source[index - width * 2];
      const below = source[index + width * 2];
      const minimum = Math.min(left, right, above, below);
      const maximum = Math.max(left, right, above, below);
      const normalizedSignal = center / UINT16_MAX;
      const modeledNoise = Math.sqrt(Math.max(0, calibration.noiseS * normalizedSignal + calibration.noiseO)) * UINT16_MAX;
      const threshold = clamp(Math.round(256 + modeledNoise * 5), 256, 3072);
      if ((center > maximum + threshold || center + threshold < minimum) && maximum - minimum < threshold * 3) {
        output[index] = median4(left, right, above, below);
        repaired += 1;
      }
    }
  }
  return { pixels: output, repaired };
}

function sceneDelta(current, previous) {
  if (!previous || previous.length !== current.length) return Number.POSITIVE_INFINITY;
  const stride = Math.max(1, Math.floor(current.length / 8192));
  let total = 0;
  let count = 0;
  for (let index = 0; index < current.length; index += stride) {
    total += Math.abs(current[index] - previous[index]);
    count += 1;
  }
  return count ? total / count / UINT16_MAX : Number.POSITIVE_INFINITY;
}

function temporalFuse(current, previous, calibration, quality) {
  const delta = sceneDelta(current, previous);
  if (!previous || previous.length !== current.length || delta > 0.045 || quality === 'accelerated') {
    return { pixels: current, fused: 0, sceneDelta: Number.isFinite(delta) ? delta : null };
  }
  const output = current.slice();
  const baseMix = quality === 'maximum' ? 0.16 : 0.10;
  let fused = 0;
  for (let index = 0; index < current.length; index += 1) {
    const center = current[index];
    const prior = previous[index];
    const normalizedSignal = center / UINT16_MAX;
    const modeledNoise = Math.sqrt(Math.max(0, calibration.noiseS * normalizedSignal + calibration.noiseO)) * UINT16_MAX;
    const threshold = clamp(320 + modeledNoise * 4, 320, 2400);
    const difference = Math.abs(center - prior);
    if (difference < threshold) {
      const confidence = 1 - difference / threshold;
      const mix = baseMix * confidence * confidence;
      output[index] = Math.round(center * (1 - mix) + prior * mix);
      fused += 1;
    }
  }
  return { pixels: output, fused, sceneDelta: delta };
}

const NIV99_RAW_VERSION = 'NIV99_RAW_CONVERSION_V1';
const NIV99_RAW_OPTIONS = Object.freeze({
  spatialStrength: 0.42,
  temporalStrength: 0.30,
  defectSigmaThreshold: 6.0,
  spatialSigmaThreshold: 3.2,
  temporalSigmaThreshold: 3.0,
  sceneCutThreshold: 0.075
});

function smoothstep(edge0, edge1, value) {
  if (edge1 <= edge0) return value >= edge1 ? 1 : 0;
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function trimmedMean8(a, b, c, d, e, f, g, h) {
  const sum = a + b + c + d + e + f + g + h;
  const low = Math.min(a, b, c, d, e, f, g, h);
  const high = Math.max(a, b, c, d, e, f, g, h);
  return Math.floor((sum - low - high + 3) / 6);
}

/** Exact camera NIV99 sensor-CFA stage, before WB, lens shading and demosaic. */
class Niv99RawProcessor {
  constructor(media, options = NIV99_RAW_OPTIONS) {
    this.media = media;
    this.options = { ...NIV99_RAW_OPTIONS, ...options };
    this.previous = null;
    this.previousTimestamp = -1;
    this.previousFrame = -1;
    this.processedFrames = 0;
    this.totalSpatial = 0;
    this.totalTemporal = 0;
    this.totalDefects = 0;
    this.historyUsedFrames = 0;
    this.historyResetFrames = 0;
    this.processingTimesMs = [];
  }

  blackLevel(calibration, x, y) {
    const channel = cfaChannel(x, y, calibration.bayerPattern);
    const value = Number(calibration.blackLevels[channel]);
    return clamp(Number.isFinite(value) ? Math.round(value) : Math.round(calibration.blackLevel), 0, calibration.whiteLevel - 1);
  }

  lensGain(calibration, x, y) {
    const grid = calibration.lensShadingGrid;
    if (!calibration.lensShadingEnabled || !grid || grid.length !== 36) return 1;
    const gx = Math.floor(x * 2 / Math.max(1, this.media.width - 1));
    const gy = Math.floor(y * 2 / Math.max(1, this.media.height - 1));
    const channel = cfaChannel(x, y, calibration.bayerPattern);
    return clamp(Number(grid[(gy * 3 + gx) * 4 + channel]) || 1, 0.25, 8);
  }

  noiseSigma(sample, black, x, y, calibration) {
    const dynamicRange = Math.max(1, calibration.whiteLevel - Math.round(calibration.blackLevel));
    const signal = Math.max(0, sample - black) / dynamicRange;
    const totalGain = clamp(calibration.analogGain * calibration.digitalGain, 1, 64);
    const shot = Math.max(calibration.noiseS, 0.000018 * totalGain);
    const read = Math.max(calibration.noiseO, 0.0000008 * totalGain * totalGain);
    const rawSigma = Math.sqrt(Math.max(1e-10, shot * signal + read)) * dynamicRange;
    return Math.max(0.75, rawSigma * Math.sqrt(Math.max(1, this.lensGain(calibration, x, y))));
  }

  highlightGuard(black, white) {
    return Math.max(black + 1, white - Math.max(2, Math.floor((white - black) / 64)));
  }

  applySpatial(source, calibration) {
    const { width, height } = this.media;
    const output = source.slice();
    if (width < 5 || height < 5 || this.options.spatialStrength <= 0) {
      return { pixels: output, filtered: 0, defects: 0 };
    }
    const channelMap = CFA_CHANNEL_MAPS[calibration.bayerPattern] || CFA_CHANNEL_MAPS[0];
    const white = calibration.whiteLevel;
    const defaultBlack = Math.round(calibration.blackLevel);
    const blackLevels = channelMap.map((_, channel) => {
      const value = Number(calibration.blackLevels[channel]);
      return clamp(Number.isFinite(value) ? Math.round(value) : defaultBlack, 0, white - 1);
    });
    const highlightGuards = blackLevels.map(black => this.highlightGuard(black, white));
    const gainPressures = channelMap.map((_, channel) => {
      const gain = clamp(Number(calibration.whiteBalance[channel]) || 1, 0.25, 8);
      return clamp((gain - 1) / 2, 0, 1);
    });
    const dynamicRange = Math.max(1, white - defaultBlack);
    const totalGain = clamp(calibration.analogGain * calibration.digitalGain, 1, 64);
    const shot = Math.max(calibration.noiseS, 0.000018 * totalGain);
    const read = Math.max(calibration.noiseO, 0.0000008 * totalGain * totalGain);
    const lensGrid = calibration.lensShadingEnabled && calibration.lensShadingGrid?.length === 36
      ? calibration.lensShadingGrid.map(value => Math.sqrt(Math.max(1, clamp(Number(value) || 1, 0.25, 8))))
      : null;
    let filtered = 0;
    let defects = 0;
    for (let y = 2; y < height - 2; y += 1) {
      const row = y * width;
      const lensY = lensGrid ? Math.floor(y * 2 / Math.max(1, height - 1)) : 0;
      for (let x = 2; x < width - 2; x += 1) {
        const index = row + x;
        const center = source[index];
        const channel = channelMap[((y & 1) << 1) | (x & 1)];
        const black = blackLevels[channel];
        if (center <= black || center >= highlightGuards[channel]) continue;
        const left = source[index - 2];
        const right = source[index + 2];
        const up = source[index - width * 2];
        const down = source[index + width * 2];
        const upLeft = source[index - width * 2 - 2];
        const upRight = source[index - width * 2 + 2];
        const downLeft = source[index + width * 2 - 2];
        const downRight = source[index + width * 2 + 2];
        const consensus = trimmedMean8(left, right, up, down, upLeft, upRight, downLeft, downRight);
        const signal = Math.max(0, center - black) / dynamicRange;
        const rawSigma = Math.sqrt(Math.max(1e-10, shot * signal + read)) * dynamicRange;
        const lensScale = lensGrid
          ? lensGrid[(lensY * 3 + Math.floor(x * 2 / Math.max(1, width - 1))) * 4 + channel]
          : 1;
        const sigma = Math.max(0.75, rawSigma * lensScale);
        const defectThreshold = Math.max(6, sigma * this.options.defectSigmaThreshold);
        if (Math.abs(center - consensus) > defectThreshold &&
            Math.abs(left - right) <= Math.max(6, sigma * 2.5) &&
            Math.abs(up - down) <= Math.max(6, sigma * 2.5)) {
          output[index] = clamp(consensus, black, calibration.whiteLevel);
          defects += 1;
          continue;
        }
        let directional = Math.floor((left + right + 1) / 2);
        let localGradient = Math.abs(left - right);
        const verticalGradient = Math.abs(up - down);
        if (verticalGradient < localGradient) {
          directional = Math.floor((up + down + 1) / 2);
          localGradient = verticalGradient;
        }
        const diagonalAGradient = Math.abs(upLeft - downRight);
        if (diagonalAGradient < localGradient) {
          directional = Math.floor((upLeft + downRight + 1) / 2);
          localGradient = diagonalAGradient;
        }
        const diagonalBGradient = Math.abs(upRight - downLeft);
        if (diagonalBGradient < localGradient) {
          directional = Math.floor((upRight + downLeft + 1) / 2);
          localGradient = diagonalBGradient;
        }
        const residual = Math.abs(center - directional);
        const cutoff = Math.max(1, sigma * this.options.spatialSigmaThreshold);
        if (residual >= cutoff) continue;
        const normalizedResidual = residual / cutoff;
        const robustWeight = (1 - normalizedResidual * normalizedResidual) ** 2;
        const edgeGuard = smoothstep(sigma * 1.5, sigma * 5.5, localGradient);
        const shadowPressure = 1 - smoothstep(black + dynamicRange * 0.03, black + dynamicRange * 0.24, center);
        const strength = this.options.spatialStrength * robustWeight * (1 - edgeGuard) *
          (0.72 + shadowPressure * 0.18 + gainPressures[channel] * 0.10);
        if (strength <= 0.002) continue;
        const value = clamp(Math.round(center + (directional - center) * strength), black, white);
        output[index] = value;
        if (value !== center) filtered += 1;
      }
    }
    return { pixels: output, filtered, defects };
  }

  timelineContinuous(frameIndex, timestamp, fps) {
    if (frameIndex !== this.previousFrame + 1) return false;
    if (!(timestamp > 0) || !(this.previousTimestamp > 0)) return true;
    const duration = 1e9 / Math.max(1, fps);
    const gap = timestamp - this.previousTimestamp;
    return gap > 0 && gap <= duration * 4;
  }

  isSceneCut(current, previous, calibration) {
    const stride = Math.max(1, Math.floor(current.length / 4096));
    const dynamicRange = Math.max(1, calibration.whiteLevel - Math.round(calibration.blackLevel));
    let total = 0;
    let count = 0;
    for (let index = 0; index < current.length; index += stride) {
      total += Math.abs(current[index] - previous[index]) / dynamicRange;
      count += 1;
    }
    return count > 0 && total / count >= this.options.sceneCutThreshold;
  }

  applyTemporal(current, previous, calibration) {
    const { width, height } = this.media;
    const channelMap = CFA_CHANNEL_MAPS[calibration.bayerPattern] || CFA_CHANNEL_MAPS[0];
    const white = calibration.whiteLevel;
    const defaultBlack = Math.round(calibration.blackLevel);
    const blackLevels = channelMap.map((_, channel) => {
      const value = Number(calibration.blackLevels[channel]);
      return clamp(Number.isFinite(value) ? Math.round(value) : defaultBlack, 0, white - 1);
    });
    const highlightGuards = blackLevels.map(black => this.highlightGuard(black, white));
    const dynamicRange = Math.max(1, white - defaultBlack);
    const totalGain = clamp(calibration.analogGain * calibration.digitalGain, 1, 64);
    const shot = Math.max(calibration.noiseS, 0.000018 * totalGain);
    const read = Math.max(calibration.noiseO, 0.0000008 * totalGain * totalGain);
    const lensGrid = calibration.lensShadingEnabled && calibration.lensShadingGrid?.length === 36
      ? calibration.lensShadingGrid.map(value => Math.sqrt(Math.max(1, clamp(Number(value) || 1, 0.25, 8))))
      : null;
    let fused = 0;
    for (let y = 2; y < height - 2; y += 1) {
      const row = y * width;
      const lensY = lensGrid ? Math.floor(y * 2 / Math.max(1, height - 1)) : 0;
      for (let x = 2; x < width - 2; x += 1) {
        const index = row + x;
        const value = current[index];
        const channel = channelMap[((y & 1) << 1) | (x & 1)];
        const black = blackLevels[channel];
        if (value <= black || value >= highlightGuards[channel]) continue;
        const old = previous[index];
        const signal = Math.max(0, value - black) / dynamicRange;
        const rawSigma = Math.sqrt(Math.max(1e-10, shot * signal + read)) * dynamicRange;
        const lensScale = lensGrid
          ? lensGrid[(lensY * 3 + Math.floor(x * 2 / Math.max(1, width - 1))) * 4 + channel]
          : 1;
        const sigma = Math.max(0.75, rawSigma * lensScale);
        const residual = Math.abs(value - old);
        const cutoff = Math.max(1, sigma * this.options.temporalSigmaThreshold);
        if (residual >= cutoff) continue;
        const gradient = Math.min(
          Math.abs(current[index - 2] - current[index + 2]),
          Math.abs(current[index - width * 2] - current[index + width * 2])
        );
        const structureGuard = smoothstep(sigma * 1.4, sigma * 4.5, gradient);
        const normalizedResidual = residual / cutoff;
        const robustWeight = (1 - normalizedResidual * normalizedResidual) ** 2;
        const weight = this.options.temporalStrength * robustWeight * (1 - structureGuard);
        if (weight <= 0.002) continue;
        const blended = clamp(Math.round(value + (old - value) * weight), black, white);
        current[index] = blended;
        if (blended !== value) fused += 1;
      }
    }
    return fused;
  }

  process(source, calibration, frameIndex = this.processedFrames, timestamp = 0) {
    const started = process.hrtime.bigint();
    const spatial = this.applySpatial(source, calibration);
    const continuous = this.previous && this.timelineContinuous(frameIndex, timestamp, this.media.fps || 30);
    const sceneCut = Boolean(continuous && this.isSceneCut(spatial.pixels, this.previous, calibration));
    const temporal = continuous && !sceneCut && this.options.temporalStrength > 0
      ? this.applyTemporal(spatial.pixels, this.previous, calibration) : 0;
    const historyReset = !this.previous || !continuous || sceneCut;
    this.previous = spatial.pixels.slice();
    this.previousFrame = frameIndex;
    this.previousTimestamp = timestamp;
    this.processedFrames += 1;
    this.totalSpatial += spatial.filtered;
    this.totalTemporal += temporal;
    this.totalDefects += spatial.defects;
    this.historyUsedFrames += temporal > 0 ? 1 : 0;
    this.historyResetFrames += historyReset ? 1 : 0;
    const processingMs = Number(process.hrtime.bigint() - started) / 1e6;
    this.processingTimesMs.push(processingMs);
    return {
      pixels: spatial.pixels,
      evidence: {
        version: NIV99_RAW_VERSION,
        frameNumber: frameIndex,
        sensorTimestampNs: timestamp,
        fullFrameSamples: source.length,
        spatiallyFilteredSamples: spatial.filtered,
        temporallyFusedSamples: temporal,
        correctedDefects: spatial.defects,
        historyUsed: temporal > 0,
        historyReset,
        sourceSamplesPreserved: true,
        capturedWhiteBalancePreserved: true,
        processingMs
      }
    };
  }
}

function edgeDirectedDemosaic(mosaic, width, height, pattern) {
  const output = Buffer.allocUnsafe(width * height * 6);
  const outputWords = new Uint16Array(output.buffer, output.byteOffset, width * height * 3);
  const at = (x, y) => mosaic[clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)];
  const meanColor = (x, y, targetColor) => {
    let sum = 0;
    let count = 0;
    for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) {
      if (Math.abs(dx) + Math.abs(dy) > 2) continue;
      const xx = clamp(x + dx, 0, width - 1);
      const yy = clamp(y + dy, 0, height - 1);
      if (colorOf(cfaChannel(xx, yy, pattern)) === targetColor) { sum += at(xx, yy); count += 1; }
    }
    return count ? Math.round(sum / count) : at(x, y);
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const center = at(x, y);
      const color = colorOf(cfaChannel(x, y, pattern));
      let red;
      let green;
      let blue;
      if (x < 2 || y < 2 || x >= width - 2 || y >= height - 2) {
        red = color === 0 ? center : meanColor(x, y, 0);
        green = color === 1 ? center : meanColor(x, y, 1);
        blue = color === 2 ? center : meanColor(x, y, 2);
      } else if (color === 0 || color === 2) {
        const left2 = mosaic[index - 2]; const right2 = mosaic[index + 2];
        const left1 = mosaic[index - 1]; const right1 = mosaic[index + 1];
        const up2 = mosaic[index - width * 2]; const down2 = mosaic[index + width * 2];
        const up1 = mosaic[index - width]; const down1 = mosaic[index + width];
        const horizontalGradient = Math.abs(left2 - right2) + Math.abs(left1 - right1);
        const verticalGradient = Math.abs(up2 - down2) + Math.abs(up1 - down1);
        green = horizontalGradient < verticalGradient ? Math.round((left1 + right1) / 2) :
          verticalGradient < horizontalGradient ? Math.round((up1 + down1) / 2) :
            Math.round((left1 + right1 + up1 + down1) / 4);
        const upLeft = mosaic[index - width - 1]; const downRight = mosaic[index + width + 1];
        const upRight = mosaic[index - width + 1]; const downLeft = mosaic[index + width - 1];
        const diagonalA = Math.abs(upLeft - downRight);
        const diagonalB = Math.abs(upRight - downLeft);
        const opposite = diagonalA < diagonalB ? Math.round((upLeft + downRight) / 2) :
          diagonalB < diagonalA ? Math.round((upRight + downLeft) / 2) :
            Math.round((upLeft + upRight + downLeft + downRight) / 4);
        red = color === 0 ? center : opposite;
        blue = color === 2 ? center : opposite;
      } else {
        green = center;
        const horizontalColor = colorOf(cfaChannel(x - 1, y, pattern));
        const horizontal = Math.round((mosaic[index - 1] + mosaic[index + 1]) / 2);
        const vertical = Math.round((mosaic[index - width] + mosaic[index + width]) / 2);
        red = horizontalColor === 0 ? horizontal : vertical;
        blue = horizontalColor === 2 ? horizontal : vertical;
      }
      const offset = (y * width + x) * 3;
      outputWords[offset] = clamp(red, 0, UINT16_MAX);
      outputWords[offset + 1] = clamp(green, 0, UINT16_MAX);
      outputWords[offset + 2] = clamp(blue, 0, UINT16_MAX);
    }
  }
  return output;
}

function rawPreviewGeometry(media) {
  const sourceWidth = Math.max(2, Math.floor(Number(media.width || 0)));
  const sourceHeight = Math.max(2, Math.floor(Number(media.height || 0)));
  let step = 2;
  while (sourceWidth / step > 1280 || sourceHeight / step > 1080) step *= 2;
  return {
    width: Math.max(1, Math.floor(sourceWidth / step)),
    height: Math.max(1, Math.floor(sourceHeight / step)),
    step
  };
}

// Playback proxies do not need the expensive full-resolution sensor cleanup used by
// final renders. One calibrated 2x2 CFA cell is reduced to one RGB48 pixel at an even
// stride, which preserves the captured R/G/B samples, white balance and lens shading
// while making first playback practical on low-power CPUs. Render output never uses
// this path and retains the full NIV99 + edge-directed development pipeline above.
function developRawPreviewFrame(frame, media) {
  const started = process.hrtime.bigint();
  const calibration = rawCalibration(media, frame);
  const geometry = rawPreviewGeometry(media);
  const { width, height } = media;
  const channelMap = CFA_CHANNEL_MAPS[calibration.bayerPattern] || CFA_CHANNEL_MAPS[0];
  const floors = channelMap.map((_, channel) => Math.max(0, Number(calibration.blackLevels[channel] ?? calibration.blackLevel)));
  const ceilings = floors.map(floor => Math.max(floor + 1, calibration.whiteLevel));
  const whiteBalance = channelMap.map((_, channel) => calibration.whiteBalance[channel]);
  const lensShading = Boolean(calibration.lensShadingEnabled && calibration.lensShadingGrid?.length === 36);
  const grid = lensShading
    ? calibration.lensShadingGrid.map(value => clamp(Number(value || 1), 0.25, 4))
    : null;
  const output = Buffer.allocUnsafe(geometry.width * geometry.height * 6);
  const words = new Uint16Array(output.buffer, output.byteOffset, geometry.width * geometry.height * 3);

  const normalize = (sample, channel, x, y) => {
    let shading = 1;
    if (lensShading) {
      const gx = width > 1 ? x * 2 / (width - 1) : 0;
      const gy = height > 1 ? y * 2 / (height - 1) : 0;
      const x0 = Math.floor(gx); const y0 = Math.floor(gy);
      const x1 = Math.min(2, x0 + 1); const y1 = Math.min(2, y0 + 1);
      const tx = gx - x0; const ty = gy - y0;
      const top = grid[(y0 * 3 + x0) * 4 + channel] * (1 - tx) + grid[(y0 * 3 + x1) * 4 + channel] * tx;
      const bottom = grid[(y1 * 3 + x0) * 4 + channel] * (1 - tx) + grid[(y1 * 3 + x1) * 4 + channel] * tx;
      shading = top * (1 - ty) + bottom * ty;
    }
    const linear = (sample - floors[channel]) / (ceilings[channel] - floors[channel]) *
      (whiteBalance[channel] * shading);
    return clamp(Math.round(linear * UINT16_MAX), 0, UINT16_MAX);
  };

  for (let outputY = 0; outputY < geometry.height; outputY += 1) {
    const sourceY = outputY * geometry.step;
    for (let outputX = 0; outputX < geometry.width; outputX += 1) {
      const sourceX = outputX * geometry.step;
      let red = 0;
      let blue = 0;
      let greenA = 0;
      let greenB = 0;
      for (let dy = 0; dy < 2; dy += 1) {
        const y = sourceY + dy;
        const row = y * width;
        for (let dx = 0; dx < 2; dx += 1) {
          const x = sourceX + dx;
          const channel = channelMap[(dy << 1) | dx];
          const value = normalize(frame.samples[row + x], channel, x, y);
          if (channel === 0) red = value;
          else if (channel === 3) blue = value;
          else if (channel === 1) greenA = value;
          else greenB = value;
        }
      }
      const offset = (outputY * geometry.width + outputX) * 3;
      words[offset] = red;
      words[offset + 1] = Math.round((greenA + greenB) / 2);
      words[offset + 2] = blue;
    }
  }
  return {
    buffer: output,
    metrics: {
      mode: 'CAMX_RAW_PREVIEW_BIN_V1',
      width: geometry.width,
      height: geometry.height,
      step: geometry.step,
      processingMs: Number(process.hrtime.bigint() - started) / 1e6
    }
  };
}

class RawDevelopProcessor {
  constructor(media, quality = 'maximum') {
    this.media = media;
    this.quality = quality;
    this.niv99Raw = new Niv99RawProcessor(media);
    this.totalDefects = 0;
    this.totalFused = 0;
  }

  process(frame) {
    const calibration = rawCalibration(this.media, frame);
    // Camera parity: NIV99 operates on untouched sensor codes. White balance,
    // lens shading and normalization are applied only after the robust CFA pass.
    const niv99 = this.niv99Raw.process(frame.samples, calibration, frame.index, frame.timestamp);
    const normalized = normalizeMosaic(niv99.pixels, calibration, this.media.width, this.media.height);
    this.totalDefects += niv99.evidence.correctedDefects;
    this.totalFused += niv99.evidence.temporallyFusedSamples;
    return {
      buffer: edgeDirectedDemosaic(normalized, this.media.width, this.media.height, calibration.bayerPattern),
      metrics: {
        demosaic: 'edge-directed-cfa-v1',
        niv99RawVersion: NIV99_RAW_VERSION,
        spatialPixels: niv99.evidence.spatiallyFilteredSamples,
        defectPixels: niv99.evidence.correctedDefects,
        temporalPixels: niv99.evidence.temporallyFusedSamples,
        historyUsed: niv99.evidence.historyUsed,
        historyReset: niv99.evidence.historyReset,
        sourceSamplesPreserved: niv99.evidence.sourceSamplesPreserved,
        processingMs: Number(niv99.evidence.processingMs.toFixed(4)),
        totalDefectPixels: this.totalDefects,
        totalTemporalPixels: this.totalFused,
        calibration: {
          blackLevel: calibration.blackLevel,
          whiteLevel: calibration.whiteLevel,
          bayerPattern: calibration.bayerPattern,
          lensShading: calibration.lensShadingEnabled,
          whiteBalance: calibration.whiteBalance
        }
      }
    };
  }
}

function createDevelopedRawStream(filePath, media, quality, progress) {
  const processor = new RawDevelopProcessor(media, quality);
  async function* frames() {
    let index = 0;
    for await (const frame of rawFrameIterator(filePath, media)) {
      const developed = processor.process(frame);
      index += 1;
      progress?.({ frame: index, frames: media.frames, ratio: media.frames ? index / media.frames : 0, raw: developed.metrics });
      yield developed.buffer;
    }
  }
  // Readable.from() defaults to object mode. Without this explicit byte mode,
  // highWaterMark means "96 million frame objects" rather than 96 MiB and the
  // worker can develop an entire 72 MiB-per-frame clip ahead of the encoder.
  return Readable.from(frames(), { objectMode: false, highWaterMark: 8 * 1024 * 1024 });
}

function createPreviewRawStream(filePath, media, progress) {
  async function* frames() {
    let index = 0;
    for await (const frame of rawFrameIterator(filePath, media)) {
      const developed = developRawPreviewFrame(frame, media);
      index += 1;
      progress?.({
        frame: index,
        frames: media.frames,
        ratio: media.frames ? index / media.frames : 0,
        rawPreview: developed.metrics
      });
      yield developed.buffer;
    }
  }
  return Readable.from(frames(), { objectMode: false, highWaterMark: 8 * 1024 * 1024 });
}

module.exports = {
  rawCalibration, normalizeMosaic, repairDefects, temporalFuse,
  NIV99_RAW_VERSION, NIV99_RAW_OPTIONS, Niv99RawProcessor,
  edgeDirectedDemosaic, rawPreviewGeometry, developRawPreviewFrame,
  RawDevelopProcessor, createDevelopedRawStream, createPreviewRawStream
};
