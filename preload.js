const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, data) => callback(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('metatron', {
  getContext: () => ipcRenderer.invoke('overlay:get-context'),
  ask: () => ipcRenderer.send('overlay:ask'),
  hide: () => ipcRenderer.send('overlay:hide'),
  onStreamStart: (callback) => subscribe('llm:start', callback),
  onStreamChunk: (callback) => subscribe('llm:chunk', callback),
  onStreamEnd: (callback) => subscribe('llm:end', callback),
  onStreamError: (callback) => subscribe('llm:error', callback),
});
