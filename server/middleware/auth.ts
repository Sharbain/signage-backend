import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { pool } from "../db";

// NOTE:
// - User auth: Authorization: Bearer <jwt>
// - Device auth supports:
//   - ?token=<device token>
//   - Authorization: Device <token>
//   - Authorization: DeviceToken <token>
//   - Authorization: Bearer <token>   (device endpoints only)
//   - X-Device-Token: <token>
//
// SaaS-grade device auth model:
// - Preferred: screens.api_key_hash (sha256 hex; indexed lookup)
// - Transitional compatibility: screens.api_key_hash stored as bcrypt/plaintext
// - Legacy fallback by device_id only: screens.password (bcrypt/plaintext)
//
// IMPORTANT:
// - This backend/schema does NOT use screens.device_key.
// - Do not query screens.device_key anywhere in this middleware.

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET environment variable must be set");
}

const JWT_SECRET = process.env.JWT_SECRET;

export type AuthedUser = {
  id: string;
  email: string;
  role: string;
  orgId: string | null; // null for super-admins with no org
};

declare global {
  namespace Express {
    interface Request {
      user?: AuthedUser;
      device?: { deviceId: string; screenId: number };
    }
  }
}

function getAuthHeader(req: Request): string | undefined {
  const h = req.headers.authorization;
  if (!h) return undefined;
  return Array.isArray(h) ? h[0] : h;
}

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

function getFullPath(req: Request) {
  return `${req.baseUrl || ""}${req.path || ""}` || "";
}

function isDeviceOrPlayerPath(req: Request) {
  const full = getFullPath(req);
  return full.startsWith("/api/device/") || full.startsWith("/api/screens/");
}

function readDeviceId(req: Request): string | undefined {
  const p: any = req.params || {};
  const b: any = req.body || {};

  const candidate =
    p.deviceId ??
    p.id ??
    p.screenId ??
    b.deviceId ??
    b.device_id ??
    b.id;

  if (typeof candidate !== "string") return undefined;
  const deviceId = candidate.trim();
  return deviceId || undefined;
}

function readDeviceToken(req: Request): string | undefined {
  const qTokenRaw: any = (req.query as any)?.token;
  const qToken =
    typeof qTokenRaw === "string"
      ? qTokenRaw
      : Array.isArray(qTokenRaw)
        ? qTokenRaw[0]
        : undefined;

  const headerToken = req.headers["x-device-token"];
  const xDeviceToken =
    typeof headerToken === "string"
      ? headerToken
      : Array.isArray(headerToken)
        ? headerToken[0]
        : undefined;

  const auth = getAuthHeader(req);
  const lower = (auth || "").toLowerCase();

  let authToken: string | undefined;
  if (auth) {
    if (lower.startsWith("device ")) authToken = auth.slice("Device ".length).trim();
    else if (lower.startsWith("devicetoken ")) authToken = auth.slice("DeviceToken ".length).trim();
    else if (lower.startsWith("bearer ")) authToken = auth.slice("Bearer ".length).trim();
  }

  const token = (qToken || authToken || xDeviceToken || "").trim();
  return token || undefined;
}

function isValidDeviceId(deviceId: string) {
  return /^[a-zA-Z0-9_-]{3,64}$/.test(deviceId);
}

function looksLikeBcrypt(value: string) {
  return value.startsWith("$2a$") || value.startsWith("$2b$") || value.startsWith("$2y$");
}

function looksLikeSha256Hex(value: string) {
  return /^[0-9a-f]{64}$/i.test(value);
}

/**
 * USER JWT AUTH (dashboard/admin)
 *
 * IMPORTANT:
 * Some projects mount authenticateJWT on "/api" globally.
 * We must bypass device/player APIs so they can use authenticateDevice.
 */
export async function authenticateJWT(req: Request, res: Response, next: NextFunction) {
  if (isDeviceOrPlayerPath(req)) return next();

  const authHeader = getAuthHeader(req);
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "missing_bearer_token" });
  }

  const token = authHeader.slice("Bearer ".length).trim();
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { sub?: string; email?: string };
    const userId = decoded.sub;
    if (!userId) return res.status(401).json({ error: "invalid_token" });

    const { rows } = await pool.query(
      `SELECT u.id::text AS id, u.email, u.role,
              m.org_id::text AS org_id
       FROM users u
       LEFT JOIN memberships m ON m.user_id = u.id
       WHERE u.id = $1
       LIMIT 1`,
      [userId],
    );

    if (!rows.length) return res.status(401).json({ error: "user_not_found" });

    req.user = {
      id:     rows[0].id,
      email:  rows[0].email,
      role:   rows[0].role,
      orgId:  rows[0].org_id ?? null,
    };
    return next();
  } catch {
    return res.status(401).json({ error: "invalid_token" });
  }
}

/**
 * DEVICE AUTH
 *
 * Fast path:
 * - find the device by device_id
 * - verify token against api_key_hash (preferred)
 *
 * Transitional compatibility:
 * - if api_key_hash is bcrypt/plaintext, still accept and backfill sha256 hash
 * - if password exists, verify only for this device (NO table scan), then backfill api_key_hash
 */
export async function authenticateDevice(req: Request, res: Response, next: NextFunction) {
  const deviceId = readDeviceId(req);
  if (!deviceId) return res.status(400).json({ error: "deviceId_required" });
  if (!isValidDeviceId(deviceId)) return res.status(400).json({ error: "invalid_device_id" });

  const deviceToken = readDeviceToken(req);
  if (!deviceToken) return res.status(401).json({ error: "missing_device_token" });

  try {
    const tokenHash = sha256Hex(deviceToken);

    const result = await pool.query(
      `SELECT id, device_id, api_key_hash, password, revoked_at
       FROM screens
       WHERE device_id = $1
       LIMIT 1`,
      [deviceId],
    );

    if (!result.rows.length) return res.status(401).json({ error: "unknown_device" });

    const screen = result.rows[0] as {
      id: number;
      device_id: string;
      api_key_hash: string | null;
      password: string | null;
      revoked_at: string | null;
    };

    if (screen.revoked_at) return res.status(401).json({ error: "device_revoked" });

    // 1) Preferred: api_key_hash
    if (screen.api_key_hash && typeof screen.api_key_hash === "string") {
      const stored = screen.api_key_hash.trim();

      if (looksLikeSha256Hex(stored) && stored.toLowerCase() === tokenHash.toLowerCase()) {
        req.device = { deviceId: screen.device_id, screenId: screen.id };
        return next();
      }

      if (looksLikeBcrypt(stored)) {
        const ok = await bcrypt.compare(deviceToken, stored);
        if (ok) {
          await pool.query(
            `UPDATE screens
             SET api_key_hash = $2,
                 api_key_last4 = $3,
                 rotated_at = NOW()
             WHERE id = $1`,
            [screen.id, tokenHash, deviceToken.slice(-4)],
          );
          req.device = { deviceId: screen.device_id, screenId: screen.id };
          return next();
        }
      }

      // Transitional support if some rows accidentally stored plaintext in api_key_hash
      if (stored === deviceToken) {
        await pool.query(
          `UPDATE screens
           SET api_key_hash = $2,
               api_key_last4 = $3,
               rotated_at = NOW()
           WHERE id = $1`,
          [screen.id, tokenHash, deviceToken.slice(-4)],
        );
        req.device = { deviceId: screen.device_id, screenId: screen.id };
        return next();
      }
    }

    // 2) Legacy per-device password fallback (NO full-table scan)
    if (screen.password && typeof screen.password === "string" && screen.password.trim()) {
      const storedPassword = screen.password.trim();

      let ok = false;
      if (looksLikeBcrypt(storedPassword)) {
        ok = await bcrypt.compare(deviceToken, storedPassword);
      } else {
        ok = storedPassword === deviceToken;
      }

      if (ok) {
        await pool.query(
          `UPDATE screens
           SET api_key_hash = COALESCE(api_key_hash, $2),
               api_key_last4 = $3,
               rotated_at = NOW()
           WHERE id = $1`,
          [screen.id, tokenHash, deviceToken.slice(-4)],
        );
        req.device = { deviceId: screen.device_id, screenId: screen.id };
        return next();
      }
    }

    return res.status(401).json({ error: "invalid_device_token" });
  } catch (e) {
    console.error("authenticateDevice error", e);
    return res.status(500).json({ error: "device_auth_failed" });
  }
}

/**
 * USER OR DEVICE AUTH
 * - Bearer -> authenticateJWT
 * - Device token (any scheme) -> auth without requiring deviceId param
 *
 * SaaS-grade behavior:
 * - indexed exact lookup by api_key_hash first
 * - bounded compatibility scan only for transitional rows where api_key_hash
 *   was stored as bcrypt/plaintext, or legacy password still holds the token
 */
export async function authenticateUserOrDevice(req: Request, res: Response, next: NextFunction) {
  const auth = getAuthHeader(req);

  if (auth?.startsWith("Bearer ")) return authenticateJWT(req, res, next);

  const deviceToken = readDeviceToken(req);
  if (!deviceToken) return res.status(401).json({ error: "unauthorized" });

  try {
    const tokenHash = sha256Hex(deviceToken);

    // 1) Preferred exact indexed lookup
    const fast = await pool.query(
      `SELECT id, device_id, revoked_at
       FROM screens
       WHERE api_key_hash = $1
       LIMIT 1`,
      [tokenHash],
    );

    if (fast.rows.length) {
      const screen = fast.rows[0] as { id: number; device_id: string; revoked_at: string | null };
      if (screen.revoked_at) return res.status(401).json({ error: "device_revoked" });
      req.device = { deviceId: screen.device_id, screenId: screen.id };
      return next();
    }

    // 2) Compatibility mode for transitional rows only
    const { rows } = await pool.query(
      `SELECT id, device_id, api_key_hash, password, revoked_at
       FROM screens
       WHERE (api_key_hash IS NOT NULL OR password IS NOT NULL)
         AND (api_key_hash IS NULL OR api_key_hash !~ '^[0-9a-f]{64}$')
       LIMIT 500`,
    );

    for (const r of rows as Array<{
      id: number;
      device_id: string;
      api_key_hash: string | null;
      password: string | null;
      revoked_at: string | null;
    }>) {
      if (r.revoked_at) continue;

      if (r.api_key_hash) {
        const stored = r.api_key_hash.trim();

        if (looksLikeBcrypt(stored) && await bcrypt.compare(deviceToken, stored)) {
          await pool.query(
            `UPDATE screens
             SET api_key_hash = $2,
                 api_key_last4 = $3,
                 rotated_at = NOW()
             WHERE id = $1`,
            [r.id, tokenHash, deviceToken.slice(-4)],
          );
          req.device = { deviceId: r.device_id, screenId: r.id };
          return next();
        }

        if (stored === deviceToken) {
          await pool.query(
            `UPDATE screens
             SET api_key_hash = $2,
                 api_key_last4 = $3,
                 rotated_at = NOW()
             WHERE id = $1`,
            [r.id, tokenHash, deviceToken.slice(-4)],
          );
          req.device = { deviceId: r.device_id, screenId: r.id };
          return next();
        }
      }

      if (r.password) {
        const storedPassword = r.password.trim();
        let ok = false;

        if (looksLikeBcrypt(storedPassword)) {
          ok = await bcrypt.compare(deviceToken, storedPassword);
        } else {
          ok = storedPassword === deviceToken;
        }

        if (ok) {
          await pool.query(
            `UPDATE screens
             SET api_key_hash = COALESCE(api_key_hash, $2),
                 api_key_last4 = $3,
                 rotated_at = NOW()
             WHERE id = $1`,
            [r.id, tokenHash, deviceToken.slice(-4)],
          );
          req.device = { deviceId: r.device_id, screenId: r.id };
          return next();
        }
      }
    }

    return res.status(401).json({ error: "invalid_device_token" });
  } catch (e) {
    console.error("authenticateUserOrDevice error", e);
    return res.status(500).json({ error: "auth_failed" });
  }
}
