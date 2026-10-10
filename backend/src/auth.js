import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { query } from "./db.js";

export async function login(email, password) {
  const rows = await query("SELECT * FROM users WHERE email = $1 LIMIT 1", [email]);
  const user = rows[0];
  if (!user?.password_hash || !(await bcrypt.compare(password, user.password_hash))) return null;
  return createApiSession(user);
}

function createApiSession(user) {
  const publicUser = { id: user.id, email: user.email, role: user.role };
  const token = jwt.sign(publicUser, process.env.JWT_SECRET, { expiresIn: "8h" });
  return { token, user: publicUser };
}

export async function loginWithSupabaseToken(accessToken) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !publishableKey) {
    throw new Error("Supabase Auth is not configured on the backend");
  }
  if (!accessToken) return { error: "invalid_token" };

  const response = await fetch(`${supabaseUrl.replace(/\/$/, "")}/auth/v1/user`, {
    headers: {
      apikey: publishableKey,
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (response.status === 401 || response.status === 403) return { error: "invalid_token" };
  if (!response.ok) throw new Error("Unable to verify Supabase Auth session");

  const identity = await response.json();
  const email = String(identity.email || "").trim().toLowerCase();
  if (!email || !identity.email_confirmed_at) return { error: "unverified_email" };

  // A valid Google/Supabase identity is not automatically an app account.
  // An administrator must provision the email and role in public.users first.
  const rows = await query(
    "SELECT id, email, role FROM users WHERE LOWER(email) = $1 LIMIT 1",
    [email],
  );
  if (!rows[0]) return { error: "not_authorized" };
  return createApiSession(rows[0]);
}

export function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "Authentication required" });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

export function requireRole(...roles) {
  return (req, res, next) => roles.includes(req.user?.role)
    ? next()
    : res.status(403).json({ error: "Insufficient permissions" });
}
