// Load .env if present (built into Node 20.12+). Real environment variables win.
try { process.loadEnvFile(); } catch { /* no .env file */ }

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};
const list = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);
const trimSlash = (s) => String(s).replace(/\/+$/, "");

// Turso shows a libsql:// address. Its HTTP API is the same address with https://.
// Also accepted: the https:// address, the address with /v2/pipeline on the end, ?authToken=..., and
// libsql://host:port?tls=0 for a local `turso dev` database.
function tursoSettings() {
  let url = String(process.env.TURSO_DATABASE_URL || "").trim();
  let authToken = String(process.env.TURSO_AUTH_TOKEN || "").trim();
  if (!url) return { url: "", authToken };
  const noTls = /[?&]tls=0\b/i.test(url);
  url = url.replace(/^libsql:\/\//i, noTls ? "http://" : "https://").replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://");
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  try {
    const u = new URL(url);
    if (!authToken) authToken = u.searchParams.get("authToken") || "";
    url = u.origin + u.pathname.replace(/\/v[23]\/pipeline\/?$/i, "").replace(/\/+$/, "");
  } catch {
    url = url.replace(/\/+$/, "");
  }
  return { url, authToken };
}

const core = process.env.MODEL_CORE || "qwen3:8b";
const nova = process.env.MODEL_NOVA || core;
const ultra = process.env.MODEL_ULTRA || nova;

export const config = {
  port: num(process.env.PORT, 3000),
  appUrl: trimSlash(process.env.APP_URL || "http://localhost:3000"),
  isProd: process.env.NODE_ENV === "production",
  trustProxy: process.env.TRUST_PROXY !== "false",
  dbPath: process.env.DATABASE_PATH || "./data/neuralix.db",
  // Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN to keep the database in Turso instead of a local file.
  turso: tursoSettings(),
  adminEmails: list(process.env.ADMIN_EMAILS).map((e) => e.toLowerCase()),
  timeZone: process.env.TIME_ZONE || "Asia/Manila",

  ai: {
    // Any OpenAI-compatible server: your own Ollama/vLLM machine, Ollama Cloud, or another provider.
    baseUrl: trimSlash(process.env.AI_BASE_URL || "http://localhost:11434/v1"),
    apiKey: process.env.AI_API_KEY || "ollama",
    models: {
      core,
      nova,
      ultra,
      // Used whenever a message includes images. Leave empty if your chat models can already see images.
      vision: process.env.MODEL_VISION || ""
    },
    maxTokens: {
      core: num(process.env.MAX_TOKENS_CORE, 1024),
      nova: num(process.env.MAX_TOKENS_NOVA, 2048),
      ultra: num(process.env.MAX_TOKENS_ULTRA, 4096)
    },
    timeoutMs: num(process.env.AI_TIMEOUT_MS, 180000)
  },

  plans: {
    freeImagesPerDay: num(process.env.FREE_IMAGES_PER_DAY, 10),
    // Anti-spam speed limit only (messages per minute). There is no daily message cap on either plan.
    freePerMinute: num(process.env.FREE_MESSAGES_PER_MINUTE, 20),
    premiumPerMinute: num(process.env.PREMIUM_MESSAGES_PER_MINUTE, 60),
    priceMonthly: num(process.env.PRICE_MONTHLY, 199),
    priceAnnual: num(process.env.PRICE_ANNUAL, 1910)
  },

  // The Android app made with PWABuilder. Copy both values from the assetlinks.json in PWABuilder's download.
  android: {
    packageId: String(process.env.ANDROID_PACKAGE_ID || "").trim(),
    certSha256: list(process.env.ANDROID_CERT_SHA256)
      .map((f) => f.toUpperCase().replace(/[^0-9A-F]/g, ""))
      .filter((f) => f.length === 64)
      .map((f) => f.match(/../g).join(":"))
  },

  paymongo: {
    secretKey: process.env.PAYMONGO_SECRET_KEY || "",
    webhookSecret: process.env.PAYMONGO_WEBHOOK_SECRET || "",
    methods: list(process.env.PAYMONGO_METHODS || "gcash"),
    apiBase: trimSlash(process.env.PAYMONGO_API_BASE || "https://api.paymongo.com")
  }
};

export const MODELS = {
  core: { name: "Neuralix Core", desc: "Fast everyday answers", premium: false },
  nova: { name: "Neuralix Nova", desc: "Smarter, more detailed answers", premium: true },
  ultra: { name: "Neuralix Ultra", desc: "Deep reasoning for hard problems", premium: true }
};
