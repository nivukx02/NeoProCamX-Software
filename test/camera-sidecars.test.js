'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { crc32 } = require('../src/core/binary-formats');
const {
  parseDevelopColor, parseCameraMetadataSidecar, probeNpv10Audio,
  parseAudioSpecificConfig, adtsHeader, prepareConversionCompanions
} = require('../src/core/camera-sidecars');

function i32(value) { const b = Buffer.alloc(4); b.writeInt32BE(value); return b; }
function i64(value) { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(value)); return b; }
function f32(value) { const b = Buffer.alloc(4); b.writeFloatBE(value); return b; }
function utf(value) {
  const encoded = Buffer.from(value, 'utf8');
  const size = Buffer.alloc(2); size.writeUInt16BE(encoded.length);
  return Buffer.concat([size, encoded]);
}

test('camera develop-color v3 sidecar is CRC-validated and decoded', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-devcolor-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'clip.mov.devcolor');
  const body = Buffer.concat([
    Buffer.from('NEOVDEV1'), i32(3), i32(3840), i32(2160), i32(10), i32(30),
    f32(2), f32(1), f32(1), f32(1.5),
    ...[0.637, 0.145, 0.169, 0.263, 0.678, 0.059, 0, 0.028, 1.061].map(f32),
    f32(64), f32(5500), f32(0.02), i32(1), i32(2), utf('NIVUKX'), utf('FOCUSED_DETAIL'), i32(90)
  ]);
  const checksum = Buffer.alloc(8); checksum.writeBigUInt64BE(BigInt(crc32(body)));
  fs.writeFileSync(target, Buffer.concat([body, checksum]));
  const result = parseDevelopColor(target);
  assert.equal(result.width, 3840);
  assert.equal(result.colorSpace, 1);
  assert.equal(result.colorTransfer, 2);
  assert.equal(result.detailProfileTag, 'FOCUSED_DETAIL');
  assert.equal(result.orientation, 90);
});

test('camera professional metadata is schema and clip bound before color use', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-camera-metadata-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'CAMX_take.mov.metadata.json');
  fs.writeFileSync(target, JSON.stringify({
    schema: 'NeoProCamX.MediaSidecar.v1',
    file: 'CAMX_take.mov',
    workingSpace: 'ACEScg',
    colorStandard: 'BT2020',
    colorTransfer: 'ST2084',
    colorRange: 'LIMITED',
    masteringDisplay: { peakNits: 5000, minimumBlackNits: 0.0001 },
    description: 'hdrIntent=NDR10+;detailProfile=natural detail;snceSaturation=1.04'
  }));
  const metadata = parseCameraMetadataSidecar(target, 'CAMX_take.mov');
  assert.equal(metadata.colorTransfer, 'ST2084');
  assert.equal(metadata.masteringPeakNits, 5000);
  assert.equal(metadata.metadataValues.hdrintent, 'NDR10+');
  assert.equal(metadata.metadataValues.detailprofile, 'natural detail');
  assert.throws(() => parseCameraMetadataSidecar(target, 'CAMX_other.mov'), /does not identify this video/);
});

test('NPV10 AAC sidecar validates every packet/footer and stages ADTS plus exact PTS commands', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-npv10-audio-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const master = path.join(directory, 'clip.npv10');
  const target = `${master}.audio.npv10a`;
  const config = Buffer.from([0x11, 0x90]); // AAC-LC, 48 kHz, stereo
  const packets = [Buffer.from([1, 2, 3]), Buffer.from([4, 5])];
  const encodedPackets = packets.map((payload, index) => Buffer.concat([
    Buffer.from('AAC0'), i64(index * 21333), i32(0), i32(payload.length), i32(crc32(payload) | 0), payload
  ]));
  const header = Buffer.concat([
    Buffer.from([0x4e, 0x50, 0x56, 0x31, 0x30, 0x41, 0x31, 0x00]),
    i32(1), i32(48000), i32(2), i32(256000), i64(1_000_000_000), i32(config.length), config
  ]);
  const footer = Buffer.concat([Buffer.from('AEND'), i64(2), i64(42666), i64(5)]);
  fs.writeFileSync(target, Buffer.concat([header, ...encodedPackets, footer]));
  const audio = await probeNpv10Audio(master);
  assert.equal(audio.packetCount, 2);
  assert.equal(audio.crcValidated, true);
  assert.equal(audio.codecConfigSha256, require('node:crypto').createHash('sha256').update(config).digest('hex'));
  assert.equal(audio.payloadSha256, require('node:crypto').createHash('sha256').update(Buffer.concat(packets)).digest('hex'));
  assert.deepEqual(audio.packets.map(packet => packet.sha256), packets.map(packet =>
    require('node:crypto').createHash('sha256').update(packet).digest('hex')));
  assert.deepEqual(parseAudioSpecificConfig(config, 48000, 2), { profile: 1, frequencyIndex: 3, channelConfig: 2 });
  const adts = adtsHeader(3, { profile: 1, frequencyIndex: 3, channelConfig: 2 });
  assert.equal(adts.length, 7);
  assert.equal(((adts[3] & 3) << 11) | (adts[4] << 3) | (adts[5] >>> 5), 10);

  const job = { partialPath: path.join(directory, 'out.partial.mov'), media: { kind: 'npv10', audioSidecar: audio } };
  const temporary = await prepareConversionCompanions(job);
  assert.equal(temporary.length, 2);
  assert.equal(fs.readFileSync(job.media.audioInputPath).length, 7 + 3 + 7 + 2);
  assert.match(fs.readFileSync(job.media.audioTimelinePath, 'utf8'), /21333\/\(1000000\*TB\)/);
});

test('NPV10 and NPRAW companions map strictly increasing sensor timestamps to microseconds', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-npraw-time-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const kind of ['npv10', 'npraw']) {
    const job = {
      partialPath: path.join(directory, `${kind}.partial.mov`),
      media: { kind, fps: 30, timestamps: [10_000_000_000, 10_033_333_333, 10_070_000_000] }
    };
    await prepareConversionCompanions(job);
    const commands = fs.readFileSync(job.media.videoTimelinePath, 'utf8');
    assert.ok(commands.includes('0/(1000000*TB)'));
    assert.ok(commands.includes('33333/(1000000*TB)'));
    assert.ok(commands.includes('70000/(1000000*TB)'));
  }
});
