# Metatron

A minimal macOS meeting assistant overlay built with Electron, Deepgram (`nova-3`), and the Gemini API.

## Features (Steps 1–4)

- Frameless, transparent, dark rounded always-on-top overlay that stays visible over other apps and across macOS Spaces.
- Dual-stream live transcription:
  - **Me** (microphone via `getUserMedia` + dedicated `AudioWorklet`, 16-bit PCM @ 16 kHz mono)
  - **Them** (system audio loopback via `setDisplayMediaRequestHandler` + `getDisplayMedia` with video track discarded + dedicated `AudioWorklet`, 16-bit PCM @ 16 kHz mono)
- Separate Deepgram `nova-3` WebSocket connections per source (`me` and `them`), each with independent `KeepAlive` during silence and exponential-backoff reconnection.
- Rolling ~3-minute timestamped transcript merged chronologically with color-coded **Me** and **Them** labels (lighter italic interim lines, normal finalized lines, auto-scrolling).
- Global shortcuts:
  - `Cmd+Shift+Space`: Toggle showing/hiding the overlay.
  - `Cmd+Shift+T`: Start/stop both microphone and system audio transcription together.
  - `Cmd+Enter`: Send the last ~2 minutes of labeled (`Me` / `Them`) transcript as `context` to Gemini and stream a 1–2 sentence suggested reply into the overlay.
- Isolated provider modules: `llm.js` (Gemini) and `stt.js` (Deepgram).
- Secure Electron setup (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, minimal `preload.js` IPC bridge).

## Prerequisites

- macOS 13+ (Microphone and **Screen & System Audio Recording** permissions granted to Electron / your terminal app)
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

- `main.js` — Electron main process, overlay window config, global shortcuts, macOS Microphone & Screen Recording permission checks, `setDisplayMediaRequestHandler` (`audio: 'loopback'`), merged rolling transcript buffer, and IPC wiring.
- `preload.js` — Secure `contextBridge` API exposed to the renderer as `window.metatron`.
- `renderer.html` — Frameless dark translucent overlay layout and styles (color-coded `Me` and `Them` transcript lines).
- `renderer.js` — Dual `AudioWorklet` capture pipelines (`me` mic + `them` system audio loopback) and overlay UI logic.
- `audio-processor.js` — `AudioWorkletProcessor` that mixes to mono and resamples audio to 16 kHz 16-bit PCM.
- `stt.js` — Isolated speech-to-text provider module (independent Deepgram `nova-3` WebSocket session per source).
- `llm.js` — Isolated LLM provider module (Gemini via `@google/genai`).
- `.env.example` — Template for required environment variables (`.env` is gitignored).
