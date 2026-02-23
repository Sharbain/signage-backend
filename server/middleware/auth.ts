import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { pool } from "../db";

// NOTE:
// - User auth: Authorization: Bearer <jwt>
// - Device auth (canonical): Authorization: DeviceKey <raw_device_key>
// - Legacy device auth: Authorization: Device <token>  (or x-device-token header; may be raw key or legacy bcrypt secret)

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

function getDeviceKeyFromRequest(req: Request): string | undefined {
  const authHeader = getAuthHeader(req);
  if (authHeader?.startsWith("DeviceKey ")) return authHeader.slice("DeviceKey ".length).trim();
  return undefined;
}

function getLegacyDeviceTokenFromRequest(req: Request): string | undefined {
  const authHeader = getAuthHeader(req);
  const headerToken = req.headers["x-device-token"];

  const fromAuth =
    authHeader && authHeader.startsWith("Device ") ? authHeader.slice("Device ".length).trim() : undefined;

  const fromHeader =
    typeof headerToken === "string"
      ? headerToken
      : Array.isArray(headerToken) && typeof headerToken[0] === "string"
        ? headerToken[0]
        : undefined;

  return fromAuth || fromHeader;
}

async function findScreenByApiKeyHash(tokenHash: string) {
  const { rows } = await pool.query(
    `SELECT id, device_id, revoked_at
     FROM screens
     WHERE api_key_hash = $1
     LIMIT 1`,
    [tokenHash],
  );
  if (!rows.length) return null;
  return rows[0] as { id: number; device_id: string; revoked_at: string | null };
}

async function migrateLegacyPasswordToApiKey(screenId: number, tokenHash: string, rawToken: string) {
  // Move legacy bcrypt token -> api_key_hash (sha256)
  await pool.query(
    `UPDATE screens
     SET api_key_hash = $2,
         api_key_last4 = $3,
         password = NULL,
         rotated_at = NOW()
     WHERE id = $1`,
    [screenId, tokenHash, rawToken.slice(-4)],
  );
}

export async function authenticateJWT(req: Request, res: Response, next: NextFunction) {
  const authHeader = getAuthHeader(req);
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "missing_bearer_token" });
  }

  const token = authHeader.slice("Bearer ".length).trim();
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { sub: string; email?: string };
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
 * Device-only auth for /api/device/* routes.
 * Canonical: Authorization: DeviceKey <raw_key>
 * Legacy: Authorization: Device <token> OR x-device-token (raw_key OR legacy bcrypt secret)
 */
export async function authenticateDevice(req: Request, res: Response, next: NextFunction) {
  try {
    // ✅ Canonical DeviceKey (no deviceId required)
    const rawDeviceKey = getDeviceKeyFromRequest(req);
    if (rawDeviceKey) {
      const tokenHash = sha256Hex(rawDeviceKey);
      const screen = await findScreenByApiKeyHash(tokenHash);
      if (!screen) return res.status(401).json({ error: "invalid_device_key" });
      if (screen.revoked_at) return res.status(401).json({ error: "device_revoked" });

      req.device = { deviceId: screen.device_id, screenId: screen.id };
      return next();
    }

    // Legacy token (Device <token> / x-device-token)
    const legacyToken = getLegacyDeviceTokenFromRequest(req);
    if (!legacyToken) return res.status(401).json({ error: "missing_device_token" });

    const tokenHash = sha256Hex(legacyToken);

    // Fast-path: maybe the legacy token is actually an API key already
    const screenFast = await findScreenByApiKeyHash(tokenHash);
    if (screenFast) {
      if (screenFast.revoked_at) return res.status(401).json({ error: "device_revoked" });
      req.device = { deviceId: screenFast.device_id, screenId: screenFast.id };
      return next();
    }

    // Fallback: legacy bcrypt secret stored in screens.password (we don't know device_id here).
    // Keep bounded for safety (should phase out once all devices migrate).
    const { rows } = await pool.query(
      `SELECT id, device_id, password, revoked_at
       FROM screens
       WHERE password IS NOT NULL
       LIMIT 500`,
    );

    for (const r of rows as Array<{ id: number; device_id: string; password: string; revoked_at: string | null }>) {
      if (r.revoked_at) continue;
      const ok = await bcrypt.compare(legacyToken, r.password);
      if (!ok) continue;

      // Auto-migrate on successful legacy auth
      await migrateLegacyPasswordToApiKey(r.id, tokenHash, legacyToken);

      req.device = { deviceId: r.device_id, screenId: r.id };
      return next();
    }

    return res.status(401).json({ error: "invalid_device_token" });
  } catch (e) {
    console.error("authenticateDevice error", e);
    return res.status(500).json({ error: "device_auth_failed" });
  }
}

/**
 * Allows either:
 * - User JWT: Authorization: Bearer <jwt>
 * - Device: Authorization: DeviceKey <raw> OR legacy device token headers
 *
 * Used for endpoints that can be hit by either dashboards (user) or devices (uploads, etc.)
 */
export async function authenticateUserOrDevice(req: Request, res: Response, next: NextFunction) {
  const authHeader = getAuthHeader(req);

  // User takes priority if Bearer present
  if (authHeader?.startsWith("Bearer ")) {
    return authenticateJWT(req, res, next);
  }

  // DeviceKey present => authenticate as device
  if (getDeviceKeyFromRequest(req)) {
    return authenticateDevice(req, res, next);
  }

  // Legacy device token present => authenticate as device
  if (getLegacyDeviceTokenFromRequest(req)) {
    return authenticateDevice(req, res, next);
  }

  return res.status(401).json({ error: "unauthorized" });
}
