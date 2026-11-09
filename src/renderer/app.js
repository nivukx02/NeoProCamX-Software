'use strict';

const state = {
  sources: [], jobs: [], phoneFiles: [], selectedPhoneIds: new Set(), capabilities: null,
  catalog: null, outputDirectory: '', mode: 'sdr', deliveryId: 'rec709-sdr', chroma: '444',
  transportId: 'ffv1rgb16', rawProfileId: 'cinemadng-sequence', profileId: 'rec709-sdr-ffv1rgb16',
  quality: 'maximum', executionMode: 'gpu-auto', logVariant: 'base', aiEnhance: true,
  mfsrEnhance: true, setupTab: 'output', phoneFilter: 'conversion', scanning: false, detectingPhone: false,
  importingPhone: false, phoneDevices: [], phoneDeviceSignature: '', phoneInventorySignature: '', phoneWarning: '',
  importedPhoneIds: new Set(), phonePollTimer: null, previewRequestId: null,
  selectedSourceIndex: null, contextSourceIndex: null, renderWizardOpen: false
};

const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));

function formatBytes(bytes) {
  if (!Number.isFinite(Number(bytes)) || bytes <= 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const tier = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** tier).toFixed(tier > 1 ? 1 : 0)} ${units[tier]}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(Number(seconds)) || seconds <= 0) return '-';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function selectedDelivery() {
  return state.catalog?.deliveries.find(item => item.id === state.deliveryId) || null;
}

function selectedTransport() {
  return state.catalog?.transports.find(item => item.id === state.transportId) || null;
}

function selectedSource() {
  const media = state.sources[state.selectedSourceIndex];
  return media?.supported && !media.error ? media : null;
}

function selectedRenderSource() {
  const media = selectedSource();
  return media && media.conversionEligible !== false && media.libraryKind !== 'saved' ? media : null;
}

function isRenderedMode() { return state.mode !== 'raw'; }
function supportsAi() { return isRenderedMode(); }
function supportsMfsr() { return isRenderedMode(); }

function sourceAllowsMode(mode, source = selectedSource()) {
  return !source || source.raw || mode === 'sdr';
}

function configurationError() {
  const source = selectedSource();
  if (source && !selectedRenderSource()) return 'Saved videos are preview-only. Select a Cinema Cam conversion master.';
  if (state.mode === 'raw') {
    const compatible = source?.raw && (state.rawProfileId !== 'cinemadng-sequence' || ['npv10', 'npraw'].includes(source.kind));
    return compatible ? null : state.rawProfileId === 'cinemadng-sequence'
      ? 'CinemaDNG requires a CamX NPV10 RAW or NPRAW source.'
      : 'RAW Preserve requires a RAW source.';
  }
  const transport = selectedTransport();
  const delivery = selectedDelivery();
  if (!delivery || !transport) return 'Choose a valid delivery and codec.';
  if (!sourceAllowsMode(state.mode, source) || (!source?.raw && delivery.family !== 'sdr')) {
    return 'SDR sources can only use the SDR to SDR conversion route.';
  }
  if (state.executionMode === 'gpu-encode' &&
      (!state.capabilities?.preferredLosslessGpuEncoder || transport.id !== 'lossless420')) {
    return 'Strict lossless GPU encode requires 4:2:0 and an NVENC adapter that passed pixel round-trip verification.';
  }
  return null;
}

function rebuildProfileSelection() {
  if (state.mode === 'raw') state.profileId = state.rawProfileId;
  else state.profileId = `${state.deliveryId}-${state.transportId}`;
}

function deliveryDescription(delivery) {
  return {
    'rec709-sdr': 'Universal reference display',
    'display-p3-sdr': 'Wide-gamut display master',
    'bt2020-sdr': 'Wide-gamut SDR archive',
    'ndr10-pq': 'CamX proprietary 5,000-nit PQ',
    'nivukx-pq': 'CamX proprietary 10,000-nit vision',
    neolog: 'Scene-referred ACEScg grading master'
  }[delivery.id] || 'Professional mastering output';
}

function deliveryBadge(delivery) {
  return {
    'rec709-sdr': '709', 'display-p3-sdr': 'P3', 'bt2020-sdr': '2020',
    'ndr10-pq': '5K', 'nivukx-pq': '10K', neolog: 'LOG'
  }[delivery.id] || 'OUT';
}

function transportDescription(transport) {
  if (transport.id === 'ffv1rgb16') return 'Pixel-lossless RGB / 16-bit';
  if (transport.id === 'r210') return 'Pixel-lossless uncompressed RGB / 10-bit';
  if (transport.id === 'v210') return 'Lossless codec after 4:2:2 sampling';
  if (transport.id === 'lossless420') return 'Lossless codec after 4:2:0 sampling';
  return transport.losslessScope || 'Professional mastering transport';
}

function showSetupTab(name) {
  const tabs = ['output', 'processing', 'render'];
  if (!tabs.includes(name)) return;
  state.setupTab = name;
  $$('[data-setup-step]').forEach(step => {
    const index = tabs.indexOf(step.dataset.setupStep);
    const activeIndex = tabs.indexOf(name);
    step.classList.toggle('active', index === activeIndex);
    step.classList.toggle('complete', index < activeIndex);
    if (index === activeIndex) step.setAttribute('aria-current', 'step');
    else step.removeAttribute('aria-current');
  });
  tabs.forEach(tab => {
    const panel = $(`#setup${tab[0].toUpperCase()}${tab.slice(1)}Panel`);
    const active = tab === name;
    panel.hidden = !active;
    panel.classList.toggle('active', active);
  });
  $('#setupStepReadout').textContent = `${name.toUpperCase()} ${tabs.indexOf(name) + 1}/3`;
}

function showGuideTab(name) {
  if (!['quick', 'detailed'].includes(name)) return;
  $$('[data-guide-tab]').forEach(button => {
    const active = button.dataset.guideTab === name;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  });
  $$('[data-guide-panel]').forEach(panel => {
    const active = panel.dataset.guidePanel === name;
    panel.hidden = !active;
    panel.classList.toggle('active', active);
  });
  $('.guide-scroll').scrollTop = 0;
}

function openGuide(name = 'quick') {
  showGuideTab(name);
  const dialog = $('#guideDialog');
  if (!dialog.open) dialog.showModal();
  requestAnimationFrame(() => $(`[data-guide-tab="${name}"]`)?.focus());
}

function advanceRenderWorkflow(name) {
  const tabs = ['output', 'processing', 'render'];
  const currentIndex = tabs.indexOf(state.setupTab);
  const targetIndex = tabs.indexOf(name);
  if (targetIndex < 0) return false;
  if (targetIndex > currentIndex) {
    const error = configurationError();
    if (error) {
      toast(error, true);
      return false;
    }
  }
  showSetupTab(name);
  return true;
}

function updateRenderLauncher() {
  const source = selectedSource();
  const renderSource = selectedRenderSource();
  const ready = Boolean(renderSource && state.outputDirectory && state.capabilities?.ready);
  const button = $('#titleRenderButton');
  button.disabled = !ready;
  button.classList.toggle('ready', ready);
  button.title = ready ? `Configure render for ${renderSource.name}` : source
    ? 'Saved videos are preview-only; select a Cinema Cam conversion master'
    : 'Select a Cinema Cam conversion master to configure Render';
  $('#previewRenderButton').disabled = !ready;
}

function openRenderWizard(index = state.selectedSourceIndex) {
  if (Number.isInteger(index)) state.selectedSourceIndex = index;
  if (!selectedRenderSource()) {
    toast(selectedSource()
      ? 'Saved videos cannot be converted. Select a Cinema Cam conversion master.'
      : 'Select a Cinema Cam conversion master before opening Render.', true);
    return;
  }
  hideSourceContextMenu();
  showView('workspace');
  state.renderWizardOpen = true;
  $('#renderBackdrop').classList.remove('hidden');
  $('#renderWizard').classList.remove('hidden');
  document.body.classList.add('render-open');
  $('#renderWizardTitle').textContent = `Render — ${selectedSource().name}`;
  renderConversionControls();
  showSetupTab('output');
  updateRenderSummary();
  requestAnimationFrame(() => $('#closeRenderButton').focus());
}

function closeRenderWizard() {
  state.renderWizardOpen = false;
  $('#renderBackdrop').classList.add('hidden');
  $('#renderWizard').classList.add('hidden');
  document.body.classList.remove('render-open');
  $('#titleRenderButton').focus();
}

function hideSourceContextMenu() {
  state.contextSourceIndex = null;
  $('#sourceContextMenu').classList.add('hidden');
}

function showSourceContextMenu(index, clientX, clientY) {
  const media = state.sources[index];
  if (!media?.supported || media.error) return;
  state.contextSourceIndex = index;
  state.selectedSourceIndex = index;
  renderSources();
  const menu = $('#sourceContextMenu');
  const renderAction = menu.querySelector('[data-context-action="render"]');
  if (renderAction) {
    const eligible = media.conversionEligible !== false && media.libraryKind !== 'saved';
    renderAction.disabled = !eligible;
    renderAction.title = eligible ? 'Configure this Cinema Cam master' : 'Saved videos are preview-only';
  }
  menu.classList.remove('hidden');
  const width = 230;
  const height = 126;
  menu.style.left = `${Math.max(8, Math.min(clientX, window.innerWidth - width - 8))}px`;
  menu.style.top = `${Math.max(52, Math.min(clientY, window.innerHeight - height - 8))}px`;
  menu.querySelector('button')?.focus();
}

function renderConversionControls() {
  if (!state.catalog) return;
  const source = selectedSource();
  if (!sourceAllowsMode(state.mode, source)) state.mode = 'sdr';
  const rendered = isRenderedMode();
  $('#renderedSettings').classList.toggle('hidden', !rendered);
  $('#rawSettings').classList.toggle('hidden', rendered);
  $('#processingControls').classList.toggle('hidden', !rendered);
  $('#rawProcessingNotice').classList.toggle('hidden', rendered);
  $('#executionGroup').classList.toggle('hidden', !rendered);
  $('#logVariantGroup').classList.toggle('hidden', state.mode !== 'log');

  $$('input[name="mode"]').forEach(input => {
    input.checked = input.value === state.mode;
    input.disabled = !sourceAllowsMode(input.value, source);
    input.closest('label')?.classList.toggle('disabled', input.disabled);
  });
  const deliveries = state.catalog.deliveries.filter(item => item.mode === state.mode);
  if (rendered && !deliveries.some(item => item.id === state.deliveryId)) state.deliveryId = deliveries[0]?.id || '';
  $('#deliveryOptions').innerHTML = deliveries.map(item => `<button type="button" class="delivery-card${item.id === state.deliveryId ? ' active' : ''}" data-delivery-id="${escapeHtml(item.id)}" aria-pressed="${item.id === state.deliveryId}">
    <span><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(deliveryDescription(item))}</small></span><b>${escapeHtml(deliveryBadge(item))}</b>
  </button>`).join('');

  $$('input[name="chroma"]').forEach(input => { input.checked = input.value === state.chroma; });
  const transports = state.catalog.transports.filter(item => item.chroma === state.chroma);
  if (rendered && !transports.some(item => item.id === state.transportId)) state.transportId = transports[0]?.id || '';
  $('#transportOptions').innerHTML = transports.map(item => `<button type="button" class="codec-card${item.id === state.transportId ? ' active' : ''}" data-transport-id="${escapeHtml(item.id)}" aria-pressed="${item.id === state.transportId}">
    <i aria-hidden="true"></i><span><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(transportDescription(item))}</small></span>${item.id === 'lossless420' && state.capabilities?.preferredLosslessGpuEncoder ? '<b>GPU VERIFIED</b>' : '<b>LOSSLESS</b>'}
  </button>`).join('');

  $('#rawProfileOptions').innerHTML = state.catalog.rawProfiles.map(item => `<label class="profile-option${item.id === state.rawProfileId ? ' active' : ''}">
    <input type="radio" name="rawProfile" value="${escapeHtml(item.id)}" ${item.id === state.rawProfileId ? 'checked' : ''}>
    <span><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.description)}</small></span><b>${item.id === 'cinemadng-sequence' ? 'DNG' : 'RAW'}</b>
  </label>`).join('');

  rebuildProfileSelection();
  const transport = selectedTransport();
  const delivery = selectedDelivery();
  if (rendered && transport && delivery) {
    const chroma = transport.chroma.split('').join(':');
    $('#formatContract').textContent = `${delivery.label} / ${chroma} / ${transport.bitDepth}-bit / ${transport.losslessScope}`;
  }
  updateAiControl();
  updateMfsrControl();
  updateExecutionControl();
  updateConversionNotice();
  updateRenderSummary();
  renderSources();
}

function toast(message, error = false) {
  const element = document.createElement('div');
  element.className = `toast${error ? ' error' : ''}`;
  element.textContent = message;
  $('#toastRegion').appendChild(element);
  setTimeout(() => element.remove(), error ? 8000 : 4200);
}

function showView(name) {
  if (name !== 'preview') $('#previewVideo')?.pause();
  hideSourceContextMenu();
  $$('.view').forEach(view => view.classList.toggle('active', view.id === `${name}View`));
  $$('.nav-item').forEach(button => {
    const active = button.dataset.view === name;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
}

function mediaCategory(item) {
  return item.raw || ['.npv10', '.npraw', '.dng', '.raw'].includes(String(item.extension || '').toLowerCase()) ? 'RAW' : 'SDR';
}

async function addSources(paths, { autoPreview = true } = {}) {
  const descriptors = (paths || []).map(value => typeof value === 'string' ? { filePath: value } : value)
    .filter(value => value?.filePath);
  const existing = new Set(state.sources.map(item => item.filePath.toLowerCase()));
  const fresh = descriptors.filter(item => !existing.has(item.filePath.toLowerCase()));
  if (!fresh.length) return [];
  $('#sourceSummary').textContent = 'Inspecting media...';
  const probed = await window.neoStudio.probeMedia(fresh.map(item => item.filePath));
  const metadata = new Map(fresh.map(item => [item.filePath.toLowerCase(), item]));
  const results = probed.map(item => {
    const descriptor = metadata.get(item.filePath.toLowerCase()) || {};
    return {
      ...item,
      ...(descriptor.libraryKind ? { libraryKind: descriptor.libraryKind } : {}),
      ...(typeof descriptor.conversionEligible === 'boolean' ? { conversionEligible: descriptor.conversionEligible } : {}),
      ...(descriptor.conversionKind ? { conversionKind: descriptor.conversionKind } : {})
    };
  });
  const firstNewOffset = results.findIndex(item => item.supported && !item.error);
  const firstNewIndex = firstNewOffset >= 0 ? state.sources.length + firstNewOffset : -1;
  state.sources.push(...results);
  renderSources();
  const failures = results.filter(item => item.error);
  if (failures.length) toast(`${failures.length} source${failures.length > 1 ? 's were' : ' was'} not supported.`, true);
  if (autoPreview && firstNewIndex >= 0) void previewSource(firstNewIndex);
  return results.filter(item => item.supported && !item.error);
}

function renderSources() {
  const list = $('#sourceList');
  const valid = state.sources.filter(item => item.supported && !item.error);
  if (!selectedSource()) state.selectedSourceIndex = null;
  const totalBytes = state.sources.reduce((sum, item) => sum + Number(item.size || 0), 0);
  const setupError = configurationError();
  updateRenderSummary();
  updateRenderLauncher();
  $('#sourceSummary').textContent = state.sources.length ? `${state.sources.length} clip${state.sources.length === 1 ? '' : 's'} / ${formatBytes(totalBytes)}` : 'No media loaded';
  const renderable = selectedRenderSource();
  $('#convertButton').disabled = !renderable || !state.outputDirectory || !state.capabilities?.ready || Boolean(setupError);
  $('#convertCount').textContent = !renderable ? 'Select source media' : setupError ? 'Resolve settings' : '1 output';
  updateConversionNotice();
  if (!state.sources.length) {
    list.className = 'source-list empty';
    list.innerHTML = '<div class="empty-state"><span>NO SOURCES</span><p>Add a video to begin.</p></div>';
    updateAiControl();
    updateMfsrControl();
    return;
  }
  list.className = 'source-list';
  list.innerHTML = state.sources.map((item, index) => {
    const format = item.error ? 'ERROR' : item.kind === 'npraw' ? 'NPRAW' : item.kind === 'npv10' ? item.payloadFormat : item.codec || item.container;
    const image = item.error ? 'Unreadable' : `${item.width || '-'} x ${item.height || '-'}<small>${item.bitDepth || '-'}-bit / ${item.fps ? Number(item.fps).toFixed(2).replace(/\.00$/, '') : '-'} fps</small>`;
    const category = item.error ? 'ERROR' : mediaCategory(item);
    const libraryBadge = item.libraryKind === 'saved' ? '<i class="source-lock-pill">PREVIEW ONLY</i>' :
      item.libraryKind === 'conversion' ? '<i class="source-lock-pill">CINEMA MASTER</i>' : '';
    const subtitle = item.error || (item.previewLut
      ? `NeoLog viewing LUT / SHA-256 ${item.previewLut.sha256.slice(0, 12)}`
      : item.warnings?.[0] || item.container || 'Media source');
    return `<div class="media-row${item.error ? ' error-row' : ''}${index === state.selectedSourceIndex ? ' selected' : ''}" data-select-index="${index}" tabindex="${item.error ? '-1' : '0'}">
      <div class="clip-cell"><span class="clip-glyph ${category.toLowerCase()}">${escapeHtml(category)}</span><div><div class="clip-title" title="${escapeHtml(item.filePath)}">${escapeHtml(item.name)}${libraryBadge}</div><div class="clip-subtitle">${escapeHtml(subtitle)}</div></div></div>
      <div class="data-cell">${escapeHtml(format)}<small>${item.raw ? 'Camera original' : escapeHtml(item.pixelFormat || '')}</small></div>
      <div class="data-cell">${image}</div>
      <div class="data-cell">${formatDuration(item.duration)}<small>${formatBytes(item.size)}</small></div>
      <div class="source-actions">${item.error ? '' : `<button class="preview-source" data-preview-index="${index}" title="Open in Preview">Preview</button>`}<button class="remove-source" data-remove-index="${index}" title="Remove" aria-label="Remove ${escapeHtml(item.name)}">&times;</button></div>
    </div>`;
  }).join('');
  updateAiControl();
  updateMfsrControl();
}

function renderJobs() {
  const markup = state.jobs.length ? state.jobs.map(job => {
    const progress = Math.round((job.progress || 0) * 100);
    const terminal = ['complete', 'failed', 'cancelled'].includes(job.state);
    const aiBadge = job.ai?.enabled ? '<span class="ai-badge">AI</span>' : '';
    const mfsrBadge = job.mfsr?.enabled ? '<span class="mfsr-badge">MFSR</span>' : '';
    const hardwareBadge = job.execution?.encode?.startsWith('GPU') ? '<span class="gpu-badge">GPU</span>' :
      job.state !== 'queued' ? '<span class="cpu-badge">CPU</span>' : '';
    const frames = job.expectedFrames ? `${Number(job.processedFrames || 0).toLocaleString()} / ${Number(job.expectedFrames).toLocaleString()} frames` : '';
    const fps = job.processingFps > 0 ? `${Number(job.processingFps).toFixed(1)} fps` : '';
    const elapsed = job.elapsedSeconds > 0 ? `${formatDuration(job.elapsedSeconds)} elapsed` : '';
    const eta = Number.isFinite(Number(job.etaSeconds)) && job.etaSeconds > 0 ? `${formatDuration(job.etaSeconds)} remaining` : '';
    const metrics = [job.progressStage || job.state, frames, fps, elapsed, eta].filter(Boolean).join(' • ');
    return `<div class="job-row" data-job-id="${job.id}">
      <div class="job-top"><span class="job-name" title="${escapeHtml(job.source)}">${escapeHtml(job.sourceName)}</span><span class="job-engine">${hardwareBadge}${mfsrBadge}${aiBadge}${escapeHtml(job.engine || job.profileId)}</span><span class="job-state ${job.state}">${escapeHtml(job.state.toUpperCase())}</span></div>
      <progress class="progress-track" max="100" value="${progress}">${progress}%</progress>
      <div class="job-meta"><span>${progress}% • ${escapeHtml(metrics)}</span><span class="job-actions">${job.state === 'running' || job.state === 'queued' ? '<button data-action="cancel">Cancel</button>' : ''}${job.state === 'complete' ? '<button data-action="reveal">Show file</button>' : ''}${terminal ? '<button data-action="remove">Remove</button>' : ''}</span></div>
      ${job.error ? `<div class="job-error">${escapeHtml(job.error)}</div>` : ''}
    </div>`;
  }).join('') : '';
  $('#queueFull').innerHTML = markup || '<div class="empty-state"><span>QUEUE EMPTY</span><p>Conversions will appear here.</p></div>';
  const active = state.jobs.filter(job => ['queued', 'running'].includes(job.state)).length;
  $('#queueBadge').textContent = active;
  $('#queueBadge').classList.toggle('hidden', active === 0);
}

function renderPhone() {
  const list = $('#phoneList');
  const counts = {
    total: state.phoneFiles.length,
    conversion: state.phoneFiles.filter(item => item.libraryKind === 'conversion').length,
    saved: state.phoneFiles.filter(item => item.libraryKind !== 'conversion').length
  };
  $('#phoneConversionCount').textContent = counts.conversion;
  $('#phoneSavedCount').textContent = counts.saved;
  $('#phoneBadge').textContent = counts.total || 'USB';
  $('#phoneBadge').classList.toggle('hidden', state.phoneDevices.length === 0 && counts.total === 0);
  $$('.phone-filter').forEach(button => button.classList.toggle('active', button.dataset.phoneFilter === state.phoneFilter));
  const indexed = state.phoneFiles.map((item, index) => ({ item, index }));
  const visible = indexed.filter(({ item }) => (item.libraryKind || 'saved') === state.phoneFilter);
  if (!visible.length) {
    list.className = 'phone-list empty';
    const storageUnavailable = state.phoneDevices.length > 0 && Boolean(state.phoneWarning);
    const emptyLabel = storageUnavailable ? 'PHONE STORAGE UNAVAILABLE' : state.phoneDevices.length ? (state.phoneFiles.length ? 'NO FILES IN CATEGORY' : 'NO CAMX PIPELINE MEDIA') : 'CONNECT A PHONE';
    const emptyHelp = state.phoneWarning || (state.phoneDevices.length ? (state.phoneFiles.length ? 'Choose the other media category.' : 'No CamX cinema-pipeline recordings or conversions were found.') : 'Unlock the phone and select File transfer / Android Auto. Only CamX pipeline media is shown.');
    list.innerHTML = `<div class="empty-state"><span>${emptyLabel}</span><p>${emptyHelp}</p></div>`;
  } else {
    list.className = 'phone-list';
    const groups = [state.phoneFilter];
    list.innerHTML = groups.map(category => {
      const rows = visible.filter(({ item }) => (item.libraryKind || 'saved') === category);
      if (!rows.length) return '';
      const label = category === 'conversion' ? 'CINEMA CAM CONVERSION MASTERS' : 'SAVED VIDEOS / PREVIEW ONLY';
      return `<div class="phone-group"><div class="phone-group-title"><span>${label}</span><b>${rows.length}</b></div>${rows.map(({ item, index }) => `<label class="phone-row">
        <input type="checkbox" data-phone-index="${index}" ${state.selectedPhoneIds.has(item.id) ? 'checked' : ''} ${state.importingPhone || state.importedPhoneIds.has(item.id) ? 'disabled' : ''}>
        <span class="phone-name"><strong>${escapeHtml(item.name)}</strong><small title="${escapeHtml(item.displayPath)}">${escapeHtml(item.displayPath)}</small></span>
        <span class="phone-tags"><i class="category-pill ${category}">${category === 'conversion' ? escapeHtml(String(item.conversionKind || item.category || 'MASTER').toUpperCase()) : 'SAVED'}</i>${state.importedPhoneIds.has(item.id) ? '<i class="downloaded-pill">IN LIBRARY</i>' : ''}</span>
        <span>${formatBytes(item.size)}</span>
      </label>`).join('')}</div>`;
    }).join('');
  }
  updatePhoneSelection();
}

function updatePhoneSelection() {
  const available = new Set(state.phoneFiles.map(item => item.id));
  state.selectedPhoneIds = new Set([...state.selectedPhoneIds].filter(id => available.has(id)));
  const count = state.selectedPhoneIds.size;
  const downloaded = state.phoneFiles.filter(item => state.importedPhoneIds.has(item.id)).length;
  $('#phoneSelection').textContent = count
    ? `${count} file${count === 1 ? '' : 's'} selected`
    : downloaded ? `${downloaded} downloaded clip${downloaded === 1 ? '' : 's'} available in the source list` : 'Select videos to download';
  $('#importPhoneButton').disabled = count === 0 || state.importingPhone;
  $('#importPhoneButton').textContent = state.importingPhone ? 'Downloading…' : 'Download to library';
}

function portableDeviceSignature(devices = []) {
  return devices.map(device => `${device.name || ''}|${device.path || ''}`).sort().join('\n');
}

function setPhoneConnection(kind, message) {
  $('#phoneConnection').className = `connection-chip ${kind}`;
  $('#phoneConnectionText').textContent = message;
}

async function scanPhone(options = {}) {
  const automatic = options?.automatic === true;
  if (state.scanning || state.importingPhone) return null;
  state.scanning = true;
  $('#scanPhoneButton').disabled = true;
  $('#scanPhoneButton').textContent = 'Scanning…';
  setPhoneConnection('scanning', 'Reading phone');
  $('#phoneStatus').textContent = 'Scanning connected phone...';
  try {
    const result = await window.neoStudio.scanPhone();
    state.phoneDevices = result.devices || [];
    state.phoneDeviceSignature = portableDeviceSignature(state.phoneDevices);
    state.phoneWarning = (result.warnings || []).join(' ');
    state.phoneInventorySignature = state.phoneWarning ? '' : state.phoneDeviceSignature;
    state.phoneFiles = result.files || [];
    const conversionCount = state.phoneFiles.filter(item => item.libraryKind === 'conversion').length;
    const savedCount = state.phoneFiles.filter(item => item.libraryKind !== 'conversion').length;
    if (state.phoneFilter === 'conversion' && conversionCount === 0 && savedCount > 0) state.phoneFilter = 'saved';
    if (state.phoneFilter === 'saved' && savedCount === 0 && conversionCount > 0) state.phoneFilter = 'conversion';
    const deviceLabel = state.phoneDevices.length === 1 ? state.phoneDevices[0].name : `${state.phoneDevices.length} phones`;
    $('#phoneStatus').textContent = state.phoneWarning || (state.phoneDevices.length ? `${deviceLabel} / ${state.phoneFiles.length} supported videos` : 'Waiting for a phone');
    const storageUnavailable = state.phoneDevices.length > 0 && Boolean(state.phoneWarning);
    setPhoneConnection(storageUnavailable ? 'waiting' : state.phoneDevices.length ? 'connected' : 'waiting',
      storageUnavailable ? 'Unlock / File transfer' : state.phoneDevices.length ? `${deviceLabel} connected` : 'Watching for USB');
    renderPhone();
    if (!automatic && result.warnings?.length) toast(result.warnings.join(' '), true);
    return result;
  } catch (error) {
    $('#phoneStatus').textContent = 'Scan failed';
    setPhoneConnection('error', 'USB scan failed');
    if (!automatic) toast(error.message, true);
    return null;
  } finally {
    state.scanning = false;
    $('#scanPhoneButton').disabled = false;
    $('#scanPhoneButton').textContent = 'Refresh';
    renderPhone();
  }
}

async function detectPhoneConnection({ initial = false } = {}) {
  if (state.detectingPhone || state.scanning || state.importingPhone) return;
  state.detectingPhone = true;
  try {
    const result = await window.neoStudio.detectPhone();
    const devices = result.devices || [];
    const nextSignature = portableDeviceSignature(devices);
    const previousSignature = state.phoneDeviceSignature;
    state.phoneDevices = devices;
    state.phoneDeviceSignature = nextSignature;
    if (!nextSignature) {
      state.phoneWarning = '';
      if (previousSignature || state.phoneFiles.length) {
        state.phoneFiles = [];
        state.selectedPhoneIds.clear();
        state.phoneInventorySignature = '';
        toast('Phone disconnected. Local downloaded clips remain in the source list.');
      }
      $('#phoneStatus').textContent = 'Waiting for a phone';
      setPhoneConnection('waiting', 'Watching for USB');
      renderPhone();
      return;
    }

    const deviceLabel = devices.length === 1 ? devices[0].name : `${devices.length} phones`;
    setPhoneConnection('connected', `${deviceLabel} connected`);
    const newlyConnected = !previousSignature || previousSignature !== nextSignature;
    if (newlyConnected || state.phoneInventorySignature !== nextSignature) {
      const inventory = await scanPhone({ automatic: true });
      if (inventory && newlyConnected) {
        if (inventory.warnings?.length) toast(`${deviceLabel} detected. Unlock it and enable USB File transfer to load videos.`, true);
        else if (inventory.files?.length) toast(`${deviceLabel} detected. Video inventory loaded automatically.`);
        else toast(`${deviceLabel} detected. No supported videos were found in shared storage.`);
      }
    }
  } catch {
    setPhoneConnection('error', 'USB discovery unavailable');
  } finally {
    state.detectingPhone = false;
  }
}

function schedulePhoneDetection(delay = 5000) {
  clearTimeout(state.phonePollTimer);
  state.phonePollTimer = setTimeout(async () => {
    await detectPhoneConnection();
    schedulePhoneDetection();
  }, delay);
}

function updateAiControl() {
  const toggle = $('#aiToggle');
  const supportedProfile = supportsAi();
  const ready = Boolean(state.capabilities?.ai?.ready);
  toggle.disabled = !ready || !supportedProfile;
  if (!ready) $('#aiStatus').textContent = 'Model unavailable';
  else if (!supportedProfile) $('#aiStatus').textContent = 'Not applied to this output';
  else $('#aiStatus').textContent = state.aiEnhance ? 'Verified model / texture protected' : 'Disabled';
}

function updateMfsrControl() {
  const toggle = $('#mfsrToggle');
  const supportedProfile = supportsMfsr();
  const ready = Boolean(state.capabilities?.mfsr?.ready);
  toggle.disabled = !ready || !supportedProfile;
  if (!ready) $('#mfsrStatus').textContent = 'Offline MFSR runtime unavailable';
  else if (!supportedProfile) $('#mfsrStatus').textContent = 'Bypassed for identity RAW output';
  else $('#mfsrStatus').textContent = state.mfsrEnhance ? 'Motion-aligned / ghost protected' : 'Disabled';
}

function updateExecutionControl() {
  const transport = selectedTransport();
  const gpuEligible = isRenderedMode() && transport?.id === 'lossless420' &&
    Boolean(state.capabilities?.preferredLosslessGpuEncoder);
  const gpuBackend = state.capabilities?.gpuEncoders?.find(item =>
    item.encoder === state.capabilities?.preferredLosslessGpuEncoder);
  const compute = state.capabilities?.compute;
  const continuum = compute?.continuum?.version;
  const computeLabel = compute?.ready
    ? `${continuum ? `${continuum} / ` : ''}${compute.engine} on ${compute.adapter}`
    : 'CPU reference kernels';
  const automatic = state.executionMode === 'gpu-auto';
  const gpuEncode = isRenderedMode() && gpuEligible && (automatic || state.executionMode === 'gpu-encode');
  const acceleratedStages = [compute?.ready ? 'GPU image pipeline' : null,
    gpuEligible ? `${gpuBackend?.label || 'GPU'} verified lossless encode` : null]
    .filter(Boolean);
  $('#gpuEngineDetail').textContent = acceleratedStages.length
    ? `${acceleratedStages.join(' + ')}; CPU fallback`
    : 'No validated GPU path; exact CPU fallback';
  $$('input[name="execution"]').forEach(input => { input.checked = input.value === state.executionMode; });
  if (!isRenderedMode()) {
    $('#executionNote').textContent = 'RAW identity output bypasses colour processing and video encoding.';
  } else if (automatic) {
    const encodeNote = gpuEncode
      ? `${gpuBackend?.label || state.capabilities.preferredLosslessGpuEncoder.toUpperCase()} handles runtime-proven lossless encoding.`
      : 'The selected lossless codec uses its exact CPU encoder; validated image processing remains on the GPU.';
    $('#executionNote').textContent = `${computeLabel}. ${encodeNote} No format or quality setting is changed.`;
  } else if (state.executionMode === 'gpu-encode') {
    $('#executionNote').textContent = gpuEligible
      ? `${state.capabilities.preferredLosslessGpuEncoder.toUpperCase()} lossless encode with ${computeLabel}. Unsupported stages retain exact CPU fallback.`
      : 'Strict lossless GPU encoding is unavailable. Maximum GPU still accelerates image processing and FFV1 preserves the output samples.';
  } else {
    $('#executionNote').textContent = `${computeLabel}; the selected professional codec retains its native encoder.`;
  }

  const aiActive = supportsAi() && state.aiEnhance && Boolean(state.capabilities?.ai?.ready);
  const stages = !isRenderedMode()
    ? [
        ['Read sensor original', 'I/O', 'io'],
        ['Identity write', 'I/O', 'io'],
        ['SHA-256 verification', 'CPU', 'cpu']
      ]
    : [
        ['Decode and source timing', 'CPU', 'cpu'],
        ['RAW development / registration', 'CPU', 'cpu'],
        ['MFSR / NIV99 / delivery graph', compute?.ready ? 'GPU RESIDENT' : 'CPU', compute?.ready ? 'gpu' : 'cpu'],
        ['Camera AI inference', aiActive ? (state.capabilities.ai.accelerated ? 'GPU' : 'CPU') : 'BYPASSED',
          aiActive ? (state.capabilities.ai.accelerated ? 'gpu' : 'cpu') : 'off'],
        ['Video encode', gpuEncode ? 'GPU' : 'CPU', gpuEncode ? 'gpu' : 'cpu'],
        ['Full decode validation', 'CPU', 'cpu']
      ];
  $('#resourcePlanMode').textContent = !isRenderedMode() ? 'IDENTITY' : automatic
    ? (compute?.ready || gpuEncode ? 'MAXIMUM GPU / AUTO' : 'CPU FALLBACK')
    : compute?.ready
      ? `${compute.backend?.toUpperCase() || 'GPU'} COMPUTE${state.capabilities?.ai?.accelerated ? ' + DIRECTML' : ''}`
      : state.executionMode === 'gpu-encode' ? `${gpuBackend?.label || 'GPU'} ENCODE` : 'CPU ENCODE';
  $('#stagePlan').innerHTML = stages.map(([label, owner, kind]) => `<div><span>${label}</span><b class="${kind}">${owner}</b></div>`).join('');
}

function updateRenderSummary() {
  const renderCount = selectedRenderSource() ? 1 : 0;
  $('#summaryCount').textContent = `${renderCount} CLIP${renderCount === 1 ? '' : 'S'}`;
  if (!isRenderedMode()) {
    const raw = state.catalog?.rawProfiles.find(item => item.id === state.rawProfileId);
    $('#summaryDelivery').textContent = raw?.label || 'RAW identity output';
    $('#summaryFormat').textContent = state.rawProfileId === 'cinemadng-sequence' ? 'CinemaDNG sequence / native CFA' : 'Verified bit-exact original';
    $('#summaryProcessing').textContent = 'Bypassed / sensor identity protected';
    $('#summaryEngine').textContent = 'I/O copy + SHA-256 verification';
    return;
  }
  const delivery = selectedDelivery();
  const transport = selectedTransport();
  const quality = { maximum: 'Maximum', production: 'Production', accelerated: 'Fast' }[state.quality] || state.quality;
  const processing = [quality, state.mfsrEnhance && state.capabilities?.mfsr?.ready ? 'MFSR' : null,
    supportsAi() && state.aiEnhance && state.capabilities?.ai?.ready ? 'Camera AI' : null].filter(Boolean);
  $('#summaryDelivery').textContent = delivery?.label || 'Choose delivery';
  $('#summaryFormat').textContent = transport
    ? `${transport.label} / ${transport.chroma.split('').join(':')} / ${transport.bitDepth}-bit`
    : 'Choose codec';
  $('#summaryProcessing').textContent = processing.join(' / ');
  const gpuBackend = state.capabilities?.gpuEncoders?.find(item =>
    item.encoder === state.capabilities?.preferredLosslessGpuEncoder);
  const compute = state.capabilities?.compute;
  const pieces = [compute?.ready
    ? `${compute.continuum?.version ? `${compute.continuum.version} / ` : ''}${compute.engine}`
    : 'CPU reference compute'];
  if (supportsAi() && state.aiEnhance && state.capabilities?.ai?.ready) pieces.push(state.capabilities.ai.engine);
  const gpuEncode = transport?.id === 'lossless420' && Boolean(state.capabilities?.preferredLosslessGpuEncoder) &&
    ['gpu-auto', 'gpu-encode'].includes(state.executionMode);
  pieces.push(gpuEncode
    ? `${gpuBackend?.label || state.capabilities?.preferredLosslessGpuEncoder?.toUpperCase() || 'GPU'} verified lossless encode`
    : state.executionMode === 'gpu-auto' ? 'lossless CPU codec fallback' : 'lossless CPU codec');
  $('#summaryEngine').textContent = pieces.join(' / ');
}

function updateConversionNotice() {
  const raw = state.sources.some(item => item.raw);
  const notice = $('#conversionNotice p');
  const family = selectedDelivery()?.family;
  if (state.mode === 'raw' && state.rawProfileId === 'cinemadng-sequence') notice.textContent = 'CinemaDNG writes original CFA samples without denoise, sharpening, white balance, MFSR or AI.';
  else if (state.mode === 'raw') notice.textContent = 'RAW Preserve performs a bit-exact copy and verifies SHA-256. No image processing is applied.';
  else if (['ndr', 'nivukx'].includes(family) && !raw) notice.textContent = 'PQ output cannot recreate highlight data absent from SDR input. RAW or genuine HDR is recommended.';
  else if (state.mode === 'log') notice.textContent = 'NeoLog uses the selected camera curve and includes a Rec.709 viewing LUT. Detail-safe AI is bounded to protect grading latitude.';
  else if (selectedTransport()?.id === 'lossless420') notice.textContent = 'The 4:2:0 samples are encoded losslessly. Chroma subsampling itself is not reversible, so use RGB 4:4:4 for full colour preservation.';
  else if (raw) notice.textContent = 'RAW input will be developed at 16-bit RGB precision before the selected colour and chroma contract is encoded.';
  else notice.textContent = 'The selected bit depth and chroma are validated after a full decode. Any mismatch fails the job; no silent downgrade is allowed.';
}

function selectMode(value) {
  if (!sourceAllowsMode(value)) {
    toast('This source is SDR. Only SDR to SDR conversion is available.', true);
    return;
  }
  state.mode = value;
  renderConversionControls();
}

function selectQuality(value) {
  state.quality = value;
  const notes = {
    maximum: '8-frame offline MFSR, maximum precision and frequent AI analysis.',
    production: '5-frame offline MFSR with balanced analysis and turnaround time.',
    accelerated: '3-frame offline MFSR with reduced analysis latency. Encode hardware is controlled separately.'
  };
  $('#qualityNote').textContent = notes[value];
  updateRenderSummary();
}

async function startConversion() {
  if (selectedSource() && !selectedRenderSource()) {
    toast('Saved videos are preview-only. Choose a Cinema Cam conversion master.', true);
    return;
  }
  let inputs = selectedRenderSource() ? [selectedRenderSource()] : [];
  if (state.mode === 'raw') {
    const compatible = inputs.filter(item => item.raw &&
      (state.rawProfileId !== 'cinemadng-sequence' || ['npv10', 'npraw'].includes(item.kind)));
    if (compatible.length !== inputs.length) toast(`${inputs.length - compatible.length} non-RAW source${inputs.length - compatible.length === 1 ? ' was' : 's were'} excluded from RAW identity output.`, true);
    inputs = compatible;
  }
  if (!inputs.length) {
    toast(state.mode === 'raw' ? 'Add a compatible RAW source for this identity output.' : 'Add a supported source first.', true);
    return;
  }
  const invalid = configurationError();
  if (invalid) { toast(invalid, true); return; }
  $('#convertButton').disabled = true;
  try {
    const jobs = await window.neoStudio.startJobs({
      inputs, outputDirectory: state.outputDirectory, profileId: state.profileId,
      quality: state.quality, executionMode: state.mode === 'raw' ? null : state.executionMode,
      logVariant: state.logVariant,
      aiEnhance: state.aiEnhance && supportsAi(),
      mfsrEnhance: state.mfsrEnhance && Boolean(state.capabilities?.mfsr?.ready) && supportsMfsr()
    });
    for (const job of jobs) {
      const index = state.jobs.findIndex(existing => existing.id === job.id);
      if (index >= 0) state.jobs[index] = job; else state.jobs.push(job);
    }
    renderJobs();
    toast(`${jobs.length} conversion${jobs.length === 1 ? '' : 's'} added.`);
    closeRenderWizard();
    showView('queue');
  } catch (error) { toast(error.message, true); }
  finally { renderSources(); }
}

async function previewSource(index) {
  const media = state.sources[index];
  if (!media?.supported || media.error) return;
  const previousRequestId = state.previewRequestId;
  if (previousRequestId) void window.neoStudio.cancelPreview(previousRequestId).catch(() => {});
  state.selectedSourceIndex = index;
  hideSourceContextMenu();
  renderSources();
  showView('preview');
  const requestId = crypto.randomUUID();
  state.previewRequestId = requestId;
  $('#previewTitle').textContent = media.name;
  $('#previewFormatBadge').textContent = media.raw ? 'RAW SOURCE' : media.previewLut ? 'NEOLOG + LUT' : String(media.codec || media.container || 'SOURCE').toUpperCase();
  $('#previewMeta').textContent = `${media.width} x ${media.height} / ${media.bitDepth}-bit / ${Number(media.fps || 0).toFixed(2)} fps / ${formatDuration(media.duration)}${media.previewLut ? ' / verified companion viewing LUT' : ''}`;
  $('#previewStatus').textContent = 'Preparing a universally playable H.264 proxy...';
  $('#previewProgress').removeAttribute('value');
  $('#previewEmpty').classList.add('hidden');
  $('#previewLoading').classList.remove('hidden');
  const video = $('#previewVideo');
  video.pause();
  video.removeAttribute('src');
  video.load();
  video.classList.add('hidden');
  try {
    const result = await window.neoStudio.createPreview({ filePath: media.filePath, requestId });
    if (state.previewRequestId !== requestId) return;
    video.src = result.url;
    video.classList.remove('hidden');
    $('#previewLoading').classList.add('hidden');
    video.load();
    video.addEventListener('canplay', () => video.play().catch(() => {}), { once: true });
  } catch (error) {
    if (state.previewRequestId === requestId) {
      $('#previewStatus').textContent = 'Preview failed';
      $('#previewProgress').value = 0;
      toast(error.message, true);
    }
  }
}

function clearPreview() {
  const requestId = state.previewRequestId;
  state.previewRequestId = null;
  if (requestId) void window.neoStudio.cancelPreview(requestId).catch(() => {});
  const video = $('#previewVideo');
  video.pause();
  video.removeAttribute('src');
  video.load();
  video.classList.add('hidden');
  $('#previewLoading').classList.add('hidden');
  $('#previewEmpty').classList.remove('hidden');
  $('#previewTitle').textContent = 'No source selected';
  $('#previewFormatBadge').textContent = 'SOURCE';
  $('#previewMeta').textContent = 'No clip loaded';
}

function togglePreviewPlayback() {
  const video = $('#previewVideo');
  if (!video.src || video.classList.contains('hidden')) return;
  if (video.paused) video.play().catch(() => {});
  else video.pause();
}

function openSelectedPreview() {
  if (!selectedSource()) {
    toast('Select a supported video to open Preview.', true);
    showView('workspace');
    return;
  }
  const video = $('#previewVideo');
  if (!video.src) void previewSource(state.selectedSourceIndex);
  else {
    showView('preview');
    video.play().catch(() => {});
  }
}

function removeSource(index) {
  if (!Number.isInteger(index) || index < 0 || index >= state.sources.length) return;
  const removedSelected = index === state.selectedSourceIndex;
  state.sources.splice(index, 1);
  if (removedSelected) {
    state.selectedSourceIndex = null;
    clearPreview();
    showView('workspace');
  } else if (Number.isInteger(state.selectedSourceIndex) && state.selectedSourceIndex > index) {
    state.selectedSourceIndex -= 1;
  }
  renderSources();
}

function updateJob(incoming) {
  const index = state.jobs.findIndex(job => job.id === incoming.id);
  if (index >= 0) state.jobs[index] = incoming; else state.jobs.push(incoming);
  renderJobs();
  if (incoming.state === 'complete') toast(`${incoming.sourceName} is ready.`);
  if (incoming.state === 'failed') toast(`${incoming.sourceName} failed. Open Activity for details.`, true);
}

function renderSystemDetails(caps) {
  const details = [
    ['CPU', `${caps.cpuModel} (${caps.logicalCores} logical cores)`],
    ['GPU', caps.gpu?.map(item => `${item.name} / driver ${item.driver}`).join(', ') || 'Not reported'],
    ['Camera AI', caps.ai?.ready ? `${caps.ai.model} / ${caps.ai.engine}` : 'Unavailable'],
    ['AI model SHA-256', caps.ai?.modelSha256 || 'Not found'],
    ['Offline MFSR', caps.mfsr?.ready ? `${caps.mfsr.algorithm} / RGB48 / 3-8 frames` : `Unavailable${caps.mfsr?.error ? `: ${caps.mfsr.error}` : ''}`],
    ['GPU compute', caps.compute?.ready
      ? `${caps.compute.engine} / ${caps.compute.adapter} / parity ≤ ${caps.compute.maximumCodeDelta} RGB48 code`
      : `CPU fallback${caps.compute?.error ? `: ${caps.compute.error}` : ''}`],
    ['Continuum engine', caps.compute?.continuum?.version
      ? `${caps.compute.continuum.version} / persistent GPU resources / batched MFSR / resident temporal state`
      : 'Unavailable'],
    ['FFmpeg', caps.ffmpegVersion || 'Not found'],
    ['GPU encoders', caps.gpuEncoders?.length ? caps.gpuEncoders.map(item => `${item.label}${item.selected ? ' (selected)' : ''}`).join(' / ') : 'No compatible 10-bit HEVC hardware encoder'],
    ['Lossless GPU encode', caps.losslessGpuEncoding?.ready
      ? `${caps.losslessGpuEncoding.encoder} / decoded-frame SHA-256 verified`
      : `FFV1 exact fallback${caps.losslessGpuEncoding?.error ? ` / ${caps.losslessGpuEncoding.error}` : ''}`],
    ['Default execution', 'Maximum validated GPU processing / lossless codec fallback / no format downgrade'],
    ['CPU architecture', `${caps.architecture || 'unknown'} / ${formatBytes(caps.memoryBytes)} system memory`],
    ['Lossless CPU codec', caps.encoders?.ffv1 ? 'FFV1 v3 with per-slice CRC ready' : 'Unavailable'],
    ['Colour pipeline', [caps.filters?.zscale && 'zscale', caps.filters?.tonemap && 'tonemap', caps.filters?.vulkan && 'Vulkan', caps.filters?.opencl && 'OpenCL'].filter(Boolean).join(' / ') || 'Unavailable'],
    ['RAW develop', 'Defect repair / temporal fusion / edge-directed CFA / 16-bit RGB'],
    ['Delivery verification', 'Profile conformance / full decode / audio check / SHA-256 receipt']
  ];
  $('#systemDetails').innerHTML = details.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`).join('');
}

async function initialize() {
  $$('.nav-item').forEach(button => button.addEventListener('click', () => {
    if (state.renderWizardOpen) closeRenderWizard();
    if (button.dataset.view === 'preview') openSelectedPreview();
    else {
      showView(button.dataset.view);
      if (button.dataset.view === 'workspace') void detectPhoneConnection();
    }
  }));
  $$('[data-go]').forEach(button => button.addEventListener('click', () => showView(button.dataset.go)));
  $('#openPhoneButton').addEventListener('click', () => {
    $('#phonePanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    void scanPhone();
  });
  $('#scanPhoneButton').addEventListener('click', () => { void scanPhone(); });
  $('#addFilesButton').addEventListener('click', async () => addSources(await window.neoStudio.chooseInputs()));
  $('#clearSourcesButton').addEventListener('click', () => { state.sources = []; state.selectedSourceIndex = null; clearPreview(); renderSources(); });
  $('#sourceList').addEventListener('click', event => {
    const preview = event.target.closest('[data-preview-index]');
    if (preview) { previewSource(Number(preview.dataset.previewIndex)); return; }
    const remove = event.target.closest('[data-remove-index]');
    if (remove) { removeSource(Number(remove.dataset.removeIndex)); return; }
    const row = event.target.closest('[data-select-index]');
    if (row) previewSource(Number(row.dataset.selectIndex));
  });
  $('#sourceList').addEventListener('keydown', event => {
    const row = event.target.closest('[data-select-index]');
    if (row && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); previewSource(Number(row.dataset.selectIndex)); }
  });
  $('#sourceList').addEventListener('contextmenu', event => {
    const row = event.target.closest('[data-select-index]');
    if (!row || Number(row.dataset.selectIndex) < 0) return;
    event.preventDefault();
    showSourceContextMenu(Number(row.dataset.selectIndex), event.clientX, event.clientY);
  });
  $('#dropZone').addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') $('#addFilesButton').click(); });
  for (const name of ['dragenter', 'dragover']) $('#dropZone').addEventListener(name, event => { event.preventDefault(); $('#dropZone').classList.add('dragging'); });
  for (const name of ['dragleave', 'drop']) $('#dropZone').addEventListener(name, event => { event.preventDefault(); $('#dropZone').classList.remove('dragging'); });
  $('#dropZone').addEventListener('drop', event => addSources(window.neoStudio.pathsForFiles(event.dataTransfer.files)));
  $$('[data-setup-next]').forEach(button => button.addEventListener('click', () => advanceRenderWorkflow(button.dataset.setupNext)));
  $$('input[name="mode"]').forEach(input => input.addEventListener('change', () => selectMode(input.value)));
  $('#deliveryOptions').addEventListener('click', event => {
    const button = event.target.closest('[data-delivery-id]');
    if (!button) return;
    state.deliveryId = button.dataset.deliveryId;
    rebuildProfileSelection();
    renderConversionControls();
  });
  $$('input[name="chroma"]').forEach(input => input.addEventListener('change', () => {
    state.chroma = input.value;
    state.transportId = state.catalog.transports.find(item => item.chroma === state.chroma)?.id || '';
    renderConversionControls();
  }));
  $('#transportOptions').addEventListener('click', event => {
    const button = event.target.closest('[data-transport-id]');
    if (!button) return;
    state.transportId = button.dataset.transportId;
    rebuildProfileSelection();
    renderConversionControls();
  });
  $('#rawProfileOptions').addEventListener('change', event => {
    const input = event.target.closest('input[name="rawProfile"]');
    if (!input) return;
    state.rawProfileId = input.value;
    renderConversionControls();
  });
  $$('input[name="quality"]').forEach(input => input.addEventListener('change', () => selectQuality(input.value)));
  $$('input[name="execution"]').forEach(input => input.addEventListener('change', () => {
    state.executionMode = input.value;
    updateExecutionControl();
    updateRenderSummary();
    renderSources();
  }));
  $('#aiToggle').addEventListener('change', event => { state.aiEnhance = event.target.checked; updateAiControl(); updateRenderSummary(); });
  $('#mfsrToggle').addEventListener('change', event => { state.mfsrEnhance = event.target.checked; updateMfsrControl(); updateRenderSummary(); });
  $('#logVariant').addEventListener('change', event => { state.logVariant = event.target.value; updateRenderSummary(); });
  $('#outputButton').addEventListener('click', async () => {
    const selected = await window.neoStudio.chooseFolder(state.outputDirectory);
    if (selected) { state.outputDirectory = selected; $('#outputPath').textContent = selected; renderSources(); }
  });
  $('#convertButton').addEventListener('click', startConversion);
  $$('.phone-filter').forEach(button => button.addEventListener('click', () => { state.phoneFilter = button.dataset.phoneFilter; renderPhone(); }));
  $('#phoneList').addEventListener('change', event => {
    const input = event.target.closest('[data-phone-index]');
    if (!input) return;
    const item = state.phoneFiles[Number(input.dataset.phoneIndex)];
    if (input.checked) state.selectedPhoneIds.add(item.id); else state.selectedPhoneIds.delete(item.id);
    updatePhoneSelection();
  });
  $('#importPhoneButton').addEventListener('click', async () => {
    const selected = state.phoneFiles.filter(item => state.selectedPhoneIds.has(item.id));
    if (!selected.length) return;
    state.importingPhone = true;
    renderPhone();
    $('#phoneStatus').textContent = 'Downloading selected videos...';
    try {
      const result = await window.neoStudio.importPhoneFiles({ items: selected, destination: state.outputDirectory });
      await addSources(result.importedItems?.length ? result.importedItems : (result.imported || []), { autoPreview: false });
      selected.forEach(item => state.importedPhoneIds.add(item.id));
      state.selectedPhoneIds.clear();
      $('#phoneStatus').textContent = `Downloaded ${result.imported.length} file${result.imported.length === 1 ? '' : 's'} to the source list`;
      toast('Phone transfer complete. The clips are now in the existing source list.');
    } catch (error) { toast(error.message, true); $('#phoneStatus').textContent = 'Transfer failed'; }
    finally {
      state.importingPhone = false;
      const deviceLabel = state.phoneDevices.length === 1 ? state.phoneDevices[0].name : `${state.phoneDevices.length} phones`;
      setPhoneConnection(state.phoneDevices.length ? 'connected' : 'waiting', state.phoneDevices.length ? `${deviceLabel} connected` : 'Watching for USB');
      renderPhone();
    }
  });
  $('#queueFull').addEventListener('click', async event => {
    const action = event.target.dataset.action;
    const row = event.target.closest('[data-job-id]');
    if (!action || !row) return;
    const id = row.dataset.jobId;
    const job = state.jobs.find(item => item.id === id);
    if (action === 'cancel') await window.neoStudio.cancelJob(id);
    if (action === 'reveal' && job) await window.neoStudio.revealPath(job.outputPath);
    if (action === 'remove' && await window.neoStudio.removeJob(id)) { state.jobs = state.jobs.filter(item => item.id !== id); renderJobs(); }
  });
  $('#sourceContextMenu').addEventListener('click', event => {
    const button = event.target.closest('[data-context-action]');
    if (!button) return;
    const index = state.contextSourceIndex;
    const action = button.dataset.contextAction;
    hideSourceContextMenu();
    if (action === 'preview') previewSource(index);
    if (action === 'render') openRenderWizard(index);
    if (action === 'remove') removeSource(index);
  });
  document.addEventListener('pointerdown', event => {
    if (!event.target.closest('#sourceContextMenu')) hideSourceContextMenu();
  });
  window.addEventListener('resize', hideSourceContextMenu);
  $('#titleRenderButton').addEventListener('click', () => openRenderWizard());
  $('#previewRenderButton').addEventListener('click', () => openRenderWizard());
  $('#previewBackButton').addEventListener('click', () => showView('workspace'));
  $('#renderBackdrop').addEventListener('click', closeRenderWizard);
  $('#closeRenderButton').addEventListener('click', closeRenderWizard);
  $('#aboutButton').addEventListener('click', () => $('#systemDialog').showModal());
  $('#closeSystemDialog').addEventListener('click', () => $('#systemDialog').close());
  $('#guideButton').addEventListener('click', () => openGuide());
  $('#closeGuideDialog').addEventListener('click', () => $('#guideDialog').close());
  $$('[data-guide-tab]').forEach(button => button.addEventListener('click', () => showGuideTab(button.dataset.guideTab)));
  $('#guideDialog').addEventListener('keydown', event => {
    if (!event.target.matches('[data-guide-tab]') || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    showGuideTab(event.key === 'ArrowRight' ? 'detailed' : 'quick');
    $(`[data-guide-tab="${event.key === 'ArrowRight' ? 'detailed' : 'quick'}"]`).focus();
  });
  $('#guideStartButton').addEventListener('click', () => {
    $('#guideDialog').close();
    showView('workspace');
    requestAnimationFrame(() => $('#dropZone').focus());
  });
  document.addEventListener('keydown', event => {
    const editable = event.target.closest?.('input, select, textarea, [contenteditable="true"]');
    const modifier = event.ctrlKey || event.metaKey;
    const modalOpen = Boolean(document.querySelector('dialog[open]'));
    if (modalOpen && event.key !== 'Escape') return;
    if (modifier && event.key.toLowerCase() === 'o') {
      event.preventDefault();
      $('#addFilesButton').click();
    } else if (modifier && event.key.toLowerCase() === 'r') {
      event.preventDefault();
      openRenderWizard();
    } else if (modifier && ['1', '2', '3'].includes(event.key)) {
      event.preventDefault();
      const destination = { '1': 'workspace', '2': 'preview', '3': 'queue' }[event.key];
      if (destination === 'preview') openSelectedPreview(); else showView(destination);
    } else if (modifier && event.key === 'Enter' && state.renderWizardOpen) {
      event.preventDefault();
      if (state.setupTab === 'render' && !$('#convertButton').disabled) $('#convertButton').click();
    } else if (event.altKey && event.key === 'ArrowRight' && state.renderWizardOpen) {
      event.preventDefault();
      advanceRenderWorkflow(state.setupTab === 'output' ? 'processing' : 'render');
    } else if (event.altKey && event.key === 'ArrowLeft' && state.renderWizardOpen) {
      event.preventDefault();
      showSetupTab(state.setupTab === 'render' ? 'processing' : 'output');
    } else if (event.key === 'Escape') {
      hideSourceContextMenu();
      if (!modalOpen && state.renderWizardOpen) closeRenderWizard();
    } else if (event.key === 'Delete' && !editable && Number.isInteger(state.selectedSourceIndex)) {
      event.preventDefault();
      removeSource(state.selectedSourceIndex);
    } else if (event.key === ' ' && !editable) {
      event.preventDefault();
      if ($('#previewView').classList.contains('active')) togglePreviewPlayback();
      else if (selectedSource()) openSelectedPreview();
    } else if ((event.key === 'F1' || (modifier && event.key === '/')) && !editable) {
      event.preventDefault();
      openGuide();
    }
  });
  window.neoStudio.onQueueEvent(event => {
    if (event.type === 'removed') state.jobs = state.jobs.filter(job => job.id !== event.id);
    else if (event.job) updateJob(event.job);
    renderJobs();
  });
  window.neoStudio.onPhoneProgress(progress => {
    if (progress.state === 'copying' || progress.state === 'verifying') {
      const percent = Math.round((progress.overallRatio ?? progress.ratio ?? 0) * 100);
      const action = progress.state === 'verifying' ? 'Verifying' : 'Downloading';
      const speed = Number(progress.speedBytesPerSecond) > 0 ? `${formatBytes(progress.speedBytesPerSecond)}/s` : '';
      const eta = Number(progress.etaSeconds) > 0 ? `${formatDuration(progress.etaSeconds)} remaining` : '';
      const metrics = [speed, eta].filter(Boolean).join(' • ');
      $('#phoneStatus').textContent = `${action} ${progress.name} / ${percent}%${metrics ? ` • ${metrics}` : ''}`;
      setPhoneConnection('connected', progress.state === 'verifying' ? 'Checking SHA-256' : `USB File Transfer ${percent}%${speed ? ` • ${speed}` : ''}`);
    }
  });
  window.neoStudio.onPreviewProgress(progress => {
    if (!progress || progress.requestId !== state.previewRequestId) return;
    $('#previewStatus').textContent = progress.stage || 'Preparing preview';
    if (Number.isFinite(progress.ratio)) $('#previewProgress').value = Math.round(progress.ratio * 100);
    else $('#previewProgress').removeAttribute('value');
  });

  const [caps, catalog, output, jobs] = await Promise.all([
    window.neoStudio.capabilities(), window.neoStudio.conversionCatalog(), window.neoStudio.defaultOutput(), window.neoStudio.queueSnapshot()
  ]);
  state.capabilities = caps;
  state.executionMode = 'gpu-auto';
  state.catalog = catalog;
  state.outputDirectory = output;
  state.jobs = jobs;
  $('#outputPath').textContent = output;
  $('#cpuReadout').textContent = `${caps.cpuModel} / ${caps.logicalCores} threads`;
  $('#gpuReadout').textContent = caps.gpu?.map(item => item.name).join(', ') || 'No GPU reported';
  $('#titleStatus').textContent = caps.ready ? 'Ready' : 'Runtime missing';
  $('#titleDot').className = `status-dot ${caps.ready ? 'ready' : 'error'}`;
  renderSystemDetails(caps);
  selectQuality(state.quality);
  showSetupTab(state.setupTab);
  renderConversionControls();
  renderJobs();
  renderPhone();
  setTimeout(async () => {
    await detectPhoneConnection({ initial: true });
    schedulePhoneDetection();
  }, 350);
}

initialize().then(() => {
  document.body.dataset.appReady = 'true';
}).catch(error => {
  document.body.dataset.appError = error.message;
  toast(error.message, true);
});
