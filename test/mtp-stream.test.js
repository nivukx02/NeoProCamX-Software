'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const windowsOnly = process.platform === 'win32' ? test : test.skip;

function psLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

windowsOnly('native MTP stream helper resumes at a chunk boundary and preserves bytes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camx-mtp-stream-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.bin');
  const target = path.join(root, 'target.partial');
  const payload = crypto.randomBytes(10 * 1024 * 1024 + 173);
  const resumeBytes = 4 * 1024 * 1024;
  fs.writeFileSync(source, payload);
  fs.writeFileSync(target, payload.subarray(0, resumeBytes));
  const helper = path.resolve(__dirname, '..', 'scripts', 'CamxMtpStream.cs');
  const command = [
    `Add-Type -Path ${psLiteral(helper)}`,
    `$r=[CamX.MtpStreamCopy]::Copy(${psLiteral(source)},${psLiteral(target)},${payload.length},${resumeBytes},4194304,$null)`,
    '$r | ConvertTo-Json -Compress'
  ].join('; ');
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command
  ], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.Bytes, payload.length);
  assert.equal(report.ResumedBytes, resumeBytes);
  assert.equal(report.Sha256, crypto.createHash('sha256').update(payload).digest('hex'));
  assert.deepEqual(fs.readFileSync(target), payload);
});

windowsOnly('native MTP stream helper fails closed when no Shell path exists', () => {
  const helper = path.resolve(__dirname, '..', 'scripts', 'CamxMtpStream.cs');
  const command = [
    `Add-Type -Path ${psLiteral(helper)}`,
    "try { [CamX.MtpStreamCopy]::Copy('', 'unused', 1, 0, 4194304, $null); exit 9 } catch { if ($_.Exception.ToString() -match 'CAMX_MTP_STREAM_UNAVAILABLE') { exit 0 }; Write-Error $_; exit 8 }"
  ].join('; ');
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command
  ], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

windowsOnly('MTP metadata restores an extension hidden by the Shell display label', () => {
  const portableScript = fs.readFileSync(
    path.resolve(__dirname, '..', 'scripts', 'portable-device.ps1'),
    'utf8'
  );
  const helperStart = portableScript.indexOf('function Get-ItemExtension');
  const helperEnd = portableScript.indexOf('function Get-PortableRoots');
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'portable metadata helpers are missing');
  const helpers = portableScript.slice(helperStart, helperEnd);
  const command = `${helpers}
$item = [pscustomobject]@{
  Name = 'CamX 06092026'
  IsFolder = $false
  ShellProperties = @{
    'System.FileExtension' = '.mov'
    'System.ItemType' = '.mov'
    'System.FileName' = 'CamX 06092026.mov'
  }
}
$item | Add-Member -MemberType ScriptMethod -Name ExtendedProperty -Value {
  param([string]$propertyName)
  return $this.ShellProperties[$propertyName]
}
[pscustomobject]@{
  Extension = Get-ItemExtension $item
  FileName = Get-ItemFileName $item
} | ConvertTo-Json -Compress
`;
  const encodedCommand = Buffer.from(command, 'utf16le').toString('base64');
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand
  ], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    Extension: '.mov',
    FileName: 'CamX 06092026.mov'
  });
});
