# Metatron

A minimal macOS meeting & coding assistant overlay built with Electron, Deepgram (`nova-3`), Gemini, and Groq.

## Features

- Frameless, transparent, dark rounded always-on-top overlay that stays visible over other apps and across macOS Spaces.
- **Multi-provider LLM switching (Gemini & Groq)**:
  - Editable model catalog in `models.json` (`provider`, `model`, `label`, `supportsVision`, `maxOutputTokens`).
  - Top model bar showing the active provider/model and Vision/Text capability.
  - Press `Cmd+Shift+P` to cycle models or click the model pill to pick from a dropdown; your last selection persists in `config.json`.
  - Automatically guards screenshots so images are only sent to vision-capable models (`supportsVision: true`), showing a clear message otherwise.
  - Per-provider error handling (including `"Rate limited, try another model"` on HTTP `429` and clear missing API key errors) plus per-request provider/model/TTFT/total latency logging.
- **Coding & Meeting modes** with persistent settings in `config.json` (default `mode: "coding"`, `language: "cpp"`).
  - **Coding mode**: returns full solutions (Approach, complete commented Code, Complexity, Edge Cases) with raised `maxOutputTokens` (`8192`) and monospace code blocks with a one-click **Copy** button.
  - **Meeting mode**: returns concise 1–2 sentence suggestions (`maxOutputTokens: 1024`) for what `"Me"` should say next based on `"Them"` and `"Me"`.
- **Multi-turn conversation**: type follow-ups (e.g., `"give the full solution"`, `"optimize it"`, `"explain line 5"`, `"switch to Java"`) in the bottom input bar and press `Enter`.
  - Screenshots are transmitted **only on Turn 1** — never re-sent on follow-up turns — to keep follow-ups fast and cheap.
- **Dual-stream live transcription**:
  - **Me** (microphone via `getUserMedia` + dedicated `AudioWorklet`, 16-bit PCM @ 16 kHz mono)
  - **Them** (system audio loopback via `setDisplayMediaRequestHandler` + `getDisplayMedia` with video track discarded + dedicated `AudioWorklet`, 16-bit PCM @ 16 kHz mono)
  - Separate Deepgram `nova-3` WebSocket connections per source with independent `KeepAlive` and exponential-backoff reconnection.
- **Global shortcuts**:
  - `Cmd+Shift+Space`: Toggle showing/hiding the overlay.
  - `Cmd+Shift+P`: Cycle through configured models in `models.json`.
  - `Cmd+Shift+T`: Start/stop both microphone and system audio transcription together.
  - `Cmd+Enter`: Send the last ~2 minutes of labeled (`Me` / `Them`) transcript (never sends screenshots automatically).
  - `Cmd+Shift+S`: Capture primary screen screenshot and attach it to the overlay.
  - `Cmd+Shift+Enter`: Start a fresh turn sending the attached screenshot + last ~2 minutes of labeled transcript (vision models only).
  - `Cmd+Shift+X`: Clear the attached screenshot.
  - `Enter` (in overlay input): Send typed follow-up along with text-only conversation history.

## Prerequisites

- macOS 13+ (Microphone and **Screen & System Audio Recording** permissions granted to Electron / your terminal app)
- Node.js 20+ and npm
- API keys in `.env`:
  - `GEMINI_API_KEY` from [Google AI Studio](https://aistudio.google.com/apikey)
  - `GROQ_API_KEY` from [Groq Console](https://console.groq.com/keys)
  - `DEEPGRAM_API_KEY` from [Deepgram Console](https://console.deepgram.com/)

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create or update `.env` from `.env.example`:

   ```bash
   cp .env.example .env
   ```

   ```env
   GEMINI_API_KEY=your_real_gemini_key
   GROQ_API_KEY=your_real_groq_key
   DEEPGRAM_API_KEY=your_real_deepgram_key
   ```

3. *(Optional)* Edit `models.json` to add/remove/reorder Gemini or Groq models without touching code, or customize `config.json` (`language`, `mode`, `selectedModel`).

## Run

```bash
npm start
```

## Project Structure

- `main.js` — Electron main process, `models.json` & `config.json` management, overlay window, global shortcuts, macOS permissions, screen capture, multi-turn history, transcript buffer, and IPC.
- `llm.js` — Multi-provider LLM interface with `gemini` (`contents/parts`) and `groq` (OpenAI-compatible SSE `messages` + base64 data URL images), error normalization, and latency logging.
- `models.json` — Editable model catalog (`provider`, `model`, `label`, `supportsVision`, `maxOutputTokens`).
- `config.json` — Persistent user preferences (`language`, `mode`, `selectedModel`).
- `stt.js` — Isolated Deepgram `nova-3` streaming WebSocket provider per source (`me`, `them`).
- `preload.js` — Secure `contextBridge` API (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`).
- `renderer.html` & `renderer.js` — Model switcher bar/dropdown, chat thread with monospace code blocks + Copy button, screenshot bar, follow-up input, and dual `AudioWorklet` capture.
- `audio-processor.js` — `AudioWorkletProcessor` resampling to 16 kHz mono 16-bit PCM.
