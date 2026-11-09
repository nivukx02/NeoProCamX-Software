'use strict';

const os = require('node:os');

const DEFAULT_TIMING_CAPACITY = 512;

function percentile(sorted, fraction) {
  if (!sorted.length) return 0;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(sorted.length * fraction)));
  return sorted[rank - 1];
}

/**
 * Desktop port of the camera DMC sustained-conversion evidence contract.
 * This governor only controls scheduling; it has no image-quality fields and
 * therefore cannot reduce resolution, precision, colour, MFSR, or bitrate.
 */
class SustainedConversionGovernor {
  constructor(workload, options = {}) {
    this.workload = { ...workload };
    this.logicalCores = Math.max(1, Number(options.logicalCores || os.cpus().length || 1));
    this.capacity = Math.max(32, Number(options.timingCapacity || DEFAULT_TIMING_CAPACITY));
    this.clock = typeof options.clock === 'function' ? options.clock : () => process.hrtime.bigint();
    this.startedNs = BigInt(options.startedNs ?? this.clock());
    this.lastNs = this.startedNs;
    this.lastFrame = 0;
    this.completedFrames = 0;
    this.timingsNs = [];
    this.stageLatenciesMs = new Map();
  }

  recordFrames(exactFramesDone) {
    const frame = Math.max(0, Math.trunc(Number(exactFramesDone || 0)));
    if (frame <= this.lastFrame) return;
    const now = BigInt(this.clock());
    const delta = BigInt(frame - this.lastFrame);
    const perFrame = Number((now - this.lastNs) / delta);
    this.timingsNs.push(Math.max(1, perFrame));
    if (this.timingsNs.length > this.capacity) this.timingsNs.shift();
    this.lastNs = now;
    this.lastFrame = frame;
    this.completedFrames = frame;
  }

  recordStageLatency(stage, milliseconds) {
    const value = Number(milliseconds);
    if (!Number.isFinite(value) || value < 0) return;
    const samples = this.stageLatenciesMs.get(stage) || [];
    samples.push(value);
    if (samples.length > this.capacity) samples.shift();
    this.stageLatenciesMs.set(stage, samples);
  }

  summary() {
    const elapsedNs = Number(BigInt(this.clock()) - this.startedNs);
    const sorted = [...this.timingsNs].sort((a, b) => a - b);
    const summarizeMs = samples => {
      const ordered = [...samples].sort((a, b) => a - b);
      return {
        samples: ordered.length,
        p50Ms: Number(percentile(ordered, 0.50).toFixed(4)),
        p95Ms: Number(percentile(ordered, 0.95).toFixed(4)),
        p99Ms: Number(percentile(ordered, 0.99).toFixed(4)),
        maximumMs: Number((ordered.at(-1) || 0).toFixed(4))
      };
    };
    return {
      version: 'DMC-SUSTAINED-DESKTOP-v1',
      ...this.workload,
      logicalCores: this.logicalCores,
      workerLimit: Math.max(1, this.logicalCores - 1),
      inFlightLimit: 4,
      completedFrames: this.completedFrames,
      elapsedNanos: elapsedNs,
      averageFramesPerSecond: elapsedNs > 0 ? this.completedFrames * 1e9 / elapsedNs : 0,
      p50FrameNanos: percentile(sorted, 0.50),
      p95FrameNanos: percentile(sorted, 0.95),
      p99FrameNanos: percentile(sorted, 0.99),
      maximumFrameNanos: sorted.at(-1) || 0,
      stageLatency: Object.fromEntries([...this.stageLatenciesMs].map(([stage, samples]) => [stage, summarizeMs(samples)])),
      thermalPolicy: 'OS-managed scheduling; quality settings remain invariant',
      qualityInvariant: true
    };
  }
}

module.exports = { SustainedConversionGovernor, percentile };
