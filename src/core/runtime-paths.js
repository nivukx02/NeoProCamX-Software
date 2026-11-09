'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function executableCandidates(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'ffmpeg', exe));
  candidates.push(path.resolve(__dirname, '..', '..', 'vendor', 'ffmpeg', exe));
  return candidates;
}

function resolveExecutable(name) {
  const local = executableCandidates(name).find(candidate => fs.existsSync(candidate));
  if (local) return local;
  try {
    const locator = process.platform === 'win32' ? 'where.exe' : 'which';
    const output = execFileSync(locator, [name], { encoding: 'utf8', windowsHide: true });
    return output.split(/\r?\n/).map(v => v.trim()).find(Boolean) || null;
  } catch {
    return null;
  }
}

function defaultOutputDirectory() {
  const videos = path.join(os.homedir(), 'Videos');
  return path.join(fs.existsSync(videos) ? videos : os.homedir(), 'CamX Studio');
}

function tempDirectory() {
  return path.join(os.tmpdir(), 'CamX-Studio');
}

function resolveAiRuntime() {
  const roots = [];
  if (process.resourcesPath) roots.push(path.join(process.resourcesPath, 'ai'));
  roots.push(path.resolve(__dirname, '..', '..', 'vendor', 'ai'));
  for (const root of roots) {
    const workerPath = path.join(root, process.platform === 'win32' ? 'camx-ai.exe' : 'camx-ai');
    const modelPath = path.join(root, 'models', 'enhancement_denoise.tflite');
    const onnxModelPath = path.join(root, 'models', 'enhancement_denoise.onnx');
    if (fs.existsSync(workerPath) && fs.existsSync(modelPath)) {
      return { workerPath, modelPath, onnxModelPath: fs.existsSync(onnxModelPath) ? onnxModelPath : null };
    }
  }
  return { workerPath: null, modelPath: null, onnxModelPath: null };
}

module.exports = { resolveExecutable, resolveAiRuntime, defaultOutputDirectory, tempDirectory };
