import { config } from "./config.js";
import { db, q } from "./db.js";
import { requireUser, requireAdmin, isPremium } from "./auth.js";
import { HttpError } from "./http.js";

const monthStart = () => {
  const [y, m] = new Intl.DateTimeFormat("en-CA", { timeZone: config.timeZone, year: "numeric", month: "2-digit" }).format(new Date()).split("-");
  // Start of the month in the configured time zone (Asia/Manila has no daylight saving time).
  return new Date(`${y}-${m}-01T00:00:00+08:00`).getTime();
};

const stmts = {
  users: db.prepare("SELECT COUNT(*) AS n FROM users"),
  premium: db.prepare("SELECT COUNT(*) AS n FROM users WHERE premium_until > ?"),
  revenue: db.prepare("SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS n FROM payments WHERE status = 'paid' AND paid_at >= ?"),
  recentPayments: db.prepare(`SELECT p.id, p.plan, p.amount, p.status, p.reference, p.created_at, p.paid_at, u.email
    FROM payments p JOIN users u ON u.id = p.user_id ORDER BY p.created_at DESC LIMIT 50`),
  recentUsers: db.prepare("SELECT id, name, email, premium_until, created_at FROM users ORDER BY created_at DESC LIMIT 50")
};

export function mountAdmin(app) {
const guard = [requireUser, requireAdmin];
app.get("/api/admin/overview", ...guard, (_req, res) => {
  const now = Date.now();
  const rev = stmts.revenue.get(monthStart());
  res.json({
    stats: { users: stmts.users.get().n, premium: stmts.premium.get(now).n, revenueThisMonth: rev.total, paidThisMonth: rev.n },
    payments: stmts.recentPayments.all(),
    users: stmts.recentUsers.all().map((u) => ({ ...u, premium: u.premium_until > now }))
  });
});

app.post("/api/admin/grant", ...guard, async (req, res) => {
  const body = await req.json();
  const email = String(body.email || "").trim().toLowerCase();
  const days = Math.min(3650, Math.max(1, parseInt(body.days, 10) || 30));
  const user = q.userByEmail.get(email);
  if (!user) throw new HttpError(404, "No account uses that email.");
  const until = Math.max(Date.now(), Number(user.premium_until) || 0) + days * 864e5;
  q.setPremiumUntil.run(until, user.id);
  res.json({ ok: true, email, premiumUntil: until });
});

app.post("/api/admin/revoke", ...guard, async (req, res) => {
  const body = await req.json();
  const email = String(body.email || "").trim().toLowerCase();
  const user = q.userByEmail.get(email);
  if (!user) throw new HttpError(404, "No account uses that email.");
  if (!isPremium(user)) return res.json({ ok: true, email, premiumUntil: 0 });
  q.setPremiumUntil.run(0, user.id);
  res.json({ ok: true, email, premiumUntil: 0 });
});
}
