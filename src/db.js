import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

fs.mkdirSync(path.dirname(path.resolve(config.dbPath)), { recursive: true });

export const db = new DatabaseSync(config.dbPath);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

// Runs fn inside one SQLite transaction.
export const transaction = (fn) => (...args) => {
  db.exec("BEGIN IMMEDIATE");
  try { const out = fn(...args); db.exec("COMMIT"); return out; }
  catch (e) { db.exec("ROLLBACK"); throw e; }
};

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  premium_until INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL DEFAULT 'core',
  persona TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS conv_user ON conversations(user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  images INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS msg_conv ON messages(conversation_id, id);
CREATE TABLE IF NOT EXISTS usage (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  images INTEGER NOT NULL DEFAULT 0,
  messages INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  reference TEXT NOT NULL,
  provider_payment_id TEXT,
  created_at INTEGER NOT NULL,
  paid_at INTEGER
);
CREATE INDEX IF NOT EXISTS pay_user ON payments(user_id, created_at DESC);
`);

export const dayKey = (t = Date.now()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: config.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));

export const q = {
  userByEmail: db.prepare("SELECT * FROM users WHERE email = ?"),
  userById: db.prepare("SELECT * FROM users WHERE id = ?"),
  createUser: db.prepare("INSERT INTO users (email, name, pass_hash, created_at) VALUES (?, ?, ?, ?)"),
  setPrefs: db.prepare("UPDATE users SET model = ?, persona = ? WHERE id = ?"),
  setPremiumUntil: db.prepare("UPDATE users SET premium_until = ? WHERE id = ?"),

  createSession: db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"),
  sessionUser: db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`),
  deleteSession: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
  purgeSessions: db.prepare("DELETE FROM sessions WHERE expires_at <= ?"),

  listConversations: db.prepare("SELECT id, title, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 300"),
  conversation: db.prepare("SELECT * FROM conversations WHERE id = ? AND user_id = ?"),
  createConversation: db.prepare("INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"),
  touchConversation: db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?"),
  deleteConversation: db.prepare("DELETE FROM conversations WHERE id = ? AND user_id = ?"),

  messages: db.prepare("SELECT id, role, content, images, model, error, created_at FROM messages WHERE conversation_id = ? ORDER BY id"),
  recentMessages: db.prepare("SELECT role, content, images FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?"),
  addMessage: db.prepare("INSERT INTO messages (conversation_id, role, content, images, model, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"),

  usage: db.prepare("SELECT images, messages FROM usage WHERE user_id = ? AND day = ?"),
  addUsage: db.prepare(`INSERT INTO usage (user_id, day, images, messages) VALUES (?, ?, ?, 1)
    ON CONFLICT(user_id, day) DO UPDATE SET images = images + excluded.images, messages = messages + 1`),

  createPayment: db.prepare("INSERT INTO payments (id, user_id, plan, amount, status, reference, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)"),
  payment: db.prepare("SELECT * FROM payments WHERE id = ?"),
  markPaid: db.prepare("UPDATE payments SET status = 'paid', paid_at = ?, provider_payment_id = ? WHERE id = ? AND status != 'paid'")
};

setInterval(() => q.purgeSessions.run(Date.now()), 6 * 3600 * 1000).unref();
