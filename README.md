# Metatron

A minimal macOS meeting & coding assistant overlay built with Electron, Deepgram (`nova-3`), and the Gemini API.

## Features

- Frameless, transparent, dark rounded always-on-top overlay that stays visible over other apps and across macOS Spaces.
- **Coding & Meeting modes** with persistent settings in `config.json` (default `mode: "coding"`, `language: "cpp"`).
  - **Coding mode**: returns full solutions (Approach, complete commented Code, Complexity, Edge Cases) with raised `maxOutputTokens` (`8192`) and monospace code blocks with a one-click **Copy** button.
  - **Meeting mode**: returns concise 1–2 sentence suggestions for what `"Me"` should say next based on what `"Them"` and `"Me"` discussed.
- **Multi-turn conversation**: type follow-ups (e.g., `"give the full solution"`, `"optimize it"`, `"explain line 5"`, `"switch to Java"`) in the bottom input bar and press `Enter`.
  - Screenshots are transmitted **only on Turn 1** — never re-sent on follow-up turns — to keep follow-ups fast and cheap.
- **Dual-stream live transcription**:
  - **Me** (microphone via `getUserMedia` + dedicated `AudioWorklet`, 16-bit PCM @ 16 kHz mono)
  - **Them** (system audio loopback via `setDisplayMediaRequestHandler` + `getDisplayMedia` with video track discarded + dedicated `AudioWorklet`, 16-bit PCM @ 16 kHz mono)
  - Separate Deepgram `nova-3` WebSocket connections per source with independent `KeepAlive` and exponential-backoff reconnection.
  - Rolling ~3-minute timestamped transcript merged chronologically with color-coded **Me** and **Them** labels.
- **On-demand screenshot capture**: captures the primary screen (hiding Metatron during capture), downscales the longest side to `~1280px` JPEG, previews a thumbnail in the overlay, and only sends when explicitly triggered.
- **Global shortcuts**:
  - `Cmd+Shift+Space`: Toggle showing/hiding the overlay.
  - `Cmd+Shift+T`: Start/stop both microphone and system audio transcription together.
  - `Cmd+Enter`: Send the last ~2 minutes of labeled (`Me` / `Them`) transcript to Gemini (never sends screenshots automatically).
  - `Cmd+Shift+S`: Capture primary screen screenshot and attach it to the overlay.
  - `Cmd+Shift+Enter`: Start a fresh turn sending the attached screenshot + last ~2 minutes of labeled transcript to Gemini.
  - `Cmd+Shift+X`: Clear the attached screenshot.
  - `Enter` (in overlay input): Send typed follow-up along with text-only conversation history.
- Isolated provider modules: `llm.js` (Gemini text, multi-turn, vision) and `stt.js` (Deepgram).
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

   *(Optional)* Set `GEMINI_MODEL` in `.env` to override the default vision-capable model (`gemini-3.5-flash-lite`, with automatic retry and fallback on transient `503` high-demand errors).

4. *(Optional)* Customize `config.json` (or switch directly in the overlay header):

   ```json
   {
     "language": "cpp",
     "mode": "coding"
   }
   ```

## Run

```bash
npm start
```

## Project Structure

- `main.js` — Electron main process, config persistence (`config.json`), overlay window, global shortcuts, macOS Microphone & Screen Recording permission checks, `setDisplayMediaRequestHandler` (`audio: 'loopback'`), on-demand screen capture, multi-turn conversation history, merged rolling transcript buffer, and IPC wiring.
- `preload.js` — Secure `contextBridge` API exposed to the renderer as `window.metatron`.
- `renderer.html` — Frameless dark translucent overlay layout and styles (monospace code blocks + Copy button, screenshot bar, follow-up input, color-coded transcript).
- `renderer.js` — Dual `AudioWorklet` capture pipelines, safe markdown/code-block renderer, multi-turn chat UI, and config controls.
- `audio-processor.js` — `AudioWorkletProcessor` that mixes to mono and resamples audio to 16 kHz 16-bit PCM.
- `stt.js` — Isolated speech-to-text provider module (independent Deepgram `nova-3` WebSocket session per source).
- `llm.js` — Isolated LLM provider module (Gemini single-turn, multi-turn, and multimodal vision via `@google/genai`).
- `config.json` — Persistent user preferences (`language`, `mode`).
- `.env.example` — Template for required environment variables (`.env` is gitignored).
