const { GoogleGenAI } = require('@google/genai');

const GROQ_CHAT_COMPLETIONS_URL = 'https://api.groq.com/openai/v1/chat/completions';
const TRANSIENT_RETRY_DELAY_MS = 600;

function extractReadableMessage(error) {
  let msg = error && error.message ? String(error.message) : String(error || 'Unknown error');

  // Providers/SDKs sometimes wrap JSON error bodies (occasionally double-encoded) inside error.message.
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

function isRateLimitError(status, raw) {
  return (
    status === 429 ||
    /429|rate[_\s-]?limit|quota|RESOURCE_EXHAUSTED|too many requests/i.test(raw)
  );
}

function isTransientUnavailableError(status, raw) {
  return (
    status === 503 ||
    status === 502 ||
    /503|UNAVAILABLE|Service Unavailable|high demand|overloaded|bad gateway/i.test(raw)
  );
}

function isAuthError(status, raw) {
  return (
    status === 401 ||
    status === 403 ||
    /API key not valid|API_KEY_INVALID|invalid[_\s-]?api[_\s-]?key|unauthorized|authentication/i.test(
      raw
    )
  );
}

function isNetworkError(raw) {
  return /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|fetch failed|network/i.test(raw);
}

function formatGeminiError(error) {
  const raw = error && error.message ? String(error.message) : String(error || 'Unknown error');
  const status = error && (error.status || error.code);
  const clean = extractReadableMessage(error);

  if (isAuthError(status, raw)) {
    return 'Invalid Gemini API key. Check GEMINI_API_KEY in .env and restart Metatron.';
  }
  if (isRateLimitError(status, raw)) {
    return 'Rate limited, try another model';
  }
  if (isTransientUnavailableError(status, raw)) {
    return 'Gemini is temporarily experiencing high demand (503). Try again or switch models (⌘⇧P).';
  }
  if (isNetworkError(raw)) {
    return 'Network error while contacting Gemini API. Check your internet connection.';
  }
  if (status === 404 || /404|NOT_FOUND|is not found/i.test(raw)) {
    return `Gemini model unavailable: ${clean}`;
  }

  return `Gemini request failed: ${clean}`;
}

function formatGroqError(status, bodyText) {
  const raw = bodyText || '';
  const clean = extractReadableMessage({ message: raw });

  if (isAuthError(status, raw)) {
    return 'Invalid Groq API key. Check GROQ_API_KEY in .env and restart Metatron.';
  }
  if (isRateLimitError(status, raw)) {
    return 'Rate limited, try another model';
  }
  if (isTransientUnavailableError(status, raw)) {
    return `Groq is temporarily unavailable (${status || 503}). Try again or switch models (⌘⇧P).`;
  }
  if (isNetworkError(raw)) {
    return 'Network error while contacting Groq API. Check your internet connection.';
  }
  if (status === 404 || /model_not_found|model_decommissioned|not found/i.test(raw)) {
    return `Groq model unavailable: ${clean}`;
  }
  if (status === 400 && /vision|image|multimodal/i.test(raw)) {
    return "This model can't read images. Switch to a vision model";
  }

  return `Groq request failed${status ? ` (HTTP ${status})` : ''}: ${clean || 'Unknown error'}`;
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

function normalizeMessages(input) {
  if (Array.isArray(input)) {
    return input.map((msg) => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      text: String(msg.text || ''),
    }));
  }
  return [{ role: 'user', text: String(input || '') }];
}

function imageToBase64(image) {
  return Buffer.isBuffer(image.data) ? image.data.toString('base64') : String(image.data);
}

/**
 * Convert provider-agnostic messages + optional Turn-1 image into Gemini `contents/parts`.
 */
function buildGeminiContents(messages, image) {
  const contents = messages.map((msg) => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: msg.text }],
  }));

  if (image && image.data && contents.length > 0) {
    const base64Data = imageToBase64(image);
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
 * Convert provider-agnostic messages + systemInstruction + optional Turn-1 image
 * into OpenAI-compatible `messages` for Groq (base64 data URL for vision models).
 */
function buildGroqMessages(messages, systemInstruction, image) {
  const groqMessages = [];

  if (systemInstruction) {
    groqMessages.push({
      role: 'system',
      content: systemInstruction,
    });
  }

  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserIndex = i;
      break;
    }
  }

  messages.forEach((msg, idx) => {
    if (image && image.data && idx === lastUserIndex) {
      const mimeType = image.mimeType || 'image/jpeg';
      const dataUrl = `data:${mimeType};base64,${imageToBase64(image)}`;
      groqMessages.push({
        role: 'user',
        content: [
          { type: 'text', text: msg.text },
          {
            type: 'image_url',
            image_url: { url: dataUrl },
          },
        ],
      });
    } else {
      groqMessages.push({
        role: msg.role,
        content: msg.text,
      });
    }
  });

  return groqMessages;
}

/**
 * Gemini provider implementation.
 */
const geminiProvider = {
  name: 'gemini',

  async *stream({ model, messages, systemInstruction, image, maxOutputTokens, signal }) {
    const apiKey = (process.env.GEMINI_API_KEY || '').trim();
    if (!apiKey || apiKey === 'your_gemini_api_key_here') {
      throw new Error(
        'Missing GEMINI_API_KEY. Add your Gemini API key to .env and restart Metatron.'
      );
    }

    const ai = new GoogleGenAI({ apiKey });
    const contents = buildGeminiContents(messages, image);

    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal && signal.aborted) return;

      let yieldedAnyChunk = false;
      try {
        const config = {
          abortSignal: signal,
        };
        if (systemInstruction) {
          config.systemInstruction = systemInstruction;
        }
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
            yieldedAnyChunk = true;
            yield chunk.text;
          }
        }
        return;
      } catch (error) {
        if (signal && signal.aborted) return;
        if (yieldedAnyChunk) {
          throw new Error(formatGeminiError(error));
        }

        const status = error && (error.status || error.code);
        const raw = error && error.message ? String(error.message) : '';
        if (attempt === 0 && isTransientUnavailableError(status, raw)) {
          console.warn(
            `[LLM:gemini] ${model} returned transient error; retrying in ${TRANSIENT_RETRY_DELAY_MS}ms...`
          );
          await sleep(TRANSIENT_RETRY_DELAY_MS, signal);
          continue;
        }

        throw new Error(formatGeminiError(error));
      }
    }
  },
};

/**
 * Groq provider implementation (OpenAI-compatible Chat Completions SSE streaming).
 */
const groqProvider = {
  name: 'groq',

  async *stream({ model, messages, systemInstruction, image, maxOutputTokens, signal }) {
    const apiKey = (process.env.GROQ_API_KEY || '').trim();
    if (!apiKey || apiKey === 'your_groq_api_key_here') {
      throw new Error(
        'Missing GROQ_API_KEY. Add your Groq API key to .env and restart Metatron.'
      );
    }

    const groqMessages = buildGroqMessages(messages, systemInstruction, image);
    const body = {
      model,
      messages: groqMessages,
      stream: true,
    };
    if (typeof maxOutputTokens === 'number' && maxOutputTokens > 0) {
      body.max_tokens = maxOutputTokens;
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal && signal.aborted) return;

      let response;
      try {
        response = await fetch(GROQ_CHAT_COMPLETIONS_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (error) {
        if (signal && signal.aborted) return;
        throw new Error(formatGroqError(null, error && error.message ? error.message : String(error)));
      }

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        if (attempt === 0 && isTransientUnavailableError(response.status, errText)) {
          console.warn(
            `[LLM:groq] ${model} returned HTTP ${response.status}; retrying in ${TRANSIENT_RETRY_DELAY_MS}ms...`
          );
          await sleep(TRANSIENT_RETRY_DELAY_MS, signal);
          continue;
        }
        throw new Error(formatGroqError(response.status, errText));
      }

      if (!response.body) {
        throw new Error('Groq returned an empty response body.');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      try {
        while (true) {
          if (signal && signal.aborted) return;
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line || line.startsWith(':')) continue;
            if (!line.startsWith('data:')) continue;

            const dataStr = line.slice(5).trim();
            if (dataStr === '[DONE]') {
              return;
            }

            let parsed;
            try {
              parsed = JSON.parse(dataStr);
            } catch {
              continue;
            }

            if (parsed && parsed.error) {
              throw new Error(
                formatGroqError(parsed.error.code || 500, JSON.stringify(parsed))
              );
            }

            const delta =
              parsed &&
              Array.isArray(parsed.choices) &&
              parsed.choices[0] &&
              parsed.choices[0].delta &&
              parsed.choices[0].delta.content;

            if (typeof delta === 'string' && delta.length > 0) {
              yield delta;
            }
          }
        }
      } catch (error) {
        if (signal && signal.aborted) return;
        if (error && error.message && /^(Groq |Rate limited|Invalid Groq|This model can't|Network error)/.test(error.message)) {
          throw error;
        }
        throw new Error(formatGroqError(null, error && error.message ? error.message : String(error)));
      } finally {
        try {
          reader.releaseLock();
        } catch {}
      }

      return;
    }
  },
};

const providers = {
  gemini: geminiProvider,
  groq: groqProvider,
};

/**
 * Provider-agnostic streaming entry point.
 * Logs provider, model, time to first token (TTFT), and total latency for every request.
 *
 * @param {{
 *   provider: 'gemini' | 'groq',
 *   model: string,
 *   messages: string | Array<{ role: 'user' | 'assistant', text: string }>,
 *   systemInstruction?: string,
 *   image?: { mimeType: string, data: Buffer | string },
 *   maxOutputTokens?: number,
 *   signal?: AbortSignal
 * }} options
 */
async function* streamResponse({
  provider,
  model,
  messages,
  systemInstruction,
  image,
  maxOutputTokens,
  signal,
}) {
  const impl = providers[provider];
  if (!impl) {
    throw new Error(`Unsupported LLM provider "${provider}". Check models.json.`);
  }
  if (!model) {
    throw new Error(`Missing model ID for provider "${provider}". Check models.json.`);
  }

  const normalizedMessages = normalizeMessages(messages);
  const startMs = Date.now();
  let ttftMs = null;

  console.log(
    `[LLM] Request start -> provider=${provider} model=${model} turns=${normalizedMessages.length} vision=${Boolean(image && image.data)} maxOutputTokens=${maxOutputTokens || 'default'}`
  );

  try {
    for await (const chunk of impl.stream({
      model,
      messages: normalizedMessages,
      systemInstruction,
      image,
      maxOutputTokens,
      signal,
    })) {
      if (ttftMs === null) {
        ttftMs = Date.now() - startMs;
      }
      yield chunk;
    }

    const totalMs = Date.now() - startMs;
    console.log(
      `[LLM] Request complete -> provider=${provider} model=${model} ttft=${ttftMs !== null ? `${ttftMs}ms` : 'n/a'} total=${totalMs}ms`
    );
  } catch (error) {
    const totalMs = Date.now() - startMs;
    console.error(
      `[LLM] Request error -> provider=${provider} model=${model} ttft=${ttftMs !== null ? `${ttftMs}ms` : 'n/a'} total=${totalMs}ms error="${error && error.message ? error.message : String(error)}"`
    );
    throw error;
  }
}

module.exports = {
  streamResponse,
  providers,
};
