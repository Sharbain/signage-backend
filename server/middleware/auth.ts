import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
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
    const { rows } = await pool.query(
      `SELECT id, device_id, password
       FROM screens
       WHERE device_id = $1`,
      [deviceId],
    );
    if (!rows.length) return res.status(401).json({ error: "unknown_device" });

    const screen = rows[0] as { id: number; device_id: string; password: string | null };
    if (!screen.password) return res.status(401).json({ error: "device_token_not_set" });

    const ok = await bcrypt.compare(deviceToken, screen.password);
    if (!ok) return res.status(401).json({ error: "invalid_device_token" });

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
      const { rows } = await pool.query(
        `SELECT id, device_id, password
         FROM screens
         WHERE password IS NOT NULL
         LIMIT 500`,
      );
      for (const r of rows as Array<{ id: number; device_id: string; password: string }>) {
        if (await bcrypt.compare(deviceToken, r.password)) {
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
