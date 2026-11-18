const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const listenPill = document.getElementById('listen-pill');
const listenLabel = document.getElementById('listen-label');
const responseEl = document.getElementById('response');
const responseScroll = document.getElementById('response-scroll');
const transcriptList = document.getElementById('transcript-list');
const transcriptScroll = document.getElementById('transcript-scroll');
const errorBox = document.getElementById('error-box');
const askBtn = document.getElementById('ask-btn');
const hideBtn = document.getElementById('hide-btn');

let mediaStream = null;
let audioContext = null;
let sourceNode = null;
let workletNode = null;
let silentGain = null;
let captureActive = false;

function setStatus(state, label) {
  statusDot.className = 'status-dot' + (state ? ` ${state}` : '');
  statusText.textContent = label;
}

function setListeningIndicator(state) {
  listenPill.className = 'listen-pill' + (state && state !== 'stopped' ? ` ${state}` : '');
  if (state === 'listening') {
    listenLabel.textContent = 'Listening';
  } else if (state === 'connecting') {
    listenLabel.textContent = 'Connecting…';
  } else if (state === 'reconnecting') {
    listenLabel.textContent = 'Reconnecting…';
  } else {
    listenLabel.textContent = 'Mic off';
  }
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.classList.add('visible');
}

function clearError() {
  errorBox.textContent = '';
  errorBox.classList.remove('visible');
}

function scrollToBottom(el) {
  el.scrollTop = el.scrollHeight;
}

function renderTranscript({ entries = [], interim = null }) {
  transcriptList.textContent = '';

  if (entries.length === 0 && (!interim || !interim.text)) {
    const empty = document.createElement('div');
    empty.className = 'transcript-empty';
    empty.textContent = captureActive
      ? 'Listening… speak into your microphone.'
      : 'Not listening yet. Press ⌘⇧T to start.';
    transcriptList.appendChild(empty);
    return;
  }

  for (const entry of entries) {
    const line = document.createElement('div');
    line.className = 'transcript-line';

    const timeSpan = document.createElement('span');
    timeSpan.className = 'transcript-time';
    timeSpan.textContent = entry.time;

    line.appendChild(timeSpan);
    line.appendChild(document.createTextNode(entry.text));
    transcriptList.appendChild(line);
  }

  if (interim && interim.text) {
    const interimLine = document.createElement('div');
    interimLine.className = 'transcript-line interim';

    const timeSpan = document.createElement('span');
    timeSpan.className = 'transcript-time';
    timeSpan.textContent = interim.time;

    interimLine.appendChild(timeSpan);
    interimLine.appendChild(document.createTextNode(interim.text));
    transcriptList.appendChild(interimLine);
  }

  scrollToBottom(transcriptScroll);
}

async function startMicCapture() {
  if (captureActive) return;
  clearError();

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    audioContext = new AudioContext();
    await audioContext.audioWorklet.addModule('./audio-processor.js');

    sourceNode = audioContext.createMediaStreamSource(mediaStream);
    workletNode = new AudioWorkletNode(audioContext, 'pcm-16k-processor');
    silentGain = audioContext.createGain();
    silentGain.gain.value = 0;

    workletNode.port.onmessage = (event) => {
      if (!captureActive || !event.data || !event.data.pcm) return;
      window.metatron.sendAudioChunk(new Uint8Array(event.data.pcm), event.data.rms || 0);
    };

    sourceNode.connect(workletNode);
    workletNode.connect(silentGain);
    silentGain.connect(audioContext.destination);

    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }

    captureActive = true;
    console.log(
      `[Mic] Capturing audio at ${audioContext.sampleRate} Hz -> resampling to 16000 Hz mono 16-bit PCM`
    );

    const state = await window.metatron.getSttState();
    renderTranscript(state);
  } catch (error) {
    await stopMicCapture();
    const msg =
      error && error.name === 'NotAllowedError'
        ? 'Microphone access denied. Enable Microphone permission in System Settings → Privacy & Security → Microphone and restart Metatron.'
        : `Microphone capture failed: ${error && error.message ? error.message : String(error)}`;
    window.metatron.reportMicError(msg);
  }
}

async function stopMicCapture() {
  captureActive = false;

  if (workletNode) {
    workletNode.port.onmessage = null;
    try {
      workletNode.disconnect();
    } catch {}
    workletNode = null;
  }

  if (sourceNode) {
    try {
      sourceNode.disconnect();
    } catch {}
    sourceNode = null;
  }

  if (silentGain) {
    try {
      silentGain.disconnect();
    } catch {}
    silentGain = null;
  }

  if (mediaStream) {
    for (const track of mediaStream.getTracks()) {
      track.stop();
    }
    mediaStream = null;
  }

  if (audioContext) {
    try {
      await audioContext.close();
    } catch {}
    audioContext = null;
  }
}

askBtn.addEventListener('click', () => {
  window.metatron.ask();
});

hideBtn.addEventListener('click', () => {
  window.metatron.hide();
});

listenPill.addEventListener('click', () => {
  window.metatron.toggleListening();
});

window.metatron.getSttState().then((state) => {
  setListeningIndicator(state.status);
  renderTranscript(state);
});

window.metatron.onSttControl(({ action }) => {
  if (action === 'start') {
    startMicCapture();
  } else if (action === 'stop') {
    stopMicCapture();
  }
});

window.metatron.onSttStatus((state) => {
  setListeningIndicator(state);
  if (state === 'listening') {
    clearError();
  }
});

window.metatron.onTranscriptUpdate((payload) => {
  renderTranscript(payload);
});

window.metatron.onSttError((message) => {
  showError(message);
  setStatus('error', 'Error');
});

window.metatron.onStreamStart(() => {
  clearError();
  responseEl.textContent = '';
  responseEl.classList.remove('empty');
  responseEl.classList.add('streaming');
  setStatus('streaming', 'Streaming…');
  scrollToBottom(responseScroll);
});

window.metatron.onStreamChunk((chunk) => {
  responseEl.textContent += chunk;
  scrollToBottom(responseScroll);
});

window.metatron.onStreamEnd(() => {
  responseEl.classList.remove('streaming');
  setStatus('', 'Ready');
  scrollToBottom(responseScroll);
});

window.metatron.onStreamError((message) => {
  responseEl.classList.remove('streaming');
  if (!responseEl.textContent.trim()) {
    responseEl.classList.add('empty');
    responseEl.textContent = 'Press ⌘↩ to try again.';
  }
  showError(message);
  setStatus('error', 'Error');
});
