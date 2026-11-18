const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { app, BrowserWindow, globalShortcut, ipcMain } = require('electron');
const { streamResponse } = require('./llm');

app.setName('Metatron');

// Hardcoded meeting context for steps 1-2.
const context = 'Suggest a good question to ask in a meeting about project timelines';

let mainWindow = null;
let currentAbortController = null;
let activeRequestId = 0;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 300,
    minWidth: 300,
    minHeight: 200,
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
    if (currentAbortController) {
      currentAbortController.abort();
      currentAbortController = null;
    }
    mainWindow = null;
  });
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function toggleWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
  }
}

async function runContextPrompt() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (!mainWindow.isVisible()) {
    mainWindow.showInactive();
  }

  if (currentAbortController) {
    currentAbortController.abort();
  }

  const controller = new AbortController();
  currentAbortController = controller;
  const requestId = ++activeRequestId;

  sendToRenderer('llm:start', { context });

  try {
    let receivedAnyChunk = false;
    for await (const chunk of streamResponse(context, { signal: controller.signal })) {
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
}

ipcMain.handle('overlay:get-context', () => context);
ipcMain.on('overlay:ask', () => runContextPrompt());
ipcMain.on('overlay:hide', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  }
});

app.whenReady().then(() => {
  createWindow();
  registerShortcuts();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (mainWindow && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
