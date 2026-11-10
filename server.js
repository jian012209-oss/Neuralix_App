
import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config, MODELS } from "./src/config.js";
import { db, q, dayKey } from "./src/db.js";
import { createApp, HttpError } from "./src/http.js";
import {
  mountAuth,
  loadUser,
  requireUser,
  isPremium,
  isAdmin
} from "./src/auth.js";
import { mountChat } from "./src/chat.js";
import {
  mountBilling,
  gcashReady,
  paymentMode
} from "./src/billing.js";
import { mountAdmin } from "./src/admin.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");

// Inline script security
function inlineScriptHashes() {
  try {
    const html = fs.readFileSync(
      path.join(publicDir, "index.html"),
      "utf8"
    ).replace(/\r\n?/g, "\n");

    return [...html.matchAll(
      /<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script\s*>/gi
    )]
      .filter((m) => m[1].trim())
      .map((m) =>
        `'sha256-${crypto.createHash("sha256")
          .update(m[1], "utf8")
          .digest("base64")}'`
      );
  } catch {
    return [];
  }
}

const app = createApp({
  publicDir,
  trustProxy: config.trustProxy,
  securityHeaders: {
    "Content-Security-Policy": [
      "default-src 'self'",
      ["script-src 'self'", ...inlineScriptHashes()].join(" "),
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'"
    ].join("; "),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    ...(config.isProd
      ? { "Strict-Transport-Security": "max-age=15552000" }
      : {})
  }
});

// Protect cross-site requests
app.before((req) => {
  if (
    !req.path.startsWith("/api/") ||
    req.method === "GET" ||
    req.method === "HEAD"
  ) return;

  if (req.path === "/api/billing/webhook") return;

  const origin = req.get("origin");

  if (origin) {
    let host = "";

    try {
      host = new URL(origin).host;
    } catch {
      // Invalid origin
    }

    if (host !== req.get("host")) {
      throw new HttpError(403, "Cross-site request blocked.");
    }
  }

  if (
    (req.method === "POST" || req.method === "PATCH") &&
    !String(req.get("content-type") || "")
      .includes("application/json")
  ) {
    throw new HttpError(415, "Requests must be JSON.");
  }
});

// Load authenticated user for API requests
app.before((req) =>
  req.path.startsWith("/api/") ? loadUser(req) : undefined
);

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

// Android Digital Asset Links
app.get("/.well-known/assetlinks.json", async (_req, res) => {
  const { packageId, certSha256 } = config.android;

  if (packageId && certSha256.length) {
    return res.json([{
      relation: [
        "delegate_permission/common.handle_all_urls"
      ],
      target: {
        namespace: "android_app",
        package_name: packageId,
        sha256_cert_fingerprints: certSha256
      }
    }]);
  }

  try {
    const content = await fs.promises.readFile(
      path.join(publicDir, ".well-known", "assetlinks.json"),
      "utf8"
    );

    res.json(JSON.parse(content));
  } catch {
    res.json([], 404);
  }
});

mountAuth(app);

// Current user information
app.get("/api/me", requireUser, async (req, res) => {
  const u = req.user;
  const premium = isPremium(u);
  const admin = isAdmin(u);
  const mode = paymentMode();

  const [usage, last, pending] = await db.batch([
    q.usage.bind(u.id, dayKey()),
    q.lastRequestForUser.bind(u.id),
    q.pendingRequestCount.bind()
  ]);

  res.json({
    user: {
      name: u.name,
      email: u.email,
      premium,
      premiumUntil: premium ? u.premium_until : 0,
      model: u.model,
      persona: u.persona,
      isAdmin: admin
    },
    usage: {
      imagesToday: usage.rows[0]?.images || 0,
      imageLimit: config.plans.freeImagesPerDay
    },
    models: Object.entries(MODELS).map(([id, m]) => ({
      id,
      ...m
    })),
    prices: {
      monthly: config.plans.priceMonthly,
      annual: config.plans.priceAnnual
    },
    gcashReady: gcashReady(),
    payment: {
      mode,
      gcashNumber: mode === "manual" ? config.gcash.number : "",
      gcashName: mode === "manual" ? config.gcash.name : "",
      lastRequest: last.rows[0] || null
    },
    ...(admin
      ? { admin: { pendingRequests: pending.rows[0].n } }
      : {})
  });
});

// Update user preferences
app.patch("/api/me", requireUser, async (req, res) => {
  const body = await req.json();
  const u = req.user;
  const premium = isPremium(u);

  let model =
    body.model !== undefined
      ? String(body.model)
      : u.model;

  if (!Object.hasOwn(MODELS, model)) {
    model = "core";
  }

  if (MODELS[model].premium && !premium) {
    throw new HttpError(
      403,
      `${MODELS[model].name} is a Premium model.`,
      { code: "premium_required" }
    );
  }

  let persona = u.persona;

  if (body.persona !== undefined) {
    if (!premium) {
      throw new HttpError(
        403,
        "Custom instructions are a Premium feature.",
        { code: "premium_required" }
      );
    }

    persona = String(body.persona).trim().slice(0, 1500);
  }

  await q.setPrefs.run(model, persona, u.id);

  res.json({ ok: true, model, persona });
});

// ============================================
// NEURALIX BRAIN CONNECTION
// ============================================

// Brain API requests are made server-side.
// Never expose BRAIN_API_KEY to the browser.
async function brainRequest(pathname, options = {}) {
  if (!config.brain.baseUrl || !config.brain.apiKey) {
    throw new HttpError(
      503,
      "Neuralix Brain is not configured."
    );
  }

  let response;

  try {
    response = await fetch(
      config.brain.baseUrl + pathname,
      {
        ...options,
        headers: {
          "Content-Type": "application/json",
          "X-Brain-Api-Key": config.brain.apiKey,
          ...(options.headers || {})
        },
        signal: AbortSignal.timeout(30000)
      }
    );
  } catch {
    throw new HttpError(
      502,
      "Neuralix Brain could not be reached."
    );
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new HttpError(
      response.status === 401 ? 502 : response.status,
      data.detail || "Neuralix Brain request failed."
    );
  }

  return data;
}

// Generate memory suggestions.
// Suggestions are returned for review and are NOT saved automatically.
app.post(
  "/api/memory/suggestions",
  requireUser,
  async (req, res) => {
    const body = await req.json(16000);
    const conversation = String(body.conversation || "").trim();

    if (
      conversation.length < 20 ||
      conversation.length > 12000
    ) {
      throw new HttpError(
        400,
        "Conversation must be between 20 and 12,000 characters."
      );
    }

    const result = await brainRequest(
      "/v1/memory/suggest",
      {
        method: "POST",
        body: JSON.stringify({ conversation })
      }
    );

    res.json({
      success: true,
      saved: false,
      suggestions: Array.isArray(result.suggestions)
        ? result.suggestions
        : []
    });
  }
);

// Get saved memories for the logged-in user
app.get("/api/memories", requireUser, async (req, res) => {
  const result = await brainRequest(
    "/v1/memory/" +
      encodeURIComponent(String(req.user.id))
  );

  res.json(result);
});

// Save an approved memory
app.post("/api/memories", requireUser, async (req, res) => {
  const body = await req.json(8000);
  const memory = String(body.memory || "").trim();

  const allowed = new Set([
    "preference",
    "project",
    "learning",
    "general"
  ]);

  const category = allowed.has(body.category)
    ? body.category
    : "general";

  if (!memory || memory.length > 1000) {
    throw new HttpError(
      400,
      "Memory must be between 1 and 1,000 characters."
    );
  }

  const result = await brainRequest(
    "/v1/memory",
    {
      method: "POST",
      body: JSON.stringify({
        user_id: String(req.user.id),
        memory,
        category
      })
    }
  );

  res.json(result);
});

// Delete a saved memory belonging to the logged-in user
app.delete(
  "/api/memories/:id",
  requireUser,
  async (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id < 1) {
      throw new HttpError(400, "Invalid memory ID.");
    }

    const result = await brainRequest(
      "/v1/memory/" +
        id +
        "?user_id=" +
        encodeURIComponent(String(req.user.id)),
      { method: "DELETE" }
    );

    res.json(result);
  }
);

// ============================================
// EXISTING APP MODULES
// ============================================

mountChat(app);
mountBilling(app);
mountAdmin(app);

// ============================================
// START SERVER
// ============================================

const server = http.createServer(app.handle);

server.requestTimeout = 0;
server.headersTimeout = 60000;

server.listen(config.port, () => {
  console.log(
    `Neuralix AI running on ${config.appUrl} (port ${config.port})`
  );

  console.log(`Database: ${db.backend}`);

  if (!db.isTurso && config.isProd) {
    console.log(
      "Warning: the database is a local file. On Render's free plan it is erased on every restart. Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN."
    );
  }

  const m = config.ai.models;

  console.log(
    `AI server: ${config.ai.baseUrl} · core=${m.core}, nova=${m.nova}, ultra=${m.ultra}${m.vision ? ", vision=" + m.vision : ""}`
  );

  if (config.ai.vision.baseUrl) {
    console.log(
      `Image AI server: ${config.ai.vision.baseUrl} · vision=${m.vision || "(set MODEL_VISION)"}`
    );
  }

  const mode = paymentMode();

  console.log(
    mode === "paymongo"
      ? "GCash payments: automatic (PayMongo)."
      : mode === "manual"
        ? `GCash payments: manual, to ${config.gcash.number}. Approve them in the Owner console.`
        : "GCash payments are off. Set GCASH_NUMBER (manual) or PAYMONGO_SECRET_KEY (automatic)."
  );

  if (!config.adminEmails.length) {
    console.log("Tip: set ADMIN_EMAILS to open the owner console.");
  }
});

// Graceful shutdown
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () =>
    server.close(() => process.exit(0))
  );
}
