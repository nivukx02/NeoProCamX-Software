'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { CapabilityService } = require('../src/core/capabilities');
const { MediaProbe } = require('../src/core/media-probe');
const { ConversionQueue } = require('../src/core/conversion-queue');
const { crc32 } = require('../src/core/binary-formats');

function i32(value) { const b = Buffer.alloc(4); b.writeInt32BE(value); return b; }
function i64(value) { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(value)); return b; }

function createRawNpv10(target, options = {}) {
  const width = 64; const height = 64; const fps = 24;
  const timestamps = options.timestamps || [
    1_000_000_000, 1_041_667_000, 1_090_000_000,
    1_125_000_000, 1_180_000_000, 1_220_000_000
  ];
  const metadataLines = [
    'payloadFormat=RAW12_NPV10_PACKED', 'packetCodec=LEGACY_UNCOMPRESSED',
    'sourceFormat=RAW_SENSOR', 'sourceBitDepth=12', 'storageBitDepth=12',
    'rawSensorCapture=true', 'bayerPattern=RGGB', 'exactSelectedResolution=true'
  ];
  if (options.withAudio) metadataLines.push('audioStoredInNpv10Bundle=true');
  const metadata = Buffer.from(`${metadataLines.join('\n')}\n`, 'utf8');
  const pieces = [Buffer.from('NPV10'), i32(2), i32(width), i32(height), i32(fps), i32(12), i32(metadata.length), metadata];
  for (let frame = 0; frame < timestamps.length; frame += 1) {
    const payload = Buffer.alloc(width * height * 2);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const raw = Math.min(4095, 128 + x * 42 + y * 16 + frame * 24);
      const nibble = (raw ^ (raw >>> 4) ^ (raw >>> 8)) & 0x0f;
      payload.writeUInt16LE(((raw >>> 2) << 6) | ((raw & 3) << 4) | nibble, (y * width + x) * 2);
    }
    pieces.push(Buffer.from('FRM0'), i64(timestamps[frame]), i32(width), i32(height), i32(payload.length), i32(crc32(payload) | 0), payload);
  }
  fs.writeFileSync(target, Buffer.concat(pieces));
  return timestamps;
}

function createRawNpraw(target) {
  const width = 64; const height = 64;
  const timestamps = [
    7_000_000_000, 7_043_000_000, 7_091_000_000,
    7_127_000_000, 7_183_000_000, 7_224_000_000
  ];
  const pieces = [];
  for (let frame = 0; frame < timestamps.length; frame += 1) {
    const payload = Buffer.alloc(width * height * 2);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      payload.writeUInt16LE(Math.min(65535, 1024 + x * 700 + y * 301 + frame * 333), (y * width + x) * 2);
    }
    const suffix = Buffer.alloc(28);
    suffix.writeInt32BE(16, 0);
    suffix.writeInt32BE(0, 4);
    suffix.writeInt32BE(65535, 8);
    suffix.writeFloatBE(16, 12);
    suffix.writeFloatBE(0.002, 16);
    suffix.writeBigUInt64BE(BigInt(crc32(payload)), 20);
    pieces.push(
      Buffer.from('NPRAW'), Buffer.from([2]), i32(10), i32(width), i32(height),
      i32(width * 2), i32(2), i64(timestamps[frame]), i32(payload.length), i32(payload.length),
      suffix, payload
    );
  }
  fs.writeFileSync(target, Buffer.concat(pieces));
  return timestamps;
}

function adtsPackets(encoded) {
  const packets = [];
  let offset = 0;
  while (offset < encoded.length) {
    if (offset + 7 > encoded.length || encoded[offset] !== 0xff || (encoded[offset + 1] & 0xf0) !== 0xf0) {
      throw new Error(`Invalid generated ADTS stream at byte ${offset}`);
    }
    const headerBytes = (encoded[offset + 1] & 1) ? 7 : 9;
    const frameBytes = ((encoded[offset + 3] & 3) << 11) | (encoded[offset + 4] << 3) | (encoded[offset + 5] >>> 5);
    if (frameBytes <= headerBytes || offset + frameBytes > encoded.length) throw new Error('Truncated generated ADTS frame');
    packets.push(encoded.subarray(offset + headerBytes, offset + frameBytes));
    offset += frameBytes;
  }
  return packets;
}

function createNpv10AudioSidecar(master, ffmpegPath, videoOriginSensorTimestampNs) {
  const encoded = spawnSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'sine=frequency=997:sample_rate=48000:duration=0.4',
    '-ac', '2', '-ar', '48000', '-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '192k', '-f', 'adts', 'pipe:1'
  ], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  if (encoded.status !== 0) throw new Error(`Unable to generate AAC fixture: ${String(encoded.stderr).slice(-1000)}`);
  const packets = adtsPackets(encoded.stdout).slice(0, 12);
  if (packets.length !== 12) throw new Error(`AAC fixture produced only ${packets.length} packets`);
  const codecConfig = Buffer.from([0x11, 0x90]); // AAC-LC, 48 kHz, stereo.
  const pieces = [
    Buffer.from([0x4e, 0x50, 0x56, 0x31, 0x30, 0x41, 0x31, 0x00]),
    i32(1), i32(48000), i32(2), i32(192000), i64(videoOriginSensorTimestampNs),
    i32(codecConfig.length), codecConfig
  ];
  let payloadBytes = 0;
  packets.forEach((payload, index) => {
    payloadBytes += payload.length;
    pieces.push(Buffer.from('AAC0'), i64(index * 21333), i32(index === 0 ? 1 : 0),
      i32(payload.length), i32(crc32(payload) | 0), payload);
  });
  pieces.push(Buffer.from('AEND'), i64(packets.length), i64(packets.length * 21333), i64(payloadBytes));
  fs.writeFileSync(`${master}.audio.npv10a`, Buffer.concat(pieces));
}

function ffmpegFilterPath(filePath) {
  return filePath.replace(/\\/g, '/').replace(':', '\\:').replace(/'/g, "\\'");
}

function createContainerVfr(target, ffmpegPath) {
  const presentationUs = [0, 41667, 90000, 125000, 180000, 220000];
  const commands = `${target}.sendcmd`;
  const lines = presentationUs.map((timestamp, index) =>
    `${Math.max(0, index / 24 - (index ? 0.0000005 : 0)).toFixed(9)} ` +
    `setpts@verify_vfr expr ${timestamp}/(1000000*TB);`
  );
  fs.writeFileSync(commands, `${lines.join('\n')}\n`, 'utf8');
  try {
    execFileSync(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
      '-i', 'testsrc2=size=160x90:rate=24', '-frames:v', String(presentationUs.length),
      '-vf', `settb=expr=1/1000000,sendcmd=f='${ffmpegFilterPath(commands)}',setpts@verify_vfr=PTS,format=yuv420p10le`,
      '-fps_mode:v', 'vfr', '-enc_time_base:v', '1:1000000', '-c:v', 'ffv1', '-level', '3', target
    ], { windowsHide: true, stdio: 'inherit' });
  } finally {
    fs.rmSync(commands, { force: true });
  }
  return presentationUs;
}

async function waitFor(queue, id) {
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const job = queue.snapshot().find(item => item.id === id);
      if (!job || !['complete', 'failed', 'cancelled'].includes(job.state)) return;
      clearInterval(timer);
      if (job.state === 'complete') resolve(job);
      else reject(new Error(job.error || `Verification job ${job.state}`));
    }, 100);
  });
}

function receiptFor(job) {
  const receiptPath = job.profileId === 'cinemadng-sequence'
    ? path.join(job.outputPath, 'conversion-receipt.json')
    : `${job.outputPath}.json`;
  if (!fs.existsSync(receiptPath)) throw new Error(`Missing conversion receipt: ${receiptPath}`);
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  const certificate = receipt.qualityCertificate;
  const integrity = receipt.sourceIntegrity;
  if (receipt.schema !== 'com.neoproc.camx.studio.conversion-receipt.v8' ||
      !receipt.validation?.passed || receipt.output !== job.outputPath || !/^[a-f0-9]{64}$/i.test(receipt.outputSha256 || '') ||
      certificate?.schema !== 'com.neoproc.camx.studio.quality-certificate.v1' || !certificate.passed ||
      !certificate.noSilentDowngrade || !certificate.codecLossless || !certificate.qualityInvariantUnderGovernor ||
      certificate.outputSha256 !== receipt.outputSha256 || !certificate.sourceUnchanged ||
      !integrity?.unchanged || integrity.before?.sha256 !== integrity.after?.sha256 ||
      integrity.before?.sha256 !== receipt.sourceSha256) {
    throw new Error(`Invalid conversion receipt: ${receiptPath}`);
  }
  for (const artifact of job.companionArtifacts || []) {
    const recorded = receipt.companionArtifacts?.find(item => item.kind === artifact.kind && item.outputPath === artifact.outputPath);
    const actualHash = fs.existsSync(artifact.outputPath)
      ? crypto.createHash('sha256').update(fs.readFileSync(artifact.outputPath)).digest('hex') : null;
    if (!recorded || recorded.sha256 !== artifact.sha256 || actualHash !== artifact.sha256) {
      throw new Error(`Invalid companion artifact receipt: ${artifact.outputPath}`);
    }
  }
  return {
    path: receiptPath, schema: receipt.schema, outputSha256: receipt.outputSha256,
    mfsr: receipt.multiFrameSuperResolution, companionArtifacts: receipt.companionArtifacts || []
  };
}

function verifyDynamicDeliveryEvidence(job) {
  if (!['ndr10-pq-ffv1rgb16', 'nivukx-pq-ffv1rgb16'].includes(job.profileId)) return;
  const evidence = job.companionArtifacts?.find(item => item.kind === 'camx-private-dynamic-delivery-metadata');
  if (!evidence || !fs.existsSync(evidence.outputPath)) {
    throw new Error(`Missing private dynamic-delivery evidence for ${job.profileId}`);
  }
  const records = fs.readFileSync(evidence.outputPath, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const frames = records.filter(record => record.recordType === 'frame');
  if (records[0]?.recordType !== 'header' || records.at(-1)?.recordType !== 'footer' ||
      frames.length !== job.validation?.decodedFrames) {
    throw new Error(`Invalid dynamic-delivery evidence cadence for ${job.profileId}`);
  }
  let previous = '0'.repeat(64);
  for (const record of records) {
    const { previousRecordSha256, recordSha256, ...payload } = record;
    const expected = crypto.createHash('sha256').update(previous, 'hex')
      .update(JSON.stringify(payload), 'utf8').digest('hex');
    if (previousRecordSha256 !== previous || recordSha256 !== expected) {
      throw new Error(`Dynamic metadata hash chain failed for ${job.profileId}`);
    }
    previous = recordSha256;
  }
  const measured = records.at(-1).measuredContentLight;
  if (measured?.framesMeasured !== frames.length || !job.colorPipeline?.measuredContentLight?.embeddedInContainer ||
      job.validation?.color?.hdrMetadata?.contentLightAuthority !== 'measured-final-pq-pixels') {
    throw new Error(`Measured HDR metadata was not embedded for ${job.profileId}`);
  }
}

function verifyMfsrJob(job) {
  if (['raw-preserve', 'cinemadng-sequence'].includes(job.profileId)) {
    if (job.mfsr?.enabled) throw new Error(`${job.profileId} violated its identity contract by enabling MFSR`);
    return;
  }
  if (!job.mfsr?.enabled) throw new Error(`MFSR was not enabled for ${job.profileId}`);
  if (job.mfsr.processedFrames !== job.validation?.decodedFrames) {
    throw new Error(`MFSR cadence mismatch for ${job.profileId}: ${job.mfsr.processedFrames} != ${job.validation?.decodedFrames}`);
  }
  if (!(job.mfsr.fusedFrames > 0)) throw new Error(`MFSR did not fuse any frames for ${job.profileId}`);
}

function verifySensorTimeline(job, expectedFrames, expectedAuthority = 'sensor-nanoseconds') {
  const timing = job.validation?.timing;
  if (timing?.authority !== expectedAuthority || timing.frameCount !== expectedFrames ||
      timing.maximumTimestampErrorUs > 2 || timing.strictlyMonotonic !== true) {
    throw new Error(`Sensor timeline verification failed for ${job.profileId}: ${JSON.stringify(timing)}`);
  }
}

function verifyNiv99Evidence(job) {
  if (['raw-preserve', 'cinemadng-sequence'].includes(job.profileId)) return;
  const evidence = job.companionArtifacts?.find(item => item.kind === 'niv99-per-frame-quality-evidence');
  if (!evidence || !fs.existsSync(evidence.outputPath) || !/^[a-f0-9]{64}$/i.test(evidence.sha256 || '')) {
    throw new Error(`Missing NIV99 evidence for ${job.profileId}`);
  }
  const events = fs.readFileSync(evidence.outputPath, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const frames = events.filter(event => event.event === 'niv99');
  if (frames.length !== job.validation?.decodedFrames || events.at(-1)?.event !== 'complete') {
    throw new Error(`Invalid NIV99 evidence cadence for ${job.profileId}`);
  }
  frames.forEach((event, index) => {
    if (event.frame !== index + 1) throw new Error(`Non-contiguous NIV99 evidence at frame ${index + 1}`);
  });
}

function verifyAiGuardrail(caps) {
  if (!caps.ai?.ready) return { skipped: true, reason: caps.ai?.error || 'AI unavailable' };
  const width = 64; const height = 64; const frames = 3;
  const input = Buffer.alloc(width * height * 3 * 2 * frames);
  for (let frame = 0; frame < frames; frame += 1) for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const base = Math.round((x / (width - 1) * 0.72 + y / (height - 1) * 0.18 + frame * 0.002) * 65535);
    const offset = ((frame * width * height + y * width + x) * 3) * 2;
    input.writeUInt16LE(Math.min(65535, base + ((x + y) % 3) * 24), offset);
    input.writeUInt16LE(Math.min(65535, base), offset + 2);
    input.writeUInt16LE(Math.max(0, base - ((x * 3 + y) % 5) * 18), offset + 4);
  }
  const result = spawnSync(caps.ai.workerPath, [
    '--model', caps.ai.modelPath, '--width', String(width), '--height', String(height),
    '--threads', '4', '--strength', '0.52', '--interval', '2', '--temporal-strength', '0.16'
  ], { input, windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 120000 });
  if (result.status !== 0) throw new Error(`AI guardrail test failed: ${String(result.stderr).slice(-1000)}`);
  if (result.stdout.length !== input.length) throw new Error(`AI guardrail frame size changed: ${result.stdout.length} != ${input.length}`);
  let maximumDelta = 0;
  let totalDelta = 0;
  const samples = input.length / 2;
  for (let offset = 0; offset < input.length; offset += 2) {
    const delta = Math.abs(result.stdout.readUInt16LE(offset) - input.readUInt16LE(offset));
    maximumDelta = Math.max(maximumDelta, delta);
    totalDelta += delta;
  }
  const meanDelta = totalDelta / samples;
  if (maximumDelta > 4096 || meanDelta > 1024) throw new Error(`AI guardrail exceeded bounded correction: max=${maximumDelta}, mean=${meanDelta}`);
  return { passed: true, frames, maximumCodeDelta: maximumDelta, meanCodeDelta: Number(meanDelta.toFixed(3)) };
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const output = path.join(root, 'verification-output');
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  const capabilityService = new CapabilityService();
  const caps = await capabilityService.detect(true);
  if (!caps.ready) throw new Error('FFmpeg/FFprobe or libx265 unavailable');
  const source = path.join(output, 'reference-input.mkv');
  execFileSync(caps.ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=12:duration=0.5',
    '-f', 'lavfi', '-i', 'sine=frequency=997:sample_rate=48000:duration=0.5', '-c:v', 'ffv1', '-level', '3', '-pix_fmt', 'yuv420p10le',
    '-c:a', 'pcm_s24le', source
  ], { windowsHide: true, stdio: 'inherit' });
  const mediaProbe = new MediaProbe(capabilityService);
  // This file is generated inside the verifier and never enters through the user library.
  // Mark only this trusted fixture as a conversion source so the production Saved-video gate
  // remains fail-closed for ordinary local/gallery media.
  const media = {
    ...await mediaProbe.probe(source),
    libraryKind: 'conversion',
    conversionEligible: true,
    conversionKind: 'verification-fixture'
  };
  const queue = new ConversionQueue(capabilityService, mediaProbe, () => {});
  const cases = [
    { profileId: 'rec709-sdr-ffv1rgb16', quality: 'maximum', aiEnhance: false },
    { profileId: 'rec709-sdr-r210', quality: 'maximum', aiEnhance: false },
    { profileId: 'rec709-sdr-v210', quality: 'maximum', aiEnhance: false },
    { profileId: 'rec709-sdr-lossless420', quality: 'maximum', aiEnhance: false }
  ];
  if (caps.ai?.ready) cases.push(
    { profileId: 'rec709-sdr-ffv1rgb16', quality: 'maximum', aiEnhance: true, label: 'sdr-camera-ai' }
  );
  const results = [];
  for (const item of cases) {
    const [created] = await queue.enqueue({ inputs: [media], outputDirectory: output, ...item });
    const completed = await waitFor(queue, created.id);
    verifyMfsrJob(completed);
    verifyNiv99Evidence(completed);
    verifyDynamicDeliveryEvidence(completed);
    results.push({ profile: item.label || item.profileId, quality: item.quality, output: completed.outputPath, bytes: completed.bytesWritten, engine: completed.engine, ai: completed.ai, mfsr: completed.mfsr, validation: completed.validation, receipt: receiptFor(completed) });
  }
  const rawSource = path.join(output, 'reference-raw.npv10');
  createRawNpv10(rawSource);
  const rawMedia = await mediaProbe.probe(rawSource);
  for (const rawCase of [
    { profileId: 'rec709-sdr-ffv1rgb16', label: 'raw-to-sdr' },
    { profileId: 'ndr10-pq-ffv1rgb16', label: 'raw-to-ndr10' },
    { profileId: 'nivukx-pq-ffv1rgb16', label: 'raw-to-nivukx' },
    { profileId: 'neolog-ffv1rgb16', label: 'raw-to-neolog-base', logVariant: 'base' },
    { profileId: 'neolog-ffv1rgb16', label: 'raw-to-neolog-shadow', logVariant: 'shadow' },
    { profileId: 'neolog-ffv1rgb16', label: 'raw-to-neolog-highlight', logVariant: 'highlight' },
    { profileId: 'neolog-ffv1rgb16', label: 'raw-to-neolog-cinema', logVariant: 'cinema' },
    ...(caps.ai?.ready ? [{ profileId: 'rec709-sdr-ffv1rgb16', label: 'raw-to-sdr-camera-ai', aiEnhance: true }] : []),
    { profileId: 'raw-preserve', label: 'raw-bit-exact-preserve' },
    { profileId: 'cinemadng-sequence', label: 'raw-to-cinemadng' }
  ]) {
    const [rawCreated] = await queue.enqueue({ inputs: [rawMedia], outputDirectory: output, quality: 'production', aiEnhance: false, ...rawCase });
    const rawCompleted = await waitFor(queue, rawCreated.id);
    verifyMfsrJob(rawCompleted);
    verifyNiv99Evidence(rawCompleted);
    verifyDynamicDeliveryEvidence(rawCompleted);
    if (!['raw-preserve', 'cinemadng-sequence'].includes(rawCase.profileId)) {
      verifySensorTimeline(rawCompleted, rawMedia.frames);
    }
    results.push({ profile: rawCase.label, quality: 'production', output: rawCompleted.outputPath, bytes: rawCompleted.bytesWritten, engine: rawCompleted.engine, ai: rawCompleted.ai, mfsr: rawCompleted.mfsr, rawDevelopment: rawCompleted.rawDevelopment, validation: rawCompleted.validation, receipt: receiptFor(rawCompleted) });
  }

  const nprawSource = path.join(output, 'reference-vfr.npraw');
  createRawNpraw(nprawSource);
  const nprawMedia = await mediaProbe.probe(nprawSource);
  const [nprawCreated] = await queue.enqueue({
    inputs: [nprawMedia], outputDirectory: output, profileId: 'rec709-sdr-ffv1rgb16',
    quality: 'production', aiEnhance: false
  });
  const nprawCompleted = await waitFor(queue, nprawCreated.id);
  verifyMfsrJob(nprawCompleted);
  verifyNiv99Evidence(nprawCompleted);
  verifySensorTimeline(nprawCompleted, nprawMedia.frames);
  results.push({
    profile: 'npraw-vfr-to-sdr', quality: 'production', output: nprawCompleted.outputPath,
    bytes: nprawCompleted.bytesWritten, engine: nprawCompleted.engine, ai: nprawCompleted.ai,
    mfsr: nprawCompleted.mfsr, rawDevelopment: nprawCompleted.rawDevelopment,
    validation: nprawCompleted.validation, receipt: receiptFor(nprawCompleted)
  });

  const containerVfrSource = path.join(output, 'reference-container-vfr.mkv');
  createContainerVfr(containerVfrSource, caps.ffmpegPath);
  const containerVfrMedia = {
    ...await mediaProbe.probe(containerVfrSource),
    libraryKind: 'conversion',
    conversionEligible: true,
    conversionKind: 'verification-fixture'
  };
  if (!containerVfrMedia.variableFrameRate || containerVfrMedia.timingAuthority !== 'container-presentation-timestamps') {
    throw new Error(`Container VFR probe failed: ${JSON.stringify(containerVfrMedia)}`);
  }
  const [containerVfrCreated] = await queue.enqueue({
    inputs: [containerVfrMedia], outputDirectory: output, profileId: 'rec709-sdr-ffv1rgb16',
    quality: 'production', aiEnhance: false
  });
  const containerVfrCompleted = await waitFor(queue, containerVfrCreated.id);
  verifyMfsrJob(containerVfrCompleted);
  verifyNiv99Evidence(containerVfrCompleted);
  verifySensorTimeline(containerVfrCompleted, containerVfrMedia.frames, 'container-presentation-timestamps');
  results.push({
    profile: 'container-vfr-to-sdr', quality: 'production', output: containerVfrCompleted.outputPath,
    bytes: containerVfrCompleted.bytesWritten, engine: containerVfrCompleted.engine,
    ai: containerVfrCompleted.ai, mfsr: containerVfrCompleted.mfsr,
    validation: containerVfrCompleted.validation, receipt: receiptFor(containerVfrCompleted)
  });

  const audioSource = path.join(output, 'reference-audio-vfr.npv10');
  const audioTimestamps = createRawNpv10(audioSource, { withAudio: true });
  createNpv10AudioSidecar(audioSource, caps.ffmpegPath, audioTimestamps[0]);
  const audioMedia = await mediaProbe.probe(audioSource);
  const [audioCreated] = await queue.enqueue({
    inputs: [audioMedia], outputDirectory: output, profileId: 'rec709-sdr-ffv1rgb16',
    quality: 'production', aiEnhance: false
  });
  const audioCompleted = await waitFor(queue, audioCreated.id);
  verifyMfsrJob(audioCompleted);
  verifyNiv99Evidence(audioCompleted);
  verifySensorTimeline(audioCompleted, audioMedia.frames);
  const audioValidation = audioCompleted.validation?.audio;
  if (audioValidation?.codec !== 'aac' || audioValidation.channels !== 2 ||
      audioValidation.sampleRate !== 48000 || !audioValidation.integrity?.streamCopy ||
      audioValidation.integrity.packetHashesMatched !== audioMedia.audioSidecar.packetCount ||
      audioValidation.integrity.sourcePayloadSha256 !== audioMedia.audioSidecar.payloadSha256) {
    throw new Error(`NPV10 AAC delivery validation failed: ${JSON.stringify(audioCompleted.validation?.audio)}`);
  }
  results.push({
    profile: 'npv10-vfr-aac-to-sdr', quality: 'production', output: audioCompleted.outputPath,
    bytes: audioCompleted.bytesWritten, engine: audioCompleted.engine, ai: audioCompleted.ai,
    mfsr: audioCompleted.mfsr, rawDevelopment: audioCompleted.rawDevelopment,
    validation: audioCompleted.validation, receipt: receiptFor(audioCompleted)
  });
  const aiGuardrail = verifyAiGuardrail(caps);
  fs.writeFileSync(path.join(output, 'verification-report.json'), JSON.stringify({ verifiedAt: new Date().toISOString(), capabilities: caps, aiGuardrail, results }, null, 2));
  process.stdout.write(`${JSON.stringify({ ok: true, output, aiGuardrail, results }, null, 2)}\n`);
}

main().catch(error => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
