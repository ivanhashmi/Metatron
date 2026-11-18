const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const promptPreview = document.getElementById('prompt-preview');
const responseEl = document.getElementById('response');
const errorBox = document.getElementById('error-box');
const contentEl = document.getElementById('content');
const askBtn = document.getElementById('ask-btn');
const hideBtn = document.getElementById('hide-btn');

function setStatus(state, label) {
  statusDot.className = 'status-dot' + (state ? ` ${state}` : '');
  statusText.textContent = label;
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.classList.add('visible');
}

function clearError() {
  errorBox.textContent = '';
  errorBox.classList.remove('visible');
}

function scrollToBottom() {
  contentEl.scrollTop = contentEl.scrollHeight;
}

askBtn.addEventListener('click', () => {
  window.metatron.ask();
});

hideBtn.addEventListener('click', () => {
  window.metatron.hide();
});

window.metatron.getContext().then((ctx) => {
  if (ctx) {
    promptPreview.textContent = `Context: ${ctx}`;
  }
});

window.metatron.onStreamStart(({ context }) => {
  clearError();
  if (context) {
    promptPreview.textContent = `Context: ${context}`;
  }
  responseEl.textContent = '';
  responseEl.classList.remove('empty');
  responseEl.classList.add('streaming');
  setStatus('streaming', 'Streaming…');
  scrollToBottom();
});

window.metatron.onStreamChunk((chunk) => {
  responseEl.textContent += chunk;
  scrollToBottom();
});

window.metatron.onStreamEnd(() => {
  responseEl.classList.remove('streaming');
  setStatus('', 'Ready');
  scrollToBottom();
});

window.metatron.onStreamError((message) => {
  responseEl.classList.remove('streaming');
  if (!responseEl.textContent.trim()) {
    responseEl.classList.add('empty');
    responseEl.textContent = 'Press ⌘↩ to try again.';
  }
  showError(message);
  setStatus('error', 'Error');
  scrollToBottom();
});
