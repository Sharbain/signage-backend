import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { pool } from "../db";

// NOTE:
// - User auth: Authorization: Bearer <jwt>
// - Device auth: Authorization: Device <token>  (or X-Device-Token header)

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

export async function authenticateDevice(req: Request, res: Response, next: NextFunction) {
  const authHeader = getAuthHeader(req);
  const headerToken = req.headers["x-device-token"];
  const deviceToken =
    (authHeader && authHeader.startsWith("Device ") ? authHeader.slice("Device ".length).trim() : undefined) ||
    (typeof headerToken === "string" ? headerToken : Array.isArray(headerToken) ? headerToken[0] : undefined);

  const deviceId = (req.params as any).deviceId || (req.body as any)?.deviceId;
  if (!deviceId || typeof deviceId !== "string") {
    return res.status(400).json({ error: "deviceId_required" });
  }

  // Strict allowlist to prevent path traversal and odd identifiers.
  if (!/^[a-zA-Z0-9_-]{3,64}$/.test(deviceId)) {
    return res.status(400).json({ error: "invalid_device_id" });
  }

  if (!deviceToken) {
    return res.status(401).json({ error: "missing_device_token" });
  }

  try {
    const tokenHash = sha256Hex(deviceToken);

    // --------------------------------------------------
    // Fast-path (v2): sha256 token lookup with an index
    // NOTE: If the DB hasn't been migrated yet (missing column),
    // we gracefully fall back to the legacy bcrypt path.
    // --------------------------------------------------
    try {
      const fast = await pool.query(
        `SELECT id, device_id, api_key_hash, revoked_at
         FROM screens
         WHERE device_id = $1
           AND api_key_hash = $2
         LIMIT 1`,
        [deviceId, tokenHash],
      );

      if (fast.rows.length) {
        const screen = fast.rows[0] as { id: number; device_id: string; revoked_at: string | null };
        if (screen.revoked_at) return res.status(401).json({ error: "device_revoked" });
        req.device = { deviceId: screen.device_id, screenId: screen.id };
        return next();
      }
    } catch (e: any) {
      // 42703 = undefined_column (Postgres)
      if (String(e?.code) !== "42703") throw e;
    }

    // --------------------------------------------------
    // Legacy-path (v1): bcrypt compare against screens.password
    // On success, auto-migrate to v2 fields (api_key_hash).
    // --------------------------------------------------
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

    // Auto-migrate on successful legacy auth.
    await pool.query(
      `UPDATE screens
       SET api_key_hash = $2,
           api_key_last4 = $3,
           password = NULL,
           rotated_at = NOW()
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

export async function authenticateUserOrDevice(req: Request, res: Response, next: NextFunction) {
  const authHeader = getAuthHeader(req);
  const headerToken = req.headers["x-device-token"];
  const hasDeviceToken =
    (authHeader && authHeader.startsWith("Device ")) ||
    typeof headerToken === "string" ||
    (Array.isArray(headerToken) && typeof headerToken[0] === "string");

  if (authHeader?.startsWith("Bearer ")) {
    return authenticateJWT(req, res, next);
  }

  // For static uploads, we don't have a deviceId param. We accept any registered device token.
  if (hasDeviceToken) {
    const deviceToken =
      (authHeader && authHeader.startsWith("Device ") ? authHeader.slice("Device ".length).trim() : undefined) ||
      (typeof headerToken === "string" ? headerToken : Array.isArray(headerToken) ? headerToken[0] : undefined);
    if (!deviceToken) return res.status(401).json({ error: "missing_device_token" });

    try {
      const tokenHash = sha256Hex(deviceToken);

      // Fast-path: api_key_hash lookup (no deviceId required for /uploads)
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
      } catch (e: any) {
        if (String(e?.code) !== "42703") throw e;
      }

      // Legacy fallback (temporary): scan a bounded number of legacy bcrypt tokens.
      const { rows } = await pool.query(
        `SELECT id, device_id, password
         FROM screens
         WHERE password IS NOT NULL
         LIMIT 500`,
      );
      for (const r of rows as Array<{ id: number; device_id: string; password: string }>) {
        if (await bcrypt.compare(deviceToken, r.password)) {
          // Auto-migrate to v2 on first successful legacy use.
          await pool.query(
            `UPDATE screens
             SET api_key_hash = $2,
                 api_key_last4 = $3,
                 password = NULL,
                 rotated_at = NOW()
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

  return res.status(401).json({ error: "unauthorized" });
}
