const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  session,
  systemPreferences,
} = require('electron');
const { streamResponse } = require('./llm');
const { createSttSession } = require('./stt');

app.setName('Metatron');

const TRANSCRIPT_RETENTION_MS = 3 * 60 * 1000; // Rolling ~3 minutes displayed
const LLM_CONTEXT_WINDOW_MS = 2 * 60 * 1000; // Last ~2 minutes sent to LLM
const PRUNE_INTERVAL_MS = 15 * 1000;
const MEETING_SYSTEM_PROMPT =
  'You are a discreet meeting assistant. Suggest what I should say next, in one or two sentences.';

let mainWindow = null;
let currentAbortController = null;
let activeRequestId = 0;

let sttSession = null;
let isListening = false;
let isStartingTranscription = false;
let sttState = 'stopped';
let transcriptEntries = []; // { id, text, timestamp }
let currentInterim = null; // { text, timestamp } | null
let nextEntryId = 1;
let pruneTimer = null;

function formatTimestamp(ms) {
  const date = new Date(ms);
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function pruneTranscript(now = Date.now()) {
  const cutoff = now - TRANSCRIPT_RETENTION_MS;
  const beforeCount = transcriptEntries.length;
  transcriptEntries = transcriptEntries.filter((entry) => entry.timestamp >= cutoff);
  if (currentInterim && currentInterim.timestamp < cutoff) {
    currentInterim = null;
  }
  return transcriptEntries.length !== beforeCount;
}

function broadcastTranscript() {
  sendToRenderer('stt:transcript', {
    entries: transcriptEntries.map((entry) => ({
      id: entry.id,
      text: entry.text,
      time: formatTimestamp(entry.timestamp),
    })),
    interim: currentInterim
      ? {
          text: currentInterim.text,
          time: formatTimestamp(currentInterim.timestamp),
        }
      : null,
  });
}

function buildTranscriptContext() {
  const now = Date.now();
  pruneTranscript(now);
  const cutoff = now - LLM_CONTEXT_WINDOW_MS;
  const lines = transcriptEntries
    .filter((entry) => entry.timestamp >= cutoff)
    .map((entry) => `[${formatTimestamp(entry.timestamp)}] ${entry.text}`);

  if (currentInterim && currentInterim.text && currentInterim.timestamp >= cutoff) {
    lines.push(`[${formatTimestamp(currentInterim.timestamp)}] ${currentInterim.text}`);
  }

  return lines.join('\n').trim();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 380,
    minWidth: 320,
    minHeight: 260,
    title: 'Metatron',
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop: true,
    resizable: true,
    fullscreenable: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Stay visible over other apps (including fullscreen apps) and across all macOS Spaces.
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  mainWindow.loadFile(path.join(__dirname, 'renderer.html'));

  mainWindow.on('closed', () => {
    stopTranscription();
    if (currentAbortController) {
      currentAbortController.abort();
      currentAbortController = null;
    }
    mainWindow = null;
  });
}

function toggleWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
  }
}

async function ensureMicrophoneAccess() {
  if (process.platform !== 'darwin') {
    return true;
  }

  const status = systemPreferences.getMediaAccessStatus('microphone');
  console.log(`[Mic] Current macOS microphone permission status: ${status}`);

  if (status === 'granted') {
    return true;
  }

  if (status === 'denied' || status === 'restricted') {
    return false;
  }

  const granted = await systemPreferences.askForMediaAccess('microphone');
  console.log(`[Mic] askForMediaAccess('microphone') result: ${granted}`);
  return granted;
}

function initSttSession() {
  if (sttSession) return sttSession;

  sttSession = createSttSession({
    onStatus(state) {
      sttState = state;
      sendToRenderer('stt:status', state);
      if (state === 'stopped' && isListening) {
        isListening = false;
        currentInterim = null;
        broadcastTranscript();
        sendToRenderer('stt:control', { action: 'stop' });
      }
    },

    onTranscript({ text, isFinal, timestamp }) {
      const now = timestamp || Date.now();
      pruneTranscript(now);

      if (isFinal) {
        currentInterim = null;
        if (text) {
          transcriptEntries.push({
            id: nextEntryId++,
            text,
            timestamp: now,
          });
        }
      } else if (text) {
        currentInterim = { text, timestamp: now };
      } else {
        currentInterim = null;
      }

      broadcastTranscript();
    },

    onError(message) {
      sendToRenderer('stt:error', message);
    },
  });

  return sttSession;
}

async function startTranscription() {
  if (isListening || isStartingTranscription) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;

  isStartingTranscription = true;
  try {
    if (!mainWindow.isVisible()) {
      mainWindow.showInactive();
    }

    const granted = await ensureMicrophoneAccess();
    if (!granted) {
      sendToRenderer('stt:status', 'stopped');
      sendToRenderer(
        'stt:error',
        'Microphone access denied. Enable Microphone permission for your terminal/Electron in System Settings → Privacy & Security → Microphone, then restart Metatron.'
      );
      return;
    }

    const sessionObj = initSttSession();
    const started = sessionObj.start();
    if (!started) {
      return;
    }

    isListening = true;
    sendToRenderer('stt:control', { action: 'start' });
    console.log('[STT] Transcription started (awaiting audio frames from renderer)');
  } finally {
    isStartingTranscription = false;
  }
}

function stopTranscription() {
  const wasListening = isListening || sttState !== 'stopped';
  isListening = false;
  currentInterim = null;

  if (sttSession) {
    sttSession.stop();
  }

  sendToRenderer('stt:control', { action: 'stop' });
  sendToRenderer('stt:status', 'stopped');
  if (wasListening) {
    broadcastTranscript();
  }
}

async function toggleTranscription() {
  if (isListening) {
    stopTranscription();
  } else {
    await startTranscription();
  }
}

async function runContextPrompt() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (!mainWindow.isVisible()) {
    mainWindow.showInactive();
  }

  const context = buildTranscriptContext();
  if (!context) {
    sendToRenderer(
      'llm:error',
      'No transcript in the last 2 minutes yet. Press ⌘⇧T to start listening and speak first.'
    );
    return;
  }

  if (currentAbortController) {
    currentAbortController.abort();
  }

  const controller = new AbortController();
  currentAbortController = controller;
  const requestId = ++activeRequestId;

  console.log(
    `[LLM] Sending ${context.length} chars of transcript context (last ~2 min) to Gemini`
  );
  sendToRenderer('llm:start', { context });

  const prompt = `Recent meeting transcript (last ~2 minutes):\n${context}\n\nWhat should I say next?`;

  try {
    let receivedAnyChunk = false;
    for await (const chunk of streamResponse(prompt, {
      signal: controller.signal,
      systemInstruction: MEETING_SYSTEM_PROMPT,
    })) {
      if (requestId !== activeRequestId || controller.signal.aborted) {
        return;
      }
      receivedAnyChunk = true;
      sendToRenderer('llm:chunk', chunk);
    }

    if (requestId !== activeRequestId || controller.signal.aborted) {
      return;
    }

    if (!receivedAnyChunk) {
      sendToRenderer('llm:error', 'The model returned an empty response. Try again.');
      return;
    }

    sendToRenderer('llm:end');
  } catch (error) {
    if (requestId !== activeRequestId || controller.signal.aborted) {
      return;
    }
    const message = error && error.message ? error.message : 'Unexpected error calling LLM.';
    sendToRenderer('llm:error', message);
  } finally {
    if (currentAbortController === controller) {
      currentAbortController = null;
    }
  }
}

function registerShortcuts() {
  const toggleRegistered = globalShortcut.register('CommandOrControl+Shift+Space', () => {
    toggleWindow();
  });
  if (!toggleRegistered) {
    console.warn('Metatron: Failed to register global shortcut CommandOrControl+Shift+Space');
  }

  const askRegistered = globalShortcut.register('CommandOrControl+Return', () => {
    runContextPrompt();
  });
  if (!askRegistered) {
    console.warn('Metatron: Failed to register global shortcut CommandOrControl+Return');
  }

  const transcribeRegistered = globalShortcut.register('CommandOrControl+Shift+T', () => {
    toggleTranscription();
  });
  if (!transcribeRegistered) {
    console.warn('Metatron: Failed to register global shortcut CommandOrControl+Shift+T');
  }
}

function configureMediaPermissions() {
  const defaultSession = session.defaultSession;
  defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    if (permission === 'media') return true;
    return false;
  });

  defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === 'media') {
      callback(true);
    } else {
      callback(false);
    }
  });
}

ipcMain.on('overlay:ask', () => runContextPrompt());
ipcMain.on('overlay:hide', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  }
});

ipcMain.on('stt:toggle', () => {
  toggleTranscription();
});

ipcMain.on('stt:audio-chunk', (_event, chunk, rms) => {
  if (!isListening || !sttSession || !chunk) return;
  const buffer = Buffer.isBuffer(chunk)
    ? chunk
    : ArrayBuffer.isView(chunk)
      ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      : Buffer.from(chunk);
  sttSession.sendAudio(buffer, typeof rms === 'number' ? rms : 0);
});

ipcMain.on('stt:mic-error', (_event, message) => {
  console.error('[Mic] Renderer capture error:', message);
  stopTranscription();
  sendToRenderer('stt:error', message || 'Failed to capture microphone audio.');
});

ipcMain.handle('stt:get-state', () => ({
  status: sttState,
  entries: transcriptEntries.map((entry) => ({
    id: entry.id,
    text: entry.text,
    time: formatTimestamp(entry.timestamp),
  })),
  interim: currentInterim
    ? {
        text: currentInterim.text,
        time: formatTimestamp(currentInterim.timestamp),
      }
    : null,
}));

app.whenReady().then(() => {
  configureMediaPermissions();
  createWindow();
  registerShortcuts();

  pruneTimer = setInterval(() => {
    if (pruneTranscript()) {
      broadcastTranscript();
    }
  }, PRUNE_INTERVAL_MS);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (mainWindow && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  });
});

app.on('will-quit', () => {
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
  stopTranscription();
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
