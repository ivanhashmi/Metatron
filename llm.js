const { GoogleGenAI } = require('@google/genai');

const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
const SYSTEM_INSTRUCTION =
  'You are Metatron, a concise real-time meeting assistant. Respond briefly and directly so the user can glance at your answer during a live meeting.';

function formatProviderError(error) {
  const raw = error && error.message ? String(error.message) : String(error || 'Unknown error');

  if (/API key not valid|API_KEY_INVALID|invalid api key|unauthorized|401/i.test(raw)) {
    return 'Invalid Gemini API key. Check GEMINI_API_KEY in your .env file and restart Metatron.';
  }
  if (/quota|rate limit|RESOURCE_EXHAUSTED|429/i.test(raw)) {
    return 'Gemini API rate limit or quota exceeded. Wait a moment and try again.';
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|network/i.test(raw)) {
    return 'Network error while contacting Gemini API. Check your internet connection and try again.';
  }
  if (/not found|404/i.test(raw)) {
    return `Gemini model error: ${raw}`;
  }

  return `LLM request failed: ${raw}`;
}

/**
 * Gemini provider implementation.
 * To add another provider (e.g. Groq), implement an object with the same
 * `async *stream(prompt, { signal })` method and swap `activeProvider` below.
 */
const geminiProvider = {
  name: 'gemini',

  async *stream(prompt, { signal } = {}) {
    const apiKey = (process.env.GEMINI_API_KEY || '').trim();
    if (!apiKey || apiKey === 'your_gemini_api_key_here') {
      throw new Error(
        'Missing GEMINI_API_KEY. Copy .env.example to .env, add your Gemini API key, and restart Metatron.'
      );
    }

    const model = (process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL).trim();
    const ai = new GoogleGenAI({ apiKey });

    let responseStream;
    try {
      responseStream = await ai.models.generateContentStream({
        model,
        contents: prompt,
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          abortSignal: signal,
        },
      });
    } catch (error) {
      if (signal && signal.aborted) return;
      throw new Error(formatProviderError(error));
    }

    try {
      for await (const chunk of responseStream) {
        if (signal && signal.aborted) return;
        if (chunk && chunk.text) {
          yield chunk.text;
        }
      }
    } catch (error) {
      if (signal && signal.aborted) return;
      throw new Error(formatProviderError(error));
    }
  },
};

// Swap this reference to switch providers (e.g. groqProvider) without touching main.js.
const activeProvider = geminiProvider;

/**
 * Stream completion text chunks from the active LLM provider.
 * @param {string} prompt
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {AsyncGenerator<string, void, unknown>}
 */
async function* streamResponse(prompt, options = {}) {
  yield* activeProvider.stream(prompt, options);
}

module.exports = {
  streamResponse,
  activeProvider,
};
