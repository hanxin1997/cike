'use strict';
/**
 * Preload: minimal bridge. The renderer talks to the Local API over HTTP;
 * only connection info and a few native actions cross the bridge.
 */
const { contextBridge, ipcRenderer } = require('electron');

const connection = ipcRenderer.sendSync('connection-info');
contextBridge.exposeInMainWorld('lfb', {
  apiBase: connection.apiBase || '',
  token: connection.token || '',
  paths: connection.paths || {},
  platform: connection.platform || '',
  packaged: connection.packaged === true,
  readProxyClipboard: () => ipcRenderer.invoke('proxy-clipboard'),
  chromiumStatus: () => ipcRenderer.invoke('chromium-status'),
  chromiumDownload: () => ipcRenderer.invoke('chromium-download'),
  onChromiumProgress: (cb) => {
    const listener = (_event, progress) => cb(progress);
    ipcRenderer.on('chromium-download-progress', listener);
    return () => ipcRenderer.removeListener('chromium-download-progress', listener);
  },
  openDataDir: () => ipcRenderer.invoke('open-data-dir'),
  checkUpdate: () => ipcRenderer.invoke('update-check'),
  installUpdate: () => ipcRenderer.invoke('update-install'),
  onUpdateProgress: (cb) => {
    const listener = (_event, progress) => cb(progress);
    ipcRenderer.on('update-progress', listener);
    return () => ipcRenderer.removeListener('update-progress', listener);
  },
});
