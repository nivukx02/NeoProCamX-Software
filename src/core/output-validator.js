'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { inspectDngHeader } = require('./cinema-dng');

const execFileAsync = promisify(execFile);

function archiveColorContract(sourceMedia = {}) {
  if (sourceMedia.raw) return { primaries: 'bt2020', transfer: 'bt709', matrix: 'bt2020nc', range: 'tv' };
  if (sourceMedia.developColor) {
    if (sourceMedia.developColor.colorSpace === 1 && sourceMedia.developColor.colorTransfer === 1) {
      return { primaries: 'bt2020', transfer: 'arib-std-b67', matrix: 'bt2020nc', range: 'tv' };
    }
    if (sourceMedia.developColor.colorSpace === 1 && sourceMedia.developColor.colorTransfer === 2) {
      return { primaries: 'bt2020', transfer: 'smpte2084', matrix: 'bt2020nc', range: 'tv' };
    }
    if (sourceMedia.developColor.colorSpace === 1) {
      return { primaries: 'bt2020', transfer: 'bt2020-10', matrix: 'bt2020nc', range: 'tv' };
    }
    return { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' };
  }
  const primaries = String(sourceMedia.colorPrimaries || '').toLowerCase();
  const transfer = String(sourceMedia.colorTransfer || '').toLowerCase();
  if (transfer === 'arib-std-b67') return { primaries: 'bt2020', transfer, matrix: 'bt2020nc', range: 'tv' };
  if (transfer === 'smpte2084') return { primaries: 'bt2020', transfer, matrix: 'bt2020nc', range: 'tv' };
  if (primaries === 'bt2020') return { primaries, transfer: 'bt2020-10', matrix: 'bt2020nc', range: 'tv' };
  if (['smpte432', 'display-p3', 'display_p3'].includes(primaries)) {
    return { primaries: 'smpte432', transfer: 'iec61966-2-1', matrix: 'bt709', range: 'tv' };
  }
  return { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' };
}

function expectedContract(profile, sourceMedia = {}) {
  const color = {
    sdr: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709' },
    'p3-sdr': { primaries: 'smpte432', transfer: 'iec61966-2-1', matrix: 'bt709' },
    'bt2020-sdr': { primaries: 'bt2020', transfer: 'bt2020-10', matrix: 'bt2020nc' },
    hlg: { primaries: 'bt2020', transfer: 'arib-std-b67', matrix: 'bt2020nc' },
    hdr10: { primaries: 'bt2020', transfer: 'smpte2084', matrix: 'bt2020nc' },
    ndr: { primaries: 'bt2020', transfer: 'smpte2084', matrix: 'bt2020nc' },
    nivukx: { primaries: 'bt2020', transfer: 'smpte2084', matrix: 'bt2020nc' },
    // NeoLog is AP1/D60 with a private transfer function. There is no correct
    // ISO/IEC colour-primaries or transfer enum for it, so those fields must be
    // absent/unspecified. YUV transports still identify the numerical matrix.
    log: { primaries: null, transfer: null, matrix: 'bt2020nc', proprietaryLog: true }
  }[profile.family];
  if (color) {
    const configuredEncoder = profile.encoder || (profile.family === 'log' ? 'prores' : 'hevc');
    const encoder = profile.resolvedEncoder === 'hevc_nvenc' ? 'hevc' :
      profile.resolvedEncoder === 'ffv1' ? 'ffv1' : configuredEncoder;
    const outputMode = profile.outputMode || (profile.family === 'log' ? 'yuv444' : 'yuv420');
    const video = encoder === 'r210'
      ? { codec: 'r210', bitDepth: 10, pixelFormat: 'gbrp10le' }
      : encoder === 'v210'
        ? { codec: 'v210', bitDepth: 10, pixelFormat: 'yuv422p10le' }
        : encoder === 'ffv1'
          ? {
              codec: 'ffv1', bitDepth: outputMode === 'rgb16' ? 16 : 10,
              pixelFormat: outputMode === 'rgb16' ? 'gbrp16le' :
                outputMode === 'yuv422' ? 'yuv422p10le' :
                  outputMode === 'yuv444' ? 'yuv444p12le' : 'yuv420p10le'
            }
        : encoder === 'prores'
          ? {
              codec: 'prores', bitDepth: outputMode === 'yuv422' ? 10 : 12,
              pixelFormat: outputMode === 'yuv422' ? 'yuv422p10le' : 'yuv444p12le',
              proresProfile: profile.proresProfile === 3 ? 'HQ' : profile.proresProfile === 4 ? '4444' : 'XQ'
            }
          : {
              codec: 'hevc', bitDepth: 10,
              pixelFormat: profile.resolvedEncoder === 'hevc_nvenc' ? 'p010le' :
                outputMode === 'yuv422' ? 'yuv422p10le' : 'yuv420p10le'
            };
    return {
      ...video, ...color,
      matrix: ['rgb10', 'rgb16'].includes(outputMode) ? 'gbr' : color.matrix,
      range: ['rgb10', 'rgb16'].includes(outputMode) ? 'pc' : 'tv'
    };
  }
  if (profile.family === 'archive-video') return {
    codec: 'prores', bitDepth: profile.outputMode === 'yuv422' ? 10 : 12,
    pixelFormat: profile.outputMode === 'yuv422' ? 'yuv422p10le' : 'yuv444p12le',
    proresProfile: profile.proresProfile === 3 ? 'HQ' : profile.proresProfile === 4 ? '4444' : 'XQ',
    ...archiveColorContract(sourceMedia)
  };
  if (profile.family === 'rgb10') return {
    codec: 'r210', bitDepth: 10, pixelFormat: 'gbrp10le',
    primaries: 'bt709', transfer: 'bt709', matrix: 'gbr', range: 'pc'
  };
  if (profile.family === 'yuv10') return {
    codec: 'v210', bitDepth: 10, pixelFormat: 'yuv422p10le',
    primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv'
  };
  return {};
}

function detectedBitDepth(stream) {
  const direct = Number(stream.bits_per_raw_sample || stream.bits_per_component || 0);
  if (direct) return direct;
  const pixelFormat = String(stream.pix_fmt || '');
  const match = pixelFormat.match(/(?:p|yuv\d*p|gbrp)(\d{2})(?:le|be)?$/i) || pixelFormat.match(/(10|12|16)/);
  return match ? Number(match[1]) : 8;
}

function rationalSeconds(value) {
  if (typeof value !== 'string' || !value.includes('/')) return Number(value || 0);
  const [numerator, denominator] = value.split('/').map(Number);
  return denominator ? numerator / denominator : 0;
}

function streamDuration(stream) {
  const direct = Number(stream?.duration || 0);
  if (direct > 0) return direct;
  const durationTs = Number(stream?.duration_ts || 0);
  const timeBase = rationalSeconds(stream?.time_base);
  return durationTs > 0 && timeBase > 0 ? durationTs * timeBase : 0;
}

function effectiveColorRange(video, probe) {
  const signaled = String(video?.color_range || '').toLowerCase();
  if (signaled) return { value: signaled, authority: 'bitstream-or-container' };
  const codec = String(video?.codec_name || '').toLowerCase();
  const pixelFormat = String(video?.pix_fmt || '').toLowerCase();
  const comment = String(probe?.format?.tags?.comment || '').toLowerCase();
  if (codec === 'r210' && pixelFormat === 'gbrp10le' && comment.includes('range=pc')) {
    return { value: 'pc', authority: 'r210-coding-convention+camx-marker' };
  }
  if (codec === 'v210' && pixelFormat === 'yuv422p10le' && comment.includes('range=tv')) {
    return { value: 'tv', authority: 'v210-coding-convention+camx-marker' };
  }
  if (codec === 'ffv1' && pixelFormat.includes('gbr') && comment.includes('range=pc')) {
    return { value: 'pc', authority: 'ffv1-pixel-format+camx-marker' };
  }
  if (codec === 'ffv1' && pixelFormat.includes('yuv') && comment.includes('range=tv')) {
    return { value: 'tv', authority: 'ffv1-pixel-format+camx-marker' };
  }
  return { value: '', authority: 'unset' };
}

function validateProprietaryDeliveryMetadata(probe, profile, errors) {
  const expected = profile.family === 'ndr'
    ? { technology: 'ndr10_plus', peakNits: 5000 }
    : profile.family === 'nivukx'
      ? { technology: 'nivukx_vision', peakNits: 10000 }
      : null;
  if (!expected) return null;
  const comment = String(probe?.format?.tags?.comment || '').toLowerCase();
  const markers = [
    `technology=${expected.technology}`,
    'tone=ndr-tone-op-v4',
    'calibration=ndr-nivukx-py-cal-v4',
    'delivery=ndr-nivukx-delivery-v1',
    'diffuse-white=203',
    `peak=${expected.peakNits}`
  ];
  const missing = markers.filter(marker => !comment.includes(marker));
  if (missing.length) errors.push(`proprietary delivery metadata is incomplete (${missing.join(', ')})`);
  return { ...expected, complete: missing.length === 0, markers };
}

function validateNeoLogSignaling(video, profile, errors) {
  if (profile.family !== 'log') return null;
  const primaries = String(video?.color_primaries || '').toLowerCase();
  const transfer = String(video?.color_transfer || '').toLowerCase();
  const unspecified = value => !value || ['unknown', 'unspecified', 'reserved'].includes(value);
  if (!unspecified(primaries)) errors.push(`NeoLog must not claim standard primaries (${primaries})`);
  if (!unspecified(transfer)) errors.push(`NeoLog must not claim a standard transfer (${transfer})`);
  return {
    proprietary: true,
    primariesSignaling: primaries || 'unspecified',
    transferSignaling: transfer || 'unspecified',
    authoritativeIdentity: 'NeoLog companion manifest (ACEScg AP1 / D60)'
  };
}

function expectedHdrMetadata(profile = {}, measuredContentLight = null) {
  const peakNits = Number(profile.peakNits || ({ hdr10: 1000, ndr: 5000, nivukx: 10000 }[profile.family] || 0));
  if (!peakNits || !['hdr10', 'ndr', 'nivukx'].includes(profile.family)) return null;
  const measuredMaxContent = Number(measuredContentLight?.signalledMaxCLL);
  const measuredMaxAverage = Number(measuredContentLight?.signalledMaxFALL);
  return {
    red: [0.708, 0.292], green: [0.17, 0.797], blue: [0.131, 0.046],
    whitePoint: [0.3127, 0.329], minLuminance: 0.0001,
    maxLuminance: peakNits,
    maxContent: Number.isFinite(measuredMaxContent) ? Math.max(0, Math.min(65535, Math.round(measuredMaxContent))) : peakNits,
    maxAverage: Number.isFinite(measuredMaxAverage) ? Math.max(0, Math.min(65535, Math.round(measuredMaxAverage))) : Math.round(peakNits * 0.4),
    contentLightAuthority: Number.isFinite(measuredMaxContent) && Number.isFinite(measuredMaxAverage)
      ? 'measured-final-pq-pixels' : 'mastering-envelope-fallback'
  };
}

function rationalValue(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || !value.includes('/')) return Number(value);
  const [numerator, denominator] = value.split('/').map(Number);
  return denominator ? numerator / denominator : Number.NaN;
}

function inspectHdrMetadata(video = {}) {
  const sideData = Array.isArray(video.side_data_list) ? video.side_data_list : [];
  const mastering = sideData.find(item => String(item.side_data_type || '').toLowerCase() === 'mastering display metadata');
  const content = sideData.find(item => String(item.side_data_type || '').toLowerCase() === 'content light level metadata');
  return {
    mastering: mastering ? {
      red: [rationalValue(mastering.red_x), rationalValue(mastering.red_y)],
      green: [rationalValue(mastering.green_x), rationalValue(mastering.green_y)],
      blue: [rationalValue(mastering.blue_x), rationalValue(mastering.blue_y)],
      whitePoint: [rationalValue(mastering.white_point_x), rationalValue(mastering.white_point_y)],
      minLuminance: rationalValue(mastering.min_luminance),
      maxLuminance: rationalValue(mastering.max_luminance)
    } : null,
    contentLight: content ? {
      maxContent: Number(content.max_content), maxAverage: Number(content.max_average)
    } : null
  };
}

function validateHdrMetadata(video, profile, errors, measuredContentLight = null) {
  const expected = expectedHdrMetadata(profile, measuredContentLight);
  if (!expected) return null;
  const actual = inspectHdrMetadata(video);
  if (!actual.mastering) errors.push('mastering-display metadata is missing');
  if (!actual.contentLight) errors.push('content-light metadata is missing');
  if (!actual.mastering || !actual.contentLight) return actual;
  const close = (left, right, tolerance = 0.000021) => Number.isFinite(left) && Math.abs(left - right) <= tolerance;
  for (const key of ['red', 'green', 'blue', 'whitePoint']) {
    if (!actual.mastering[key].every((value, index) => close(value, expected[key][index]))) {
      errors.push(`${key} mastering chromaticity does not match the CamX BT.2020 contract`);
    }
  }
  if (!close(actual.mastering.minLuminance, expected.minLuminance, 0.000001)) {
    errors.push(`mastering minimum ${actual.mastering.minLuminance} != ${expected.minLuminance} nits`);
  }
  if (!close(actual.mastering.maxLuminance, expected.maxLuminance, 0.01)) {
    errors.push(`mastering peak ${actual.mastering.maxLuminance} != ${expected.maxLuminance} nits`);
  }
  if (actual.contentLight.maxContent !== expected.maxContent || actual.contentLight.maxAverage !== expected.maxAverage) {
    errors.push(`content light ${actual.contentLight.maxContent},${actual.contentLight.maxAverage} != ${expected.maxContent},${expected.maxAverage}`);
  }
  return { ...actual, contentLightAuthority: expected.contentLightAuthority };
}

async function validateSensorTimeline(filePath, sourceMedia, capabilities) {
  if (!Array.isArray(sourceMedia.timestamps) || !sourceMedia.timestamps.length) return null;
  const { stdout } = await execFileAsync(capabilities.ffprobePath, [
    '-v', 'error', '-select_streams', 'v:0', '-show_frames',
    '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'csv=p=0', filePath
  ], { windowsHide: true, timeout: 60 * 60 * 1000, maxBuffer: 128 * 1024 * 1024 });
  const actual = stdout.split(/\r?\n/)
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => Number(value.split(',')[0]))
    .filter(Number.isFinite)
    .map(value => Math.round(value * 1e6));
  if (actual.length !== sourceMedia.timestamps.length) {
    throw new Error(`Delivery contract failed: timestamp count ${actual.length} != ${sourceMedia.timestamps.length}`);
  }
  const first = sourceMedia.timestamps[0];
  let maximumErrorUs = 0;
  let previous = -1;
  for (let index = 0; index < actual.length; index += 1) {
    const expectedUs = Math.floor((sourceMedia.timestamps[index] - first) / 1000);
    const errorUs = Math.abs(actual[index] - expectedUs);
    maximumErrorUs = Math.max(maximumErrorUs, errorUs);
    if (actual[index] <= previous) throw new Error(`Delivery contract failed: non-monotonic output PTS at frame ${index + 1}`);
    if (errorUs > 2) {
      throw new Error(`Delivery contract failed: frame ${index + 1} PTS ${actual[index]}us != sensor ${expectedUs}us`);
    }
    previous = actual[index];
  }
  return {
    authority: sourceMedia.timingAuthority || 'sensor-nanoseconds',
    frameCount: actual.length,
    firstPresentationTimeUs: actual[0],
    finalPresentationTimeUs: actual[actual.length - 1],
    maximumTimestampErrorUs: maximumErrorUs,
    strictlyMonotonic: true
  };
}

async function validateCameraAudioPackets(filePath, sourceMedia, capabilities) {
  const sidecar = sourceMedia.audioSidecar;
  if (!sidecar) return null;
  const { stdout } = await execFileAsync(capabilities.ffprobePath, [
    '-v', 'error', '-select_streams', 'a:0', '-show_packets',
    '-show_entries', 'packet=pts_time,duration_time,size,data_hash',
    '-show_data_hash', 'sha256', '-of', 'json', filePath
  ], { windowsHide: true, timeout: 60 * 60 * 1000, maxBuffer: 256 * 1024 * 1024 });
  const packets = JSON.parse(stdout).packets || [];
  if (packets.length !== sidecar.packetCount) {
    throw new Error(`Delivery contract failed: AAC packet count ${packets.length} != source ${sidecar.packetCount}`);
  }
  let payloadBytes = 0;
  let previousPts = Number.NEGATIVE_INFINITY;
  let maximumTimestampErrorUs = 0;
  for (let index = 0; index < packets.length; index += 1) {
    const packet = packets[index];
    const expected = sidecar.packets[index];
    const actualHash = String(packet.data_hash || '').replace(/^SHA256:/i, '').toLowerCase();
    if (!actualHash || actualHash !== String(expected.sha256 || '').toLowerCase()) {
      throw new Error(`Delivery contract failed: AAC access-unit hash mismatch at packet ${index + 1}`);
    }
    const ptsUs = Math.round(Number(packet.pts_time || 0) * 1e6);
    const expectedPtsUs = expected.presentationTimeUs - sidecar.firstPresentationTimeUs;
    maximumTimestampErrorUs = Math.max(maximumTimestampErrorUs, Math.abs(ptsUs - expectedPtsUs));
    if (ptsUs < previousPts) throw new Error(`Delivery contract failed: AAC PTS is non-monotonic at packet ${index + 1}`);
    previousPts = ptsUs;
    payloadBytes += Number(packet.size || 0);
  }
  const toleranceUs = Math.ceil(1e6 * 1024 / Math.max(1, sidecar.sampleRate)) + 2;
  if (maximumTimestampErrorUs > toleranceUs) {
    throw new Error(`Delivery contract failed: AAC packet timing error ${maximumTimestampErrorUs}us exceeds ${toleranceUs}us`);
  }
  return {
    codec: 'aac', streamCopy: true, packetCount: packets.length,
    packetHashesMatched: packets.length, payloadBytes,
    sourcePayloadSha256: sidecar.payloadSha256,
    sourceCodecConfigSha256: sidecar.codecConfigSha256,
    maximumTimestampErrorUs, crcValidatedAtIngest: sidecar.crcValidated
  };
}

async function validateVideo(filePath, profile, sourceMedia, capabilities, measuredContentLight = null) {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile() || stat.size <= 0) throw new Error('Validation failed: output file is empty');
  const { stdout } = await execFileAsync(capabilities.ffprobePath, [
    '-v', 'error', '-show_streams', '-show_format', '-count_frames', '-of', 'json', filePath
  ], { windowsHide: true, timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  const probe = JSON.parse(stdout);
  const video = probe.streams?.find(stream => stream.codec_type === 'video');
  const audio = probe.streams?.find(stream => stream.codec_type === 'audio');
  if (!video) throw new Error('Validation failed: delivery contains no video stream');
  const contract = expectedContract(profile, sourceMedia);
  const errors = [];
  const range = effectiveColorRange(video, probe);
  if (contract.codec && String(video.codec_name).toLowerCase() !== contract.codec) errors.push(`codec ${video.codec_name || 'unknown'} != ${contract.codec}`);
  const bitDepth = detectedBitDepth(video);
  if (contract.bitDepth && bitDepth < contract.bitDepth) errors.push(`bit depth ${bitDepth} < ${contract.bitDepth}`);
  if (contract.pixelFormat && String(video.pix_fmt).toLowerCase() !== contract.pixelFormat) errors.push(`pixel format ${video.pix_fmt || 'unknown'} != ${contract.pixelFormat}`);
  if (contract.proresProfile && String(video.profile || '').toUpperCase() !== contract.proresProfile.toUpperCase()) errors.push(`ProRes profile ${video.profile || 'unknown'} != ${contract.proresProfile}`);
  const rotated = Math.abs(Number(sourceMedia.rotation || 0)) % 180 === 90;
  const expectedWidth = rotated ? sourceMedia.height : sourceMedia.width;
  const expectedHeight = rotated ? sourceMedia.width : sourceMedia.height;
  if (expectedWidth && Number(video.width) !== Number(expectedWidth)) errors.push(`width ${video.width} != ${expectedWidth}`);
  if (expectedHeight && Number(video.height) !== Number(expectedHeight)) errors.push(`height ${video.height} != ${expectedHeight}`);
  if (contract.primaries && String(video.color_primaries) !== contract.primaries) errors.push(`primaries ${video.color_primaries || 'unset'} != ${contract.primaries}`);
  if (contract.transfer && String(video.color_transfer) !== contract.transfer) errors.push(`transfer ${video.color_transfer || 'unset'} != ${contract.transfer}`);
  if (contract.matrix && String(video.color_space) !== contract.matrix) errors.push(`matrix ${video.color_space || 'unset'} != ${contract.matrix}`);
  if (contract.range && range.value !== contract.range) errors.push(`range ${range.value || 'unset'} != ${contract.range}`);
  const hdrMetadata = validateHdrMetadata(video, profile, errors, measuredContentLight);
  const proprietaryDelivery = validateProprietaryDeliveryMetadata(probe, profile, errors);
  const proprietaryLog = validateNeoLogSignaling(video, profile, errors);
  const duration = streamDuration(video) || Number(probe.format?.duration || 0);
  const sourceDuration = Number(sourceMedia.duration || 0);
  const tolerance = Math.max(0.002, 0.25 / Math.max(1, Number(sourceMedia.fps || 1)));
  if (sourceDuration > 0 && Math.abs(duration - sourceDuration) > tolerance) errors.push(`duration ${duration.toFixed(3)}s differs from source ${sourceDuration.toFixed(3)}s`);
  const decodedFrames = Number(video.nb_read_frames || video.nb_frames || 0);
  if (sourceMedia.frames && decodedFrames !== sourceMedia.frames) errors.push(`frame count ${decodedFrames} != ${sourceMedia.frames}`);
  if (sourceMedia.audio && !audio) errors.push('source audio is missing from the delivery');
  const cameraAac = Boolean(sourceMedia.audioSidecar);
  const expectedAudioCodec = cameraAac ? 'aac' : 'pcm_s24le';
  if (sourceMedia.audio && audio && String(audio.codec_name).toLowerCase() !== expectedAudioCodec) errors.push(`audio codec ${audio.codec_name || 'unknown'} != ${expectedAudioCodec}`);
  if (sourceMedia.audio && audio && !cameraAac && Number(audio.bits_per_raw_sample || audio.bits_per_sample || 0) !== 24) {
    errors.push(`audio bit depth ${audio.bits_per_raw_sample || audio.bits_per_sample || 0} != 24`);
  }
  const sourceAudio = sourceMedia.metadata?.streams?.find(stream => stream.codec_type === 'audio');
  if (sourceAudio && audio) {
    if (Number(sourceAudio.sample_rate || 0) && Number(audio.sample_rate) !== Number(sourceAudio.sample_rate)) {
      errors.push(`audio sample rate ${audio.sample_rate || 0} != source ${sourceAudio.sample_rate}`);
    }
    if (Number(sourceAudio.channels || 0) && Number(audio.channels) !== Number(sourceAudio.channels)) {
      errors.push(`audio channels ${audio.channels || 0} != source ${sourceAudio.channels}`);
    }
    const expectedAudioDuration = streamDuration(sourceAudio);
    const actualAudioDuration = streamDuration(audio);
    const audioTolerance = 1024 / Math.max(1, Number(sourceAudio.sample_rate || audio.sample_rate || 48000)) + 0.002;
    if (expectedAudioDuration > 0 && Math.abs(actualAudioDuration - expectedAudioDuration) > audioTolerance) {
      errors.push(`audio duration ${actualAudioDuration.toFixed(6)}s != source ${expectedAudioDuration.toFixed(6)}s`);
    }
  }
  if (sourceMedia.audioSidecar && audio) {
    if (Number(audio.sample_rate) !== Number(sourceMedia.audioSidecar.sampleRate)) {
      errors.push(`audio sample rate ${audio.sample_rate || 0} != ${sourceMedia.audioSidecar.sampleRate}`);
    }
    if (Number(audio.channels) !== Number(sourceMedia.audioSidecar.channelCount)) {
      errors.push(`audio channels ${audio.channels || 0} != ${sourceMedia.audioSidecar.channelCount}`);
    }
    const audioStart = Number(audio.start_time || 0);
    const audioEnd = audioStart + streamDuration(audio);
    const expectedEnd = Number(sourceMedia.audioSidecar.finalPresentationTimeUs) / 1e6;
    const packetTolerance = 1024 / Number(sourceMedia.audioSidecar.sampleRate) + 0.002;
    if (Math.abs(audioStart) > 1 / Number(sourceMedia.audioSidecar.sampleRate) + 0.000001) {
      errors.push(`audio starts at ${audioStart.toFixed(6)}s instead of zero`);
    }
    if (!Number.isFinite(audioEnd) || Math.abs(audioEnd - expectedEnd) > packetTolerance) {
      errors.push(`audio coverage ${audioEnd.toFixed(6)}s != ${expectedEnd.toFixed(6)}s`);
    }
  }
  if (errors.length) throw new Error(`Delivery contract failed: ${errors.join('; ')}`);

  const sensorTimeline = await validateSensorTimeline(filePath, sourceMedia, capabilities);
  const cameraAudioIntegrity = await validateCameraAudioPackets(filePath, sourceMedia, capabilities);

  await execFileAsync(capabilities.ffmpegPath, [
    '-hide_banner', '-v', 'error', '-xerror', '-err_detect', 'explode', '-i', filePath,
    '-map', '0:v:0', '-map', '0:a?', '-f', 'null', process.platform === 'win32' ? 'NUL' : '/dev/null'
  ], { windowsHide: true, timeout: 12 * 60 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 });

  return {
    passed: true,
    fullDecode: true,
    codec: video.codec_name,
    pixelFormat: video.pix_fmt,
    bitDepth,
    width: Number(video.width),
    height: Number(video.height),
    duration,
    decodedFrames: decodedFrames || null,
    timing: sensorTimeline || {
      authority: sourceMedia.timingAuthority || 'container',
      frameCount: decodedFrames || null,
      strictlyMonotonic: null
    },
    audio: audio ? {
      codec: audio.codec_name,
      channels: Number(audio.channels || 0),
      sampleRate: Number(audio.sample_rate || 0),
      startTime: Number(audio.start_time || 0),
      duration: streamDuration(audio),
      coverageEnd: Number(audio.start_time || 0) + streamDuration(audio),
      integrity: cameraAudioIntegrity
    } : null,
    color: {
      primaries: video.color_primaries || null,
      transfer: video.color_transfer || null,
      matrix: video.color_space || null,
      range: range.value || null,
      rangeAuthority: range.authority,
      hdrMetadata,
      proprietaryDelivery,
      proprietaryLog
    },
    lossless: profile.codecLossless ? {
      codecLossless: true,
      scope: profile.losslessScope || null,
      chromaSampling: profile.chroma ? profile.chroma.split('').join(':') : null,
      chromaPreserving: Boolean(profile.chromaPreserving),
      resolvedEncoder: profile.resolvedEncoder || profile.encoder
    } : { codecLossless: false }
  };
}

async function validateDngSequence(directory, sourceMedia, sequence) {
  const entries = await fs.promises.readdir(directory);
  const frames = entries.filter(name => /^frame_\d{6}\.dng$/i.test(name)).sort();
  if (!frames.length || frames.length !== sequence.frames) throw new Error('CinemaDNG validation failed: sequence frame count mismatch');
  if (sourceMedia.frames && frames.length !== sourceMedia.frames) throw new Error(`CinemaDNG validation failed: expected ${sourceMedia.frames}, found ${frames.length}`);
  for (const name of [frames[0], frames[frames.length - 1]]) {
    const handle = await fs.promises.open(path.join(directory, name), 'r');
    try {
      const prefix = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
      const inspected = inspectDngHeader(prefix.subarray(0, bytesRead));
      if (inspected.width !== sourceMedia.width || inspected.height !== sourceMedia.height || inspected.photometric !== 32803) {
        throw new Error(`CinemaDNG validation failed for ${name}`);
      }
    } finally {
      await handle.close();
    }
  }
  return {
    passed: true,
    identityMosaic: true,
    frames: frames.length,
    width: sourceMedia.width,
    height: sourceMedia.height,
    sequenceSha256: sequence.sequenceSha256
  };
}

module.exports = {
  expectedContract, expectedHdrMetadata, inspectHdrMetadata, validateHdrMetadata,
  validateProprietaryDeliveryMetadata, validateNeoLogSignaling,
  detectedBitDepth, rationalSeconds, streamDuration, effectiveColorRange,
  validateSensorTimeline, validateCameraAudioPackets, validateVideo, validateDngSequence
};
