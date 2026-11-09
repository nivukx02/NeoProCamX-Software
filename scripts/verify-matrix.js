'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { CapabilityService } = require('../src/core/capabilities');
const { MediaProbe } = require('../src/core/media-probe');
const { ConversionQueue } = require('../src/core/conversion-queue');
const { CONVERSION_CATALOG } = require('../src/core/conversion-profiles');
const { crc32 } = require('../src/core/binary-formats');

const execFileAsync = promisify(execFile);

function i32(value) { const buffer = Buffer.alloc(4); buffer.writeInt32BE(value); return buffer; }
function i64(value) { const buffer = Buffer.alloc(8); buffer.writeBigInt64BE(BigInt(value)); return buffer; }

function createRawNpv10(target) {
  const width = 64;
  const height = 64;
  const fps = 24;
  const timestamps = [
    1_000_000_000, 1_041_667_000, 1_090_000_000,
    1_125_000_000, 1_180_000_000, 1_220_000_000
  ];
  const metadata = Buffer.from([
    'payloadFormat=RAW12_NPV10_PACKED', 'packetCodec=LEGACY_UNCOMPRESSED',
    'sourceFormat=RAW_SENSOR', 'sourceBitDepth=12', 'storageBitDepth=12',
    'rawSensorCapture=true', 'bayerPattern=RGGB', 'exactSelectedResolution=true', ''
  ].join('\n'), 'utf8');
  const pieces = [Buffer.from('NPV10'), i32(2), i32(width), i32(height), i32(fps), i32(12), i32(metadata.length), metadata];
  for (let frame = 0; frame < timestamps.length; frame += 1) {
    const payload = Buffer.alloc(width * height * 2);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const raw = Math.min(4095, 128 + x * 42 + y * 16 + frame * 24);
      const nibble = (raw ^ (raw >>> 4) ^ (raw >>> 8)) & 0x0f;
      payload.writeUInt16LE(((raw >>> 2) << 6) | ((raw & 3) << 4) | nibble, (y * width + x) * 2);
    }
    pieces.push(Buffer.from('FRM0'), i64(timestamps[frame]), i32(width), i32(height),
      i32(payload.length), i32(crc32(payload) | 0), payload);
  }
  fs.writeFileSync(target, Buffer.concat(pieces));
}

async function waitFor(queue, id) {
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const job = queue.snapshot().find(item => item.id === id);
      if (!job || !['complete', 'failed', 'cancelled'].includes(job.state)) return;
      clearInterval(timer);
      if (job.state === 'complete') resolve(job);
      else reject(new Error(job.error || `Matrix verification job ${job.state}`));
    }, 100);
  });
}

function verifyReceipt(job) {
  const receiptPath = job.profileId === 'cinemadng-sequence'
    ? path.join(job.outputPath, 'conversion-receipt.json')
    : `${job.outputPath}.json`;
  if (!fs.existsSync(receiptPath)) throw new Error(`Missing matrix receipt: ${receiptPath}`);
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  if (receipt.schema !== 'com.neoproc.camx.studio.conversion-receipt.v8' ||
      !receipt.validation?.passed || !receipt.sourceIntegrity?.unchanged ||
      !receipt.qualityCertificate?.noSilentDowngrade ||
      !receipt.qualityCertificate?.codecLossless ||
      !receipt.qualityCertificate?.qualityInvariantUnderGovernor) {
    throw new Error(`Invalid matrix receipt: ${receiptPath}`);
  }
  if (['ndr', 'nivukx'].includes(receipt.profile?.family)) {
    const color = receipt.colorPipeline;
    if (!color?.exactCameraMath || color.toneOperator !== 'NDR-TONE-OP-v4' ||
        color.calibration !== 'NDR-NIVUKX-PY-CAL-v4' ||
        color.deliveryEngine !== 'NDR-NIVUKX-DELIVERY-v1' ||
        !color.measuredContentLight?.embeddedInContainer ||
        receipt.validation?.color?.hdrMetadata?.contentLightAuthority !== 'measured-final-pq-pixels' ||
        !receipt.companionArtifacts?.some(item => item.kind === 'camx-private-dynamic-delivery-metadata')) {
      throw new Error(`Canonical camera colour contract is missing: ${receiptPath}`);
    }
  }
  return receipt;
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const output = path.join(root, 'matrix-verification-output');
  if (path.dirname(output) !== root || path.basename(output) !== 'matrix-verification-output') {
    throw new Error('Unsafe matrix verification output path');
  }
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });

  const capabilityService = new CapabilityService();
  const capabilities = await capabilityService.detect(true);
  if (!capabilities.ready) throw new Error('FFmpeg/FFprobe runtime is incomplete');
  const sourcePath = path.join(output, 'matrix-reference.mkv');
  await execFileAsync(capabilities.ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', 'testsrc2=size=320x180:rate=10:duration=0.3',
    '-c:v', 'ffv1', '-level', '3', '-pix_fmt', 'yuv420p10le', sourcePath
  ], { windowsHide: true, timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  const mediaProbe = new MediaProbe(capabilityService);
  const sdrMedia = {
    ...await mediaProbe.probe(sourcePath),
    libraryKind: 'conversion', conversionEligible: true, conversionKind: 'verification-fixture'
  };
  const rawSourcePath = path.join(output, 'matrix-reference.npv10');
  createRawNpv10(rawSourcePath);
  const rawMedia = {
    ...await mediaProbe.probe(rawSourcePath),
    libraryKind: 'conversion', conversionEligible: true, conversionKind: 'verification-fixture'
  };
  const queue = new ConversionQueue(capabilityService, mediaProbe, () => {});
  const results = [];
  for (const delivery of CONVERSION_CATALOG.deliveries) {
    for (const transport of CONVERSION_CATALOG.transports) {
      const profileId = `${delivery.id}-${transport.id}`;
      const [created] = await queue.enqueue({
        inputs: [rawMedia], outputDirectory: output, profileId,
        quality: 'maximum', executionMode: 'gpu-auto',
        aiEnhance: true, mfsrEnhance: true, logVariant: 'base'
      });
      const completed = await waitFor(queue, created.id);
      const receipt = verifyReceipt(completed);
      const validation = completed.validation;
      if (!completed.mfsr?.enabled || completed.mfsr.processedFrames !== validation.decodedFrames) {
        throw new Error(`MFSR cadence contract failed for ${profileId}`);
      }
      results.push({
        route: `RAW -> ${delivery.label}`, profileId, codec: validation.codec, pixelFormat: validation.pixelFormat,
        bitDepth: validation.bitDepth, color: validation.color,
        lossless: validation.lossless,
        output: completed.outputPath, receiptSchema: receipt.schema,
        exactCameraMath: Boolean(completed.colorPipeline?.exactCameraMath)
      });
      process.stdout.write(`PASS ${profileId} -> ${validation.codec}/${validation.pixelFormat}\n`);
    }
  }

  for (const transport of CONVERSION_CATALOG.transports) {
    const profileId = `rec709-sdr-${transport.id}`;
    const [created] = await queue.enqueue({
      inputs: [sdrMedia], outputDirectory: output, profileId,
      quality: 'maximum', executionMode: 'gpu-auto',
      aiEnhance: true, mfsrEnhance: true
    });
    const completed = await waitFor(queue, created.id);
    const receipt = verifyReceipt(completed);
    results.push({
      route: 'SDR -> SDR', profileId, codec: completed.validation.codec,
      pixelFormat: completed.validation.pixelFormat, bitDepth: completed.validation.bitDepth,
      color: completed.validation.color, lossless: completed.validation.lossless,
      output: completed.outputPath, receiptSchema: receipt.schema,
      exactCameraMath: Boolean(completed.colorPipeline?.exactCameraMath)
    });
    process.stdout.write(`PASS SDR -> SDR ${transport.id} -> ${completed.validation.codec}/${completed.validation.pixelFormat}\n`);
  }

  for (const logVariant of ['shadow', 'highlight', 'cinema']) {
    const profileId = 'neolog-ffv1rgb16';
    const [created] = await queue.enqueue({
      inputs: [rawMedia], outputDirectory: output, profileId,
      quality: 'maximum', executionMode: 'gpu-auto',
      aiEnhance: true, mfsrEnhance: true, logVariant
    });
    const completed = await waitFor(queue, created.id);
    const receipt = verifyReceipt(completed);
    results.push({
      route: `RAW -> NeoLog ${logVariant}`, profileId, logVariant,
      codec: completed.validation.codec, pixelFormat: completed.validation.pixelFormat,
      bitDepth: completed.validation.bitDepth, color: completed.validation.color,
      lossless: completed.validation.lossless, output: completed.outputPath,
      receiptSchema: receipt.schema, exactCameraMath: Boolean(completed.colorPipeline?.exactCameraMath)
    });
    process.stdout.write(`PASS RAW -> NeoLog ${logVariant} -> ${completed.validation.codec}/${completed.validation.pixelFormat}\n`);
  }
  for (const rawProfile of CONVERSION_CATALOG.rawProfiles) {
    const [created] = await queue.enqueue({
      inputs: [rawMedia], outputDirectory: output, profileId: rawProfile.id,
      quality: 'maximum', aiEnhance: false, mfsrEnhance: false
    });
    const completed = await waitFor(queue, created.id);
    const receipt = verifyReceipt(completed);
    results.push({
      route: 'RAW -> RAW', profileId: rawProfile.id,
      lossless: receipt.losslessContract, output: completed.outputPath,
      receiptSchema: receipt.schema, validation: completed.validation
    });
    process.stdout.write(`PASS RAW -> RAW ${rawProfile.id}\n`);
  }
  let strictGpu = null;
  if (capabilities.preferredLosslessGpuEncoder) {
    const profileId = 'ndr10-pq-lossless420';
    const [created] = await queue.enqueue({
      inputs: [rawMedia], outputDirectory: output, profileId,
      quality: 'maximum', executionMode: 'gpu-encode',
      aiEnhance: false, mfsrEnhance: true
    });
    const completed = await waitFor(queue, created.id);
    verifyReceipt(completed);
    const validation = completed.validation;
    strictGpu = {
      encoder: completed.engine, codec: validation.codec,
      pixelFormat: validation.pixelFormat, color: validation.color
    };
    process.stdout.write(`PASS strict-gpu -> ${completed.engine}/${validation.pixelFormat}\n`);
  }
  const report = {
    verifiedAt: new Date().toISOString(),
    expectedProfiles: CONVERSION_CATALOG.deliveries.length * CONVERSION_CATALOG.transports.length +
      CONVERSION_CATALOG.transports.length + 3 + CONVERSION_CATALOG.rawProfiles.length,
    passedProfiles: results.length,
    strictGpu,
    results
  };
  fs.writeFileSync(path.join(output, 'matrix-verification-report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify({ ok: true, output, passedProfiles: results.length, strictGpu }, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
