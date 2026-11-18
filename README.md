# Metatron

A minimal macOS meeting assistant overlay built with Electron, Deepgram (`nova-3`), and the Gemini API.

## Features (Steps 1–3)

- Frameless, transparent, dark rounded always-on-top overlay that stays visible over other apps and across macOS Spaces.
- Live microphone transcription via `getUserMedia` + `AudioWorklet` (16-bit PCM @ 16 kHz mono) streamed over IPC to Deepgram's `nova-3` WebSocket API with `interim_results` and `smart_format`.
- Graceful WebSocket reconnection and automatic `KeepAlive` messages during silence.
- Rolling ~3-minute timestamped transcript buffer in the overlay (lighter italic interim lines, normal finalized lines, auto-scrolling).
- Global shortcuts:
  - `Cmd+Shift+Space`: Toggle showing/hiding the overlay.
  - `Cmd+Shift+T`: Start/stop live microphone transcription (with listening status indicator in the overlay).
  - `Cmd+Enter`: Send the last ~2 minutes of rolling transcript as `context` to Gemini and stream a 1–2 sentence suggested reply into the overlay.
- Isolated provider modules: `llm.js` (Gemini) and `stt.js` (Deepgram).
- Secure Electron setup (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, minimal `preload.js` IPC bridge).

## Prerequisites

- macOS (Microphone permission granted to your terminal / Electron)
- Node.js 20+ and npm
- A Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey)
- A Deepgram API key from [Deepgram Console](https://console.deepgram.com/)

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create your `.env` file from the example:

   ```bash
   cp .env.example .env
   ```

3. Open `.env` and add your API keys:

   ```env
   GEMINI_API_KEY=your_real_gemini_key
   DEEPGRAM_API_KEY=your_real_deepgram_key
   ```

   *(Optional)* Set `GEMINI_MODEL` in `.env` to override the default model (`gemini-3.5-flash-lite`, with automatic retry and fallback on transient `503` high-demand errors).

## Run

```bash
npm start
```

## Project Structure

- `main.js` — Electron main process, overlay window config, global shortcuts, macOS mic permission handling, rolling transcript buffer, and IPC wiring.
- `preload.js` — Secure `contextBridge` API exposed to the renderer as `window.metatron`.
- `renderer.html` — Frameless dark translucent overlay layout and styles.
- `renderer.js` — Renderer UI logic, `getUserMedia` + `AudioWorklet` capture, and streaming display.
- `audio-processor.js` — `AudioWorkletProcessor` that resamples mic input to 16 kHz mono 16-bit PCM.
- `stt.js` — Isolated speech-to-text provider module (Deepgram `nova-3` WebSocket streaming, keepalive, reconnect).
- `llm.js` — Isolated LLM provider module (Gemini via `@google/genai`).
- `.env.example` — Template for required environment variables (`.env` is gitignored).
