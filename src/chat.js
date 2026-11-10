
import crypto from "node:crypto";
import { config, MODELS } from "./config.js";
import { db, q, dayKey, countUsage } from "./db.js";
import { requireUser, isPremium } from "./auth.js";
import { HttpError } from "./http.js";
import { rateLimit } from "./ratelimit.js";
import { streamChat, AiError } from "./ai.js";

const UNLIMITED = 1e12;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const IMAGE_RX = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/;

// No plan has a daily message cap. This only stops spam bots from flooding the AI server.
const chatLimit = rateLimit({
  windowMs: 60 * 1000,
  max: (req) => (
    isPremium(req.user)
      ? config.plans.premiumPerMinute
      : config.plans.freePerMinute
  ),
  key: (req) => "chat:" + req.user.id,
  message: "You're sending messages very fast. Wait a few seconds and try again."
});

function systemPrompt(user, modelKey) {
  const today = new Date().toLocaleDateString("en-PH", {
    timeZone: config.timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  });

  const lines = [
    "You are Neuralix, the AI assistant of the Neuralix AI website.",
    "Be warm, clear and genuinely useful. Reply in the language the user writes in; English, Filipino and Taglish are all welcome.",
    "Format replies in Markdown: short paragraphs, bullet or numbered lists when they help, **bold** for key terms, and fenced code blocks with a language tag for code.",
    modelKey === "core"
      ? "Keep replies focused: lead with the answer, then only the supporting points that matter."
      : "Give thorough, well-organized answers with examples or steps where they help.",
    "If you are not sure about a fact, say so instead of guessing.",
    `Today is ${today}.`
  ];

  if (user.persona && isPremium(user)) {
    lines.push(
      "The user set these custom instructions. Follow them unless they ask for something unsafe or dishonest:\n" +
      user.persona
    );
  }

  return lines.join("\n");
}

// recentRows: newest messages first.
function buildHistory(recentRows) {
  const rows = recentRows.slice().reverse();
  const out = [];
  let total = 0;

  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    let content = r.content || "";

    if (r.role === "user" && r.images) {
      content += (content ? "\n\n" : "") +
        `[The user shared ${r.images} image${r.images > 1 ? "s" : ""} here earlier.]`;
    }

    if (!content.trim()) continue;

    total += content.length;

    if (out.length && total > 24000) break;

    out.unshift({
      role: r.role,
      content
    });
  }

  return out;
}

export function mountChat(app) {
  app.get("/api/conversations", requireUser, async (req, res) => {
    res.json({
      conversations: await q.listConversations.all(req.user.id)
    });
  });

  app.get("/api/conversations/:id", requireUser, async (req, res) => {
    const [conv, msgs] = await db.batch([
      q.conversation.bind(req.params.id, req.user.id),
      q.messages.bind(req.params.id)
    ]);

    const c = conv.rows[0];

    if (!c) {
      throw new HttpError(404, "That chat doesn't exist anymore.");
    }

    res.json({
      conversation: {
        id: c.id,
        title: c.title,
        updated_at: c.updated_at
      },
      messages: msgs.rows
    });
  });

  app.delete("/api/conversations/:id", requireUser, async (req, res) => {
    await db.batch([
      q.deleteConversationMessages.bind(req.params.id, req.user.id),
      q.deleteConversation.bind(req.params.id, req.user.id)
    ], {
      transaction: true
    });

    res.json({ ok: true });
  });

  app.post("/api/chat", requireUser, chatLimit, handleChat);
}

async function handleChat(req, res) {
  const body = await req.json(24 * 1024 * 1024);
  const user = req.user;
  const premium = isPremium(user);

  const text = String(body.message || "").slice(0, 20000).trim();
  const images = Array.isArray(body.images) ? body.images : [];
  const modelKey = Object.hasOwn(MODELS, body.model) ? body.model : "core";

  if (!text && !images.length) {
    throw new HttpError(400, "Type a message or add an image.");
  }

  if (MODELS[modelKey].premium && !premium) {
    throw new HttpError(
      403,
      `${MODELS[modelKey].name} is a Premium model.`,
      { code: "premium_required" }
    );
  }

  if (images.length > MAX_IMAGES) {
    throw new HttpError(
      400,
      `You can send up to ${MAX_IMAGES} images per message.`
    );
  }

  for (const img of images) {
    const m = typeof img === "string" && img.match(IMAGE_RX);

    if (!m) {
      throw new HttpError(400, "Use JPG, PNG, WebP or GIF images.");
    }

    if (Math.floor(m[2].length * 0.75) > MAX_IMAGE_BYTES) {
      throw new HttpError(400, "Each image must be under 4 MB.");
    }
  }

  const today = dayKey();

  // Load an existing conversation and its recent messages.
  let conv = null;
  let history = [];

  if (body.conversationId) {
    const id = String(body.conversationId);

    const [c, recent] = await db.batch([
      q.conversation.bind(id, user.id),
      q.recentMessages.bind(id, 24)
    ]);

    conv = c.rows[0];

    if (!conv) {
      throw new HttpError(
        404,
        "That chat doesn't exist anymore. Start a new one."
      );
    }

    history = buildHistory(recent.rows);
  }

  // Check the image upload limit.
  const imageLimit = premium
    ? UNLIMITED
    : config.plans.freeImagesPerDay;

  if (!(await countUsage(user.id, today, images.length, imageLimit))) {
    const used = (await q.usage.get(user.id, today))?.images || 0;

    throw new HttpError(
      403,
      `Free accounts can upload ${config.plans.freeImagesPerDay} images per day.`,
      {
        code: "image_limit",
        used
      }
    );
  }

  const now = Date.now();

  if (conv) {
    await q.addMessage.run(
      conv.id,
      "user",
      text,
      images.length,
      null,
      null,
      now
    );
  } else {
    const title = text
      ? text.replace(/\s+/g, " ").slice(0, 60)
      : "Image chat";

    conv = {
      id: crypto.randomUUID(),
      title
    };

    await db.batch([
      q.createConversation.bind(
        conv.id,
        user.id,
        title,
        now,
        now
      ),
      q.addMessage.bind(
        conv.id,
        "user",
        text,
        images.length,
        null,
        null,
        now
      )
    ], {
      transaction: true
    });
  }

  // Prepare the current message.
  const userContent = images.length
    ? [
        {
          type: "text",
          text: text ||
            "Look at the attached image and tell me what you see, plus anything useful about it."
        },
        ...images.map((url) => ({
          type: "image_url",
          image_url: { url }
        }))
      ]
    : text;

  const messages = [
    {
      role: "system",
      content: systemPrompt(user, modelKey)
    },
    ...history,
    {
      role: "user",
      content: userContent
    }
  ];

  // Images use the existing vision provider.
  const useVision = images.length > 0 && !!config.ai.models.vision;

  const modelId = useVision
    ? config.ai.models.vision
    : config.ai.models[modelKey];

  const service = useVision && config.ai.vision.baseUrl
    ? {
        baseUrl: config.ai.vision.baseUrl,
        apiKey: config.ai.vision.apiKey || config.ai.apiKey
      }
    : {};

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  const send = (event, data) => {
    if (!res.writableEnded) {
      res.write(
        `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
      );
    }
  };

  send("meta", {
    conversationId: conv.id,
    title: conv.title,
    model: modelKey
  });

  const ping = setInterval(() => {
    if (!res.writableEnded) {
      res.write(": ping\n\n");
    }
  }, 15000);

  const abort = new AbortController();
  let finished = false;

  res.on("close", () => {
    if (!finished) abort.abort();
  });

  let answer = "";
  let error = null;
  let truncated = false;

  try {
    const out = await streamChat({
      ...service,
      model: modelId,
      messages,
      maxTokens: config.ai.maxTokens[modelKey],
      signal: abort.signal,

      // Text-only messages use Neuralix Brain.
      // Messages with images keep using the vision provider.
      userId: user.id,
      useBrain: images.length === 0,

      onText: (delta) => {
        answer += delta;
        send("delta", { text: delta });
      }
    });

    truncated = out.truncated;

    if (!answer.trim()) {
      error = "empty";
    }
  } catch (e) {
    if (abort.signal.aborted) {
      error = "stopped";
    } else {
      error = "ai_unavailable";
      console.error(
        "[chat]",
        e instanceof AiError ? e.message : e
      );
    }
  } finally {
    finished = true;
    clearInterval(ping);
  }

  // Refund image uploads if the vision service failed.
  if (
    images.length &&
    (error === "ai_unavailable" || error === "empty")
  ) {
    error = "image_unavailable";
  }

  // Save the answer and update conversation history.
  const saves = [];

  if (answer.trim() || error !== "stopped") {
    saves.push(
      q.addMessage.bind(
        conv.id,
        "assistant",
        answer,
        0,
        modelKey,
        error,
        Date.now()
      )
    );
  }

  saves.push(
    q.touchConversation.bind(Date.now(), conv.id)
  );

  if (error === "image_unavailable") {
    saves.push(
      q.refundImages.bind(images.length, user.id, today)
    );
  }

  try {
    await db.batch(saves);
  } catch (e) {
    console.error(
      "[chat] couldn't save the answer:",
      e.message
    );
  }

  if (error === "image_unavailable") {
    send("error", {
      code: "image_unavailable",
      refunded: images.length,
      error: "Neuralix couldn't look at the image right now. It wasn't counted against your uploads."
    });
  } else if (error === "ai_unavailable") {
    send("error", {
      code: "ai_unavailable",
      error: "Neuralix couldn't reach its AI model. Try again in a moment."
    });
  } else if (error === "empty") {
    send("error", {
      code: "empty",
      error: "No answer came back. Try rephrasing your message."
    });
  } else {
    send("done", { truncated });
  }

  res.end();
}
