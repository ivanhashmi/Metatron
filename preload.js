const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, data) => callback(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('metatron', {
  ask: () => ipcRenderer.send('overlay:ask'),
  askWithScreenshot: () => ipcRenderer.send('overlay:ask-with-screenshot'),
  sendFollowUp: (text) => ipcRenderer.send('overlay:followup', text),
  clearChat: () => ipcRenderer.send('overlay:clear-chat'),
  hide: () => ipcRenderer.send('overlay:hide'),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  cycleModel: () => ipcRenderer.send('model:cycle'),
  captureScreenshot: () => ipcRenderer.send('screenshot:capture'),
  clearScreenshot: () => ipcRenderer.send('screenshot:clear'),
  getScreenshotState: () => ipcRenderer.invoke('screenshot:get-state'),
  toggleListening: () => ipcRenderer.send('stt:toggle'),
  toggleClickThrough: () => ipcRenderer.send('overlay:toggle-click-through'),
  getClickThrough: () => ipcRenderer.invoke('overlay:get-click-through'),
  sendAudioChunk: (source, pcmBytes, rms) =>
    ipcRenderer.send('stt:audio-chunk', source, pcmBytes, rms),
  reportCaptureError: (source, message) =>
    ipcRenderer.send('stt:capture-error', source, message),
  getSttState: () => ipcRenderer.invoke('stt:get-state'),
  onStreamStart: (callback) => subscribe('llm:start', callback),
  onStreamChunk: (callback) => subscribe('llm:chunk', callback),
  onStreamEnd: (callback) => subscribe('llm:end', callback),
  onStreamError: (callback) => subscribe('llm:error', callback),
  onChatReset: (callback) => subscribe('chat:reset', callback),
  onConfigUpdate: (callback) => subscribe('config:update', callback),
  onSttControl: (callback) => subscribe('stt:control', callback),
  onSttStatus: (callback) => subscribe('stt:status', callback),
  onTranscriptUpdate: (callback) => subscribe('stt:transcript', callback),
  onSttError: (callback) => subscribe('stt:error', callback),
  onScreenshotUpdate: (callback) => subscribe('screenshot:update', callback),
  onClickThroughChange: (callback) => subscribe('overlay:click-through', callback),
});
