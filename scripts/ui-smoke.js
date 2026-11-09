'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain } = require('electron');
const { CONVERSION_CATALOG } = require('../src/core/conversion-profiles');

const root = path.resolve(__dirname, '..');
const target = process.argv.find(value => value.toLowerCase().endsWith('.png')) || path.join(root, 'ui-camx.png');
const requestedMode = process.argv.find(value => value.startsWith('--mode='))?.slice('--mode='.length);
const requestedSetupArgument = process.argv.find(value => /^(?:--)?setup=/.test(value));
const requestedSetup = requestedSetupArgument?.replace(/^(?:--)?setup=/, '') ||
  ['processing', 'render'].find(step => path.basename(target).toLowerCase().includes(`-${step}`));
const requestedViewArgument = process.argv.find(value => /^(?:--)?view=/.test(value));
const requestedView = requestedViewArgument?.replace(/^(?:--)?view=/, '') ||
  (path.basename(target).toLowerCase().includes('-preview') ? 'preview' : null);
const requestedGuideArgument = process.argv.find(value => /^(?:--)?guide=/.test(value));
const requestedGuide = requestedGuideArgument?.replace(/^(?:--)?guide=/, '') ||
  (path.basename(target).toLowerCase().includes('-guide') ? 'detailed' : null);
const requestedWidth = Number(process.argv.find(value => value.startsWith('--width='))?.slice('--width='.length)) || 1500;
const requestedHeight = Number(process.argv.find(value => value.startsWith('--height='))?.slice('--height='.length)) || 940;
const sourcePath = path.join(root, '.camx-prores-test.mov');
const phoneImportPath = path.join(root, '.phone-imported-npraw.npraw');
// Use a RAW Cinema Cam source so the smoke contract can exercise every
// permitted output family. Separate queue tests enforce the SDR-only route.
const rawSource = true;
const phoneDevices = [{ name: 'CamX Test Phone', path: 'mtp://camx-test-phone' }];
const phoneFiles = [
  {
    id: 'CamX Test Phone::Internal storage/Documents/CamX/NEO_RADIANCE_RAW_001/stream.npraw',
    deviceName: 'CamX Test Phone', name: 'stream.npraw', extension: '.npraw',
    size: 1468006400, displayPath: 'CamX Test Phone\\Internal storage\\Documents\\CamX\\NEO_RADIANCE_RAW_001\\stream.npraw',
    segments: ['Internal storage', 'Documents', 'CamX', 'NEO_RADIANCE_RAW_001', 'stream.npraw'], category: 'raw',
    libraryKind: 'conversion', conversionEligible: true, conversionKind: 'npraw'
  },
  {
    id: 'CamX Test Phone::Internal storage/DCIM/CamX/CAMX_SAVED_001.mov',
    deviceName: 'CamX Test Phone', name: 'CAMX_SAVED_001.mov', extension: '.mov',
    size: 734003200, displayPath: 'CamX Test Phone\\Internal storage\\DCIM\\CamX\\CAMX_SAVED_001.mov',
    segments: ['Internal storage', 'DCIM', 'CamX', 'CAMX_SAVED_001.mov'], category: 'sdr',
    libraryKind: 'saved', conversionEligible: false, conversionKind: null
  }
];

app.disableHardwareAcceleration();
app.setPath('userData', path.join(root, '.profile-smoke'));

function mockMedia(filePath) {
  const isPrimarySource = filePath === sourcePath;
  const isPhoneRaw = filePath === phoneImportPath;
  const isRaw = (isPrimarySource && rawSource) || isPhoneRaw;
  return {
    filePath,
    name: isPhoneRaw ? 'stream.npraw' : isRaw ? 'CAMX_RAW_TAKE_001.npv10' : 'CAMX_MASTER_TAKE_001.mov',
    supported: true,
    raw: isRaw,
    kind: isPhoneRaw ? 'npraw' : isRaw ? 'npv10' : 'container',
    extension: isPhoneRaw ? '.npraw' : isRaw ? '.npv10' : '.mov',
    payloadFormat: isPhoneRaw ? 'RAW12_NPRAW_PACKED' : isRaw ? 'RAW12_NPV10_PACKED' : null,
    codec: isRaw ? 'rawvideo' : 'prores',
    container: isPhoneRaw ? 'NPRAW' : isRaw ? 'NPV10' : 'QuickTime / MOV',
    pixelFormat: isRaw ? 'bayer_rggb12' : 'yuv444p12le',
    width: 4096,
    height: 2160,
    bitDepth: 12,
    fps: 24,
    duration: 18.25,
    size: 734003200,
    warnings: []
  };
}

async function rendererContract(window) {
  return window.webContents.executeJavaScript(`(async () => {
    const waitFor = (predicate, label) => new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (predicate()) { clearInterval(timer); resolve(); }
        else if (Date.now() - started > 5000) { clearInterval(timer); reject(new Error(label)); }
      }, 25);
    });

    await waitFor(() => document.querySelector('#phoneConnection').classList.contains('connected') &&
      document.querySelector('#phoneConversionCount').textContent === '1' && document.querySelector('#phoneSavedCount').textContent === '1',
      'automatic phone discovery did not populate media');
    const autoPhone = {
      activeView: document.querySelector('.view.active')?.id,
      connection: document.querySelector('#phoneConnectionText').textContent,
      conversionCount: document.querySelector('#phoneConversionCount').textContent,
      savedCount: document.querySelector('#phoneSavedCount').textContent
    };

    const renderButton = document.querySelector('#titleRenderButton');
    const beforeSelection = {
      disabled: renderButton.disabled,
      ready: renderButton.classList.contains('ready'),
      drawerHidden: document.querySelector('#renderWizard').classList.contains('hidden')
    };

    document.querySelector('#addFilesButton').click();
    await waitFor(() => document.querySelector('.media-row.selected') && renderButton.classList.contains('ready'), 'source selection did not become render-ready');
    const afterSelection = {
      disabled: renderButton.disabled,
      ready: renderButton.classList.contains('ready'),
      activeView: document.querySelector('.view.active')?.id,
      activeNav: document.querySelector('.nav-item.active')?.dataset.view,
      previewTitle: document.querySelector('#previewTitle').textContent,
      selectedRows: document.querySelectorAll('.media-row.selected').length
    };

    const navStates = [];
    for (const view of ['workspace', 'preview', 'queue', 'workspace']) {
      document.querySelector('.nav-item[data-view="' + view + '"]').click();
      navStates.push({ view, activeView: document.querySelector('.view.active')?.id, current: document.querySelector('.nav-item[aria-current="page"]')?.dataset.view });
    }

    document.dispatchEvent(new KeyboardEvent('keydown', { key: '3', ctrlKey: true, bubbles: true }));
    const shortcutActivity = document.querySelector('.view.active')?.id;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', ctrlKey: true, bubbles: true }));
    const shortcutPhone = document.querySelector('.view.active')?.id;

    const row = document.querySelector('.media-row.selected');
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 320, clientY: 330 }));
    const menu = document.querySelector('#sourceContextMenu');
    const contextMenu = {
      visible: !menu.classList.contains('hidden'),
      actions: [...menu.querySelectorAll('[data-context-action]')].map(button => button.dataset.contextAction)
    };
    menu.querySelector('[data-context-action="render"]').click();
    const contextOpenedRender = !document.querySelector('#renderWizard').classList.contains('hidden') &&
      document.querySelector('.setup-tab.active')?.dataset.setupStep === 'output';
    document.querySelector('#closeRenderButton').click();
    renderButton.click();
    const titleOpenedRender = !document.querySelector('#renderWizard').classList.contains('hidden') &&
      document.querySelector('.setup-tab.active')?.dataset.setupStep === 'output';

    document.querySelector('input[name="mode"][value="hdr"]').click();
    const hdrDeliveries = [...document.querySelectorAll('[data-delivery-id]')].map(button => button.dataset.deliveryId);
    document.querySelector('[data-delivery-id="nivukx-pq"]').click();
    document.querySelector('input[name="chroma"][value="444"]').click();
    document.querySelector('[data-transport-id="ffv1rgb16"]').click();

    const stepStates = [];
    const recordStep = name => {
      const panel = document.querySelector('#setup' + name[0].toUpperCase() + name.slice(1) + 'Panel');
      stepStates.push({ name, active: document.querySelector('.setup-tab.active')?.dataset.setupStep, visible: !panel.hidden });
    };
    recordStep('output');
    document.querySelector('[data-setup-next="processing"]').click();
    recordStep('processing');
    document.querySelector('[data-setup-next="render"]').click();
    recordStep('render');
    document.querySelector('[data-setup-step="output"]').click();
    const passiveStep = document.querySelector('.setup-tab.active')?.dataset.setupStep;

    const selectedRender = {
      delivery: document.querySelector('#summaryDelivery').textContent,
      format: document.querySelector('#summaryFormat').textContent,
      engine: document.querySelector('#summaryEngine').textContent,
      executionMode: document.querySelector('input[name="execution"]:checked')?.value,
      automaticDetail: document.querySelector('#gpuEngineDetail').textContent,
      resourceMode: document.querySelector('#resourcePlanMode').textContent
    };

    document.querySelector('[data-setup-next="processing"]').click();
    document.querySelector('[data-setup-next="output"]').click();
    document.querySelector('input[name="mode"][value="raw"]').click();
    const rawInterface = {
      renderedHidden: document.querySelector('#renderedSettings').classList.contains('hidden'),
      rawHidden: document.querySelector('#rawSettings').classList.contains('hidden'),
      executionHidden: document.querySelector('#executionGroup').classList.contains('hidden')
    };
    document.querySelector('input[name="mode"][value="sdr"]').click();

    document.querySelector('.nav-item[data-view="workspace"]').click();
    await waitFor(() => document.querySelector('.phone-row [data-phone-index]'), 'Cinema Cam conversion media did not render');
    const sourceCountBeforePhoneImport = document.querySelectorAll('.media-row').length;
    const phoneTabs = [...document.querySelectorAll('.phone-filter')].map(button => button.dataset.phoneFilter);
    const conversionPhoneName = document.querySelector('.phone-row .phone-name strong')?.textContent;
    const phoneCheckbox = document.querySelector('.phone-row [data-phone-index]');
    phoneCheckbox.checked = true;
    phoneCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#importPhoneButton').click();
    await waitFor(() => document.querySelector('.downloaded-pill') &&
      document.querySelectorAll('.media-row').length === sourceCountBeforePhoneImport + 1,
      'phone import did not remain in Phone and enter the local library');
    const phoneImport = {
      activeView: document.querySelector('.view.active')?.id,
      sourceCountBefore: sourceCountBeforePhoneImport,
      sourceCountAfter: document.querySelectorAll('.media-row').length,
      downloadedBadge: document.querySelector('.downloaded-pill')?.textContent,
      selectionText: document.querySelector('#phoneSelection').textContent,
      conversionPhoneName,
      importedLibraryBadge: document.querySelector('.media-row:last-child .source-lock-pill')?.textContent,
      sourceNames: [...document.querySelectorAll('.media-row .clip-title')].map(item => item.childNodes[0]?.textContent)
    };
    document.querySelector('.phone-filter[data-phone-filter="saved"]').click();
    const savedPhoneName = document.querySelector('.phone-row .phone-name strong')?.textContent;
    document.querySelector('.phone-filter[data-phone-filter="conversion"]').click();

    const shortcutWatermarks = document.querySelectorAll('.titlebar kbd, .preview-header-actions kbd, #sourceContextMenu kbd').length;
    document.querySelector('#guideButton').click();
    const guideQuick = {
      open: document.querySelector('#guideDialog').open,
      selected: document.querySelector('[data-guide-tab="quick"]').getAttribute('aria-selected'),
      steps: document.querySelectorAll('#guideQuickPanel .guide-steps > li').length,
      title: document.querySelector('#guideTitle').textContent
    };
    document.querySelector('[data-guide-tab="detailed"]').click();
    const guideDetailed = {
      visible: !document.querySelector('#guideDetailedPanel').hidden,
      selected: document.querySelector('[data-guide-tab="detailed"]').getAttribute('aria-selected'),
      sections: document.querySelectorAll('#guideDetailedPanel .guide-section').length
    };
    document.querySelector('#closeGuideDialog').click();

    return {
      autoPhone,
      beforeSelection,
      afterSelection,
      navLabels: [...document.querySelectorAll('.title-nav .nav-item > span:first-child')].map(item => item.textContent),
      navStates,
      shortcutActivity,
      shortcutPhone,
      titleBarOwnsRender: renderButton.closest('.titlebar') !== null,
      topLeftWordmark: document.querySelector('.titlebar-leading > .wordmark') !== null,
      topRightWordmark: document.querySelector('.title-actions .wordmark') !== null,
      brandName: document.querySelector('.titlebar-leading > .wordmark .brand-name')?.textContent,
      contextMenu,
      contextOpenedRender,
      titleOpenedRender,
      stepStates,
      passiveStep,
      hdrDeliveries,
      selectedRender,
      rawInterface,
      phoneTabs,
      phoneImport,
      savedPhoneName,
      shortcutWatermarks,
      guideQuick,
      guideDetailed
    };
  })()`);
}

app.whenReady().then(async () => {
  ipcMain.handle('system:capabilities', () => ({
    ready: true,
    cpuModel: 'AMD Ryzen 7 Desktop Processor',
    logicalCores: 16,
    architecture: 'x64',
    memoryBytes: 34359738368,
    gpu: [{ name: 'AMD Radeon Graphics', driver: 'Verified' }],
    preferredGpuEncoder: 'hevc_amf',
    preferredLosslessGpuEncoder: null,
    losslessGpuEncoding: { ready: false, encoder: 'hevc_nvenc', error: 'No NVIDIA adapter' },
    gpuEncoders: [{ encoder: 'hevc_amf', label: 'AMD AMF', selected: true }],
    encoders: { libx265: true, ffv1: true, r210: true, v210: true },
    filters: { zscale: true, tonemap: true, vulkan: true, opencl: true },
    ai: { ready: true, accelerated: true, model: 'CamX Camera Enhancement Denoise', engine: 'ONNX Runtime DirectML', modelSha256: '64484177de04aa5d1ba3435ac3920bf366e58ec55ca2b1568f3258f51fd75c1c' },
    mfsr: { ready: true, algorithm: 'CAMX_OFFLINE_MFSR_V2', engine: 'WebGPU/WGSL Vulkan' },
    compute: { ready: true, version: 'CAMX-WGSL-COMPUTE-v1', engine: 'WebGPU/WGSL Vulkan', backend: 'Vulkan', adapter: 'AMD Radeon Graphics', maximumCodeDelta: 1, continuum: { version: 'NIVUKX-CONTINUUM-v1' } },
    ffmpegVersion: 'FFmpeg verified'
  }));
  ipcMain.handle('conversion:catalog', () => CONVERSION_CATALOG);
  ipcMain.handle('system:default-output', () => 'C:\\Users\\Creator\\Videos\\CamX Studio');
  ipcMain.handle('queue:snapshot', () => []);
  ipcMain.handle('dialog:inputs', () => [sourcePath]);
  ipcMain.handle('dialog:folder', (_event, initialPath) => initialPath);
  ipcMain.handle('media:probe', (_event, paths) => paths.map(mockMedia));
  ipcMain.handle('media:preview', (_event, request) => ({ url: pathToFileURL(sourcePath).href, filePath: request.filePath }));
  ipcMain.handle('phone:devices', () => ({ devices: phoneDevices, warnings: [] }));
  ipcMain.handle('phone:scan', () => ({ devices: phoneDevices, files: phoneFiles, warnings: [] }));
  ipcMain.handle('phone:import', () => ({
    imported: [phoneImportPath],
    importedItems: [{
      filePath: phoneImportPath,
      libraryKind: 'conversion',
      conversionEligible: true,
      conversionKind: 'npraw'
    }]
  }));

  const window = new BrowserWindow({
    width: requestedWidth,
    height: requestedHeight,
    show: false,
    backgroundColor: '#f5f6f8',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#ffffff', symbolColor: '#17191d', height: 54 },
    webPreferences: { preload: path.join(root, 'src', 'preload.js'), contextIsolation: true, sandbox: true }
  });
  await window.loadFile(path.join(root, 'src', 'renderer', 'index.html'));
  const initialized = await window.webContents.executeJavaScript(`new Promise(resolve => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (document.body.dataset.appReady === 'true') { clearInterval(timer); resolve({ ready: true }); }
      else if (document.body.dataset.appError) { clearInterval(timer); resolve({ ready: false, error: document.body.dataset.appError }); }
      else if (Date.now() - started > 10000) { clearInterval(timer); resolve({ ready: false, error: 'timeout' }); }
    }, 25);
  })`);
  if (!initialized.ready) throw new Error(`Renderer initialization failed: ${initialized.error}`);

  window.showInactive();
  const contract = await rendererContract(window);
  if (!contract.beforeSelection.disabled || contract.beforeSelection.ready || !contract.beforeSelection.drawerHidden) {
    throw new Error(`Render launcher enabled before source selection: ${JSON.stringify(contract.beforeSelection)}`);
  }
  if (contract.autoPhone.activeView !== 'workspaceView' || !contract.autoPhone.connection.includes('connected') ||
      contract.autoPhone.conversionCount !== '1' || contract.autoPhone.savedCount !== '1') {
    throw new Error(`Automatic USB phone contract failed: ${JSON.stringify(contract.autoPhone)}`);
  }
  if (contract.afterSelection.disabled || !contract.afterSelection.ready || contract.afterSelection.activeView !== 'previewView' ||
      contract.afterSelection.activeNav !== 'preview' || contract.afterSelection.selectedRows !== 1 || !contract.afterSelection.previewTitle.includes('CAMX_')) {
    throw new Error(`Selected-source preview/render contract failed: ${JSON.stringify(contract.afterSelection)}`);
  }
  if (contract.navLabels.join(',') !== 'Phone,Preview,Activity' ||
      contract.navStates.some(item => item.activeView !== `${item.view}View` || item.current !== item.view)) {
    throw new Error(`Title-bar navigation contract failed: ${JSON.stringify(contract.navStates)}`);
  }
  if (contract.shortcutActivity !== 'queueView' || contract.shortcutPhone !== 'workspaceView') {
    throw new Error(`Workspace shortcut contract failed: ${contract.shortcutActivity} / ${contract.shortcutPhone}`);
  }
  if (!contract.titleBarOwnsRender || !contract.topLeftWordmark || contract.topRightWordmark || contract.brandName !== 'CamX Studio' || !contract.contextMenu.visible ||
      contract.contextMenu.actions.join(',') !== 'preview,render,remove' || !contract.contextOpenedRender || !contract.titleOpenedRender) {
    throw new Error(`Professional shell/context contract failed: ${JSON.stringify(contract)}`);
  }
  if (contract.stepStates.some(item => item.active !== item.name || !item.visible) || contract.passiveStep !== 'render') {
    throw new Error(`Sequential Render workflow contract failed: ${JSON.stringify(contract.stepStates)} / passive=${contract.passiveStep}`);
  }
  if (contract.hdrDeliveries.join(',') !== 'ndr10-pq,nivukx-pq') {
    throw new Error(`Public CamX HDR contract failed: ${contract.hdrDeliveries.join(',')}`);
  }
  if (contract.selectedRender.delivery !== 'NIVUKX Vision PQ' || !contract.selectedRender.format.includes('FFV1 RGB 16-bit Lossless') ||
      contract.selectedRender.executionMode !== 'gpu-auto' || !contract.selectedRender.engine.includes('NIVUKX-CONTINUUM-v1') ||
      !contract.selectedRender.engine.includes('lossless CPU codec fallback') || !contract.selectedRender.automaticDetail.includes('GPU image pipeline') ||
      contract.selectedRender.resourceMode !== 'MAXIMUM GPU / AUTO') {
    throw new Error(`Selected-render summary contract failed: ${JSON.stringify(contract.selectedRender)}`);
  }
  if (!contract.rawInterface.renderedHidden || contract.rawInterface.rawHidden || !contract.rawInterface.executionHidden) {
    throw new Error(`RAW identity interface contract failed: ${JSON.stringify(contract.rawInterface)}`);
  }
  if (contract.phoneTabs.join(',') !== 'conversion,saved' || contract.phoneImport.activeView !== 'workspaceView' ||
      contract.phoneImport.sourceCountAfter !== contract.phoneImport.sourceCountBefore + 1 ||
      contract.phoneImport.downloadedBadge !== 'IN LIBRARY' || !contract.phoneImport.selectionText.includes('available in the source list') ||
      !contract.phoneImport.sourceNames.includes('stream.npraw') || contract.phoneImport.importedLibraryBadge !== 'CINEMA MASTER' ||
      contract.phoneImport.conversionPhoneName !== 'stream.npraw' || contract.savedPhoneName !== 'CAMX_SAVED_001.mov') {
    throw new Error(`Unified Phone/library contract failed: ${JSON.stringify({ tabs: contract.phoneTabs, phoneImport: contract.phoneImport, savedPhoneName: contract.savedPhoneName })}`);
  }
  if (contract.shortcutWatermarks !== 0 || !contract.guideQuick.open || contract.guideQuick.selected !== 'true' ||
      contract.guideQuick.steps !== 7 || contract.guideQuick.title !== 'How to use CamX Studio' ||
      !contract.guideDetailed.visible || contract.guideDetailed.selected !== 'true' || contract.guideDetailed.sections < 8) {
    throw new Error(`Guide/shortcut presentation contract failed: ${JSON.stringify({ shortcutWatermarks: contract.shortcutWatermarks, quick: contract.guideQuick, detailed: contract.guideDetailed })}`);
  }

  const finalState = await window.webContents.executeJavaScript(`(() => {
    const wizard = document.querySelector('#renderWizard');
    if (wizard.classList.contains('hidden')) document.querySelector('#titleRenderButton').click();
    const active = document.querySelector('.setup-tab.active')?.dataset.setupStep;
    if (active === 'render') document.querySelector('[data-setup-next="processing"]').click();
    if (document.querySelector('.setup-tab.active')?.dataset.setupStep === 'processing') document.querySelector('[data-setup-next="output"]').click();
    const requestedMode = ${JSON.stringify(requestedMode || null)};
    if (requestedMode) {
      const input = document.querySelector('input[name="mode"][value="' + requestedMode + '"]');
      if (!input) throw new Error('Unknown UI smoke mode: ' + requestedMode);
      input.click();
    }
    const requestedSetup = ${JSON.stringify(requestedSetup || null)};
    if (requestedSetup === 'processing' || requestedSetup === 'render') document.querySelector('[data-setup-next="processing"]').click();
    if (requestedSetup === 'render') document.querySelector('[data-setup-next="render"]').click();
    const requestedView = ${JSON.stringify(requestedView || null)};
    if (requestedView) {
      if (!wizard.classList.contains('hidden')) document.querySelector('#closeRenderButton').click();
      document.querySelector('.nav-item[data-view="' + requestedView + '"]').click();
    } else if (!requestedMode && !requestedSetup) {
      document.querySelector('#closeRenderButton').click();
      document.querySelector('.nav-item[data-view="workspace"]').click();
    }
    const requestedGuide = ${JSON.stringify(requestedGuide || null)};
    if (requestedGuide) {
      if (!wizard.classList.contains('hidden')) document.querySelector('#closeRenderButton').click();
      document.querySelector('#guideButton').click();
      if (requestedGuide === 'detailed') document.querySelector('[data-guide-tab="detailed"]').click();
    }
    return {
      activeView: document.querySelector('.view.active')?.id,
      activeNav: document.querySelector('.nav-item.active')?.dataset.view,
      renderOpen: !wizard.classList.contains('hidden'),
      backdropOpen: !document.querySelector('#renderBackdrop').classList.contains('hidden'),
      setup: document.querySelector('.setup-tab.active')?.dataset.setupStep,
      mode: document.querySelector('input[name="mode"]:checked')?.value,
      guideOpen: document.querySelector('#guideDialog').open,
      guideTab: document.querySelector('[data-guide-tab].active')?.dataset.guideTab,
      drawerPosition: getComputedStyle(wizard).position,
      drawerZ: getComputedStyle(wizard).zIndex,
      backdropZ: getComputedStyle(document.querySelector('#renderBackdrop')).zIndex,
      panelOpacity: getComputedStyle(document.querySelector('.setup-tab-panel.active')).opacity,
      nextBackground: getComputedStyle(document.querySelector('.setup-tab-panel.active .next-button') || document.querySelector('#convertButton')).backgroundColor,
      topElement: document.elementFromPoint(window.innerWidth - 120, 220)?.id || document.elementFromPoint(window.innerWidth - 120, 220)?.className
    };
  })()`);
  if (requestedView && (finalState.activeView !== `${requestedView}View` || finalState.activeNav !== requestedView || finalState.renderOpen)) {
    throw new Error(`Requested view did not activate cleanly: ${JSON.stringify(finalState)}`);
  }
  if (requestedSetup && (finalState.setup !== requestedSetup || !finalState.renderOpen || !finalState.backdropOpen)) {
    throw new Error(`Requested Render step did not activate: ${JSON.stringify(finalState)}`);
  }
  if (requestedMode && finalState.mode !== requestedMode) throw new Error(`Requested mode did not activate: ${JSON.stringify(finalState)}`);
  if (requestedGuide && (!finalState.guideOpen || finalState.guideTab !== requestedGuide)) {
    throw new Error(`Requested guide did not activate: ${JSON.stringify(finalState)}`);
  }
  if (finalState.renderOpen && (finalState.drawerPosition !== 'fixed' || Number(finalState.drawerZ) <= Number(finalState.backdropZ))) {
    throw new Error(`Render drawer stacking contract failed: ${JSON.stringify(finalState)}`);
  }
  window.webContents.invalidate();
  await new Promise(resolve => setTimeout(resolve, 300));
  const settledState = await window.webContents.executeJavaScript(`(() => ({
    drawerOpacity: getComputedStyle(document.querySelector('#renderWizard')).opacity,
    panelOpacity: getComputedStyle(document.querySelector('.setup-tab-panel.active')).opacity
  }))()`);
  if (settledState.drawerOpacity !== '1' || settledState.panelOpacity !== '1') {
    throw new Error(`Render animation did not settle: ${JSON.stringify(settledState)}`);
  }
  const image = await window.webContents.capturePage();
  fs.writeFileSync(target, image.toPNG());
  window.hide();
  process.stdout.write(`${JSON.stringify({ ready: true, target, contract: 'professional-shell-v1', finalState, settledState })}\n`);
  app.quit();
}).catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  app.exit(1);
});
