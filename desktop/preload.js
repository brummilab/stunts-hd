// What the page may ask of the app: your game's files, picked with the system's dialog ([{ name, data }] or null);
// the app's version; the window fullscreen or not.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('stuntsHost', {
  pickGame: () => ipcRenderer.invoke('pick-game'),
  version: () => ipcRenderer.invoke('version'),
  fullscreen: on => ipcRenderer.invoke('fullscreen', on),
});
