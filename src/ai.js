
import { config } from "./config.js";

// Removes <think>...</think> blocks, including tags split across chunks.
function thinkFilter() {
  const OPEN = "<think>", CLOSE = "</think>";
  let buf = "", inThink = false, started = false;

  const partialTail = (s, tag) => {
    for (let k = Math.min(tag.length - 1, s.length); k > 0; k--) {
      if (tag.startsWith(s.slice(-k))) return k;
    }
    return 0;
  };

  const emit = (s) => {
    if (!started) {
      s = s.replace(/^\s+/, "");
      if (s) started = true;
    }
    return s;
  };

  return {
    push(chunk) {
      buf += chunk;
      let out = "";

      for (;;) {
        if (inThink) {
          const i = buf.indexOf(CLOSE);
          if (i < 0) {
            buf = buf.slice(-(CLOSE.length - 1));
            return emit(out);
          }
          buf = buf.slice(i + CLOSE.length);
          inThink = false;
        } else {
          const i = buf.indexOf(OPEN);
          if (i < 0) {
            const keep = partialTail(buf, OPEN);
            out += buf.slice(0, buf.length - keep);
            buf = buf.slice(buf.length - keep);
            return emit(out);
          }
          out += buf.slice(0, i);
          buf = buf.slice(i + OPEN.length);
          inThink = true;
        }
      }
    },

    flush() {
      const s = inThink ? "" : buf;
      buf = "";
      return emit(s);
    }
  };
}

export class AiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * Sends text-only conversations to Neuralix Brain when useBrain is true.
 * Otherwise, streams completions from the configured OpenAI-compatible
 * AI provider. Image requests can continue using the vision provider.
 */
export async function streamChat({
  model,
  messages,
  maxTokens,
  signal,
  onText,
  userId,
  useBrain = false,
  baseUrl = config.ai.baseUrl,
  apiKey = config.ai.apiKey
}) {
  const timeout = AbortSignal.timeout(config.ai.timeoutMs);
  const combined = signal
    ? AbortSignal.any([signal, timeout])
    : timeout;

  // --------------------------------------------------
  // NEURALIX BRAIN: TEXT-ONLY CHAT
  // --------------------------------------------------
  if (useBrain) {
    if (!config.brain?.baseUrl || !config.brain?.apiKey) {
      throw new AiError(
        "Neuralix Brain is not configured. Check BRAIN_BASE_URL and BRAIN_API_KEY.",
        500
      );
    }

    if (!userId) {
      throw new AiError(
        "A user ID is required to use Neuralix Brain.",
        400
      );
    }

    const conversation = Array.isArray(messages)
      ? messages.filter((m) =>
          m &&
          ["user", "assistant"].includes(m.role) &&
          typeof m.content === "string"
        )
      : [];

    const latest = conversation[conversation.length - 1];

    if (
      !latest ||
      latest.role !== "user" ||
      !latest.content.trim()
    ) {
      throw new AiError(
        "The latest message must be a non-empty user message.",
        400
      );
    }

    const system = Array.isArray(messages)
      ? messages.find(
          (m) =>
            m?.role === "system" &&
            typeof m.content === "string"
        )?.content || ""
      : "";

    let response;

    try {
      response = await fetch(
        `${config.brain.baseUrl}/v1/chat`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Brain-Api-Key": config.brain.apiKey
          },
          body: JSON.stringify({
            user_id: String(userId),
            message: latest.content.slice(0, 20000),
            history: conversation
              .slice(0, -1)
              .slice(-20)
              .map((m) => ({
                role: m.role,
                content: String(m.content).slice(0, 10000)
              })),
            system_instruction: String(system).slice(0, 12000),
            max_output_tokens: Math.max(
              128,
              Math.min(Number(maxTokens) || 2048, 4096)
            )
          }),
          signal: combined
        }
      );
    } catch (e) {
      if (signal?.aborted) throw e;

      throw new AiError(
        `Could not reach Neuralix Brain at ${config.brain.baseUrl}: ${e.message}`,
        0
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");

      throw new AiError(
        `Neuralix Brain answered ${response.status}: ${detail.slice(0, 500)}`,
        response.status
      );
    }

    let result;

    try {
      result = await response.json();
    } catch {
      throw new AiError(
        "Neuralix Brain returned an invalid JSON response.",
        502
      );
    }

    const answer =
      typeof result.answer === "string"
        ? result.answer
        : "";

    if (!answer.trim()) {
      throw new AiError(
        "Neuralix Brain returned an empty answer.",
        502
      );
    }

    if (typeof onText === "function") {
      onText(answer);
    }

    return {
      text: answer,
      truncated: false
    };
  }

  // --------------------------------------------------
  // EXISTING AI PROVIDER: STREAMING CHAT / VISION
  // --------------------------------------------------
  let res;

  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        max_tokens: maxTokens,
        temperature: 0.7
      }),
      signal: combined
    });
  } catch (e) {
    if (signal?.aborted) throw e;

    throw new AiError(
      `Could not reach the AI server at ${baseUrl} (${e.cause?.code || e.name})`,
      0
    );
  }

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");

    throw new AiError(
      `AI server answered ${res.status}: ${detail.slice(0, 300)}`,
      res.status
    );
  }

  const filter = thinkFilter();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  let pending = "";
  let full = "";
  let finish = null;

  const handleLine = (line) => {
    line = line.trim();

    if (!line.startsWith("data:")) return;

    const data = line.slice(5).trim();

    if (!data || data === "[DONE]") return;

    let json;

    try {
      json = JSON.parse(data);
    } catch {
      return;
    }

    if (json.error) {
      throw new AiError(
        `AI server error: ${json.error.message || JSON.stringify(json.error)}`,
        502
      );
    }

    const choice = json.choices && json.choices[0];

    if (!choice) return;

    if (choice.finish_reason) {
      finish = choice.finish_reason;
    }

    const piece =
      choice.delta &&
      typeof choice.delta.content === "string"
        ? choice.delta.content
        : "";

    if (piece) {
      const out = filter.push(piece);

      if (out) {
        full += out;
        onText(out);
      }
    }
  };

  for (;;) {
    const { value, done } = await reader.read();

    if (done) break;

    pending += decoder.decode(value, { stream: true });

    let nl;

    while ((nl = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);

      handleLine(line);
    }
  }

  pending += decoder.decode();

  if (pending) {
    handleLine(pending);
  }

  const tail = filter.flush();

  if (tail) {
    full += tail;
    onText(tail);
  }

  return {
    text: full,
    truncated: finish === "length"
  };
}
