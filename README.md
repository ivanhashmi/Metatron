# Metatron

A minimal macOS meeting assistant overlay built with Electron and the Gemini API.

## Features (Steps 1–2)

- Frameless, transparent, dark rounded always-on-top overlay (`400×300`) that stays visible over other apps and across macOS Spaces.
- Draggable header and footer bar.
- Global shortcuts:
  - `Cmd+Shift+Space`: Toggle showing/hiding the overlay.
  - `Cmd+Enter`: Send the `context` prompt in `main.js` to Gemini and stream the response into the overlay token by token.
- Provider-isolated LLM layer in `llm.js` so Gemini can be swapped for Groq or another provider later.
- Secure Electron setup (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, minimal `preload.js` IPC bridge).

## Prerequisites

- macOS
- Node.js 20+ and npm
- A Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey)

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create your `.env` file from the example:

   ```bash
   cp .env.example .env
   ```

3. Open `.env` and replace `your_gemini_api_key_here` with your real Gemini API key:

   ```env
   GEMINI_API_KEY=your_real_key_here
   ```

   *(Optional)* Set `GEMINI_MODEL` in `.env` to override the default model (`gemini-3.8-flash`).

## Run

```bash
npm start
```

## Project Structure

- `main.js` — Electron main process, overlay window config, global shortcuts, IPC, and hardcoded `context` variable.
- `preload.js` — Secure `contextBridge` API exposed to the renderer as `window.metatron`.
- `renderer.html` — Frameless dark translucent overlay layout and styles.
- `renderer.js` — Renderer UI logic for streaming chunks and error display.
- `llm.js` — Isolated LLM provider module (currently Gemini via `@google/genai`).
- `.env.example` — Template for required environment variables (`.env` is gitignored).
