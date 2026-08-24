'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = Object.freeze({
  getState: 'dsh-update:get-state',
  confirm: 'dsh-update:confirm',
  retry: 'dsh-update:retry',
  cancel: 'dsh-update:cancel',
  openLog: 'dsh-update:open-log',
  state: 'dsh-update:state',
});

function createUpdateApi({ contextBridgeImpl = contextBridge, ipcRendererImpl = ipcRenderer } = {}) {
  const api = Object.freeze({
    getState: () => ipcRendererImpl.invoke(CHANNELS.getState),
    confirmUpdate: () => ipcRendererImpl.invoke(CHANNELS.confirm),
    retryUpdate: () => ipcRendererImpl.invoke(CHANNELS.retry),
    cancelUpdate: () => ipcRendererImpl.invoke(CHANNELS.cancel),
    openUpdateLog: () => ipcRendererImpl.invoke(CHANNELS.openLog),
    onStateChange: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, payload) => callback(payload);
      ipcRendererImpl.on(CHANNELS.state, listener);
      return () => {
        if (typeof ipcRendererImpl.removeListener === 'function') ipcRendererImpl.removeListener(CHANNELS.state, listener);
      };
    },
  });
  contextBridgeImpl.exposeInMainWorld('updateApi', api);
  return api;
}

if (contextBridge && ipcRenderer) createUpdateApi();

module.exports = { createUpdateApi, CHANNELS };
