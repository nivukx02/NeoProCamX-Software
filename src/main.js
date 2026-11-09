'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, dialog, ipcMain, shell, powerSaveBlocker } = require('electron');
const { CapabilityService } = require('./core/capabilities');
const { MediaProbe } = require('./core/media-probe');
const { ConversionQueue } = require('./core/conversion-queue');
const { PreviewService } = require('./core/preview-service');
const { CONVERSION_CATALOG } = require('./core/conversion-profiles');
const { PortableDeviceService } = require('./core/portable-device');
const { defaultOutputDirectory } = require('./core/runtime-paths');
const { runBackgroundTask } = require('./core/background-task-runner');

const APP_USER_MODEL_ID = 'com.neoproc.camx.studio';

let mainWindow;
let renderPowerBlocker = null;
let capabilities;
let mediaProbe;
let conversionQueue;
let portableDevices;
let previewService;
let activePreviewRequestId = null;
const smokeTest = process.argv.includes('--smoke-test');
const ownsInstanceLock = smokeTest || app.requestSingleInstanceLock();

// Give every launch the same explicit Windows identity. Without this, an
// installed frameless Electron window can be omitted from the taskbar.
if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);

if (!ownsInstanceLock) app.quit();

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function presentMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  mainWindow.setSkipTaskbar(false);
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
  return true;
}

function createWindow(show = true) {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1120,
    minHeight: 720,
    show,
    backgroundColor: '#f4f5f7',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    title: 'CamX Studio',
    skipTaskbar: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#ffffff',
      symbolColor: '#17191d',
      height: 54
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.setSkipTaskbar(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  return mainWindow;
}

function handleQueueEvent(event) {
  send('queue:event', event);
  const rendering = conversionQueue?.snapshot().some(job => job.state === 'running');
  if (rendering && renderPowerBlocker === null) {
    renderPowerBlocker = powerSaveBlocker.start('prevent-app-suspension');
  } else if (!rendering && renderPowerBlocker !== null) {
    if (powerSaveBlocker.isStarted(renderPowerBlocker)) powerSaveBlocker.stop(renderPowerBlocker);
    renderPowerBlocker = null;
  }
}

function installIpc() {
  ipcMain.handle('system:capabilities', () => capabilities.detect());
  ipcMain.handle('conversion:catalog', () => CONVERSION_CATALOG);
  ipcMain.handle('system:default-output', () => defaultOutputDirectory());
  ipcMain.handle('dialog:inputs', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Add source media',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Supported media', extensions: ['mov', 'mp4', 'mkv', 'mxf', 'avi', 'webm', 'm4v', 'hevc', 'npv10', 'npraw', 'dng', 'raw', 'nivukx'] },
        { name: 'All files', extensions: ['*'] }
      ]
    });
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle('dialog:folder', async (_event, initialPath) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose delivery folder',
      defaultPath: initialPath || defaultOutputDirectory(),
      properties: ['openDirectory', 'createDirectory']
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('media:probe', async (_event, paths) => mediaProbe.probeMany(paths));
  ipcMain.handle('media:preview', async (_event, request) => {
    if (!request || typeof request.filePath !== 'string') throw new Error('Invalid preview request');
    const requestId = typeof request.requestId === 'string' && request.requestId ? request.requestId : crypto.randomUUID();
    activePreviewRequestId = requestId;
    previewService.cancelAllExcept(null);
    const media = await mediaProbe.probe(request.filePath);
    if (activePreviewRequestId !== requestId) throw new Error('Preview request superseded');
    const previewPath = await previewService.create(media, progress => send('preview:progress', {
      requestId,
      filePath: media.filePath,
      ...progress
    }), requestId);
    if (activePreviewRequestId !== requestId) throw new Error('Preview request superseded');
    return { url: pathToFileURL(previewPath).href, filePath: media.filePath };
  });
  ipcMain.handle('media:preview-cancel', (_event, requestId) => {
    if (typeof requestId !== 'string' || !requestId) return false;
    if (activePreviewRequestId === requestId) activePreviewRequestId = null;
    return previewService.cancel(requestId);
  });
  ipcMain.handle('phone:devices', async () => portableDevices.detectDevices());
  ipcMain.handle('phone:scan', async () => portableDevices.scan());
  ipcMain.handle('phone:import', async (_event, request) => {
    const result = await portableDevices.importFiles(request, progress => send('phone:progress', progress));
    return result;
  });
  ipcMain.handle('queue:start', async (_event, request) => conversionQueue.enqueue(request));
  ipcMain.handle('queue:cancel', (_event, id) => conversionQueue.cancel(id));
  ipcMain.handle('queue:remove', (_event, id) => conversionQueue.remove(id));
  ipcMain.handle('queue:snapshot', () => conversionQueue.snapshot());
  ipcMain.handle('path:reveal', async (_event, target) => {
    if (typeof target === 'string' && fs.existsSync(target)) shell.showItemInFolder(target);
  });
}

if (ownsInstanceLock && !smokeTest) {
  app.on('second-instance', () => {
    presentMainWindow();
  });
}

app.whenReady().then(async () => {
  if (!ownsInstanceLock) return;
  capabilities = new CapabilityService({ cacheDirectory: app.getPath('userData') });
  mediaProbe = new MediaProbe(capabilities);
  portableDevices = new PortableDeviceService({ allowDevelopmentCertificate: !app.isPackaged });
  conversionQueue = new ConversionQueue(capabilities, mediaProbe, handleQueueEvent);
  previewService = new PreviewService(capabilities);
  installIpc();
  if (smokeTest) {
    try {
      const caps = await capabilities.detect(true);
      if (!caps.ready) throw new Error('Packaged media runtime is not ready');
      if (!caps.ai?.ready) throw new Error(`Packaged AI runtime is not ready: ${caps.ai?.error || 'unknown error'}`);
      if (!caps.mfsr?.ready) throw new Error(`Packaged camera processing runtime is not ready: ${caps.mfsr?.error || 'unknown error'}`);
      const workerCheck = await runBackgroundTask('ping', {}, { timeoutMs: 10000 });
      if (!workerCheck?.ready || !workerCheck?.isolated) throw new Error('Packaged background media worker is not ready');
      const window = createWindow(false);
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Renderer launch timed out')), 30000);
        window.webContents.once('did-finish-load', () => { clearTimeout(timeout); resolve(); });
        window.webContents.once('did-fail-load', (_event, code, description) => { clearTimeout(timeout); reject(new Error(`Renderer failed to load (${code}): ${description}`)); });
      });
      const rendererState = await window.webContents.executeJavaScript(`new Promise(resolve => {
        const started = Date.now();
        const timer = setInterval(() => {
          if (document.body.dataset.appReady === 'true') {
            clearInterval(timer); resolve({ ready: true });
          } else if (document.body.dataset.appError) {
            clearInterval(timer); resolve({ ready: false, error: document.body.dataset.appError });
          } else if (Date.now() - started > 30000) {
            clearInterval(timer); resolve({ ready: false, error: 'renderer initialization timed out' });
          }
        }, 50);
      })`);
      if (!rendererState.ready) throw new Error(`Renderer or secure preload bridge did not initialize: ${rendererState.error || 'unknown error'}`);
      process.stdout.write(`${JSON.stringify({ ready: true, ffmpeg: caps.ffmpegVersion, ai: caps.ai.engine })}\n`);
      app.exit(0);
    } catch (error) {
      process.stderr.write(`${error.stack || error.message}\n`);
      app.exit(1);
    }
    return;
  }
  createWindow(true);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(true);
    else presentMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (renderPowerBlocker !== null && powerSaveBlocker.isStarted(renderPowerBlocker)) {
    powerSaveBlocker.stop(renderPowerBlocker);
    renderPowerBlocker = null;
  }
  conversionQueue?.shutdown();
  previewService?.shutdown();
});
