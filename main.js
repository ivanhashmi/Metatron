const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  screen,
  session,
  systemPreferences,
} = require('electron');
const { streamResponse } = require('./llm');
const { createSttSession } = require('./stt');

app.setName('Metatron');

const TRANSCRIPT_RETENTION_MS = 3 * 60 * 1000; // Rolling ~3 minutes displayed
const LLM_CONTEXT_WINDOW_MS = 2 * 60 * 1000; // Last ~2 minutes sent to LLM
const PRUNE_INTERVAL_MS = 15 * 1000;

const SCREENSHOT_MAX_SIDE_PX = 1280;
const SCREENSHOT_JPEG_QUALITY = 75;
const SCREENSHOT_THUMB_WIDTH_PX = 160;
const OVERLAY_HIDE_SETTLE_MS = 80;

const MEETING_SYSTEM_PROMPT =
  'You are a discreet real-time meeting assistant. In the transcript, "Them" is the other party on the call and "Me" is the user. Suggest what the user ("Me") should say next, in one or two concise sentences.';

const VISION_MEETING_SYSTEM_PROMPT =
  'You are a discreet real-time meeting assistant. In the transcript, "Them" is the other party on the call and "Me" is the user. Use both the attached screen capture and the recent transcript (if provided) to give a concise, practical answer or suggest what the user ("Me") should say next in one to three short sentences.';

const SOURCE_LABELS = {
  me: 'Me',
  them: 'Them',
};

const SCREEN_PERMISSION_INSTRUCTIONS =
  'Screen Recording permission is not granted (needed for system audio / "Them" and screenshots). Open System Settings → Privacy & Security → Screen & System Audio Recording, enable Electron (or your terminal app), then quit and restart Metatron.';

let mainWindow = null;
let currentAbortController = null;
let activeRequestId = 0;

const sttSessions = {
  me: null,
  them: null,
};
const sourceStates = {
  me: 'stopped',
  them: 'stopped',
};
let isListening = false;
let isStartingTranscription = false;
let isCapturingScreenshot = false;

let attachedScreenshot = null; // { buffer, mimeType, width, height, sizeKb, capturedAt, thumbnailDataUrl }

let transcriptEntries = []; // { id, source, label, text, timestamp }
const interimBySource = {
  me: null, // { source, label, text, timestamp } | null
  them: null,
};
let nextEntryId = 1;
let pruneTimer = null;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function getAggregateStatus() {
  const states = [sourceStates.me, sourceStates.them];
  if (states.includes('listening')) return 'listening';
  if (states.includes('reconnecting')) return 'reconnecting';
  if (states.includes('connecting')) return 'connecting';
  return 'stopped';
}

function broadcastStatus() {
  sendToRenderer('stt:status', {
    overall: getAggregateStatus(),
    sources: { ...sourceStates },
  });
}

function getScreenshotSummary() {
  if (!attachedScreenshot) return null;
  return {
    width: attachedScreenshot.width,
    height: attachedScreenshot.height,
    sizeKb: attachedScreenshot.sizeKb,
    time: formatTimestamp(attachedScreenshot.capturedAt),
    thumbnailDataUrl: attachedScreenshot.thumbnailDataUrl,
  };
}

function broadcastScreenshot() {
  sendToRenderer('screenshot:update', getScreenshotSummary());
}

function pruneTranscript(now = Date.now()) {
  const cutoff = now - TRANSCRIPT_RETENTION_MS;
  const beforeCount = transcriptEntries.length;
  transcriptEntries = transcriptEntries.filter((entry) => entry.timestamp >= cutoff);

  let interimChanged = false;
  for (const src of ['me', 'them']) {
    if (interimBySource[src] && interimBySource[src].timestamp < cutoff) {
      interimBySource[src] = null;
      interimChanged = true;
    }
  }

  return transcriptEntries.length !== beforeCount || interimChanged;
}

function getTranscriptPayload() {
  const interims = ['me', 'them']
    .map((src) => interimBySource[src])
    .filter((item) => item && item.text)
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((item) => ({
      source: item.source,
      label: item.label,
      text: item.text,
      time: formatTimestamp(item.timestamp),
    }));

  return {
    entries: transcriptEntries.map((entry) => ({
      id: entry.id,
      source: entry.source,
      label: entry.label,
      text: entry.text,
      time: formatTimestamp(entry.timestamp),
    })),
    interims,
  };
}

function broadcastTranscript() {
  sendToRenderer('stt:transcript', getTranscriptPayload());
}

function buildTranscriptContext() {
  const now = Date.now();
  pruneTranscript(now);
  const cutoff = now - LLM_CONTEXT_WINDOW_MS;

  const combined = transcriptEntries
    .filter((entry) => entry.timestamp >= cutoff)
    .map((entry) => ({
      timestamp: entry.timestamp,
      order: entry.id,
      line: `[${formatTimestamp(entry.timestamp)}] ${entry.label}: ${entry.text}`,
    }));

  for (const src of ['me', 'them']) {
    const interim = interimBySource[src];
    if (interim && interim.text && interim.timestamp >= cutoff) {
      combined.push({
        timestamp: interim.timestamp,
        order: Number.MAX_SAFE_INTEGER,
        line: `[${formatTimestamp(interim.timestamp)}] ${interim.label}: ${interim.text}`,
      });
    }
  }

  combined.sort((a, b) => a.timestamp - b.timestamp || a.order - b.order);
  return combined.map((item) => item.line).join('\n').trim();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 440,
    height: 430,
    minWidth: 340,
    minHeight: 280,
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

  mainWindow.webContents.on('did-finish-load', () => {
    checkScreenPermissionOnStartup();
  });

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

function getScreenPermissionStatus() {
  if (process.platform !== 'darwin') {
    return 'granted';
  }
  return systemPreferences.getMediaAccessStatus('screen');
}

function checkScreenPermissionOnStartup() {
  const status = getScreenPermissionStatus();
  console.log(`[Screen] macOS Screen Recording permission status on start: ${status}`);
  if (status !== 'granted') {
    sendToRenderer('stt:error', SCREEN_PERMISSION_INSTRUCTIONS);
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

async function capturePrimaryScreenScreenshot() {
  if (isCapturingScreenshot) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const screenStatus = getScreenPermissionStatus();
  console.log(`[Screenshot] Screen Recording permission status: ${screenStatus}`);

  if (screenStatus !== 'granted') {
    if (!mainWindow.isVisible()) {
      mainWindow.showInactive();
    }
    sendToRenderer('stt:error', SCREEN_PERMISSION_INSTRUCTIONS);
    if (process.platform === 'darwin' && screenStatus === 'not-determined') {
      desktopCapturer
        .getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
        .catch(() => {});
    }
    return;
  }

  isCapturingScreenshot = true;
  const startTime = Date.now();
  const wasVisible = mainWindow.isVisible();

  try {
    // Temporarily hide the Metatron overlay so it never appears in the captured frame.
    if (wasVisible) {
      mainWindow.hide();
      await delay(OVERLAY_HIDE_SETTLE_MS);
    }

    const primaryDisplay = screen.getPrimaryDisplay();
    const { width: dispW, height: dispH } = primaryDisplay.size;
    const scale = Math.min(1, SCREENSHOT_MAX_SIDE_PX / Math.max(dispW, dispH));
    const requestedSize = {
      width: Math.max(1, Math.round(dispW * scale)),
      height: Math.max(1, Math.round(dispH * scale)),
    };

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: requestedSize,
    });

    if (!sources || sources.length === 0) {
      throw new Error(
        'No screen source returned. Check Screen & System Audio Recording permission in System Settings.'
      );
    }

    const primaryDisplayId = String(primaryDisplay.id);
    const primarySource =
      sources.find((s) => s.display_id === primaryDisplayId) || sources[0];

    let image = primarySource.thumbnail;
    if (!image || image.isEmpty()) {
      throw new Error(
        'Captured screen image was empty. Verify Screen & System Audio Recording permission is enabled and restart Metatron.'
      );
    }

    let { width: imgW, height: imgH } = image.getSize();
    const longestSide = Math.max(imgW, imgH);
    if (longestSide > SCREENSHOT_MAX_SIDE_PX) {
      const downscale = SCREENSHOT_MAX_SIDE_PX / longestSide;
      image = image.resize({
        width: Math.max(1, Math.round(imgW * downscale)),
        height: Math.max(1, Math.round(imgH * downscale)),
        quality: 'good',
      });
      const resized = image.getSize();
      imgW = resized.width;
      imgH = resized.height;
    }

    const jpegBuffer = image.toJPEG(SCREENSHOT_JPEG_QUALITY);
    if (!jpegBuffer || jpegBuffer.length === 0) {
      throw new Error('Failed to encode captured screen image as JPEG.');
    }

    const thumbImage = image.resize({
      width: Math.min(SCREENSHOT_THUMB_WIDTH_PX, imgW),
      quality: 'good',
    });
    const thumbBuffer = thumbImage.toJPEG(70);
    const thumbnailDataUrl = `data:image/jpeg;base64,${thumbBuffer.toString('base64')}`;

    const captureMs = Date.now() - startTime;
    const sizeKb = Number((jpegBuffer.length / 1024).toFixed(1));

    attachedScreenshot = {
      buffer: jpegBuffer,
      mimeType: 'image/jpeg',
      width: imgW,
      height: imgH,
      sizeKb,
      capturedAt: Date.now(),
      thumbnailDataUrl,
    };

    console.log(
      `[Screenshot] Captured primary screen (${imgW}x${imgH}) in ${captureMs}ms (${sizeKb} KB JPEG)`
    );
    broadcastScreenshot();
  } catch (error) {
    const msg =
      error && error.message ? error.message : 'Failed to capture screen screenshot.';
    console.error('[Screenshot] Capture failed:', msg);
    sendToRenderer('stt:error', `${msg}\n\n${SCREEN_PERMISSION_INSTRUCTIONS}`);
  } finally {
    if (wasVisible && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.showInactive();
    }
    isCapturingScreenshot = false;
  }
}

function clearScreenshot() {
  if (!attachedScreenshot) return;
  attachedScreenshot = null;
  console.log('[Screenshot] Cleared attached screenshot');
  broadcastScreenshot();
}

function initSttSession(source) {
  if (sttSessions[source]) return sttSessions[source];

  sttSessions[source] = createSttSession({
    source,

    onStatus(state) {
      sourceStates[source] = state;
      broadcastStatus();

      if (state === 'stopped') {
        interimBySource[source] = null;
        broadcastTranscript();
        sendToRenderer('stt:control', { action: 'stop', sources: [source] });

        if (sourceStates.me === 'stopped' && sourceStates.them === 'stopped') {
          isListening = false;
        }
      }
    },

    onTranscript({ text, isFinal, timestamp }) {
      const now = timestamp || Date.now();
      const label = SOURCE_LABELS[source] || source;
      pruneTranscript(now);

      if (isFinal) {
        interimBySource[source] = null;
        if (text) {
          transcriptEntries.push({
            id: nextEntryId++,
            source,
            label,
            text,
            timestamp: now,
          });
          transcriptEntries.sort((a, b) => a.timestamp - b.timestamp || a.id - b.id);
        }
      } else if (text) {
        interimBySource[source] = { source, label, text, timestamp: now };
      } else {
        interimBySource[source] = null;
      }

      broadcastTranscript();
    },

    onError(message) {
      sendToRenderer('stt:error', message);
    },
  });

  return sttSessions[source];
}

async function startTranscription() {
  if (isListening || isStartingTranscription) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;

  isStartingTranscription = true;
  try {
    if (!mainWindow.isVisible()) {
      mainWindow.showInactive();
    }

    const micGranted = await ensureMicrophoneAccess();
    const screenStatus = getScreenPermissionStatus();
    console.log(`[Screen] macOS Screen Recording permission status: ${screenStatus}`);

    const warnings = [];
    const sourcesToStart = [];

    if (micGranted) {
      sourcesToStart.push('me');
    } else {
      warnings.push(
        'Microphone access denied (needed for "Me"). Enable Microphone in System Settings → Privacy & Security → Microphone and restart Metatron.'
      );
    }

    if (screenStatus === 'granted') {
      sourcesToStart.push('them');
    } else {
      warnings.push(SCREEN_PERMISSION_INSTRUCTIONS);
      if (process.platform === 'darwin' && screenStatus === 'not-determined') {
        desktopCapturer
          .getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
          .catch(() => {});
      }
    }

    if (sourcesToStart.length === 0) {
      broadcastStatus();
      sendToRenderer('stt:error', warnings.join('\n\n'));
      return;
    }

    const startedSources = [];
    for (const src of sourcesToStart) {
      const sessionObj = initSttSession(src);
      if (sessionObj.start()) {
        startedSources.push(src);
      }
    }

    if (startedSources.length === 0) {
      return;
    }

    isListening = true;
    sendToRenderer('stt:control', { action: 'start', sources: startedSources });
    console.log(
      `[STT] Transcription started for sources: [${startedSources.join(', ')}] (awaiting audio frames from renderer)`
    );

    if (warnings.length > 0) {
      sendToRenderer('stt:error', warnings.join('\n\n'));
    }
  } finally {
    isStartingTranscription = false;
  }
}

function stopSource(source) {
  sourceStates[source] = 'stopped';
  interimBySource[source] = null;
  if (sttSessions[source]) {
    sttSessions[source].stop();
  }
  sendToRenderer('stt:control', { action: 'stop', sources: [source] });
  if (sourceStates.me === 'stopped' && sourceStates.them === 'stopped') {
    isListening = false;
  }
  broadcastStatus();
  broadcastTranscript();
}

function stopTranscription() {
  const wasActive =
    isListening || sourceStates.me !== 'stopped' || sourceStates.them !== 'stopped';
  isListening = false;
  interimBySource.me = null;
  interimBySource.them = null;

  for (const src of ['me', 'them']) {
    sourceStates[src] = 'stopped';
    if (sttSessions[src]) {
      sttSessions[src].stop();
    }
  }

  sendToRenderer('stt:control', { action: 'stop', sources: ['me', 'them'] });
  broadcastStatus();
  if (wasActive) {
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

async function runContextPrompt({ includeScreenshot = false } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (!mainWindow.isVisible()) {
    mainWindow.showInactive();
  }

  const context = buildTranscriptContext();
  const screenshot = includeScreenshot ? attachedScreenshot : null;

  if (includeScreenshot && !screenshot) {
    sendToRenderer(
      'llm:error',
      'No screenshot attached yet. Press ⌘⇧S to capture the screen first, then press ⌘⇧↩.'
    );
    return;
  }

  if (!includeScreenshot && !context) {
    sendToRenderer(
      'llm:error',
      'No transcript in the last 2 minutes yet. Press ⌘⇧T to start listening first.'
    );
    return;
  }

  if (currentAbortController) {
    currentAbortController.abort();
  }

  const controller = new AbortController();
  currentAbortController = controller;
  const requestId = ++activeRequestId;
  const requestStartMs = Date.now();
  const mode = includeScreenshot ? 'vision+transcript' : 'transcript-only';

  const prompt = includeScreenshot
    ? context
      ? `Recent meeting transcript (last ~2 minutes):\n${context}\n\nUsing the attached screenshot and the transcript above, what should I ("Me") say next?`
      : 'No recent transcript is available yet. Look at the attached screenshot and briefly tell me what is most relevant or what I ("Me") should say next.'
    : `Recent meeting transcript (last ~2 minutes):\n${context}\n\nWhat should I ("Me") say next?`;

  const systemInstruction = includeScreenshot
    ? VISION_MEETING_SYSTEM_PROMPT
    : MEETING_SYSTEM_PROMPT;

  console.log(
    `[LLM] Starting request (mode=${mode}, transcript=${context.length} chars` +
      (screenshot ? `, image=${screenshot.sizeKb} KB ${screenshot.width}x${screenshot.height})` : ')')
  );
  sendToRenderer('llm:start', { context, includeScreenshot });

  try {
    let receivedAnyChunk = false;
    let firstTokenMs = null;

    for await (const chunk of streamResponse(prompt, {
      signal: controller.signal,
      systemInstruction,
      image: screenshot
        ? { mimeType: screenshot.mimeType, data: screenshot.buffer }
        : undefined,
    })) {
      if (requestId !== activeRequestId || controller.signal.aborted) {
        return;
      }
      if (!receivedAnyChunk) {
        firstTokenMs = Date.now() - requestStartMs;
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

    const totalMs = Date.now() - requestStartMs;
    console.log(
      `[LLM] Completed request (mode=${mode}, ttft=${firstTokenMs}ms, total=${totalMs}ms)`
    );
    sendToRenderer('llm:end');
  } catch (error) {
    if (requestId !== activeRequestId || controller.signal.aborted) {
      return;
    }
    const totalMs = Date.now() - requestStartMs;
    const message = error && error.message ? error.message : 'Unexpected error calling LLM.';
    console.error(`[LLM] Request failed (mode=${mode}, elapsed=${totalMs}ms):`, message);
    sendToRenderer('llm:error', message);
  } finally {
    if (currentAbortController === controller) {
      currentAbortController = null;
    }
  }
}

function registerShortcuts() {
  const shortcuts = [
    ['CommandOrControl+Shift+Space', () => toggleWindow()],
    ['CommandOrControl+Return', () => runContextPrompt({ includeScreenshot: false })],
    ['CommandOrControl+Shift+Return', () => runContextPrompt({ includeScreenshot: true })],
    ['CommandOrControl+Shift+T', () => toggleTranscription()],
    ['CommandOrControl+Shift+S', () => capturePrimaryScreenScreenshot()],
    ['CommandOrControl+Shift+X', () => clearScreenshot()],
  ];

  for (const [accelerator, handler] of shortcuts) {
    const ok = globalShortcut.register(accelerator, handler);
    if (!ok) {
      console.warn(`Metatron: Failed to register global shortcut ${accelerator}`);
    }
  }
}

function configureMediaPermissions() {
  const defaultSession = session.defaultSession;

  defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    if (permission === 'media' || permission === 'display-capture') return true;
    return false;
  });

  defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === 'media' || permission === 'display-capture') {
      callback(true);
    } else {
      callback(false);
    }
  });

  defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      if (!sources || sources.length === 0) {
        console.error('[Screen] No screen sources available for system audio loopback');
        callback({});
        return;
      }

      const primaryDisplayId = String(screen.getPrimaryDisplay().id);
      const primarySource =
        sources.find((s) => s.display_id === primaryDisplayId) || sources[0];

      console.log(
        `[Screen] Granting primary screen "${primarySource.name}" (id=${primarySource.id}) with audio="loopback"`
      );
      callback({ video: primarySource, audio: 'loopback' });
    } catch (error) {
      console.error('[Screen] setDisplayMediaRequestHandler failed:', error.message);
      callback({});
    }
  });
}

ipcMain.on('overlay:ask', () => runContextPrompt({ includeScreenshot: false }));
ipcMain.on('overlay:ask-with-screenshot', () => runContextPrompt({ includeScreenshot: true }));
ipcMain.on('overlay:hide', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  }
});

ipcMain.on('screenshot:capture', () => capturePrimaryScreenScreenshot());
ipcMain.on('screenshot:clear', () => clearScreenshot());
ipcMain.handle('screenshot:get-state', () => getScreenshotSummary());

ipcMain.on('stt:toggle', () => {
  toggleTranscription();
});

ipcMain.on('stt:audio-chunk', (_event, source, chunk, rms) => {
  if (!isListening || !chunk) return;
  const src = source === 'them' ? 'them' : 'me';
  const sessionObj = sttSessions[src];
  if (!sessionObj) return;

  const buffer = Buffer.isBuffer(chunk)
    ? chunk
    : ArrayBuffer.isView(chunk)
      ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      : Buffer.from(chunk);
  sessionObj.sendAudio(buffer, typeof rms === 'number' ? rms : 0);
});

ipcMain.on('stt:capture-error', (_event, source, message) => {
  const src = source === 'them' ? 'them' : 'me';
  console.error(`[Audio:${src}] Renderer capture error:`, message);
  stopSource(src);
  sendToRenderer('stt:error', message || `Failed to capture audio for ${src}.`);
});

ipcMain.handle('stt:get-state', () => ({
  status: {
    overall: getAggregateStatus(),
    sources: { ...sourceStates },
  },
  ...getTranscriptPayload(),
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
