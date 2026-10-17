// What the page may ask of the app: your game's files, picked with the system's dialog ([{ name, data }] or null);
// the app's version; the window fullscreen or not; quitting.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('stuntsHost', {
  pickGame: kind => ipcRenderer.invoke('pick-game', kind),   // ('folder' or 'zip')
  version: () => ipcRenderer.invoke('version'),
  fullscreen: on => ipcRenderer.invoke('fullscreen', on),   // (true, false or 'toggle')
  quit: () => ipcRenderer.invoke('quit'),
});
