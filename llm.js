const { GoogleGenAI } = require('@google/genai');

const DEFAULT_GEMINI_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-2.5-flash'];
const TRANSIENT_RETRY_DELAY_MS = 600;
const SYSTEM_INSTRUCTION =
  'You are a discreet real-time meeting assistant. In the transcript, "Them" is the other party on the call and "Me" is the user. Suggest what the user ("Me") should say next, in one or two concise sentences.';

function extractReadableMessage(error) {
  let msg = error && error.message ? String(error.message) : String(error || 'Unknown error');

  // @google/genai sometimes wraps JSON error bodies (occasionally double-encoded) inside error.message.
  for (let depth = 0; depth < 3; depth++) {
    const trimmed = msg.trim();
    if (!trimmed.startsWith('{')) break;
    try {
      const parsed = JSON.parse(trimmed);
      const next =
        (parsed && parsed.error && parsed.error.message) ||
        (parsed && parsed.message);
      if (typeof next === 'string' && next.trim()) {
        msg = next;
      } else {
        break;
      }
    } catch {
      break;
    }
  }

  return msg.trim();
}

function isTransientUnavailableError(error) {
  const raw = error && error.message ? String(error.message) : String(error || '');
  const status = error && (error.status || error.code);
  return (
    status === 503 ||
    /503|UNAVAILABLE|Service Unavailable|high demand|overloaded/i.test(raw)
  );
}

function isModelNotFoundError(error) {
  const raw = error && error.message ? String(error.message) : String(error || '');
  const status = error && (error.status || error.code);
  return status === 404 || /404|NOT_FOUND|is not found|not supported/i.test(raw);
}

function formatProviderError(error) {
  const raw = error && error.message ? String(error.message) : String(error || 'Unknown error');
  const clean = extractReadableMessage(error);

  if (/API key not valid|API_KEY_INVALID|invalid api key|unauthorized|401/i.test(raw)) {
    return 'Invalid Gemini API key. Check GEMINI_API_KEY in your .env file and restart Metatron.';
  }
  if (isTransientUnavailableError(error)) {
    return 'Gemini is temporarily experiencing high demand (503). Try again in a moment.';
  }
  if (/quota|rate limit|RESOURCE_EXHAUSTED|429/i.test(raw)) {
    return 'Gemini API rate limit or quota exceeded. Wait a moment and try again.';
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|network/i.test(raw)) {
    return 'Network error while contacting Gemini API. Check your internet connection and try again.';
  }
  if (isModelNotFoundError(error)) {
    return `Gemini model unavailable: ${clean}`;
  }

  return `LLM request failed: ${clean}`;
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
    }
  });
}

function getCandidateModels() {
  const configured = (process.env.GEMINI_MODEL || '').trim();
  const list = configured ? [configured, ...DEFAULT_GEMINI_MODELS] : [...DEFAULT_GEMINI_MODELS];
  return [...new Set(list)];
}

/**
 * Convert provider-agnostic messages + optional turn-1 image into Gemini Content[].
 * @param {string | Array<{ role: 'user' | 'assistant', text: string }>} input
 * @param {{ mimeType: string, data: Buffer | string } | undefined} image
 */
function buildGeminiContents(input, image) {
  const normalizedMessages = Array.isArray(input)
    ? input
    : [{ role: 'user', text: String(input || '') }];

  const contents = normalizedMessages.map((msg) => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(msg.text || '') }],
  }));

  if (image && image.data && contents.length > 0) {
    const base64Data = Buffer.isBuffer(image.data)
      ? image.data.toString('base64')
      : String(image.data);

    // Attach image inlineData only to the target user turn (never stored in history).
    for (let i = contents.length - 1; i >= 0; i--) {
      if (contents[i].role === 'user') {
        contents[i].parts.push({
          inlineData: {
            mimeType: image.mimeType || 'image/jpeg',
            data: base64Data,
          },
        });
        break;
      }
    }
  }

  return contents;
}

/**
 * Gemini provider implementation (single-turn, multi-turn, and multimodal vision).
 * To add another provider (e.g. Groq), implement an object with the same
 * `async *stream(input, { signal, systemInstruction, image, maxOutputTokens })`
 * method and swap `activeProvider` below.
 */
const geminiProvider = {
  name: 'gemini',

  async *stream(input, { signal, systemInstruction, image, maxOutputTokens } = {}) {
    const apiKey = (process.env.GEMINI_API_KEY || '').trim();
    if (!apiKey || apiKey === 'your_gemini_api_key_here') {
      throw new Error(
        'Missing GEMINI_API_KEY. Copy .env.example to .env, add your Gemini API key, and restart Metatron.'
      );
    }

    const ai = new GoogleGenAI({ apiKey });
    const models = getCandidateModels();
    const instruction = systemInstruction || SYSTEM_INSTRUCTION;
    const contents = buildGeminiContents(input, image);
    const hasImage = Boolean(image && image.data);
    let lastError = null;

    for (const model of models) {
      // Try once, plus one quick retry on transient 503 before falling back to the next model.
      for (let attempt = 0; attempt < 2; attempt++) {
        if (signal && signal.aborted) return;

        const attemptStart = Date.now();
        let yieldedAnyChunk = false;
        try {
          console.log(
            `[LLM:gemini] Calling model=${model} (turns=${contents.length}, vision=${hasImage}, maxTokens=${maxOutputTokens || 'default'}, attempt=${attempt + 1})`
          );

          const config = {
            systemInstruction: instruction,
            abortSignal: signal,
          };
          if (typeof maxOutputTokens === 'number' && maxOutputTokens > 0) {
            config.maxOutputTokens = maxOutputTokens;
          }

          const responseStream = await ai.models.generateContentStream({
            model,
            contents,
            config,
          });

          for await (const chunk of responseStream) {
            if (signal && signal.aborted) return;
            if (chunk && chunk.text) {
              if (!yieldedAnyChunk) {
                console.log(
                  `[LLM:gemini] First token from ${model} in ${Date.now() - attemptStart}ms`
                );
              }
              yieldedAnyChunk = true;
              yield chunk.text;
            }
          }

          console.log(
            `[LLM:gemini] Stream finished from ${model} in ${Date.now() - attemptStart}ms`
          );
          return;
        } catch (error) {
          if (signal && signal.aborted) return;
          lastError = error;

          // If streaming already started, don't splice a second response onto partial text.
          if (yieldedAnyChunk) {
            throw new Error(formatProviderError(error));
          }

          if (isTransientUnavailableError(error)) {
            if (attempt === 0) {
              console.warn(
                `[LLM:gemini] ${model} returned 503; retrying in ${TRANSIENT_RETRY_DELAY_MS}ms...`
              );
              await sleep(TRANSIENT_RETRY_DELAY_MS, signal);
              continue;
            }
            console.warn(`[LLM:gemini] ${model} still unavailable (503); trying fallback model...`);
            break;
          }

          if (isModelNotFoundError(error)) {
            console.warn(`[LLM:gemini] ${model} not found (404); trying fallback model...`);
            break;
          }

          // Non-retryable error (bad API key, quota, network, etc.).
          throw new Error(formatProviderError(error));
        }
      }
    }

    throw new Error(formatProviderError(lastError));
  },
};

// Swap this reference to switch providers (e.g. groqProvider) without touching main.js.
const activeProvider = geminiProvider;

/**
 * Stream completion text chunks from the active LLM provider.
 * @param {string | Array<{ role: 'user' | 'assistant', text: string }>} input
 * @param {{ signal?: AbortSignal, systemInstruction?: string, image?: { mimeType: string, data: Buffer | string }, maxOutputTokens?: number }} [options]
 * @returns {AsyncGenerator<string, void, unknown>}
 */
async function* streamResponse(input, options = {}) {
  yield* activeProvider.stream(input, options);
}

module.exports = {
  streamResponse,
  activeProvider,
};
