const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const listenPill = document.getElementById('listen-pill');
const listenLabel = document.getElementById('listen-label');
const modeBtn = document.getElementById('mode-btn');
const langSelect = document.getElementById('lang-select');
const snapBtn = document.getElementById('snap-btn');
const hideBtn = document.getElementById('hide-btn');
const modelTrigger = document.getElementById('model-trigger');
const activeProviderBadge = document.getElementById('active-provider-badge');
const activeModelLabel = document.getElementById('active-model-label');
const activeVisionBadge = document.getElementById('active-vision-badge');
const modelDropdown = document.getElementById('model-dropdown');
const errorBox = document.getElementById('error-box');
const screenshotBar = document.getElementById('screenshot-bar');
const screenshotThumb = document.getElementById('screenshot-thumb');
const screenshotTitle = document.getElementById('screenshot-title');
const screenshotMeta = document.getElementById('screenshot-meta');
const sendScreenshotBtn = document.getElementById('send-screenshot-btn');
const clearScreenshotBtn = document.getElementById('clear-screenshot-btn');
const chatSectionLabel = document.getElementById('chat-section-label');
const clearChatBtn = document.getElementById('clear-chat-btn');
const chatScroll = document.getElementById('chat-scroll');
const chatThread = document.getElementById('chat-thread');
const transcriptList = document.getElementById('transcript-list');
const transcriptScroll = document.getElementById('transcript-scroll');
const transcribingIndicator = document.getElementById('transcribing-indicator');
const clickthruBadge = document.getElementById('clickthru-badge');
const followupForm = document.getElementById('followup-form');
const followupInput = document.getElementById('followup-input');

const captures = {
  me: null,
  them: null,
};

let currentConfig = {
  language: 'cpp',
  mode: 'coding',
  selectedModel: '',
  models: [],
  activeModel: null,
};
let activeAssistantEl = null;
let activeAssistantBodyEl = null;
let activeAssistantRawText = '';

function hasActiveCapture() {
  return Boolean(captures.me || captures.them);
}

function updateTranscribingIndicator() {
  transcribingIndicator.classList.toggle('active', hasActiveCapture());
}

function setStatus(state, label) {
  statusDot.className = 'status-dot' + (state ? ` ${state}` : '');
  statusText.textContent = label;
}

function closeModelDropdown() {
  modelDropdown.classList.remove('open');
}

function renderModelSelector() {
  const active = currentConfig.activeModel;
  const models = Array.isArray(currentConfig.models) ? currentConfig.models : [];

  if (active) {
    activeProviderBadge.textContent = active.provider;
    activeProviderBadge.className = `provider-badge ${active.provider}`;
    activeModelLabel.textContent = active.label;
    activeVisionBadge.textContent = active.supportsVision ? 'Vision' : 'Text';
    activeVisionBadge.className = `vision-badge ${active.supportsVision ? 'yes' : 'no'}`;
  }

  modelDropdown.textContent = '';
  for (const entry of models) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className =
      'model-option' + (active && entry.key === active.key ? ' selected' : '');

    const left = document.createElement('span');
    left.className = 'model-option-left';

    const prov = document.createElement('span');
    prov.className = `provider-badge ${entry.provider}`;
    prov.textContent = entry.provider;

    const name = document.createElement('span');
    name.className = 'model-name';
    name.textContent = entry.label;

    left.appendChild(prov);
    left.appendChild(name);

    const vis = document.createElement('span');
    vis.className = `vision-badge ${entry.supportsVision ? 'yes' : 'no'}`;
    vis.textContent = entry.supportsVision ? 'Vision' : 'Text';

    btn.appendChild(left);
    btn.appendChild(vis);

    btn.addEventListener('click', () => {
      closeModelDropdown();
      window.metatron.setConfig({ selectedModel: entry.key });
    });

    modelDropdown.appendChild(btn);
  }
}

function applyConfigUI(cfg) {
  if (!cfg) return;
  currentConfig = { ...currentConfig, ...cfg };

  const isCoding = currentConfig.mode === 'coding';
  modeBtn.textContent = isCoding ? 'Coding' : 'Meeting';
  modeBtn.className = 'mode-btn' + (isCoding ? '' : ' meeting');
  chatSectionLabel.textContent = isCoding
    ? `Coding Assistant (${currentConfig.language})`
    : 'Meeting Assistant';

  // Ensure custom languages edited directly in config.json still show in the selector.
  const hasOption = Array.from(langSelect.options).some(
    (opt) => opt.value === currentConfig.language
  );
  if (!hasOption && currentConfig.language) {
    const opt = document.createElement('option');
    opt.value = currentConfig.language;
    opt.textContent = currentConfig.language;
    langSelect.appendChild(opt);
  }
  langSelect.value = currentConfig.language;

  renderModelSelector();

  // Clear stale non-vision warning automatically when user switches to a vision-capable model.
  if (
    currentConfig.activeModel &&
    currentConfig.activeModel.supportsVision &&
    errorBox.textContent.includes("can't read images")
  ) {
    clearError();
    setStatus('', 'Ready');
  }
}

function setListeningIndicator(status) {
  const overall = status && status.overall ? status.overall : 'stopped';
  const sources = (status && status.sources) || {};
  listenPill.className = 'listen-pill' + (overall !== 'stopped' ? ` ${overall}` : '');

  if (overall === 'listening') {
    const activeLabels = [];
    if (sources.me === 'listening') activeLabels.push('Me');
    if (sources.them === 'listening') activeLabels.push('Them');
    listenLabel.textContent =
      activeLabels.length > 0 ? `Listening (${activeLabels.join(' + ')})` : 'Listening';
  } else if (overall === 'connecting') {
    listenLabel.textContent = 'Connecting…';
  } else if (overall === 'reconnecting') {
    listenLabel.textContent = 'Reconnecting…';
  } else {
    listenLabel.textContent = 'Off';
  }
}

function renderScreenshot(summary) {
  if (!summary) {
    screenshotBar.classList.remove('visible');
    screenshotThumb.removeAttribute('src');
    screenshotMeta.textContent = '';
    return;
  }

  screenshotThumb.src = summary.thumbnailDataUrl;
  screenshotTitle.textContent = summary.sentInConversation
    ? 'Screenshot sent on Turn 1 (not re-sent on follow-ups)'
    : 'Screenshot attached';
  screenshotMeta.textContent = `${summary.width}×${summary.height} · ${summary.sizeKb} KB · ${summary.time}`;
  screenshotBar.classList.add('visible');
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.classList.add('visible');
}

function clearError() {
  errorBox.textContent = '';
  errorBox.classList.remove('visible');
}

function isNearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 60;
}

function scrollToBottom(el) {
  el.scrollTop = el.scrollHeight;
}

function clearChatPlaceholder() {
  const placeholder = chatThread.querySelector('.chat-empty');
  if (placeholder) placeholder.remove();
}

function showEmptyChatPlaceholder() {
  chatThread.textContent = '';
  const empty = document.createElement('div');
  empty.className = 'chat-empty';
  empty.textContent =
    '⌘⇧S snap screen · ⌘⇧↩ solve with screenshot · ⌘↩ ask transcript · ⌘⇧P switch model · type below for follow-ups.';
  chatThread.appendChild(empty);
  activeAssistantEl = null;
  activeAssistantBodyEl = null;
  activeAssistantRawText = '';
}

/**
 * Render inline markdown (**bold** and `code`) safely into DOM nodes.
 */
function appendInlineFormatted(container, text) {
  const tokenRegex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let lastIndex = 0;
  let match;

  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      container.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    }
    const token = match[0];
    if (token.startsWith('**') && token.endsWith('**')) {
      const strong = document.createElement('strong');
      strong.textContent = token.slice(2, -2);
      container.appendChild(strong);
    } else if (token.startsWith('`') && token.endsWith('`')) {
      const code = document.createElement('code');
      code.className = 'md-inline-code';
      code.textContent = token.slice(1, -1);
      container.appendChild(code);
    }
    lastIndex = tokenRegex.lastIndex;
  }

  if (lastIndex < text.length) {
    container.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
}

function buildCodeBlockElement(lang, codeText) {
  const wrapper = document.createElement('div');
  wrapper.className = 'code-block';

  const header = document.createElement('div');
  header.className = 'code-header';

  const langSpan = document.createElement('span');
  langSpan.className = 'code-lang';
  langSpan.textContent = lang || 'code';

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'copy-btn';
  copyBtn.textContent = 'Copy';
  copyBtn.addEventListener('click', async () => {
    try {
      await window.metatron.copyText(codeText);
      copyBtn.textContent = 'Copied!';
      copyBtn.classList.add('copied');
      setTimeout(() => {
        copyBtn.textContent = 'Copy';
        copyBtn.classList.remove('copied');
      }, 1500);
    } catch {
      copyBtn.textContent = 'Failed';
    }
  });

  header.appendChild(langSpan);
  header.appendChild(copyBtn);

  const pre = document.createElement('pre');
  pre.className = 'code-pre';
  const code = document.createElement('code');
  code.textContent = codeText;
  pre.appendChild(code);

  wrapper.appendChild(header);
  wrapper.appendChild(pre);
  return wrapper;
}

/**
 * Parse assistant markdown into text blocks and monospace fenced code blocks
 * (works cleanly even when a fence is still open mid-stream).
 */
function renderMarkdownInto(container, rawText) {
  container.textContent = '';
  if (!rawText) return;

  const lines = rawText.split('\n');
  let inCode = false;
  let codeLang = '';
  let codeLines = [];
  let textLines = [];

  const flushText = () => {
    if (textLines.length === 0) return;
    const content = textLines.join('\n').replace(/^\n+|\n+$/g, '');
    textLines = [];
    if (!content) return;

    const p = document.createElement('div');
    p.className = 'md-text';
    appendInlineFormatted(p, content);
    container.appendChild(p);
  };

  const flushCode = () => {
    const codeText = codeLines.join('\n');
    codeLines = [];
    container.appendChild(buildCodeBlockElement(codeLang, codeText));
    codeLang = '';
  };

  for (const line of lines) {
    const fenceMatch = line.match(/^```([a-zA-Z0-9_+#.-]*)\s*$/);
    if (fenceMatch) {
      if (!inCode) {
        flushText();
        inCode = true;
        codeLang = fenceMatch[1] || '';
      } else {
        flushCode();
        inCode = false;
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line);
    } else {
      textLines.push(line);
    }
  }

  if (inCode) {
    flushCode();
  } else {
    flushText();
  }
}

function createTranscriptRow(item, isInterim) {
  const source = item.source === 'them' ? 'them' : 'me';
  const line = document.createElement('div');
  line.className = `transcript-line source-${source}` + (isInterim ? ' interim' : '');

  const timeSpan = document.createElement('span');
  timeSpan.className = 'transcript-time';
  timeSpan.textContent = item.time;

  const speakerSpan = document.createElement('span');
  speakerSpan.className = `speaker-tag ${source}`;
  speakerSpan.textContent = `${item.label || (source === 'them' ? 'Them' : 'Me')}:`;

  line.appendChild(timeSpan);
  line.appendChild(speakerSpan);
  line.appendChild(document.createTextNode(item.text));
  return line;
}

function renderTranscript({ entries = [], interims = [] }) {
  transcriptList.textContent = '';

  if (entries.length === 0 && interims.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'transcript-empty';
    empty.textContent = hasActiveCapture()
      ? 'Listening… speak into your mic or play call audio.'
      : 'Not listening yet. Press ⌘⇧T to start.';
    transcriptList.appendChild(empty);
    return;
  }

  for (const entry of entries) {
    transcriptList.appendChild(createTranscriptRow(entry, false));
  }

  for (const interim of interims) {
    if (interim && interim.text) {
      transcriptList.appendChild(createTranscriptRow(interim, true));
    }
  }

  scrollToBottom(transcriptScroll);
}

async function createCapturePipeline(source, mediaStream) {
  const audioContext = new AudioContext();
  await audioContext.audioWorklet.addModule('./audio-processor.js');

  const sourceNode = audioContext.createMediaStreamSource(mediaStream);
  const workletNode = new AudioWorkletNode(audioContext, 'pcm-16k-processor');
  const silentGain = audioContext.createGain();
  silentGain.gain.value = 0;

  const pipeline = {
    source,
    mediaStream,
    audioContext,
    sourceNode,
    workletNode,
    silentGain,
    active: true,
  };

  workletNode.port.onmessage = (event) => {
    if (!pipeline.active || !event.data || !event.data.pcm) return;
    window.metatron.sendAudioChunk(source, new Uint8Array(event.data.pcm), event.data.rms || 0);
  };

  sourceNode.connect(workletNode);
  workletNode.connect(silentGain);
  silentGain.connect(audioContext.destination);

  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  console.log(
    `[Audio:${source}] Capturing at ${audioContext.sampleRate} Hz -> resampling to 16000 Hz mono 16-bit PCM`
  );
  return pipeline;
}

async function teardownCapture(source) {
  const pipeline = captures[source];
  if (!pipeline) {
    updateTranscribingIndicator();
    return;
  }
  captures[source] = null;
  pipeline.active = false;
  updateTranscribingIndicator();

  if (pipeline.workletNode) {
    pipeline.workletNode.port.onmessage = null;
    try {
      pipeline.workletNode.disconnect();
    } catch {}
  }

  if (pipeline.sourceNode) {
    try {
      pipeline.sourceNode.disconnect();
    } catch {}
  }

  if (pipeline.silentGain) {
    try {
      pipeline.silentGain.disconnect();
    } catch {}
  }

  if (pipeline.mediaStream) {
    for (const track of pipeline.mediaStream.getTracks()) {
      track.stop();
    }
  }

  if (pipeline.audioContext) {
    try {
      await pipeline.audioContext.close();
    } catch {}
  }
}

async function startMicCapture() {
  if (captures.me) return;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    captures.me = await createCapturePipeline('me', stream);
    updateTranscribingIndicator();
  } catch (error) {
    await teardownCapture('me');
    const msg =
      error && error.name === 'NotAllowedError'
        ? 'Microphone access denied. Enable Microphone permission in System Settings → Privacy & Security → Microphone and restart Metatron.'
        : `Microphone capture failed: ${error && error.message ? error.message : String(error)}`;
    window.metatron.reportCaptureError('me', msg);
  }
}

async function startSystemAudioCapture() {
  if (captures.them) return;

  try {
    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      audio: true,
      video: true,
    });

    // Immediately stop and discard all video tracks; we only want loopback audio.
    for (const videoTrack of displayStream.getVideoTracks()) {
      videoTrack.stop();
      displayStream.removeTrack(videoTrack);
    }

    const audioTracks = displayStream.getAudioTracks();
    if (audioTracks.length === 0) {
      throw new Error(
        'No system audio loopback track returned. Confirm Screen & System Audio Recording permission is enabled in System Settings and restart Metatron.'
      );
    }

    const audioOnlyStream = new MediaStream(audioTracks);
    audioTracks[0].addEventListener('ended', () => {
      if (captures.them) {
        console.warn('[Audio:them] System audio loopback track ended unexpectedly');
        window.metatron.reportCaptureError(
          'them',
          'System audio capture stopped. Press ⌘⇧T to restart listening.'
        );
      }
    });

    captures.them = await createCapturePipeline('them', audioOnlyStream);
    updateTranscribingIndicator();
  } catch (error) {
    await teardownCapture('them');
    const msg =
      error && error.name === 'NotAllowedError'
        ? 'System audio capture denied. Enable Screen & System Audio Recording in System Settings → Privacy & Security → Screen & System Audio Recording and restart Metatron.'
        : `System audio capture failed: ${error && error.message ? error.message : String(error)}`;
    window.metatron.reportCaptureError('them', msg);
  }
}

async function handleSttControl({ action, sources = ['me', 'them'] }) {
  if (action === 'start') {
    clearError();
    setStatus('', 'Ready');
    const tasks = [];
    if (sources.includes('me')) tasks.push(startMicCapture());
    if (sources.includes('them')) tasks.push(startSystemAudioCapture());
    await Promise.all(tasks);

    const state = await window.metatron.getSttState();
    renderTranscript(state);
  } else if (action === 'stop') {
    const tasks = [];
    if (sources.includes('me')) tasks.push(teardownCapture('me'));
    if (sources.includes('them')) tasks.push(teardownCapture('them'));
    await Promise.all(tasks);
  }
}

modelTrigger.addEventListener('click', (event) => {
  event.stopPropagation();
  modelDropdown.classList.toggle('open');
});

document.addEventListener('click', (event) => {
  if (!modelDropdown.contains(event.target) && !modelTrigger.contains(event.target)) {
    closeModelDropdown();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeModelDropdown();
  }
});

modeBtn.addEventListener('click', () => {
  const nextMode = currentConfig.mode === 'coding' ? 'meeting' : 'coding';
  window.metatron.setConfig({ mode: nextMode });
});

langSelect.addEventListener('change', () => {
  window.metatron.setConfig({ language: langSelect.value });
});

snapBtn.addEventListener('click', () => {
  window.metatron.captureScreenshot();
});

hideBtn.addEventListener('click', () => {
  window.metatron.hide();
});

listenPill.addEventListener('click', () => {
  window.metatron.toggleListening();
});

sendScreenshotBtn.addEventListener('click', () => {
  window.metatron.askWithScreenshot();
});

clearScreenshotBtn.addEventListener('click', () => {
  window.metatron.clearScreenshot();
});

clearChatBtn.addEventListener('click', () => {
  window.metatron.clearChat();
});

followupForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = followupInput.value.trim();
  if (!text) return;
  followupInput.value = '';
  window.metatron.sendFollowUp(text);
});

window.metatron.getConfig().then(applyConfigUI);
window.metatron.onConfigUpdate(applyConfigUI);

if (window.metatron.getClickThrough) {
  window.metatron.getClickThrough().then((active) => {
    if (clickthruBadge) {
      clickthruBadge.classList.toggle('active', Boolean(active));
    }
  });
}

window.metatron.onClickThroughChange((active) => {
  if (clickthruBadge) {
    clickthruBadge.classList.toggle('active', Boolean(active));
  }
});

window.metatron.getSttState().then((state) => {
  setListeningIndicator(state.status);
  renderTranscript(state);
});

window.metatron.getScreenshotState().then((summary) => {
  renderScreenshot(summary);
});

window.metatron.onSttControl((payload) => {
  handleSttControl(payload);
});

window.metatron.onSttStatus((status) => {
  setListeningIndicator(status);
});

window.metatron.onTranscriptUpdate((payload) => {
  renderTranscript(payload);
});

window.metatron.onScreenshotUpdate((summary) => {
  if (summary) {
    if (currentConfig.activeModel && currentConfig.activeModel.supportsVision) {
      clearError();
      setStatus('', 'Ready');
    }
  }
  renderScreenshot(summary);
});

window.metatron.onChatReset(() => {
  clearError();
  setStatus('', 'Ready');
  showEmptyChatPlaceholder();
});

window.metatron.onSttError((message) => {
  showError(message);
  setStatus('error', 'Warning');
});

window.metatron.onStreamStart(({ reset, userLabel, includeScreenshot, modelLabel } = {}) => {
  clearError();
  closeModelDropdown();
  if (reset) {
    chatThread.textContent = '';
  } else {
    clearChatPlaceholder();
  }

  if (activeAssistantEl) {
    activeAssistantEl.classList.remove('streaming');
  }

  if (userLabel) {
    const userMsg = document.createElement('div');
    userMsg.className = 'chat-msg user';
    userMsg.textContent = userLabel;
    chatThread.appendChild(userMsg);
  }

  const assistantMsg = document.createElement('div');
  assistantMsg.className = 'chat-msg assistant streaming';

  if (modelLabel) {
    const metaEl = document.createElement('div');
    metaEl.className = 'assistant-meta';
    metaEl.textContent = modelLabel;
    assistantMsg.appendChild(metaEl);
  }

  const bodyEl = document.createElement('div');
  bodyEl.className = 'assistant-body';
  assistantMsg.appendChild(bodyEl);
  chatThread.appendChild(assistantMsg);

  activeAssistantEl = assistantMsg;
  activeAssistantBodyEl = bodyEl;
  activeAssistantRawText = '';

  setStatus('streaming', includeScreenshot ? 'Streaming (+img)…' : 'Streaming…');
  scrollToBottom(chatScroll);
});

window.metatron.onStreamChunk((chunk) => {
  if (!activeAssistantBodyEl) return;
  const shouldAutoScroll = isNearBottom(chatScroll);
  activeAssistantRawText += chunk;
  renderMarkdownInto(activeAssistantBodyEl, activeAssistantRawText);
  if (shouldAutoScroll) {
    scrollToBottom(chatScroll);
  }
});

window.metatron.onStreamEnd(() => {
  if (activeAssistantEl) {
    activeAssistantEl.classList.remove('streaming');
  }
  activeAssistantEl = null;
  activeAssistantBodyEl = null;
  setStatus('', 'Ready');
});

window.metatron.onStreamError((message) => {
  if (activeAssistantEl) {
    activeAssistantEl.classList.remove('streaming');
    if (!activeAssistantRawText.trim()) {
      activeAssistantEl.remove();
    }
    activeAssistantEl = null;
    activeAssistantBodyEl = null;
  }
  showError(message);
  setStatus('error', 'Error');
});
