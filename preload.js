const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, data) => callback(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('metatron', {
  ask: () => ipcRenderer.send('overlay:ask'),
  askWithScreenshot: () => ipcRenderer.send('overlay:ask-with-screenshot'),
  hide: () => ipcRenderer.send('overlay:hide'),
  captureScreenshot: () => ipcRenderer.send('screenshot:capture'),
  clearScreenshot: () => ipcRenderer.send('screenshot:clear'),
  getScreenshotState: () => ipcRenderer.invoke('screenshot:get-state'),
  toggleListening: () => ipcRenderer.send('stt:toggle'),
  sendAudioChunk: (source, pcmBytes, rms) =>
    ipcRenderer.send('stt:audio-chunk', source, pcmBytes, rms),
  reportCaptureError: (source, message) =>
    ipcRenderer.send('stt:capture-error', source, message),
  getSttState: () => ipcRenderer.invoke('stt:get-state'),
  onStreamStart: (callback) => subscribe('llm:start', callback),
  onStreamChunk: (callback) => subscribe('llm:chunk', callback),
  onStreamEnd: (callback) => subscribe('llm:end', callback),
  onStreamError: (callback) => subscribe('llm:error', callback),
  onSttControl: (callback) => subscribe('stt:control', callback),
  onSttStatus: (callback) => subscribe('stt:status', callback),
  onTranscriptUpdate: (callback) => subscribe('stt:transcript', callback),
  onSttError: (callback) => subscribe('stt:error', callback),
  onScreenshotUpdate: (callback) => subscribe('screenshot:update', callback),
});
