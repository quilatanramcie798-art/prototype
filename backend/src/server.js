import express from "express";
import cors from "cors";
import helmet from "helmet";
import "dotenv/config";
import { query } from "./db.js";
import { login, loginWithSupabaseToken, requireAuth, requireRole } from "./auth.js";

const app = express();
const port = Number(process.env.PORT || 3000);
app.use(helmet());
const allowedOrigins = (process.env.CLIENT_ORIGIN || "").split(",").map((origin) => origin.trim()).filter(Boolean);
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Origin is not allowed by CORS"));
  },
}));
app.use(express.json({ limit: "1mb" }));

async function audit(req, action, details = {}) {
  await query("INSERT INTO audit_logs (user_id, action, details) VALUES ($1, $2, $3)", [req.user?.id || null, action, details]);
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/[^\d+]/g, "");
  if (/^09\d{9}$/.test(digits)) return `+63${digits.slice(1)}`;
  if (/^9\d{9}$/.test(digits)) return `+63${digits}`;
  if (/^639\d{9}$/.test(digits)) return `+${digits}`;
  if (/^\+639\d{9}$/.test(digits)) return digits;
  return null;
}

function validateLearner(body) {
  const lrn = String(body.lrn || "").trim();
  const name = String(body.name || "").trim();
  const parentName = String(body.parentName || "").trim();
  const phone = normalizePhone(body.phone);
  if (!/^\d{6,15}$/.test(lrn) || !name || !parentName || !phone) return null;
  return { lrn, name, parentName, phone, className: String(body.className || "Unassigned").trim() || "Unassigned" };
}

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "learner-attendance-api" }));

app.post("/api/auth/login", async (req, res, next) => {
  try {
    const result = await login(String(req.body.email || "").trim(), String(req.body.password || ""));
    return result ? res.json(result) : res.status(401).json({ error: "Invalid credentials" });
  } catch (error) { return next(error); }
});

app.post("/api/auth/supabase", async (req, res, next) => {
  try {
    const result = await loginWithSupabaseToken(String(req.body.accessToken || ""));
    if (result.error === "not_authorized") {
      return res.status(403).json({ error: "This Google account is not authorized. Ask an administrator to add your email first." });
    }
    if (result.error === "unverified_email") {
      return res.status(403).json({ error: "Verify your Google account email before signing in." });
    }
    if (result.error) return res.status(401).json({ error: "Invalid or expired Supabase sign-in. Please try again." });
    return res.json(result);
  } catch (error) { return next(error); }
});

app.use("/api", (req, res, next) => {
  const clientToken = req.headers["x-sms-client-token"];
  if (req.path === "/sms/send" && process.env.SMS_CLIENT_TOKEN && clientToken === process.env.SMS_CLIENT_TOKEN) {
    req.user = { id: null, role: "staff", authType: "sms-client-token" };
    return next();
  }
  return requireAuth(req, res, next);
});

app.get("/api/auth/me", (req, res) => {
  res.json({ user: { id: req.user.id, email: req.user.email, role: req.user.role } });
});

app.get("/api/learners", async (req, res, next) => {
  try { res.json(await query("SELECT id, lrn, name, parent_name AS \"parentName\", phone, class_name AS \"className\", qr_version AS \"qrVersion\" FROM learners WHERE active = TRUE ORDER BY name")); } catch (error) { next(error); }
});

app.post("/api/learners", requireRole("admin", "staff"), async (req, res, next) => {
  try {
    const learner = validateLearner(req.body);
    if (!learner) return res.status(400).json({ error: "Invalid learner data or Philippine mobile number" });
    const result = await query("INSERT INTO learners (lrn, name, parent_name, phone, class_name) VALUES ($1, $2, $3, $4, $5) RETURNING id", [learner.lrn, learner.name, learner.parentName, learner.phone, learner.className]);
    await audit(req, "Added learner", { lrn: learner.lrn });
    res.status(201).json({ id: result[0].id, ...learner, qrVersion: 1 });
  } catch (error) { next(error); }
});

app.put("/api/learners/:id", requireRole("admin", "staff"), async (req, res, next) => {
  try {
    const learner = validateLearner(req.body);
    if (!learner) return res.status(400).json({ error: "Invalid learner data or Philippine mobile number" });
    await query("UPDATE learners SET lrn=$1, name=$2, parent_name=$3, phone=$4, class_name=$5, qr_version=qr_version+1, updated_at=NOW() WHERE id=$6", [learner.lrn, learner.name, learner.parentName, learner.phone, learner.className, req.params.id]);
    await audit(req, "Updated learner", { id: req.params.id });
    res.json({ ...learner });
  } catch (error) { next(error); }
});

app.delete("/api/learners/:id", requireRole("admin"), async (req, res, next) => {
  try { await query("UPDATE learners SET active=FALSE, updated_at=NOW() WHERE id=$1", [req.params.id]); await audit(req, "Archived learner", { id: req.params.id }); res.status(204).end(); } catch (error) { next(error); }
});

app.get("/api/attendance", async (req, res, next) => {
  try {
    const from = req.query.from || "2000-01-01";
    const to = req.query.to || "2999-12-31";
    res.json(await query("SELECT a.id, a.mode, a.occurred_at AS \"occurredAt\", a.sms_status AS \"smsStatus\", l.lrn, l.name, l.parent_name AS \"parentName\", l.phone, l.class_name AS \"className\" FROM attendance_logs a JOIN learners l ON l.id=a.learner_id WHERE a.occurred_at BETWEEN $1::timestamptz AND $2::timestamptz ORDER BY a.occurred_at DESC", [`${from} 00:00:00`, `${to} 23:59:59`]));
  } catch (error) { next(error); }
});

app.post("/api/attendance", async (req, res, next) => {
  try {
    const learner = (await query("SELECT * FROM learners WHERE lrn=$1 AND active=TRUE LIMIT 1", [req.body.lrn]))[0];
    if (!learner) return res.status(404).json({ error: "Learner not found" });
    const mode = ["Time IN", "Time OUT", "Absent"].includes(req.body.mode) ? req.body.mode : null;
    if (!mode) return res.status(400).json({ error: "Invalid attendance mode" });
    const result = await query("INSERT INTO attendance_logs (learner_id, mode, occurred_at, phone, created_by) VALUES ($1, $2, COALESCE($3::timestamptz, NOW()), $4, $5) RETURNING id", [learner.id, mode, req.body.occurredAt || null, learner.phone, req.user.id]);
    await audit(req, "Recorded attendance", { lrn: learner.lrn, mode });
    res.status(201).json({ id: result[0].id, lrn: learner.lrn, mode });
  } catch (error) { next(error); }
});

app.post("/api/sms/send", requireRole("admin", "staff"), async (req, res, next) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const message = String(req.body.message || "").trim();
    if (!phone || !message) return res.status(400).json({ error: "Valid Philippine phone and message are required" });
    if (!process.env.SMS_API_URL || !process.env.SMS_API_KEY) return res.status(503).json({ error: "SMS provider is not configured" });
    const providerResponse = await fetch(process.env.SMS_API_URL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.SMS_API_KEY}` }, body: JSON.stringify({ phone, message, senderId: process.env.SMS_SENDER_ID }) });
    if (!providerResponse.ok) return res.status(502).json({ error: "SMS provider rejected the request" });
    await audit(req, "Sent SMS", { phone });
    res.json({ sent: true, phone });
  } catch (error) { next(error); }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: "Server error" });
});

app.listen(port, "0.0.0.0", () => console.log(`Attendance API listening on port ${port}`));
