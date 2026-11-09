'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const subscribe = channel => listener => {
  const wrapped = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld('neoStudio', Object.freeze({
  capabilities: () => ipcRenderer.invoke('system:capabilities'),
  conversionCatalog: () => ipcRenderer.invoke('conversion:catalog'),
  defaultOutput: () => ipcRenderer.invoke('system:default-output'),
  chooseInputs: () => ipcRenderer.invoke('dialog:inputs'),
  pathsForFiles: files => Array.from(files || [], file => webUtils.getPathForFile(file)).filter(Boolean),
  chooseFolder: initialPath => ipcRenderer.invoke('dialog:folder', initialPath),
  probeMedia: paths => ipcRenderer.invoke('media:probe', paths),
  createPreview: request => ipcRenderer.invoke('media:preview', request),
  cancelPreview: requestId => ipcRenderer.invoke('media:preview-cancel', requestId),
  detectPhone: () => ipcRenderer.invoke('phone:devices'),
  scanPhone: () => ipcRenderer.invoke('phone:scan'),
  importPhoneFiles: request => ipcRenderer.invoke('phone:import', request),
  startJobs: request => ipcRenderer.invoke('queue:start', request),
  cancelJob: id => ipcRenderer.invoke('queue:cancel', id),
  removeJob: id => ipcRenderer.invoke('queue:remove', id),
  queueSnapshot: () => ipcRenderer.invoke('queue:snapshot'),
  revealPath: target => ipcRenderer.invoke('path:reveal', target),
  onQueueEvent: subscribe('queue:event'),
  onPreviewProgress: subscribe('preview:progress'),
  onPhoneProgress: subscribe('phone:progress')
}));
