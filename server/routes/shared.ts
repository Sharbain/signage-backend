/**
 * _shared.ts
 * Shared helpers used across multiple route modules.
 * Extracted from the monolithic routes.ts.
 */

import type { Request } from "express";
import path from "path";
import crypto from "crypto";
import bcrypt from "bcrypt";
import { pool } from "../db";
import { storage } from "../storage";

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

export function getPublicBaseUrl(req: Request): string {
  const configured = String(
    process.env.PUBLIC_BASE_URL || process.env.BASE_URL || "",
  ).trim();

  const host =
    (String(req.headers["x-forwarded-host"] || "").split(",")[0] || "").trim() ||
    (req.get("host") || "").trim();

  const forwardedProto =
    (String(req.headers["x-forwarded-proto"] || "").split(",")[0] || "").trim() ||
    "";

  const looksLocal = (v: string) => /localhost|127\.0\.0\.1/i.test(v);

  if (configured && !looksLocal(configured)) {
    return trimTrailingSlash(configured);
  }

  if (host) {
    const proto =
      forwardedProto ||
      (host.includes("onrender.com") || host.includes("vercel.app")
        ? "https"
        : req.protocol || "http");
    return trimTrailingSlash(`${proto}://${host}`);
  }

  if (configured) {
    return trimTrailingSlash(configured);
  }

  return `http://localhost:${process.env.PORT || 5000}`;
}

function isProtectedUploadPath(raw: string): boolean {
  return /^\/?uploads\/(screenshots|recordings|group-icons|device-thumbnails|clients)\//i.test(
    raw,
  );
}

export function toPublicMediaPath(value: string | null | undefined): string | null {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      const p = u.pathname || "";
      if (/^\/media\//i.test(p)) return `/media/${path.basename(p)}`;
      if (/^\/uploads\//i.test(p) && !isProtectedUploadPath(p))
        return `/media/${path.basename(p)}`;
      return raw;
    } catch {
      return raw;
    }
  }

  if (/^\/?media\//i.test(raw)) return `/media/${path.basename(raw)}`;
  if (/^\/?uploads\//i.test(raw) && !isProtectedUploadPath(raw))
    return `/media/${path.basename(raw)}`;
  if (/^uploads\//i.test(raw) && !isProtectedUploadPath(`/${raw}`))
    return `/media/${path.basename(raw)}`;

  return raw;
}

export function toAbsoluteMediaUrl(
  req: Request,
  value: string | null | undefined,
): string | null {
  const normalized = toPublicMediaPath(value);
  if (!normalized) return null;
  const base = getPublicBaseUrl(req);
  if (/^https?:\/\//i.test(normalized))
    return normalized.replace(/^http:\/\/localhost:\d+/i, base);
  if (normalized.startsWith("/")) return `${base}${normalized}`;
  return `${base}/${normalized.replace(/^\/+/, "")}`;
}

export function absolutizeAssetUrl(
  req: Request,
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  const mediaUrl = toAbsoluteMediaUrl(req, raw);
  if (mediaUrl && mediaUrl !== raw) return mediaUrl;

  const base = getPublicBaseUrl(req);
  if (raw.startsWith("/")) return `${base}${raw}`;
  if (/^https?:\/\//i.test(raw)) return raw.replace(/^http:\/\/localhost:\d+/i, base);
  if (raw.startsWith("uploads/")) return `${base}/${raw}`;
  return raw;
}

export function normalizeMediaRow<T extends Record<string, any>>(
  req: Request,
  row: T,
): T {
  const next: T = { ...row };
  if ("url" in next) next.url = absolutizeAssetUrl(req, next.url);
  if ("thumbnail" in next) next.thumbnail = absolutizeAssetUrl(req, next.thumbnail);
  if ("screenshot" in next) next.screenshot = absolutizeAssetUrl(req, next.screenshot);
  if ("last_recording" in next)
    next.last_recording = absolutizeAssetUrl(req, next.last_recording);
  if ("lastScreenshot" in next)
    next.lastScreenshot = absolutizeAssetUrl(req, next.lastScreenshot);
  if ("file" in next) next.file = absolutizeAssetUrl(req, next.file);
  return next;
}

// ---------------------------------------------------------------------------
// Device token helpers (used by screens + heartbeat)
// ---------------------------------------------------------------------------

export const sha256Hex = (v: string) =>
  crypto.createHash("sha256").update(v, "utf8").digest("hex");

export const looksLikeBcrypt = (v: string) =>
  v.startsWith("$2a$") || v.startsWith("$2b$") || v.startsWith("$2y$");

export const looksLikeSha256Hex = (v: string) => /^[0-9a-f]{64}$/i.test(v);

export function extractDeviceToken(req: Request): string | null {
  const q = (req.query?.token as string | undefined)?.trim();
  if (q) return q;

  const xdt = (req.headers["x-device-token"] as string | undefined)?.trim();
  if (xdt) return xdt;

  const auth = (req.headers.authorization as string | undefined)?.trim();
  if (!auth) return null;

  const lower = auth.toLowerCase();
  if (lower.startsWith("device ")) return auth.slice("device ".length).trim();
  if (lower.startsWith("devicetoken ")) return auth.slice("devicetoken ".length).trim();
  if (lower.startsWith("bearer ")) return auth.slice("bearer ".length).trim();

  return null;
}

import type { Response } from "express";

export async function verifyDeviceTokenOrFail(
  req: Request,
  res: Response,
  deviceId: string,
): Promise<{ screen: any; token: string } | null> {
  const token = extractDeviceToken(req);
  if (!token) {
    res.status(401).json({ error: "missing_device_token" });
    return null;
  }

  const screen = await storage.getScreenByDeviceId(deviceId);
  if (!screen) {
    res.status(404).json({ error: "device_not_found" });
    return null;
  }

  const tokenTrim = token.trim();

  // 1) Preferred: api_key_hash (sha256)
  const apiKeyHash =
    (screen as any).apiKeyHash ?? (screen as any).api_key_hash ?? null;

  if (typeof apiKeyHash === "string" && apiKeyHash.trim()) {
    const expected = apiKeyHash.trim();
    if (looksLikeSha256Hex(expected)) {
      if (sha256Hex(tokenTrim).toLowerCase() === expected.toLowerCase())
        return { screen, token: tokenTrim };
    } else if (looksLikeBcrypt(expected)) {
      const ok = await bcrypt.compare(tokenTrim, expected);
      if (ok) {
        await pool.query(
          `UPDATE screens SET api_key_hash = $2, api_key_last4 = $3, rotated_at = NOW() WHERE device_id = $1`,
          [deviceId, sha256Hex(tokenTrim), tokenTrim.slice(-4)],
        );
        return { screen, token: tokenTrim };
      }
    } else if (expected === tokenTrim) {
      await pool.query(
        `UPDATE screens SET api_key_hash = $2, api_key_last4 = $3, rotated_at = NOW() WHERE device_id = $1`,
        [deviceId, sha256Hex(tokenTrim), tokenTrim.slice(-4)],
      );
      return { screen, token: tokenTrim };
    }
  }

  // 2) Legacy password fallback
  const password = (screen as any).password as string | null | undefined;
  if (password && typeof password === "string" && password.trim()) {
    const p = password.trim();
    let ok = false;
    if (looksLikeBcrypt(p)) {
      ok = await bcrypt.compare(tokenTrim, p);
    } else {
      ok = p === tokenTrim;
    }
    if (ok) {
      await pool.query(
        `UPDATE screens SET api_key_hash = COALESCE(api_key_hash, $2), api_key_last4 = $3, rotated_at = NOW() WHERE device_id = $1`,
        [deviceId, sha256Hex(tokenTrim), tokenTrim.slice(-4)],
      );
      return { screen, token: tokenTrim };
    }
  }

  res.status(403).json({ error: "invalid_device_token" });
  return null;
}
