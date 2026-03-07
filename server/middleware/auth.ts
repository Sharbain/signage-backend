import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { pool } from "../db";

// NOTE:
// - User auth: Authorization: Bearer <jwt>
// - Device auth supports:
//   - ?token=<deviceKey>
//   - Authorization: Device <token>
//   - Authorization: DeviceToken <token>
//   - Authorization: Bearer <token>   (device endpoints only)
//   - X-Device-Token: <token>

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET environment variable must be set");
}

const JWT_SECRET = process.env.JWT_SECRET;

export type AuthedUser = {
  id: string;
  email: string;
  role: string;
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
  return crypto.createHash("sha256").update(input).digest("hex");
}

function getFullPath(req: Request) {
  // baseUrl is the mounted path (e.g. "/api"), path is the remaining path (e.g. "/device/DEV/playlist")
  return `${req.baseUrl || ""}${req.path || ""}` || "";
}

function isDeviceOrPlayerPath(req: Request) {
  const full = getFullPath(req);
  // Only bypass JWT middleware for these API groups
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
  // Query param token support (your playlist endpoint supports it)
  const qTokenRaw: any = (req.query as any)?.token;
  const qToken =
    typeof qTokenRaw === "string"
      ? qTokenRaw
      : Array.isArray(qTokenRaw)
        ? qTokenRaw[0]
        : undefined;

  // Header token support
  const headerToken = req.headers["x-device-token"];
  const xDeviceToken =
    typeof headerToken === "string"
      ? headerToken
      : Array.isArray(headerToken)
        ? headerToken[0]
        : undefined;

  const auth = getAuthHeader(req);
  const lower = (auth || "").toLowerCase();

  // Support multiple auth schemes
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
  // allow DEV-XXXX plus UUID-ish and basic safe identifiers
  return /^[a-zA-Z0-9_-]{3,64}$/.test(deviceId);
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
      `SELECT id::text AS id, email, role
       FROM users
       WHERE id = $1`,
      [userId],
    );

    if (!rows.length) return res.status(401).json({ error: "user_not_found" });

    req.user = { id: rows[0].id, email: rows[0].email, role: rows[0].role };
    return next();
  } catch {
    return res.status(401).json({ error: "invalid_token" });
  }
}

/**
 * DEVICE AUTH
 *
 * Supports:
 * - v2 plaintext in screens.device_key (your current SaaS v2)
 * - optional v2 hashed in screens.api_key_hash (if you migrate)
 * - legacy bcrypt in screens.password (auto-migrates if desired)
 */
export async function authenticateDevice(req: Request, res: Response, next: NextFunction) {
  const deviceId = readDeviceId(req);
  if (!deviceId) return res.status(400).json({ error: "deviceId_required" });
  if (!isValidDeviceId(deviceId)) return res.status(400).json({ error: "invalid_device_id" });

  const deviceToken = readDeviceToken(req);
  if (!deviceToken) return res.status(401).json({ error: "missing_device_token" });

  try {
    const tokenHash = sha256Hex(deviceToken);

    // 1) Prefer SaaS v2 plaintext device_key if present
    // (your backend previously validated against screens.device_key)
    try {
      const v2 = await pool.query(
        `SELECT id, device_id, api_key_hash, password, revoked_at
        FROM screens
        WHERE device_id = $1
        LIMIT 1`,
       [deviceId],
       );

      if (!v2.rows.length) return res.status(401).json({ error: "unknown_device" });

      const screen = v2.rows[0] as {
        id: number;
        device_id: string;
        device_key: string | null;
        api_key_hash: string | null;
        revoked_at: string | null;
      };

      if (screen.revoked_at) return res.status(401).json({ error: "device_revoked" });

      // a) hashed token fast path (if you have api_key_hash)
      if (screen.api_key_hash && screen.api_key_hash === tokenHash) {
        req.device = { deviceId: screen.device_id, screenId: screen.id };
        return next();
      }

      // b) plaintext key path (SaaS v2)
      if (screen.device_key && screen.device_key === deviceToken) {
        // Optional: you can backfill api_key_hash to enable fast lookup
        // (don’t clear device_key unless you intentionally migrate away from plaintext)
        if (!screen.api_key_hash) {
          await pool.query(
            `UPDATE screens SET api_key_hash = $2, api_key_last4 = $3, rotated_at = NOW()
             WHERE id = $1`,
            [screen.id, tokenHash, deviceToken.slice(-4)],
          );
        }

        req.device = { deviceId: screen.device_id, screenId: screen.id };
        return next();
      }
    } catch (e) {
      console.error("authenticateDevice v2 lookup error", e);
      // continue to legacy bcrypt fallback below
    }

    // 2) Legacy bcrypt fallback (screens.password)
    const legacy = await pool.query(
      `SELECT id, device_id, password, api_key_hash, revoked_at
       FROM screens
       WHERE device_id = $1
       LIMIT 1`,
      [deviceId],
    );

    if (!legacy.rows.length) return res.status(401).json({ error: "unknown_device" });

    const screen = legacy.rows[0] as {
      id: number;
      device_id: string;
      password: string | null;
      api_key_hash: string | null;
      revoked_at: string | null;
    };

    if (screen.revoked_at) return res.status(401).json({ error: "device_revoked" });
    if (!screen.password) return res.status(401).json({ error: "invalid_device_token" });

    const ok = await bcrypt.compare(deviceToken, screen.password);
    if (!ok) return res.status(401).json({ error: "invalid_device_token" });

    // Auto-migrate on successful legacy auth:
    // Keep password or clear it depending on your policy.
    await pool.query(
      `UPDATE screens
       SET api_key_hash = COALESCE(api_key_hash, $2),
           api_key_last4 = $3,
           rotated_at = NOW()
           -- , password = NULL
       WHERE id = $1`,
      [screen.id, tokenHash, deviceToken.slice(-4)],
    );

    req.device = { deviceId: screen.device_id, screenId: screen.id };
    return next();
  } catch (e) {
    console.error("authenticateDevice error", e);
    return res.status(500).json({ error: "device_auth_failed" });
  }
}

/**
 * USER OR DEVICE AUTH
 * - Bearer -> authenticateJWT
 * - Device token (any scheme) -> authenticateDevice-like but without requiring deviceId param
 *   (useful for static upload endpoints where deviceId isn't in the URL)
 */
export async function authenticateUserOrDevice(req: Request, res: Response, next: NextFunction) {
  const auth = getAuthHeader(req);

  if (auth?.startsWith("Bearer ")) return authenticateJWT(req, res, next);

  const deviceToken = readDeviceToken(req);
  if (!deviceToken) return res.status(401).json({ error: "unauthorized" });

  try {
    const tokenHash = sha256Hex(deviceToken);

    // Fast path: api_key_hash lookup
    try {
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
    } catch {
      // ignore
    }

    // Plaintext v2 fallback: device_key lookup
    const v2 = await pool.query(
      `SELECT id, device_id, device_key, revoked_at
       FROM screens
       WHERE device_key = $1
       LIMIT 1`,
      [deviceToken],
    );

    if (v2.rows.length) {
      const screen = v2.rows[0] as { id: number; device_id: string; revoked_at: string | null };
      if (screen.revoked_at) return res.status(401).json({ error: "device_revoked" });

      // backfill hash for fast future lookups
      await pool.query(
        `UPDATE screens SET api_key_hash = COALESCE(api_key_hash, $2), api_key_last4 = $3, rotated_at = NOW()
         WHERE id = $1`,
        [screen.id, tokenHash, deviceToken.slice(-4)],
      );

      req.device = { deviceId: screen.device_id, screenId: screen.id };
      return next();
    }

    // Legacy fallback: bounded scan
    const { rows } = await pool.query(
      `SELECT id, device_id, password
       FROM screens
       WHERE password IS NOT NULL
       LIMIT 500`,
    );

    for (const r of rows as Array<{ id: number; device_id: string; password: string }>) {
      if (await bcrypt.compare(deviceToken, r.password)) {
        await pool.query(
          `UPDATE screens
           SET api_key_hash = COALESCE(api_key_hash, $2),
               api_key_last4 = $3,
               rotated_at = NOW()
               -- , password = NULL
           WHERE id = $1`,
          [r.id, tokenHash, deviceToken.slice(-4)],
        );

        req.device = { deviceId: r.device_id, screenId: r.id };
        return next();
      }
    }

    return res.status(401).json({ error: "invalid_device_token" });
  } catch (e) {
    console.error("authenticateUserOrDevice error", e);
    return res.status(500).json({ error: "auth_failed" });
  }
}

