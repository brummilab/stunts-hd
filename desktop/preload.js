// What the page may ask of the app: your game's files, picked with the system's dialog ([{ name, data }] or null).
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('stuntsHost', {
  pickGame: () => ipcRenderer.invoke('pick-game'),
});
