const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('chatBot', {
  call: (action, payload) => ipcRenderer.invoke('chat-bot', action, payload),
  onStatus: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('desktop-status', listener); return () => ipcRenderer.removeListener('desktop-status', listener); }
});
