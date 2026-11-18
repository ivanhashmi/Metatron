const WebSocket = require('ws');

const DEEPGRAM_WS_URL =
  'wss://api.deepgram.com/v1/listen' +
  '?model=nova-3' +
  '&encoding=linear16' +
  '&sample_rate=16000' +
  '&channels=1' +
  '&interim_results=true' +
  '&smart_format=true';

const KEEPALIVE_INTERVAL_MS = 5000;
const SILENCE_RMS_THRESHOLD = 0.008;
const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 10000;
const LOG_EVERY_N_FRAMES = 25; // ~2.5s at 100ms chunks

/**
 * Deepgram Nova-3 streaming speech-to-text provider.
 * Each call to `createSession({ source, onStatus, onTranscript, onError })`
 * manages its own independent WebSocket connection, keepalive loop, and
 * exponential-backoff reconnect cycle for that audio source ("me" or "them").
 *
 * To swap providers later, implement the same `createSession` interface and
 * change `activeProvider` below.
 */
const deepgramProvider = {
  name: 'deepgram',

  createSession({ source = 'me', onStatus, onTranscript, onError } = {}) {
    const tag = `[STT:${source}]`;
    let ws = null;
    let active = false;
    let reconnectTimer = null;
    let keepAliveTimer = null;
    let reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
    let framesSent = 0;
    let lastAudioSentAt = 0;
    let lastSpeechDetectedAt = 0;

    const emitStatus = (state) => {
      if (typeof onStatus === 'function') onStatus(state, source);
    };

    const emitTranscript = (payload) => {
      if (typeof onTranscript === 'function') {
        onTranscript({ ...payload, source });
      }
    };

    const emitError = (message) => {
      if (typeof onError === 'function') onError(message, source);
    };

    function clearTimers() {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
      }
    }

    function startKeepAlive() {
      if (keepAliveTimer) clearInterval(keepAliveTimer);
      keepAliveTimer = setInterval(() => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        const now = Date.now();
        const isSilent = now - lastSpeechDetectedAt >= KEEPALIVE_INTERVAL_MS;
        const isIdle = now - lastAudioSentAt >= KEEPALIVE_INTERVAL_MS - 500;
        if (isSilent || isIdle) {
          try {
            ws.send(JSON.stringify({ type: 'KeepAlive' }));
            console.log(`${tag} Sent Deepgram KeepAlive (silence/idle)`);
          } catch (err) {
            console.warn(`${tag} Failed to send KeepAlive:`, err.message);
          }
        }
      }, KEEPALIVE_INTERVAL_MS);
    }

    function scheduleReconnect(reason) {
      if (!active) return;
      clearTimers();
      emitStatus('reconnecting');
      const delay = reconnectDelay;
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
      console.log(`${tag} Reconnecting to Deepgram in ${delay}ms (${reason})...`);
      reconnectTimer = setTimeout(() => {
        if (active) connect();
      }, delay);
    }

    function connect() {
      const apiKey = (process.env.DEEPGRAM_API_KEY || '').trim();
      if (!apiKey || apiKey === 'your_deepgram_api_key_here') {
        active = false;
        emitStatus('stopped');
        emitError(
          'Missing DEEPGRAM_API_KEY. Add your Deepgram API key to .env and restart Metatron.'
        );
        return;
      }

      emitStatus(reconnectDelay > INITIAL_RECONNECT_DELAY_MS ? 'reconnecting' : 'connecting');
      console.log(`${tag} Connecting to Deepgram streaming API (model=nova-3)...`);

      let fatalAuthError = false;
      const socket = new WebSocket(DEEPGRAM_WS_URL, {
        headers: {
          Authorization: `Token ${apiKey}`,
        },
      });
      ws = socket;

      socket.on('open', () => {
        if (ws !== socket || !active) {
          socket.close();
          return;
        }
        reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
        framesSent = 0;
        lastAudioSentAt = Date.now();
        lastSpeechDetectedAt = Date.now();
        console.log(`${tag} Connected to Deepgram WebSocket`);
        emitStatus('listening');
        startKeepAlive();
      });

      socket.on('message', (raw) => {
        if (ws !== socket) return;
        let data;
        try {
          data = JSON.parse(raw.toString());
        } catch (err) {
          console.warn(`${tag} Non-JSON message from Deepgram:`, err.message);
          return;
        }

        if (data.type === 'Results') {
          const alt =
            data.channel &&
            Array.isArray(data.channel.alternatives) &&
            data.channel.alternatives[0];
          const text = alt && typeof alt.transcript === 'string' ? alt.transcript.trim() : '';
          const isFinal = Boolean(data.is_final);
          const speechFinal = Boolean(data.speech_final);

          if (text) {
            console.log(`${tag} Deepgram ${isFinal ? 'FINAL' : 'INTERIM'}: "${text}"`);
          }

          emitTranscript({
            text,
            isFinal,
            speechFinal,
            timestamp: Date.now(),
          });
        } else if (data.type === 'Metadata') {
          console.log(`${tag} Deepgram Metadata received (request_id=${data.request_id || 'n/a'})`);
        } else if (data.type === 'Error' || data.err_code) {
          const msg = data.description || data.message || data.err_msg || 'Deepgram stream error';
          console.error(`${tag} Deepgram error message:`, msg);
          emitError(`Deepgram (${source}) error: ${msg}`);
        }
      });

      socket.on('unexpected-response', (_req, res) => {
        const statusCode = res && res.statusCode;
        console.error(`${tag} Deepgram unexpected HTTP response: ${statusCode}`);
        if (statusCode === 401 || statusCode === 403) {
          fatalAuthError = true;
          active = false;
          clearTimers();
          emitStatus('stopped');
          emitError(
            `Invalid Deepgram API key (HTTP ${statusCode}). Check DEEPGRAM_API_KEY in .env and restart Metatron.`
          );
        }
      });

      socket.on('error', (err) => {
        if (ws !== socket) return;
        console.error(`${tag} Deepgram WebSocket error:`, err.message);
        if (!fatalAuthError && !active) {
          emitError(`Deepgram (${source}) connection error: ${err.message}`);
        }
      });

      socket.on('close', (code, reasonBuf) => {
        if (ws !== socket) return;
        const reason = reasonBuf ? reasonBuf.toString() : '';
        console.log(`${tag} Deepgram WebSocket closed (code=${code}, reason="${reason}")`);
        ws = null;
        if (keepAliveTimer) {
          clearInterval(keepAliveTimer);
          keepAliveTimer = null;
        }

        if (active && !fatalAuthError) {
          scheduleReconnect(`close code ${code}`);
        } else if (!fatalAuthError) {
          emitStatus('stopped');
        }
      });
    }

    return {
      source,

      start() {
        if (active) return true;
        const apiKey = (process.env.DEEPGRAM_API_KEY || '').trim();
        if (!apiKey || apiKey === 'your_deepgram_api_key_here') {
          emitStatus('stopped');
          emitError(
            'Missing DEEPGRAM_API_KEY. Add your Deepgram API key to .env and restart Metatron.'
          );
          return false;
        }
        active = true;
        reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
        connect();
        return true;
      },

      sendAudio(pcmBuffer, rms = 0) {
        if (!active || !ws || ws.readyState !== WebSocket.OPEN) {
          return false;
        }
        try {
          ws.send(pcmBuffer);
          framesSent += 1;
          const now = Date.now();
          lastAudioSentAt = now;
          if (rms >= SILENCE_RMS_THRESHOLD) {
            lastSpeechDetectedAt = now;
          }
          if (framesSent === 1 || framesSent % LOG_EVERY_N_FRAMES === 0) {
            console.log(
              `${tag} Sent audio frame #${framesSent} (${pcmBuffer.byteLength} bytes, rms=${rms.toFixed(4)})`
            );
          }
          return true;
        } catch (err) {
          console.error(`${tag} Failed to send audio frame:`, err.message);
          return false;
        }
      },

      stop() {
        if (!active && !ws) {
          emitStatus('stopped');
          return;
        }
        active = false;
        clearTimers();
        const socket = ws;
        ws = null;

        if (socket) {
          if (socket.readyState === WebSocket.OPEN) {
            try {
              socket.send(JSON.stringify({ type: 'CloseStream' }));
              console.log(`${tag} Sent Deepgram CloseStream`);
            } catch (err) {
              console.warn(`${tag} Failed to send CloseStream:`, err.message);
            }
            setTimeout(() => {
              if (
                socket.readyState === WebSocket.OPEN ||
                socket.readyState === WebSocket.CLOSING
              ) {
                socket.terminate();
              }
            }, 500);
          } else {
            socket.terminate();
          }
        }

        emitStatus('stopped');
        console.log(`${tag} Transcription stopped`);
      },
    };
  },
};

const activeProvider = deepgramProvider;

function createSttSession(handlers) {
  return activeProvider.createSession(handlers);
}

module.exports = {
  createSttSession,
  activeProvider,
};
