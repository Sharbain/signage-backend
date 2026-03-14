import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import crypto, { randomUUID } from "crypto";
import {
  storage,
  saveDeviceStatus,
  getDashboardSummary,
  listDevicesForDashboard,
  getDashboardAlerts,
  listAllDevicesWithStatus,
  getDeviceDetails,
  createDevice,
  queueCommand,
  getQueuedCommands,
  markCommandExecuted,
  updateDeviceScreenshot,
  updateDeviceRecording,
} from "./storage";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import multer from "multer";
import path from "path";
import fs from "fs";
import express from "express";
import {
  insertScreenSchema,
  insertMediaSchema,
  insertTemplateSchema,
  insertTemplatePlaylistItemSchema,
} from "@shared/schema";
import { pool } from "./db";
import { z } from "zod";
import { requireRole } from "./middleware/permissions";
import { authenticateJWT, authenticateDevice, authenticateUserOrDevice } from "./middleware/auth";
import { registerAuthRoutes } from "./routes/auth.routes";
import { registerDeviceRoutes } from "./routes/device.routes";
import { registerPublishJobRoutes } from "./routes/publish-jobs.routes";
import { registerScreensRoutes } from "./routes/screens.routes";
import { registerClientRoutes } from "./routes/clients.routes";
import { registerScheduleRoutes } from "./routes/schedule.routes";
import { registerGroupRoutes } from "./routes/groups.routes";
import { broadcastPublishJobUpdate } from "./ws";
import { createClient } from "@supabase/supabase-js";

// Supabase Storage client (server-side, uses service role key)
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const uploadsDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const screenshotsDir = path.join(process.cwd(), "uploads", "screenshots");
if (!fs.existsSync(screenshotsDir)) {
  fs.mkdirSync(screenshotsDir, { recursive: true });
}

const recordingsDir = path.join(process.cwd(), "uploads", "recordings");
if (!fs.existsSync(recordingsDir)) {
  fs.mkdirSync(recordingsDir, { recursive: true });
}

const groupIconsDir = path.join(process.cwd(), "uploads", "group-icons");
if (!fs.existsSync(groupIconsDir)) {
  fs.mkdirSync(groupIconsDir, { recursive: true });
}

const deviceThumbnailsDir = path.join(process.cwd(), "uploads", "device-thumbnails");
if (!fs.existsSync(deviceThumbnailsDir)) {
  fs.mkdirSync(deviceThumbnailsDir, { recursive: true });
}

const frontendDir = path.join(process.cwd(), "frontend");

const multerStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

const upload = multer({
  storage: multerStorage,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowedExts = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".mp4", ".webm", ".mov"]);
    const allowedMimes = new Set([
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/gif",
      "image/webp",
      "video/mp4",
      "video/webm",
      "video/quicktime",
    ]);

    const ext = path.extname(file.originalname).toLowerCase();
    const mime = String(file.mimetype || "").toLowerCase();

    if (allowedExts.has(ext) && allowedMimes.has(mime)) cb(null, true);
    else cb(new Error("Only JPG/JPEG/PNG/GIF/WebP/MP4/WebM/MOV files allowed"));
  },
});

// Supabase Storage upload — uses memory buffer instead of disk
const uploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowedExts = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".mp4", ".webm", ".mov"]);
    const allowedMimes = new Set([
      "image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp",
      "video/mp4", "video/webm", "video/quicktime",
    ]);
    const ext = path.extname(file.originalname).toLowerCase();
    const mime = String(file.mimetype || "").toLowerCase();
    if (allowedExts.has(ext) && allowedMimes.has(mime)) cb(null, true);
    else cb(new Error("Only JPG/JPEG/PNG/GIF/WebP/MP4/WebM/MOV files allowed"));
  },
});

// Recording upload configuration
const recordingStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, recordingsDir),
  filename: (req, file, cb) => {
    const deviceId = (req.params as { deviceId: string }).deviceId || "unknown";
    const timestamp = Date.now();
    cb(null, `${deviceId}-${timestamp}${path.extname(file.originalname)}`);
  },
});

const recordingUpload = multer({
  storage: recordingStorage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 100MB limit for recordings
  fileFilter: (_req, file, cb) => {
    const allowed = /mp4|webm|mov|avi|mkv/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = /video/.test(file.mimetype);
    if (ext || mime) cb(null, true);
    else cb(new Error("Only video files allowed for recordings"));
  },
});

// Group icon upload configuration
const groupIconStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, groupIconsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `group_${Date.now()}${ext}`);
  },
});

const groupIconUpload = multer({
  storage: groupIconStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit for icons
  fileFilter: (_req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp|svg/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = /image/.test(file.mimetype);
    if (ext && mime) cb(null, true);
    else cb(new Error("Only image files allowed for group icons"));
  },
});

// Device thumbnail upload configuration
const deviceThumbnailStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, deviceThumbnailsDir),
  filename: (req, file, cb) => {
    const deviceId = (req.params as { deviceId: string }).deviceId || "unknown";
    const ext = path.extname(file.originalname);
    cb(null, `${deviceId}${ext}`);
  },
});

const deviceThumbnailUpload = multer({
  storage: deviceThumbnailStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit for thumbnails
  fileFilter: (_req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = /image/.test(file.mimetype);
    if (ext && mime) cb(null, true);
    else cb(new Error("Only image files allowed for device thumbnails"));
  },
});

// Client attachment upload configuration
const clientAttachmentsDir = path.join(process.cwd(), "uploads", "clients");
fs.mkdirSync(clientAttachmentsDir, { recursive: true });

const clientAttachmentStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, clientAttachmentsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `attachment_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
  },
});

const clientAttachmentUpload = multer({
  storage: clientAttachmentStorage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
  fileFilter: (_req, file, cb) => {
    const allowedMimes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'image/jpeg',
      'image/png',
      'image/gif',
      'text/plain',
    ];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF, Word, Excel, PowerPoint, and image files are allowed"));
    }
  },
});

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET environment variable must be set");
}
const JWT_SECRET = process.env.JWT_SECRET;

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function getPublicBaseUrl(req: Request): string {
  const configured = String(
    process.env.PUBLIC_BASE_URL || process.env.BASE_URL || "",
  ).trim();

  const host =
    (String(req.headers["x-forwarded-host"] || "").split(",")[0] || "").trim() ||
    (req.get("host") || "").trim();

  const forwardedProto =
    (String(req.headers["x-forwarded-proto"] || "").split(",")[0] || "").trim() ||
    "";

  const looksLocal = (v: string) =>
    /localhost|127\.0\.0\.1/i.test(v);

  if (configured && !looksLocal(configured)) {
    return trimTrailingSlash(configured);
  }

  if (host) {
    const proto =
      forwardedProto ||
      (host.includes("onrender.com") || host.includes("vercel.app") ? "https" : req.protocol || "http");
    return trimTrailingSlash(`${proto}://${host}`);
  }

  if (configured) {
    return trimTrailingSlash(configured);
  }

  return `http://localhost:${process.env.PORT || 5000}`;
}

function isProtectedUploadPath(raw: string): boolean {
  return /^\/?uploads\/(screenshots|recordings|group-icons|device-thumbnails|clients)\//i.test(raw);
}

function toPublicMediaPath(value: string | null | undefined): string | null {
  if (!value) return null;

  const raw = String(value).trim();
  if (!raw) return null;

  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      const p = u.pathname || "";
      if (/^\/media\//i.test(p)) return `/media/${path.basename(p)}`;
      if (/^\/uploads\//i.test(p) && !isProtectedUploadPath(p)) return `/media/${path.basename(p)}`;
      return raw;
    } catch {
      return raw;
    }
  }

  if (/^\/?media\//i.test(raw)) {
    return `/media/${path.basename(raw)}`;
  }

  if (/^\/?uploads\//i.test(raw) && !isProtectedUploadPath(raw)) {
    return `/media/${path.basename(raw)}`;
  }

  if (/^uploads\//i.test(raw) && !isProtectedUploadPath(`/${raw}`)) {
    return `/media/${path.basename(raw)}`;
  }

  return raw;
}

function toAbsoluteMediaUrl(req: Request, value: string | null | undefined): string | null {
  const normalized = toPublicMediaPath(value);
  if (!normalized) return null;
  const base = getPublicBaseUrl(req);
  if (/^https?:\/\//i.test(normalized)) return normalized.replace(/^http:\/\/localhost:\d+/i, base);
  if (normalized.startsWith("/")) return `${base}${normalized}`;
  return `${base}/${normalized.replace(/^\/+/, "")}`;
}


function absolutizeAssetUrl(req: Request, value: string | null | undefined): string | null {
  if (!value) return null;

  const raw = String(value).trim();
  if (!raw) return null;

  const mediaUrl = toAbsoluteMediaUrl(req, raw);
  if (mediaUrl && mediaUrl !== raw) {
    return mediaUrl;
  }

  const base = getPublicBaseUrl(req);

  if (raw.startsWith("/")) {
    return `${base}${raw}`;
  }

  if (/^https?:\/\//i.test(raw)) {
    return raw.replace(/^http:\/\/localhost:\d+/i, base);
  }

  if (raw.startsWith("uploads/")) {
    return `${base}/${raw}`;
  }

  return raw;
}

function normalizeMediaRow<T extends Record<string, any>>(req: Request, row: T): T {
  const next: T = { ...row };

  if ("url" in next) {
    next.url = absolutizeAssetUrl(req, next.url);
  }

  if ("thumbnail" in next) {
    next.thumbnail = absolutizeAssetUrl(req, next.thumbnail);
  }

  if ("screenshot" in next) {
    next.screenshot = absolutizeAssetUrl(req, next.screenshot);
  }

  if ("last_recording" in next) {
    next.last_recording = absolutizeAssetUrl(req, next.last_recording);
  }

  if ("lastScreenshot" in next) {
    next.lastScreenshot = absolutizeAssetUrl(req, next.lastScreenshot);
  }

  if ("file" in next) {
    next.file = absolutizeAssetUrl(req, next.file);
  }

  return next;
}


// Simple in-memory command queue: { [deviceId]: [ { id, command, value, createdAt } ] }
const pendingCommands: {
  [deviceId: string]: Array<{
    id: string;
    command: string;
    value?: any;
    createdAt: Date;
  }>;
} = {};


// In-memory playlist storage (legacy - device-level)
// Structure: { [deviceId]: { deviceId, lastUpdated, items: [...] } }
const playlists: {
  [deviceId: string]: { deviceId: string; lastUpdated: string; items: any[] };
} = {};

// Zone-based playlist storage
// Structure: { [deviceId]: { [zoneId]: { lastUpdated, items: [...] } } }
const zonePlaylists: {
  [deviceId: string]: {
    [zoneId: string]: { lastUpdated: string; items: any[] };
  };
} = {};

// RSS feeds per device zone
// Structure: { [deviceId]: { [zoneId]: { url, lastUpdated, refreshMinutes } } }
const zoneRSSFeeds: {
  [deviceId: string]: {
    [zoneId: string]: {
      url: string;
      lastUpdated: string;
      refreshMinutes: number;
    };
  };
} = {};

// Social feeds per device zone
// Structure: { [deviceId]: { [zoneId]: { platform, handle, hashtag, refreshMinutes, lastUpdated } } }
const socialZoneConfig: {
  [deviceId: string]: {
    [zoneId: string]: {
      platform: string;
      handle: string | null;
      hashtag: string | null;
      refreshMinutes: number;
      lastUpdated: string;
    };
  };
} = {};

// In-memory template storage
// templates: { [templateId]: { id, name, description, width, height, backgroundColor, zones: [...] } }
const templates: { [templateId: string]: any } = {};

// Device → Template mapping
// deviceTemplates: { [deviceId]: templateId }
const deviceTemplates: { [deviceId: string]: string } = {};

function generateId(prefix = "tpl") {
  return prefix + "-" + Math.random().toString(36).substring(2, 8);
}

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

const updateScreenSchema = insertScreenSchema.partial();

// authMiddleware replaced by authenticateJWT in server/middleware/auth.ts

export async function registerRoutes(
  httpServer: Server,
  app: Express,
): Promise<Server> {

  // --------------------------------------------------
  // Register modular route groups (NEW)
  // --------------------------------------------------
  registerAuthRoutes(app);
  registerDeviceRoutes(app);
  await registerPublishJobRoutes(app);
  await registerScreensRoutes(app);
  registerClientRoutes(app);
  registerScheduleRoutes(app);
  registerGroupRoutes(app);

  // --------------------------------------------------
  // PUBLIC MEDIA DELIVERY
  // - CMS previews must load without auth headers
  // - Android devices must be able to download published media
  // - Only generic media files are public here
  // --------------------------------------------------
  app.get("/media/:file", (req, res) => {
    try {
      const requested = String(req.params.file || "").trim();
      const safeFile = path.basename(requested);

      if (!safeFile) {
        return res.status(400).json({ error: "missing_media_file" });
      }

      const filePath = path.join(uploadsDir, safeFile);

      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return res.status(404).json({ error: "media_not_found" });
      }

      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.setHeader("X-Content-Type-Options", "nosniff");
      return res.sendFile(filePath);
    } catch (err) {
      console.error("MEDIA SERVE ERROR:", err);
      return res.status(500).json({ error: "media_serve_failed" });
    }
  });

  // --------------------------------------------------
  // Protect uploads (no public filesystem exposure)
  // Allow either admin/user JWT or a valid device token.
  // --------------------------------------------------
  if (process.env.NODE_ENV !== "test") {
    app.use(
      "/uploads",
      authenticateUserOrDevice,
      (await import("express")).default.static(uploadsDir, {
        fallthrough: false,
        setHeaders: (res) => {
          res.setHeader("X-Content-Type-Options", "nosniff");
          res.setHeader("Cache-Control", "private, max-age=300");
        },
      }),
    );
  }

  // --------------------------------------------------
  // Global API auth
  // - Allowlist auth + ping + device register
  // - Device endpoints are protected separately
  // --------------------------------------------------
  app.use("/api", (req, res, next) => {
    const p = req.path;

    // Public / auth endpoints
    if (p.startsWith("/auth/")) return next();
    if (p === "/ping") return next();
    if (p === "/screens/register") return next();

    // Template render endpoint — public, used by Android WebView (no JWT available)
    if (/^\/templates\/[^\/]+\/render$/.test(p)) return next();

    // Pairing / activation must not require admin JWT
    if (
      p === "/device/claim" ||
      p === "/device/activate" ||
      p === "/devices/activate" ||
      p === "/devices/pair"
    ) {
      return next();
    }

    // Player playlist fetch is device-authenticated separately
    if (/^\/screens\/[^\/]+\/playlist$/.test(p)) return next();

    // Device-token authenticated endpoints (singular + plural)
    if (p.startsWith("/device/")) return next();
    if (/^\/devices\/[^\/]+\/(commands|heartbeat|assignment|schedule)$/.test(p)) return next();
    if (/^\/devices\/[^\/]+\/commands\/[^\/]+\/ack$/.test(p)) return next();

    // Device progress updates for publish jobs use device token auth
    if (/^\/publish-jobs\/[^\/]+$/.test(p) && req.method === "PATCH") return next();

    return authenticateJWT(req, res, next);
  });

  // Device API must use device token when a specific deviceId is present
// ✅ PUBLIC: Device activation must NOT require device token
// ✅ PUBLIC: Device activation (pairing) - returns a device API key (token)
// - Does NOT require user JWT
// - Does NOT require a prior device token
// - Generates/rotates a device token stored as sha256 in screens.api_key_hash
// Pairing / activation handler (mounted on multiple paths for backward compatibility)
async function handleDeviceActivate(req: any, res: any) {
  try {
    // Accept multiple client field names + tolerate formatting like "123-456" / "123 456"
    const pairingCodeRaw =
      req.body?.pairing_code ??
      req.body?.pairingCode ??
      req.body?.code ??
      req.body?.pairing ??
      "";

    const pairingCode = String(pairingCodeRaw)
      .trim()
      .replace(/[-\s]/g, "")
      .toUpperCase();

    if (!pairingCode) {
      return res.status(400).json({ error: "pairing_code_required" });
    }

    const pairingCodeHash = crypto
      .createHash("sha256")
      .update(pairingCode)
      .digest("hex");

    // ✅ Support BOTH SaaS-grade hash lookup and plaintext fallback during migration
    const result = await pool.query(
      `SELECT id, device_id, pairing_expires_at, pairing_locked_until, pairing_attempts
       FROM screens
       WHERE pairing_code_hash = $1
          OR pairing_code = $2
       LIMIT 1`,
      [pairingCodeHash, pairingCode],
    );

    const row = result.rows[0] as
      | {
          id: number;
          device_id: string;
          pairing_expires_at: string | null;
          pairing_locked_until: string | null;
          pairing_attempts: number | null;
        }
      | undefined;

    if (!row) {
      return res.status(404).json({ error: "invalid_pairing_code" });
    }

    // Locked?
    if (
      row.pairing_locked_until &&
      new Date(row.pairing_locked_until).getTime() > Date.now()
    ) {
      return res.status(423).json({ error: "pairing_locked" });
    }

    // Expired?
    if (
      !row.pairing_expires_at ||
      new Date(row.pairing_expires_at).getTime() < Date.now()
    ) {
      return res.status(401).json({ error: "pairing_code_expired" });
    }

    // Rotate token on every successful activation
    const deviceToken = randomUUID();
    const tokenHash = crypto
      .createHash("sha256")
      .update(deviceToken)
      .digest("hex");
    const last4 = deviceToken.slice(-4);

    await pool.query(
      `UPDATE screens
       SET pairing_code = NULL,
           pairing_code_hash = NULL,
           pairing_expires_at = NULL,
           pairing_status = 'paired',
           pairing_attempts = 0,
           pairing_locked_until = NULL,
           last_paired_at = NOW(),
           is_online = true,
           last_seen_at = NOW(),
           api_key_hash = $2,
           api_key_last4 = $3,
           token_version = COALESCE(token_version, 0) + 1,
           revoked_at = NULL,
           rotated_at = NOW(),
           password = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [row.id, tokenHash, last4],
    );

    // ✅ Return BOTH snake_case and camelCase for client compatibility
    return res.json({
      // snake_case
      device_id: row.device_id,
      device_key: deviceToken,

      // camelCase
      deviceId: row.device_id,
      deviceKey: deviceToken,
    });
  } catch (err) {
    console.error("activateDevice error:", err);
    return res.status(500).json({ error: "activation_failed" });
  }
}

// New canonical route
app.post("/api/device/activate", handleDeviceActivate);

// Backward-compatible aliases
app.post("/api/devices/activate", handleDeviceActivate);
app.post("/api/device/claim", handleDeviceActivate);
app.post("/api/devices/pair", handleDeviceActivate);


      // =====================================================
      // DASHBOARD SUMMARY
      // =====================================================
      app.get("/api/dashboard/summary", async (_req, res) => {
        try {
          const devicesResult = await pool.query(`
            SELECT
              COUNT(*) FILTER (WHERE is_online = true)  AS active,
              COUNT(*) FILTER (WHERE is_online = false) AS offline
            FROM screens
          `);

          res.json({
            activeDevices: Number(devicesResult.rows[0]?.active ?? 0),
            offlineDevices: Number(devicesResult.rows[0]?.offline ?? 0),
            todaysImpressions: 0,
            monthlyRevenue: 0,
          });
        } catch (err) {
          console.error("Dashboard summary error:", err);
          res.status(500).json({ error: "failed_to_load_summary" });
        }
      });
  
  // =====================================================
  // DASHBOARD DEVICES LIST
  // =====================================================
  app.get("/api/devices/list", async (_req, res) => {
    try {
      const result = await pool.query(`
        SELECT
          device_id AS id,
          name,
          location AS location_branch,
          is_online
        FROM screens
        WHERE COALESCE(archived, false) = false
        ORDER BY id DESC
        LIMIT 10
      `);

      res.json({ devices: result.rows });
    } catch (err) {
      console.error("Devices list error:", err);
      res.status(500).json({ error: "failed_to_load_devices" });
    }
  });

  // =====================================================
  // FULL DEVICE LIST (CMS)
  // =====================================================
  app.get("/api/devices/list-full", async (_req, res) => {
    try {
      const query = `
        SELECT DISTINCT ON (s.device_id)
          s.device_id AS id,
          s.name,
          s.location AS location_branch,
          s.is_online,
          s.last_seen,
          s.status,
          s.current_content AS current_content_id,
          s.temperature,
          s.free_storage,
          s.battery_level,
          s.signal_strength,
          s.latitude,
          s.longitude,
          COALESCE(s.errors, '[]'::jsonb) AS errors,
          s.last_seen AS last_status_at,
          dgm.group_id
        FROM screens s
        LEFT JOIN device_group_map dgm ON s.device_id = dgm.device_id
        WHERE COALESCE(s.archived, false) = false
        ORDER BY s.device_id, s.name ASC
      `;

      const result = await pool.query(query);
      res.json({ devices: result.rows });
    } catch (err) {
      console.error("LIST FULL DEVICES ERROR:", err);
      res.status(500).json({ error: "failed_to_list_devices" });
    }
  });

  // =====================================================
  // ADMIN DEVICE DELETE (CMS)
  // Deletes by human-readable device_id (DEV-XXXX) and cleans dependent rows first.
  // =====================================================
  app.delete(
    "/api/admin/devices/:deviceId",
    authenticateJWT,
    requireRole("admin", "manager"),
    async (req, res) => {
      const deviceId = String(req.params.deviceId || "").trim();
      if (!deviceId) return res.status(400).json({ error: "missing_device_id" });

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const screenResult = await client.query(
          `
          SELECT id, device_id, name
          FROM screens
          WHERE device_id = $1
          LIMIT 1
          `,
          [deviceId],
        );

        if (screenResult.rowCount === 0) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "device_not_found" });
        }

        const screen = screenResult.rows[0];
        const screenId = screen.id;

        const safeDelete = async (sql: string, params: any[]) => {
          try {
            await client.query(sql, params);
          } catch (cleanupErr) {
            console.warn("device archive cleanup skipped:", sql, cleanupErr);
          }
        };

        await safeDelete(`DELETE FROM device_group_map WHERE device_id = $1`, [deviceId]);
        await safeDelete(`DELETE FROM playlist_assignments WHERE device_id = $1`, [deviceId]);
        await safeDelete(`DELETE FROM device_commands WHERE device_id = $1`, [deviceId]);
        await safeDelete(`DELETE FROM device_status_logs WHERE device_id = $1`, [deviceId]);
        await safeDelete(`DELETE FROM device_data_usage WHERE device_id = $1`, [deviceId]);
        await safeDelete(`DELETE FROM device_power_schedules WHERE device_id = $1`, [deviceId]);

        // Best-effort cleanup for schemas that may reference the numeric screen id.
        await safeDelete(`DELETE FROM playlists WHERE screen_id = $1`, [screenId]);
        await safeDelete(`DELETE FROM publish_jobs WHERE device_id = $1`, [deviceId]);
        await safeDelete(`DELETE FROM publish_jobs WHERE screen_id = $1`, [screenId]);

        const archiveScreen = await client.query(
          `
          UPDATE screens
          SET
            archived = true,
            status = 'offline',
            is_online = false,
            updated_at = NOW()
          WHERE device_id = $1
          RETURNING id, device_id, name, archived
          `,
          [deviceId],
        );

        await client.query("COMMIT");

        if (typeof pendingCommands !== "undefined") delete pendingCommands[deviceId];
        if (typeof playlists !== "undefined") delete playlists[deviceId];
        if (typeof zonePlaylists !== "undefined") delete zonePlaylists[deviceId];
        if (typeof zoneRSSFeeds !== "undefined") delete zoneRSSFeeds[deviceId];
        if (typeof socialZoneConfig !== "undefined") delete socialZoneConfig[deviceId];
        if (typeof deviceTemplates !== "undefined") delete deviceTemplates[deviceId];

        return res.json({
          success: true,
          archived: true,
          removed:
            archiveScreen.rows[0] || {
              id: screenId,
              device_id: deviceId,
              name: screen.name,
              archived: true,
            },
        });
      } catch (err) {
        await client.query("ROLLBACK");
        console.error("ADMIN DEVICE ARCHIVE ERROR:", err);
        return res.status(500).json({ error: "failed_to_archive_device" });
      } finally {
        client.release();
      }
    },
  );

  // =====================================================
  // DEVICE LOCATIONS (for DeviceMap)
  // =====================================================
  app.get("/api/devices/locations", async (_req, res) => {
    try {
      const query = `
        SELECT DISTINCT ON (s.device_id)
          s.device_id AS id,
          s.name,
          s.status,
          s.is_online,
          s.latitude,
          s.longitude,
          s.last_seen AS "lastHeartbeat",
          s.location AS "locationName",
          s.thumbnail,
          dgm.group_id
        FROM screens s
        LEFT JOIN device_group_map dgm ON s.device_id = dgm.device_id
        WHERE s.latitude IS NOT NULL AND s.longitude IS NOT NULL
        ORDER BY s.device_id, s.name ASC
      `;

      const result = await pool.query(query);
      const devices = result.rows.map(device => ({
        ...device,
        status: device.is_online ? "online" : "offline"
      }));

      res.json({ devices });
    } catch (err) {
      console.error("DEVICE LOCATIONS ERROR:", err);
      res.status(500).json({ error: "failed_to_get_locations" });
    }
  });

 // =====================================================
// DEVICE DETAILS (for DeviceControlPage)
// =====================================================
// Device details (admin) - supports either UUID (screens.id) or device_id (DEV-XXXX)
app.get("/api/devices/:id/details", async (req, res) => {
  try {
    const rawId = String(req.params.id || "").trim();
    if (!rawId) return res.status(400).json({ error: "missing_id" });


    const query = `
      SELECT
        s.id,
        s.device_id,
        s.name,
        s.location,
        s.status,
        s.is_online,
        s.last_seen AS "lastHeartbeat",
        s.current_content_name AS "currentContentName",
        s.screenshot,
        s.screenshot_at AS "screenshotAt",
        s.thumbnail,
        s.signal_strength AS "signalStrength",
        s.connection_type AS "connectionType",
        s.free_storage AS "freeStorage",
        s.last_offline AS "lastOffline",
        s.assigned_template_id AS "assignedTemplateId",
        s.latitude,
        s.longitude,
        t.name AS "templateName"
      FROM screens s
      LEFT JOIN templates t
        ON t.id::text = s.assigned_template_id::text
      WHERE (s.id::text = $1 OR s.device_id = $1)
      LIMIT 1
    `;

    const result = await pool.query(query, [rawId]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Device not found" });
    }

    const device = result.rows[0];

    // Enterprise-style online computation fallback
    const isOnline =
      device.lastHeartbeat &&
      new Date(device.lastHeartbeat).getTime() >
        Date.now() - 60 * 1000;

    res.json({
      id: device.device_id || device.id,
      name: device.name,
      status: isOnline ? "Online" : "Offline",
      lastHeartbeat: device.lastHeartbeat,
      currentContentName: device.currentContentName,
      templateName: device.templateName,
      lastScreenshot: absolutizeAssetUrl(req, device.screenshot),
      screenshotAt: device.screenshotAt,
      thumbnail: absolutizeAssetUrl(req, device.thumbnail),
      signalStrength: device.signalStrength,
      connectionType: device.connectionType || "wifi",
      freeStorage: device.freeStorage,
      lastOffline: device.lastOffline,
      latitude: device.latitude,
      longitude: device.longitude,

      // Until we store brightness/volume in device_status_logs
      brightness: 100,
      volume: 70,
    });
  } catch (err) {
    console.error("Device details error:", err);
    res.status(500).json({ error: "Failed to load device details" });
  }
});

// =====================================================
// DEVICE DETAILS ALIAS (compat)
// Frontend sometimes calls /api/devices/:id (no /details)
// =====================================================
app.get("/api/devices/:id", async (req, res) => {
  // Reuse the same handler by internally calling the same logic.
  // Easiest: redirect to the existing endpoint (works for GET)
  const id = encodeURIComponent(String(req.params.id || "").trim());
  return res.redirect(302, `/api/devices/${id}/details`);
});

  // =====================================================
// DEVICE SETTINGS (brightness/volume)
// =====================================================


  // =====================================================
  // DEVICE DATA USAGE
  // =====================================================
  app.get("/api/devices/:id/data-usage", async (req, res) => {
    const { id } = req.params;
    const { startDate, endDate } = req.query;

    try {
      // First get the device_id from screens table
      const deviceResult = await pool.query(
        `SELECT device_id FROM screens WHERE id::text = $1 OR device_id = $1 LIMIT 1`,
        [id]
      );

      if (deviceResult.rowCount === 0) {
        return res.status(404).json({ error: "Device not found" });
      }

      const deviceId = deviceResult.rows[0].device_id;

      let query = `
        SELECT 
          SUM(bytes_downloaded) as total_downloaded,
          SUM(bytes_uploaded) as total_uploaded,
          COUNT(*) as record_count,
          MIN(recorded_at) as first_record,
          MAX(recorded_at) as last_record
        FROM device_data_usage
        WHERE device_id = $1
      `;
      const params: any[] = [deviceId];

      if (startDate) {
        query += ` AND recorded_at >= $${params.length + 1}`;
        params.push(startDate);
      }
      if (endDate) {
        query += ` AND recorded_at <= $${params.length + 1}`;
        params.push(endDate);
      }

      const result = await pool.query(query, params);
      const data = result.rows[0];

      // Also get daily breakdown for charts
      let dailyQuery = `
        SELECT 
          DATE(recorded_at) as date,
          SUM(bytes_downloaded) as downloaded,
          SUM(bytes_uploaded) as uploaded
        FROM device_data_usage
        WHERE device_id = $1
      `;
      const dailyParams: any[] = [deviceId];

      if (startDate) {
        dailyQuery += ` AND recorded_at >= $${dailyParams.length + 1}`;
        dailyParams.push(startDate);
      }
      if (endDate) {
        dailyQuery += ` AND recorded_at <= $${dailyParams.length + 1}`;
        dailyParams.push(endDate);
      }

      dailyQuery += ` GROUP BY DATE(recorded_at) ORDER BY date DESC LIMIT 30`;

      const dailyResult = await pool.query(dailyQuery, dailyParams);

      res.json({
        totalDownloaded: parseInt(data.total_downloaded) || 0,
        totalUploaded: parseInt(data.total_uploaded) || 0,
        total: (parseInt(data.total_downloaded) || 0) + (parseInt(data.total_uploaded) || 0),
        recordCount: parseInt(data.record_count) || 0,
        firstRecord: data.first_record,
        lastRecord: data.last_record,
        dailyBreakdown: dailyResult.rows.map(r => ({
          date: r.date,
          downloaded: parseInt(r.downloaded) || 0,
          uploaded: parseInt(r.uploaded) || 0,
        })),
      });
    } catch (err) {
      console.error("Device data usage error:", err);
      res.status(500).json({ error: "Failed to load data usage" });
    }
  });

  // Record data usage (typically called by the device player)
  app.post("/api/devices/:id/data-usage", async (req, res) => {
    const { id } = req.params;
    
    // Validate request body
    const bodySchema = z.object({
      bytesDownloaded: z.number().int().nonnegative().optional().default(0),
      bytesUploaded: z.number().int().nonnegative().optional().default(0),
    });
    
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request body", details: parsed.error.errors });
    }
    
    const { bytesDownloaded, bytesUploaded } = parsed.data;

    try {
      // Get device_id
      const deviceResult = await pool.query(
        `SELECT device_id FROM screens WHERE id::text = $1 OR device_id = $1 LIMIT 1`,
        [id]
      );

      if (deviceResult.rowCount === 0) {
        return res.status(404).json({ error: "Device not found" });
      }

      const deviceId = deviceResult.rows[0].device_id;

      await pool.query(
        `INSERT INTO device_data_usage (device_id, bytes_downloaded, bytes_uploaded) VALUES ($1, $2, $3)`,
        [deviceId, bytesDownloaded, bytesUploaded]
      );

      res.json({ success: true });
    } catch (err) {
      console.error("Record data usage error:", err);
      res.status(500).json({ error: "Failed to record data usage" });
    }
  });

  // =====================================================
  // DEVICE POWER SCHEDULE
  // =====================================================
  app.get("/api/devices/:id/power-schedule", async (req, res) => {
    const { id } = req.params;

    try {
      const deviceResult = await pool.query(
        `SELECT device_id FROM screens WHERE id::text = $1 OR device_id = $1 LIMIT 1`,
        [id]
      );

      if (deviceResult.rowCount === 0) {
        return res.status(404).json({ error: "Device not found" });
      }

      const deviceId = deviceResult.rows[0].device_id;

      const result = await pool.query(
        `SELECT id, enabled, power_on_time, power_off_time, days_of_week FROM device_power_schedules WHERE device_id = $1 ORDER BY id`,
        [deviceId]
      );

      const schedules = result.rows.map(row => ({
        id: row.id,
        enabled: row.enabled,
        powerOnTime: row.power_on_time?.slice(0, 5) || "08:00",
        powerOffTime: row.power_off_time?.slice(0, 5) || "22:00",
        daysOfWeek: row.days_of_week || [0, 1, 2, 3, 4, 5, 6],
      }));

      res.json({ schedules });
    } catch (err) {
      console.error("Get power schedule error:", err);
      res.status(500).json({ error: "Failed to get power schedule" });
    }
  });

  app.post("/api/devices/:id/power-schedule", async (req, res) => {
    const { id } = req.params;
    const { schedules } = req.body;

    try {
      const deviceResult = await pool.query(
        `SELECT device_id FROM screens WHERE id::text = $1 OR device_id = $1 LIMIT 1`,
        [id]
      );

      if (deviceResult.rowCount === 0) {
        return res.status(404).json({ error: "Device not found" });
      }

      const deviceId = deviceResult.rows[0].device_id;

      // Delete existing schedules for this device
      await pool.query(`DELETE FROM device_power_schedules WHERE device_id = $1`, [deviceId]);

      // Insert new schedules
      for (const schedule of schedules) {
        await pool.query(
          `INSERT INTO device_power_schedules (device_id, enabled, power_on_time, power_off_time, days_of_week, updated_at)
           VALUES ($1, $2, $3, $4, $5, NOW())`,
          [deviceId, schedule.enabled, schedule.powerOnTime, schedule.powerOffTime, schedule.daysOfWeek]
        );
      }

      res.json({ success: true });
    } catch (err) {
      console.error("Save power schedule error:", err);
      res.status(500).json({ error: "Failed to save power schedule" });
    }
  });

  // =====================================================
  // DASHBOARD ALERTS
  // =====================================================
  app.get("/api/dashboard/alerts", async (_req, res) => {
    try {
      const result = await pool.query(`
        SELECT
          name,
          device_id,
          COALESCE(last_seen, last_seen_at, updated_at) AS last_seen,
          EXTRACT(EPOCH FROM (NOW() - COALESCE(last_seen, last_seen_at, updated_at))) / 60 AS offline_minutes
        FROM screens
        WHERE is_online = false
          AND COALESCE(archived, false) = false
          AND COALESCE(last_seen, last_seen_at, updated_at) < NOW() - INTERVAL '5 minutes'
        ORDER BY last_seen ASC
        LIMIT 20
      `);

      const alerts = result.rows.map((d) => ({
        deviceId: d.device_id,
        deviceName: d.name,
        lastSeen: d.last_seen ? new Date(d.last_seen).toISOString() : null,
        offlineMinutes: Math.floor(Number(d.offline_minutes ?? 0)),
        message: `Device "${d.name}" has gone offline.`,
        type: "offline",
      }));

      res.json({ alerts });
    } catch (err) {
      console.error("Alerts error:", err);
      res.status(500).json({ error: "failed_to_load_alerts" });
    }
  });

  // Live Content (dashboard) - disabled
app.get("/api/dashboard/live-content", authenticateJWT, async (_req, res) => {
  return res.json({ content: [], disabled: true });
});

  // =====================================================
  // ACTIVE COMMANDS STATUS (for progress tracking)
  // =====================================================
  app.get("/api/commands/active", async (_req, res) => {
    try {
      const result = await pool.query(
        `
        SELECT 
          dc.id,
          dc.device_id,
          dc.payload,
          dc.sent,
          dc.executed,
          dc.executed_at,
          dc.created_at,
          s.name as device_name
        FROM device_commands dc
        LEFT JOIN screens s ON dc.device_id = s.device_id
        WHERE dc.created_at > NOW() - INTERVAL '5 minutes'
        ORDER BY dc.created_at DESC
        LIMIT 20
        `
      );

      const publishJobSyncs: Array<{ status: string; publishJobId: number }> = [];

      const commands = result.rows.map((cmd: any) => {
        let payload: any = {};

        try {
          if (typeof cmd.payload === "string") {
            payload = JSON.parse(cmd.payload);
          } else if (cmd.payload && typeof cmd.payload === "object") {
            payload = cmd.payload;
          }
        } catch {
          payload = {};
        }

        if (!payload || typeof payload !== "object") {
          payload = {};
        }

        let status = "queued";
        let progress = 0;

        if (cmd.executed) {
          status = "completed";
          progress = 100;
        } else if (cmd.sent) {
          status = "delivering";
          progress = 50;
        }

        const rawPublishJobId = String(
          payload.publishJobId ?? payload.publish_job_id ?? "",
        ).trim();
        const publishJobId = Number(rawPublishJobId);

        if (Number.isFinite(publishJobId) && publishJobId > 0) {
          const publishStatus =
            status === "queued"
              ? "pending"
              : status === "delivering"
                ? "downloading"
                : "completed";

          publishJobSyncs.push({ status: publishStatus, publishJobId });
        }

        return {
          id: cmd.id,
          deviceId: cmd.device_id,
          deviceName: cmd.device_name || cmd.device_id,
          type: payload.type || null,
          contentName: payload.contentName || payload.content_name || payload.type || "command",
          status,
          progress,
          createdAt: cmd.created_at,
          executedAt: cmd.executed_at
        };
      });

      if (publishJobSyncs.length > 0) {
        const uniqueSyncs = Array.from(
          new Map(
            publishJobSyncs.map((sync) => [`${sync.publishJobId}:${sync.status}`, sync])
          ).values()
        );

        void Promise.allSettled(
          uniqueSyncs.map(({ status, publishJobId }) =>
            pool.query(
              `
              UPDATE publish_jobs
              SET
                status = CASE
                  WHEN status = 'completed' THEN status
                  ELSE $1
                END,
                progress = CASE
                  WHEN status = 'completed' THEN 100
                  WHEN $1 = 'downloading' AND COALESCE(progress, 0) < 50 THEN 50
                  ELSE COALESCE(progress, 0)
                END,
                completed_at = CASE
                  WHEN $1 = 'completed' THEN COALESCE(completed_at, NOW())
                  ELSE completed_at
                END
              WHERE id = $2
              `,
              [status, publishJobId]
            )
          )
        ).catch((syncErr) => {
          console.warn("Active commands publish job sync warning:", syncErr);
        });
      }

      return res.json({ commands });
    } catch (err) {
      console.error("Active commands error:", err);
      return res.json({ commands: [] });
    }
  });

// =====================================================
// DEVICE FETCHES ITS PENDING COMMANDS (DEVICE AUTH)
// - device_commands.device_id is TEXT like "DEV-XXXX"
// - device_commands.id is INTEGER
// =====================================================
const handleDeviceGetCommands = async (req: Request, res: Response) => {
  const deviceId = String(req.params.deviceId || "").trim();
  if (!deviceId) return res.status(400).json({ error: "missing_device_id" });

  try {
    const result = await pool.query(
      `
      SELECT id, payload
      FROM device_commands
      WHERE device_id = $1
        AND sent = false
      ORDER BY created_at ASC
      LIMIT 50
      `,
      [deviceId],
    );

    if (result.rows.length > 0) {
      const ids: number[] = result.rows
        .map((r: any) => Number(r.id))
        .filter((n) => Number.isFinite(n));

      if (ids.length > 0) {
        await pool.query(
          `
          UPDATE device_commands
          SET sent = true
          WHERE id = ANY($1::int[])
          `,
          [ids],
        );
      }

      const publishJobIds: number[] = result.rows
        .map((r: any) => {
          try {
            const payload = typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload;
            const raw = String(payload?.publishJobId ?? payload?.publish_job_id ?? "").trim();
            const id = Number(raw);
            return Number.isFinite(id) ? id : null;
          } catch {
            return null;
          }
        })
        .filter((n: any) => Number.isFinite(n));

      if (publishJobIds.length > 0) {
        await pool.query(
          `
          UPDATE publish_jobs
          SET
            status = CASE WHEN status = 'completed' THEN status ELSE 'downloading' END,
            progress = CASE WHEN progress >= 5 THEN progress ELSE 5 END,
            updated_at = NOW()
          WHERE id = ANY($1::int[])
            AND status IN ('pending', 'downloading')
          `,
          [publishJobIds],
        );
      }
    }

    return res.json(
      result.rows.map((r: any) => {
        let payload: any = r.payload;
        try {
          if (typeof payload === "string") payload = JSON.parse(payload);
        } catch {
          // ignore
        }
        return { id: r.id, ...(payload && typeof payload === "object" ? payload : { payload }) };
      }),
    );
  } catch (err) {
    console.error("Error fetching commands:", err);
    // ✅ Device resilience: return [] so player doesn't crash
    return res.json([]);
  }
};

app.get("/api/device/:deviceId/commands", authenticateDevice, handleDeviceGetCommands);
app.get("/api/devices/:deviceId/commands", authenticateDevice, handleDeviceGetCommands);

const handleDeviceAckCommand = async (req: Request, res: Response) => {
  const deviceId = String(req.params.deviceId || "").trim();
  const commandId = Number(req.params.commandId);

  if (!deviceId) return res.status(400).json({ error: "missing_device_id" });
  if (!Number.isFinite(commandId)) return res.status(400).json({ error: "invalid_command_id" });

  try {
    const result = await pool.query(
      `
      UPDATE device_commands
      SET
        executed = true,
        executed_at = NOW()
      WHERE id = $1
        AND device_id = $2
      RETURNING id, payload
      `,
      [commandId, deviceId],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "command_not_found" });
    }

    let payload: any = result.rows[0].payload;
    try {
      if (typeof payload === "string") payload = JSON.parse(payload);
    } catch {
      // ignore
    }

    const publishJobId = String(
      payload?.publishJobId ??
      payload?.publish_job_id ??
      "",
    ).trim();

    if (publishJobId) {
      await pool.query(
        `
        UPDATE publish_jobs
        SET
          status = 'completed',
          progress = 100,
          downloaded_bytes = COALESCE(total_bytes, downloaded_bytes),
          completed_at = NOW(),
          updated_at = NOW()
        WHERE id = $1::int
        `,
        [publishJobId],
      );
    }

    return res.json({ success: true, commandId });
  } catch (err) {
    console.error("Command ACK error:", err);
    return res.status(500).json({ error: "failed_to_ack_command" });
  }
};

app.post("/api/device/:deviceId/commands/:commandId/ack", authenticateDevice, handleDeviceAckCommand);
app.post("/api/devices/:deviceId/commands/:commandId/ack", authenticateDevice, handleDeviceAckCommand);

  

  // =====================================================
// DEVICE UPLOADS VIDEO RECORDING (DEVICE AUTH)
// Stores file path in DB via updateDeviceRecording (screens.last_recording)
// =====================================================
app.post(
  "/api/device/:deviceId/record",
  authenticateDevice,
  recordingUpload.single("file"),
  async (req, res) => {
    const deviceId = String(req.params.deviceId || "").trim();
    if (!deviceId) return res.status(400).json({ error: "missing_device_id" });

    if (!req.file) {
      return res.status(400).json({ error: "no_file_uploaded" });
    }

    const filePath = `/uploads/recordings/${req.file.filename}`;

    try {
      await updateDeviceRecording(deviceId, filePath);
      return res.json({ ok: true, filePath });
    } catch (err) {
      console.error("Recording upload error:", err);
      return res.status(500).json({ error: "recording_upload_failed" });
    }
  },
);

// =====================================================
// GET LAST RECORDING (ADMIN JWT)
// Reads from DB (screens.last_recording)
// =====================================================
app.get(
  "/api/admin/devices/:deviceId/recording",
  authenticateJWT,
  requireRole("admin", "manager"),
  async (req, res) => {
    const deviceId = String(req.params.deviceId || "").trim();
    if (!deviceId) return res.status(400).json({ error: "missing_device_id" });

    try {
      const result = await pool.query(
        `SELECT last_recording, last_seen FROM screens WHERE device_id = $1`,
        [deviceId],
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: "device_not_found" });
      }

      return res.json({
        file: absolutizeAssetUrl(req, result.rows[0].last_recording ?? null),
        last_seen: result.rows[0].last_seen ?? null,
      });
    } catch (err) {
      console.error("Get recording error:", err);
      return res.status(500).json({ error: "failed_to_get_recording" });
    }
  },
);

// =====================================================
// DEVICE SCREENSHOT UPLOAD (DEVICE AUTH) — SaaS-grade
// Supports JSON base64: { screenshot: "data:image/png;base64,..." }
// =====================================================


// =====================================================
// GET LAST SCREENSHOT (ADMIN JWT) — SaaS-grade
// (Do NOT expose screenshots to devices or public.)
// =====================================================
app.get(
  "/api/admin/devices/:deviceId/screenshot",
  authenticateJWT,
  requireRole("admin", "manager"),
  async (req, res) => {
    const deviceId = String(req.params.deviceId || "").trim();
    if (!deviceId) return res.status(400).json({ error: "missing_device_id" });

    try {
      const result = await pool.query(
        `SELECT screenshot, screenshot_at FROM screens WHERE device_id = $1`,
        [deviceId],
      );

      if (result.rows.length === 0) return res.status(404).json({ error: "device_not_found" });

      return res.json({
        screenshot: absolutizeAssetUrl(req, result.rows[0].screenshot ?? null),
        screenshot_at: result.rows[0].screenshot_at ?? null,
      });
    } catch (err) {
      console.error("Get screenshot error:", err);
      return res.status(500).json({ error: "failed_to_get_screenshot" });
    }
  },
);

  // =====================================================
  // DEVICE STATE (brightness + volume last known values)
  // =====================================================
  app.get(
    "/api/admin/devices/:deviceId/state",
    authenticateJWT,
    requireRole("admin", "manager"),
    async (req, res) => {
      const deviceId = String(req.params.deviceId || "").trim();
      if (!deviceId) return res.status(400).json({ error: "missing_device_id" });

      try {
        // Pull last brightness and volume from device_commands history
        const result = await pool.query(
          `SELECT payload FROM device_commands
           WHERE device_id = $1
             AND payload->>'type' IN ('brightness', 'volume')
             AND sent = true
           ORDER BY created_at DESC
           LIMIT 20`,
          [deviceId]
        );

        let brightness: number | null = null;
        let volume: number | null = null;

        for (const row of result.rows) {
          const p = row.payload || {};
          if (brightness === null && p.type === 'brightness' && p.value != null) {
            brightness = Number(p.value);
          }
          if (volume === null && p.type === 'volume' && p.value != null) {
            volume = Number(p.value);
          }
          if (brightness !== null && volume !== null) break;
        }

        return res.json({ brightness, volume });
      } catch (err) {
        console.error("Device state error:", err);
        return res.status(500).json({ error: "failed_to_get_state" });
      }
    }
  );

  // GET LAST RECORDING FOR A DEVICE (CMS uses this)
  

  // Alternative endpoints returning null if not found (simpler for Android)
  

  

  // Serve latest screenshot image directly
  

  app.post("/api/devices", async (req, res) => {
  try {
    // Accept multiple client payload shapes:
    const deviceName =
      (req.body?.deviceName ?? req.body?.name ?? "").toString().trim();

    const location =
      (req.body?.locationBranch ??
        req.body?.location_branch ??
        req.body?.location ??
        "").toString().trim();

    if (!deviceName) {
      return res.status(400).json({ error: "Device name is required" });
    }

    if (!location) {
      return res.status(400).json({ error: "Location / branch is required" });
    }

    const deviceId = `DEV-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
    const pairingCode = crypto.randomBytes(3).toString("hex").toUpperCase();
    const pairingCodeHash = crypto
      .createHash("sha256")
      .update(pairingCode)
      .digest("hex");
    const expiresAt = new Date(Date.now() + 1000 * 60 * 10); // 10 minutes

    const result = await pool.query(
      `
      INSERT INTO screens (
        device_id,
        name,
        location,
        location_branch,
        status,
        pairing_code,
        pairing_code_hash,
        pairing_expires_at,
        pairing_status,
        pairing_attempts,
        token_version,
        archived,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $3, 'offline', $4, $5, $6, 'pending', 0, 1, false, NOW(), NOW())
      RETURNING
        id,
        device_id as "deviceId",
        name,
        location_branch as "locationBranch",
        pairing_code as "pairingCode",
        pairing_expires_at as "pairingExpiresAt",
        api_key_last4 as "deviceKeyLast4"
      `,
      [deviceId, deviceName, location, pairingCode, pairingCodeHash, expiresAt],
    );

    return res.json(result.rows[0]);
  } catch (err) {
    console.error("Create device error:", err);
    return res.status(500).json({ error: "failed_to_create_device" });
  }
});



  // ❌ Disabled: minting long-lived device JWTs is insecure.
  // Use pairing + api_key_hash instead (see /api/device/claim + admin pairing endpoint).
  app.get("/api/devices/:id/token", authenticateJWT, requireRole("admin"), (_req, res) => {
    return res.status(410).json({ error: "disabled" });
  });

  app.post("/api/device/login", async (req, res) => {
    try {
      const { deviceId, password } = req.body;

      if (!deviceId || !password) {
        return res
          .status(400)
          .json({ error: "deviceId and password required" });
      }

      // Fetch device from your storage layer
      const device = await storage.getScreenByDeviceId(deviceId);

      if (!device) {
        return res.status(404).json({ error: "Device not found" });
      }

      if (!device.password) {
        return res.status(403).json({ error: "Device has no password set" });
      }

      const isValidPassword = await bcrypt.compare(password, device.password);
      if (!isValidPassword) {
        return res.status(403).json({ error: "Invalid password" });
      }

      const secret = process.env.JWT_SECRET;
      if (!secret) {
        console.error("JWT SECRET MISSING!");
        return res.status(500).json({ error: "JWT secret missing" });
      }

      // FIX: Ensure correct field is used in token
      const token = jwt.sign(
        { device_id: device.deviceId, role: "device" },
        secret,
        { expiresIn: "30d" },
      );

      await storage.updateScreen(device.id, { lastSeen: new Date() });

      return res.json({ success: true, token });
    } catch (err) {
      console.error("LOGIN ERROR:", err);
      return res.status(500).json({ error: "Server error" });
    }
  });

  // Auth Routes
  app.post("/api/auth/register", async (req, res) => {
    try {
      const { email, password } = registerSchema.parse(req.body);

      
      if (process.env.DISABLE_PUBLIC_REGISTER === "true") {
        return res.status(403).json({ error: "public_registration_disabled" });
      }
const existingUser = await storage.getUserByEmail(email);
      if (existingUser) {
        return res.status(400).json({ error: "User already exists" });
      }

      const hashedPassword = await bcrypt.hash(password, 10);
      const user = await storage.createUser({
        email,
        passwordHash: hashedPassword,
      });

      res.json({ message: "User registered", userId: user.id });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    try {
      const { email, password } = loginSchema.parse(req.body);

      const user = await storage.getUserByEmail(email);
      if (!user) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const isValidPassword = await bcrypt.compare(password, user.passwordHash);
      if (!isValidPassword) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const accessToken = jwt.sign(
        { sub: user.id, email: user.email, role: user.role },
        JWT_SECRET,
        { expiresIn: "24h" },
      );

      res.json({ accessToken, user: { id: user.id, email: user.email, role: user.role } });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      res.status(500).json({ error: "Internal server error" });
    }
  });


  // Admin: Users management (admin-only)
  app.get("/api/admin/users", authenticateJWT, requireRole("admin"), async (req, res) => {
    try {
      const all = await storage.getAllUsers();
      // Never return password hashes
      const safe = all.map((u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, createdAt: u.createdAt }));
      return res.json({ users: safe });
    } catch (e) {
      console.error("GET /api/admin/users error", e);
      return res.status(500).json({ error: "failed_to_list_users" });
    }
  });

  app.post("/api/admin/users", authenticateJWT, requireRole("admin"), async (req, res) => {
    try {
      const email = String((req.body as any)?.email || "").trim().toLowerCase();
      const password = String((req.body as any)?.password || "");
      const role = String((req.body as any)?.role || "restricted");
      const name = (req.body as any)?.name ? String((req.body as any).name) : undefined;

      if (!email || !email.includes("@")) return res.status(400).json({ error: "invalid_email" });
      if (!password || password.length < 6) return res.status(400).json({ error: "password_too_short" });

      const allowedRoles = new Set(["admin", "manager", "viewer", "restricted"]);
      const finalRole = allowedRoles.has(role) ? role : "restricted";

      const existing = await storage.getUserByEmail(email);
      if (existing) return res.status(409).json({ error: "user_already_exists" });

      const hashedPassword = await bcrypt.hash(password, 10);
      const user = await storage.createUser({
        email,
        passwordHash: hashedPassword,
        role: finalRole as any,
        name,
      } as any);

      return res.json({ ok: true, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
    } catch (e) {
      console.error("POST /api/admin/users error", e);
      return res.status(500).json({ error: "failed_to_create_user" });
    }
  });

  // Admin: rotate device token (returned once; stored hashed)
  app.post(
  "/api/admin/screens/:id/rotate-token",
  authenticateJWT,
  requireRole("admin"),
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "invalid_id" });
      }

      const screen = await storage.getScreen(id);
      if (!screen) {
        return res.status(404).json({ error: "screen_not_found" });
      }

      const deviceToken = randomUUID();
      const tokenHash = crypto
        .createHash("sha256")
        .update(deviceToken)
        .digest("hex");
      const last4 = deviceToken.slice(-4);

      await pool.query(
        `
        UPDATE screens
        SET api_key_hash = $2,
            api_key_last4 = $3,
            token_version = COALESCE(token_version, 0) + 1,
            revoked_at = NULL,
            rotated_at = NOW(),
            password = NULL,
            updated_at = NOW()
        WHERE id = $1
        `,
        [id, tokenHash, last4],
      );

      return res.json({
        ok: true,
        deviceToken,
        screenId: id,
        deviceId: (screen as any).deviceId || (screen as any).device_id,
      });
    } catch (e) {
      console.error("rotate-token error", e);
      return res.status(500).json({ error: "failed_to_rotate_token" });
    }
  },
);

// ✅ ADMIN → DEVICE COMMAND (JWT protected)
// Accepts BOTH legacy command types (SET_BRIGHTNESS) and modern types (brightness)
// Also accepts modern wrapper: { payload: { type, value, ... } }
app.post(
  "/api/admin/devices/:deviceId/command",
  authenticateJWT,
  requireRole("admin", "manager"),
  async (req, res) => {
    const deviceId = String(req.params.deviceId || "").trim();
    if (!deviceId) return res.status(400).json({ error: "missing_device_id" });

    // Support modern payload wrapper: { payload: { type, value, ... } }
    const raw =
      req.body?.payload && typeof req.body.payload === "object"
        ? req.body.payload
        : req.body;

    const rawType = String(raw?.type || "").trim();
    if (!rawType) return res.status(400).json({ error: "Command type is required" });

    const value = raw?.value;
    const duration = raw?.duration;

    // normalize command types:
    // - modern: "volume", "brightness", "restart_app"
    // - legacy: "SET_VOLUME", "SCREEN_ON"
    const normalize = (t: string) =>
      String(t || "")
        .trim()
        .toLowerCase()
        .replace(/[ -]/g, "_");

    const tNorm = normalize(rawType);

    let payload: any;

    // ✅ Modern supported types (preferred)
    const modernAllowed = new Set([
      "brightness",
      "volume",
      "reboot",
      "restart_app",
      "refresh",
      "kiosk_on",
      "kiosk_off",
      "set_pin",
      "reload_playlist",
      "refresh_playlist",
      "screenshot",
      "record",
      "play_content",
      "screen_on",
      "screen_off",
      "mute",
      "unmute",
    ]);

    if (modernAllowed.has(tNorm)) {
      payload = { ...raw, type: tNorm };
      if (tNorm === "record" && payload.duration == null) payload.duration = duration || 10;
    } else {
      // ✅ Legacy support
      switch (rawType) {
        case "SET_VOLUME":
          payload = { type: "volume", value };
          break;

        case "SET_BRIGHTNESS":
          payload = { type: "brightness", value };
          break;

        case "MUTE":
          payload = { type: "mute" };
          break;

        case "UNMUTE":
          payload = { type: "unmute" };
          break;

        case "SCREEN_OFF":
          payload = { type: "screen_off" };
          break;

        case "SCREEN_ON":
          payload = { type: "screen_on" };
          break;

        case "REBOOT":
          payload = { type: "reboot" };
          break;

        case "RESTART_APP":
          payload = { type: "restart_app" };
          break;

        case "REFRESH":
          payload = { type: "refresh" };
          break;

        case "SCREENSHOT":
          payload = { type: "screenshot" };
          break;

        case "RECORD":
          payload = { type: "record", duration: duration || 10 };
          break;

        case "PLAY_CONTENT": {
          const { contentId, contentName, contentUrl, contentType } = raw;
          payload = {
            type: "play_content",
            contentId,
            contentName,
            contentUrl: toAbsoluteMediaUrl(req, contentUrl) || absolutizeAssetUrl(req, contentUrl) || contentUrl,
            contentType,
          };
          break;
        }

        default:
          return res.status(400).json({
            error: "Unknown command type",
            received: rawType,
            normalized: tNorm,
            hint: "Use modern types: brightness, volume, reboot, restart_app, refresh, screenshot, screen_on, screen_off, mute, unmute",
          });
      }
    }

    try {
      if (payload?.type === "play_content" && payload?.contentUrl) {
        payload.contentUrl =
          toAbsoluteMediaUrl(req, payload.contentUrl) ||
          absolutizeAssetUrl(req, payload.contentUrl) ||
          payload.contentUrl;
      }

      // For play_content, ensure there is a publish job and attach its id to the command payload.
      if (payload?.type === "play_content") {
        const screenResult = await pool.query(
          `SELECT name FROM screens WHERE device_id = $1 LIMIT 1`,
          [deviceId],
        );

        const deviceName =
          String(raw?.deviceName || screenResult.rows[0]?.name || deviceId).trim() || deviceId;

        let totalBytesRaw = raw?.totalBytes ?? raw?.size ?? raw?.contentSize ?? null;

        // Auto-calculate total bytes from playlist media items if not provided
        if ((totalBytesRaw == null || totalBytesRaw === "") &&
            (payload.contentType === "playlist" || raw?.contentType === "playlist")) {
          const playlistId = payload.contentId ?? raw?.contentId ?? null;
          if (playlistId) {
            try {
              const sizeResult = await pool.query(
                `SELECT COALESCE(SUM(m.size), 0) as total
                 FROM playlist_items pi
                 JOIN media m ON m.id = pi.media_id
                 WHERE pi.playlist_id = $1 AND m.size IS NOT NULL`,
                [playlistId]
              );
              const sum = Number(sizeResult.rows[0]?.total ?? 0);
              if (sum > 0) totalBytesRaw = sum;

              // Also store files_total count
              const countResult = await pool.query(
                `SELECT COUNT(*) as cnt FROM playlist_items WHERE playlist_id = $1`,
                [playlistId]
              );
              payload._filesTotal = Number(countResult.rows[0]?.cnt ?? 0);
            } catch (e) {
              console.warn("Failed to calculate playlist size:", e);
            }
          }
        }

        const totalBytes =
          totalBytesRaw == null || totalBytesRaw === ""
            ? null
            : Number.isFinite(Number(totalBytesRaw))
              ? Number(totalBytesRaw)
              : null;

        if (!payload.publishJobId) {
          const publishJob = await pool.query(
            `
            INSERT INTO publish_jobs (
              device_id,
              device_name,
              content_type,
              content_id,
              content_name,
              total_bytes,
              status,
              progress,
              files_total
            )
            VALUES ($1, $2, $3, $4, $5, $6, 'pending', 0, COALESCE($7, 0))
            RETURNING id, started_at
            `,
            [
              deviceId,
              deviceName,
              String(payload.contentType || raw?.contentType || "media"),
              payload.contentId ?? raw?.contentId ?? null,
              String(payload.contentName || raw?.contentName || payload.type || "content"),
              totalBytes,
              payload._filesTotal ?? null,
            ],
          );

          payload.publishJobId = String(publishJob.rows[0].id);
        }
      }

      const result = await pool.query(
        `
        INSERT INTO device_commands (device_id, payload, sent, executed)
        VALUES ($1, $2, false, false)
        RETURNING id, created_at
        `,
        [deviceId, JSON.stringify(payload)],
      );

      const command = result.rows[0];
      return res.json({
        success: true,
        commandId: command.id,
        createdAt: command.created_at,
        publishJobId: payload?.publishJobId ?? null,
        queued: payload,
      });
    } catch (err) {
      console.error("Admin command insert error:", err);
      return res.status(500).json({ error: "failed_to_queue_command" });
    }
  },
);

// =====================================================
// COMMAND HISTORY FOR DEVICE (CMS)
// =====================================================
// ✅ ADMIN (dashboard) - JWT protected
app.get(
  "/api/admin/devices/:deviceId/commands/history",
  authenticateJWT,
  requireRole("admin", "manager"),
  async (req, res) => {
    const deviceId = String(req.params.deviceId || "").trim();
    if (!deviceId) return res.status(400).json({ error: "missing_device_id" });

    try {
      const result = await pool.query(
        `
        SELECT
          id,
          payload,
          sent,
          executed,
          executed_at,
          created_at
        FROM device_commands
        WHERE device_id = $1
        ORDER BY created_at DESC
        LIMIT 50
        `,
        [deviceId],
      );

      return res.json(result.rows);
    } catch (err) {
      console.error("Command history error:", err);
      return res.status(500).json({ error: "failed_to_fetch_command_history" });
    }
  },
);

// ❌ Deprecated (device should NOT send commands here)
app.post("/api/device/:deviceId/command", (_req, res) => {
  return res.status(410).json({ error: "moved_to_/api/admin/devices/:deviceId/command" });
});

// =====================================================
// DEVICE SCREENSHOT UPLOAD (DEVICE AUTH)
// =====================================================
app.post("/api/device/:deviceId/screenshot", authenticateDevice, async (req, res) => {
  const deviceId = String(req.params.deviceId || "").trim();
  const { screenshot } = req.body;

  if (!deviceId) return res.status(400).json({ error: "missing_device_id" });
  if (!screenshot) return res.status(400).json({ error: "screenshot_required" });

  try {
    let screenshotUrl: string = screenshot;

    // If base64 data URI, upload to Supabase Storage
    if (screenshot.startsWith("data:")) {
      const matches = screenshot.match(/^data:([^;]+);base64,(.+)$/);
      if (!matches) return res.status(400).json({ error: "invalid_screenshot_format" });

      const mimeType = matches[1];
      const base64Data = matches[2];
      const buffer = Buffer.from(base64Data, "base64");
      const ext = mimeType.includes("png") ? "png" : "jpg";
      const filename = `screenshots/${deviceId}_${Date.now()}.${ext}`;

      const { error: uploadError } = await supabaseAdmin.storage
        .from("media")
        .upload(filename, buffer, {
          contentType: mimeType,
          upsert: true,
        });

      if (uploadError) {
        console.error("Screenshot Supabase upload error:", uploadError);
        return res.status(500).json({ error: "screenshot_storage_failed" });
      }

      const { data: urlData } = supabaseAdmin.storage
        .from("media")
        .getPublicUrl(filename);

      screenshotUrl = urlData.publicUrl;
    }

    await pool.query(
      `
      UPDATE screens SET
        screenshot = $1,
        screenshot_at = NOW()
      WHERE device_id = $2
      `,
      [screenshotUrl, deviceId],
    );

    res.json({ success: true, url: screenshotUrl });
  } catch (err) {
    console.error("Screenshot upload error:", err);
    res.status(500).json({ error: "screenshot_upload_failed" });
  }
});

// =====================================================
// DEVICE THUMBNAIL UPLOAD (DEVICE AUTH)
// =====================================================
app.post(
  "/api/device/:deviceId/thumbnail",
  authenticateDevice,
  deviceThumbnailUpload.single("thumbnail"),
  async (req, res) => {
    const deviceId = String(req.params.deviceId || "").trim();
    const file = req.file;

    if (!deviceId) return res.status(400).json({ error: "missing_device_id" });
    if (!file) return res.status(400).json({ error: "No thumbnail file provided" });

    try {
      const thumbnailUrl = `/uploads/device-thumbnails/${file.filename}`;

      await pool.query(`UPDATE screens SET thumbnail = $1 WHERE device_id = $2`, [
        thumbnailUrl,
        deviceId,
      ]);

      res.json({ success: true, thumbnail: thumbnailUrl });
    } catch (err) {
      console.error("Thumbnail upload error:", err);
      res.status(500).json({ error: "Failed to upload thumbnail" });
    }
  },
);

// Get device thumbnail (DEVICE AUTH)
app.get("/api/device/:deviceId/thumbnail", authenticateDevice, async (req, res) => {
  const deviceId = String(req.params.deviceId || "").trim();
  if (!deviceId) return res.status(400).json({ error: "missing_device_id" });

  try {
    const result = await pool.query(`SELECT thumbnail FROM screens WHERE device_id = $1`, [
      deviceId,
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Device not found" });
    }

    res.json({ thumbnail: result.rows[0].thumbnail });
  } catch (err) {
    console.error("Get thumbnail error:", err);
    res.status(500).json({ error: "Failed to get thumbnail" });
  }
});

const deviceStatusSchema = z.object({
  deviceId: z.string().optional(),
  device_id: z.string().optional(),
  status: z.enum(["playing", "idle", "error", "offline"]).optional(),
  currentContentId: z.string().nullable().optional(),
  currentContentName: z.string().nullable().optional(),
  batteryLevel: z.number().min(0).max(100).nullable().optional(),
  temperature: z.number().min(-50).max(150).nullable().optional(),
  freeStorage: z.number().min(0).nullable().optional(),
  signalStrength: z.number().min(-150).max(0).nullable().optional(),
  isOnline: z.boolean().nullable().optional(),
  is_online: z.boolean().nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  errors: z.array(z.string()).nullable().optional(),
  timestamp: z.number().nullable().optional(),
});

// =====================================================
// DEVICE STATUS (DEVICE AUTH) — SaaS-grade
// NOTE: authenticateDevice already verifies the token.
// DO NOT do jwt.verify again here.
// =====================================================
app.post("/api/device/status", authenticateDevice, async (req, res) => {
  try {
    const validated = deviceStatusSchema.parse(req.body);

    const deviceId =
      String(validated.device_id || validated.deviceId || "").trim();

    if (!deviceId) {
      return res.status(400).json({ error: "device_id is required" });
    }

    const body = {
      ...req.body,
      device_id: deviceId,
      isOnline: validated.isOnline ?? validated.is_online ?? true,
    };

    await saveDeviceStatus(body);

    res.json({ success: true });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors });
    }
    console.error("Device status error:", err);
    res.status(500).json({ error: "Failed to save device status" });
  }
});

// =====================================================
// DEVICE STATUS (ADMIN AUTH) — optional audit/log pipeline
// =====================================================
app.post("/api/device/status/auth", authenticateJWT as any, async (req: Request, res) => {
  try {
    const validatedData = deviceStatusSchema.parse(req.body);

    const deviceId = String(validatedData.deviceId || validatedData.device_id || "").trim();
    if (!deviceId) return res.status(400).json({ error: "deviceId is required" });

    const screen = await storage.getScreenByDeviceId(deviceId);
    if (!screen) return res.status(404).json({ error: "Device not found" });

    await storage.createDeviceStatusLog({
      deviceId,
      status: validatedData.status ?? undefined,
      currentContentId: validatedData.currentContentId ?? undefined,
      currentContentName: validatedData.currentContentName ?? undefined,
      batteryLevel: validatedData.batteryLevel ?? undefined,
      temperature: validatedData.temperature ?? undefined,
      freeStorage: validatedData.freeStorage ?? undefined,
      signalStrength: validatedData.signalStrength ?? undefined,
      isOnline: validatedData.isOnline ?? validatedData.is_online ?? undefined,
      latitude: validatedData.latitude ?? undefined,
      longitude: validatedData.longitude ?? undefined,
      errors: validatedData.errors ?? undefined,
      timestamp: validatedData.timestamp ?? Date.now(),
    });

    await storage.updateDeviceStatus(deviceId, {
      status: validatedData.status ?? undefined,
      currentContent: validatedData.currentContentId ?? undefined,
      currentContentName: validatedData.currentContentName ?? undefined,
      batteryLevel: validatedData.batteryLevel ?? undefined,
      temperature: validatedData.temperature ?? undefined,
      freeStorage: validatedData.freeStorage ?? undefined,
      signalStrength: validatedData.signalStrength ?? undefined,
      isOnline: validatedData.isOnline ?? validatedData.is_online ?? undefined,
      latitude: validatedData.latitude ?? undefined,
      longitude: validatedData.longitude ?? undefined,
      errors: validatedData.errors ?? undefined,
    });

    res.json({ success: true });
  } catch (error: any) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.errors });
    console.error("Device status(auth) endpoint error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// =====================================================
// DEVICE STATUS by deviceId (DEVICE AUTH)
// (Your old version was open — not enterprise-grade.)
// =====================================================
app.post("/api/device/:deviceId/status", authenticateDevice, async (req, res) => {
  try {
    const deviceId = String(req.params.deviceId || "").trim();
    if (!deviceId) return res.status(400).json({ error: "missing_device_id" });

    const validatedData = deviceStatusSchema.parse({ ...req.body, deviceId });

    const screen = await storage.getScreenByDeviceId(deviceId);
    if (!screen) return res.status(404).json({ error: "Device not found" });

    await storage.createDeviceStatusLog({
      deviceId,
      status: validatedData.status ?? undefined,
      currentContentId: validatedData.currentContentId ?? undefined,
      currentContentName: validatedData.currentContentName ?? undefined,
      batteryLevel: validatedData.batteryLevel ?? undefined,
      temperature: validatedData.temperature ?? undefined,
      freeStorage: validatedData.freeStorage ?? undefined,
      signalStrength: validatedData.signalStrength ?? undefined,
      isOnline: validatedData.isOnline ?? validatedData.is_online ?? undefined,
      latitude: validatedData.latitude ?? undefined,
      longitude: validatedData.longitude ?? undefined,
      errors: validatedData.errors ?? undefined,
      timestamp: validatedData.timestamp ?? Date.now(),
    });

    const updatedScreen = await storage.updateDeviceStatus(deviceId, {
      status: validatedData.status ?? undefined,
      currentContent: validatedData.currentContentId ?? undefined,
      currentContentName: validatedData.currentContentName ?? undefined,
      batteryLevel: validatedData.batteryLevel ?? undefined,
      temperature: validatedData.temperature ?? undefined,
      freeStorage: validatedData.freeStorage ?? undefined,
      signalStrength: validatedData.signalStrength ?? undefined,
      isOnline: validatedData.isOnline ?? validatedData.is_online ?? undefined,
      latitude: validatedData.latitude ?? undefined,
      longitude: validatedData.longitude ?? undefined,
      errors: validatedData.errors ?? undefined,
    });

    res.json({ success: true, screen: updatedScreen });
  } catch (error: any) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.errors });
    console.error("Device status(deviceId) endpoint error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// =====================================================
// DEVICE PLAYLIST (NOTE)
// Your pasted code uses in-memory `playlists`.
// That is NOT SaaS-grade because it resets on restart.
// Keep for now, but protect it with authenticateDevice.
// =====================================================
app.get("/api/device/:deviceId/playlist", authenticateDevice, (req, res) => {
  const deviceId = String(req.params.deviceId || "").trim();
  const playlist = playlists[deviceId];

  if (!playlist) {
    return res.json({ deviceId, lastUpdated: null, items: [] });
  }

  res.json(playlist);
});

app.post("/api/device/:deviceId/playlist", authenticateDevice, (req, res) => {
  const deviceId = String(req.params.deviceId || "").trim();
  const { items } = req.body;

  if (!Array.isArray(items)) {
    return res.status(400).json({ error: "items must be an array" });
  }

  playlists[deviceId] = {
    deviceId,
    lastUpdated: new Date().toISOString(),
    items,
  };

  console.log("Updated playlist for", deviceId, "Items:", items.length);

  res.json({ ok: true, playlist: playlists[deviceId] });
});

  // Delete device-specific playlist (revert to default)
 app.delete("/api/device/:deviceId/playlist", authenticateDevice, (req, res) => {
    const { deviceId } = req.params;

    if (playlists[deviceId]) {
      delete playlists[deviceId];
      res.json({ ok: true, message: "Device playlist cleared" });
    } else {
      res.json({ ok: true, message: "No custom playlist was set" });
    }
  });

  // Zone-based playlist endpoints
  // GET all zone playlists for a device
  app.get("/api/device/:deviceId/zones/playlist", (req, res) => {
    const { deviceId } = req.params;
    const deviceZones = zonePlaylists[deviceId];

    if (!deviceZones) {
      return res.json({ deviceId, zones: {} });
    }

    res.json({ deviceId, zones: deviceZones });
  });

  // GET playlist for a specific zone
  app.get("/api/device/:deviceId/zone/:zoneId/playlist", (req, res) => {
    const { deviceId, zoneId } = req.params;

    const deviceZones = zonePlaylists[deviceId] || {};
    const playlist = deviceZones[zoneId];

    if (!playlist) {
      return res.json({ lastUpdated: null, items: [] });
    }

    res.json(playlist);
  });

  // POST playlist for a specific zone
  app.post("/api/device/:deviceId/zone/:zoneId/playlist", (req, res) => {
    const { deviceId, zoneId } = req.params;
    const { items } = req.body;

    if (!Array.isArray(items)) {
      return res.status(400).json({ error: "items must be an array" });
    }

    if (!zonePlaylists[deviceId]) zonePlaylists[deviceId] = {};

    zonePlaylists[deviceId][zoneId] = {
      lastUpdated: new Date().toISOString(),
      items,
    };

    console.log(`Updated playlist for device ${deviceId}, zone ${zoneId}`);

    res.json({
      ok: true,
      playlist: zonePlaylists[deviceId][zoneId],
    });
  });

  // DELETE playlist for a specific zone
  app.delete("/api/device/:deviceId/zone/:zoneId/playlist", (req, res) => {
    const { deviceId, zoneId } = req.params;

    if (zonePlaylists[deviceId] && zonePlaylists[deviceId][zoneId]) {
      delete zonePlaylists[deviceId][zoneId];
      res.json({ ok: true, message: `Zone ${zoneId} playlist cleared` });
    } else {
      res.json({ ok: true, message: "No playlist was set for this zone" });
    }
  });

  // DELETE all zone playlists for a device
  app.delete("/api/device/:deviceId/zones/playlist", (req, res) => {
    const { deviceId } = req.params;

    if (zonePlaylists[deviceId]) {
      delete zonePlaylists[deviceId];
      res.json({ ok: true, message: "All zone playlists cleared" });
    } else {
      res.json({ ok: true, message: "No zone playlists were set" });
    }
  });

  // RSS proxy — server-side fetch, avoids CORS issues on Android WebView
  // Used by both template render engine and template designer preview
  app.get("/api/rss-proxy", async (req: Request, res: Response) => {
    const { url } = req.query;
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "URL is required" });
    }
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return res.status(400).json({ error: "Invalid URL" });
    }
    try {
      const r = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; LuminaSignage/1.0; +https://lumina.app)",
          "Accept": "application/rss+xml, application/atom+xml, text/xml, application/xml, */*",
        },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) return res.status(502).json({ error: `Upstream returned ${r.status}` });
      const text = await r.text();

      const items: { title: string; description: string; link: string; pubDate: string; image?: string }[] = [];

      // Parse both RSS <item> and Atom <entry>
      let matches = text.match(/<item[\s>][\s\S]*?<\/item>/g) || [];
      if (!matches.length) matches = text.match(/<entry[\s>][\s\S]*?<\/entry>/g) || [];

      for (const item of matches.slice(0, 20)) {
        const title = item.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1]?.trim().replace(/<[^>]+>/g, '') || "";
        const description = item.match(/<(?:description|summary)[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/(?:description|summary)>/)?.[1]?.trim().replace(/<[^>]+>/g, '').substring(0, 200) || "";
        const link = item.match(/<link[^>]*href="([^"]+)"/)?.[1] || item.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() || "";
        const pubDate = item.match(/<(?:pubDate|published|updated)>([\s\S]*?)<\/(?:pubDate|published|updated)>/)?.[1]?.trim() || "";
        const image =
          item.match(/<media:content[^>]*url="([^"]+)"/)?.[1] ||
          item.match(/<media:thumbnail[^>]*url="([^"]+)"/)?.[1] ||
          item.match(/<enclosure[^>]*url="([^"]+)"[^>]*type="image/)?.[1] ||
          item.match(/<img[^>]*src=["']([^"']+)["']/)?.[1] ||
          undefined;
        if (title) items.push({ title, description, link, pubDate, image });
      }

      res.setHeader("Cache-Control", "public, max-age=300"); // cache 5 min
      res.json({ items, isValidFeed: matches.length > 0, count: items.length });
    } catch (err: any) {
      console.error("RSS proxy error:", err?.message);
      res.status(500).json({ error: "Failed to fetch RSS feed" });
    }
  });

  // Webpage ticker proxy - extracts text content from webpages
  app.get("/api/ticker-proxy", async (req, res) => {
    const { url } = req.query;
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "URL is required" });
    }

    // Security: Only allow http/https URLs
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return res.status(400).json({ error: "Invalid URL - must start with http:// or https://" });
    }

    console.log("Fetching ticker content from:", url);

    try {
      const response = await fetch(url);
      if (!response.ok) {
        return res.status(502).json({ error: `Failed to fetch webpage: ${response.status}` });
      }
      const html = await response.text();
      
      // Extract text content - remove scripts, styles, and HTML tags
      let text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
      
      // Limit to reasonable length for ticker
      if (text.length > 500) {
        text = text.substring(0, 500) + "...";
      }
      
      res.json({ text, success: text.length > 0 });
    } catch (error) {
      console.error("Ticker fetch error:", error);
      res.status(500).json({ error: "Failed to fetch webpage content" });
    }
  });

  // Screenshot capture endpoint using Puppeteer
  app.get("/api/webpage-screenshot", requireRole("admin"), async (req, res) => {
    const { url, width, height } = req.query;
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "URL is required" });
    }

    // Security: Only allow http/https URLs
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return res.status(400).json({ error: "Invalid URL - must start with http:// or https://" });
    }

    // Security: Block internal/private IP ranges to prevent SSRF
    try {
      const urlObj = new URL(url);
      const hostname = urlObj.hostname.toLowerCase();
      
      // Block localhost and private network patterns
      const blockedPatterns = [
        /^localhost$/i,
        /^127\./,
        /^10\./,
        /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
        /^192\.168\./,
        /^169\.254\./,
        /^0\./,
        /^\[::1\]$/,
        /^\[fc00:/i,
        /^\[fd00:/i,
        /^host\.docker\.internal$/i,
      ];
      
      if (blockedPatterns.some(pattern => pattern.test(hostname))) {
        return res.status(400).json({ error: "Cannot access internal/private URLs" });
      }
    } catch (e) {
      return res.status(400).json({ error: "Invalid URL format" });
    }

    const viewportWidth = parseInt(width as string) || 1280;
    const viewportHeight = parseInt(height as string) || 720;

    console.log("Capturing screenshot of:", url);

    try {
      const puppeteer = await import("puppeteer");
      const { execSync } = await import("child_process");
      
      // Find system chromium executable
      let chromiumPath: string | undefined;
      try {
        chromiumPath = execSync("which chromium").toString().trim();
      } catch {
        try {
          chromiumPath = execSync("which chromium-browser").toString().trim();
        } catch {
          // Fall back to default puppeteer chromium
        }
      }
      
      const browser = await puppeteer.default.launch({
        headless: true,
        executablePath: chromiumPath,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
      });
      
      const page = await browser.newPage();
      await page.setViewport({ width: viewportWidth, height: viewportHeight });
      
      // Set a timeout for page load
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
      
      // Wait a bit for dynamic content
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const screenshot = await page.screenshot({ type: 'png', encoding: 'base64' });
      await browser.close();
      
      res.json({ 
        image: `data:image/png;base64,${screenshot}`,
        success: true,
        width: viewportWidth,
        height: viewportHeight
      });
    } catch (error: any) {
      console.error("Screenshot capture error:", error);
      res.status(500).json({ error: `Failed to capture screenshot: ${error.message}` });
    }
  });

  // RSS feed endpoints
  app.post("/api/device/:deviceId/zone/:zoneId/rss", (req, res) => {
    const { deviceId, zoneId } = req.params;
    const { url, refreshMinutes } = req.body;

    if (!url) {
      return res.status(400).json({ error: "RSS URL is required" });
    }

    if (!zoneRSSFeeds[deviceId]) zoneRSSFeeds[deviceId] = {};

    zoneRSSFeeds[deviceId][zoneId] = {
      url,
      refreshMinutes: refreshMinutes || 5,
      lastUpdated: new Date().toISOString(),
    };

    res.json({ ok: true, rss: zoneRSSFeeds[deviceId][zoneId] });
  });

  app.get("/api/device/:deviceId/zone/:zoneId/rss", (req, res) => {
    const { deviceId, zoneId } = req.params;

    const dev = zoneRSSFeeds[deviceId];
    if (!dev || !dev[zoneId]) {
      return res.json({ url: null });
    }

    res.json(dev[zoneId]);
  });

  // Social feed zone configuration
  app.post("/api/device/:deviceId/zone/:zoneId/social", (req, res) => {
    const { deviceId, zoneId } = req.params;
    const { platform, handle, hashtag, refreshMinutes } = req.body;

    if (!platform) {
      return res.status(400).json({ error: "platform is required" });
    }

    if (!socialZoneConfig[deviceId]) socialZoneConfig[deviceId] = {};

    socialZoneConfig[deviceId][zoneId] = {
      platform,
      handle: handle || null,
      hashtag: hashtag || null,
      refreshMinutes: refreshMinutes || 10,
      lastUpdated: new Date().toISOString(),
    };

    res.json({ ok: true, config: socialZoneConfig[deviceId][zoneId] });
  });

  app.get("/api/device/:deviceId/zone/:zoneId/social", (req, res) => {
    const { deviceId, zoneId } = req.params;

    const devConfig = socialZoneConfig[deviceId];
    if (!devConfig || !devConfig[zoneId]) {
      return res.json({ platform: null });
    }

    res.json(devConfig[zoneId]);
  });

  // Social preview stub (later: plug real platform APIs)
  app.post("/api/social/preview", async (req, res) => {
    const { platform, handle, hashtag } = req.body;

    const mockPosts = [
      {
        id: "1",
        author: handle || "@brand",
        text: "First sample post from " + platform,
        likes: 124,
        time: "2h",
      },
      {
        id: "2",
        author: handle || "@brand",
        text: "Another update for " + (hashtag || "#campaign"),
        likes: 89,
        time: "4h",
      },
    ];

    res.json({ ok: true, posts: mockPosts });
  });

  // Device template assignment (uses in-memory for device assignments, database for templates)
  app.post("/api/device/:deviceId/template", async (req, res) => {
    const { deviceId } = req.params;
    const { templateId } = req.body;

    const template = await storage.getTemplate(templateId);
    if (!template) {
      return res.status(400).json({ error: "Template not found" });
    }

    deviceTemplates[deviceId] = templateId;

    console.log(`Assigned template ${templateId} to device ${deviceId}`);

    res.json({ ok: true, deviceId, templateId });
  });

  app.get("/api/device/:deviceId/template", async (req, res) => {
    const { deviceId } = req.params;
    const templateId = deviceTemplates[deviceId];

    if (!templateId) {
      return res.json({ deviceId, template: null });
    }

    const template = await storage.getTemplate(templateId);
    res.json({ deviceId, template: template || null });
  });

  app.get("/api/device/statuses", async (_req, res) => {
    try {
      const allScreens = await storage.getAllScreens();
      const statuses = allScreens.map((screen) => ({
        id: screen.id,
        device_id: screen.deviceId,
        name: screen.name,
        location: screen.location,
        status: screen.status,
        current_content_id: screen.currentContent,
        current_content_name: screen.currentContentName,
        temperature: screen.temperature,
        free_storage: screen.freeStorage,
        battery_level: screen.batteryLevel,
        signal_strength: screen.signalStrength,
        is_online: screen.isOnline,
        latitude: screen.latitude,
        longitude: screen.longitude,
        errors: screen.errors,
        last_seen: screen.lastSeen,
        resolution: screen.resolution,
      }));
      res.json(statuses);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch device statuses" });
    }
  });

  app.get("/api/screens", async (_req, res) => {
    try {
      const allScreens = await storage.getAllScreens();
      res.json(allScreens.filter((s: any) => !s.archived));
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch screens" });
    }
  });

  app.get("/api/screens/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const screen = await storage.getScreen(id);
      if (!screen) {
        return res.status(404).json({ error: "Screen not found" });
      }
      res.json(screen);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch screen" });
    }
  });

  app.post("/api/screens", async (req, res) => {
    try {
      const screenData = insertScreenSchema.parse(req.body);
      const screen = await storage.createScreen(screenData);
      res.status(201).json(screen);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      res.status(500).json({ error: "Failed to create screen" });
    }
  });

  app.patch("/api/screens/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const updateData = updateScreenSchema.parse(req.body);
      const screen = await storage.updateScreen(id, updateData);
      if (!screen) {
        return res.status(404).json({ error: "Screen not found" });
      }
      res.json(screen);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      res.status(500).json({ error: "Failed to update screen" });
    }
  });

  app.put("/api/screens/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const { name, location } = req.body;
      
      const result = await pool.query(
        `UPDATE screens SET name = COALESCE($1, name), location = COALESCE($2, location) WHERE device_id = $3 RETURNING *`,
        [name, location, id]
      );
      
      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Screen not found" });
      }
      
      res.json(result.rows[0]);
    } catch (error) {
      console.error("Update screen error:", error);
      res.status(500).json({ error: "Failed to update screen" });
    }
  });

  app.put("/api/screens/:id/group", async (req, res) => {
    try {
      const { id } = req.params;
      const { groupId } = req.body;
      
      await pool.query(`DELETE FROM device_group_map WHERE device_id = $1`, [id]);
      
      if (groupId) {
        await pool.query(
          `INSERT INTO device_group_map (id, device_id, group_id, created_at) VALUES (gen_random_uuid(), $1, $2, NOW())`,
          [id, groupId]
        );
      }
      
      res.json({ success: true });
    } catch (error) {
      console.error("Update screen group error:", error);
      res.status(500).json({ error: "Failed to update screen group" });
    }
  });

  app.delete("/api/screens/:id", async (req, res) => {
    try {
      const { id } = req.params;
      
      // Try to delete by device_id first
      const result = await pool.query(
        `DELETE FROM screens WHERE device_id = $1 RETURNING id`,
        [id]
      );
      
      if (result.rowCount === 0) {
        // If not found by device_id, try by numeric id
        const numId = parseInt(id);
        if (!isNaN(numId)) {
          const deleted = await storage.deleteScreen(numId);
          if (!deleted) {
            return res.status(404).json({ error: "Screen not found" });
          }
        } else {
          return res.status(404).json({ error: "Screen not found" });
        }
      }
      
      res.json({ message: "Screen deleted" });
    } catch (error) {
      console.error("Delete screen error:", error);
      res.status(500).json({ error: "Failed to delete screen" });
    }
  });

  // Media Routes
  app.get("/api/media", async (req, res) => {
    try {
      const includeExpired = req.query.includeExpired === "true";
      // First, mark any newly expired content
      await pool.query(`
        UPDATE media SET is_expired = true 
        WHERE expires_at IS NOT NULL 
        AND expires_at < NOW() 
        AND (is_expired IS NULL OR is_expired = false)
      `);
      
      let result;
      if (includeExpired) {
        result = await pool.query(`SELECT * FROM media ORDER BY uploaded_at DESC`);
      } else {
        result = await pool.query(`
          SELECT * FROM media 
          WHERE is_expired IS NULL OR is_expired = false 
          ORDER BY uploaded_at DESC
        `);
      }
      res.json(result.rows.map((row) => normalizeMediaRow(req, row)));
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch media" });
    }
  });

  // Get expired media only
  app.get("/api/media/expired", async (_req, res) => {
    try {
      // First, mark any newly expired content
      await pool.query(`
        UPDATE media SET is_expired = true 
        WHERE expires_at IS NOT NULL 
        AND expires_at < NOW() 
        AND (is_expired IS NULL OR is_expired = false)
      `);
      
      const result = await pool.query(`
        SELECT * FROM media 
        WHERE is_expired = true 
        ORDER BY expires_at DESC
      `);
      res.json(result.rows.map((row) => normalizeMediaRow(req, row)));
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch expired media" });
    }
  });

  // Update media expiry date
  app.put("/api/media/:id/expiry", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { expiresAt } = req.body;
      
      // Recompute is_expired: false when expiresAt is null or in the future, true when in the past
      let isExpired = false;
      if (expiresAt) {
        const expiryDate = new Date(expiresAt);
        isExpired = expiryDate < new Date();
      }
      
      const result = await pool.query(
        `UPDATE media SET expires_at = $1, is_expired = $2 WHERE id = $3 RETURNING *`,
        [expiresAt || null, isExpired, id]
      );
      
      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Media not found" });
      }
      
      res.json(result.rows[0]);
    } catch (error) {
      console.error("Update media expiry error:", error);
      res.status(500).json({ error: "Failed to update media expiry" });
    }
  });

  // Restore expired media (clear expiry and is_expired flag)
  app.post("/api/media/:id/restore", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      
      const result = await pool.query(
        `UPDATE media SET is_expired = false, expires_at = NULL WHERE id = $1 RETURNING *`,
        [id]
      );
      
      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Media not found" });
      }
      
      res.json(result.rows[0]);
    } catch (error) {
      console.error("Restore media error:", error);
      res.status(500).json({ error: "Failed to restore media" });
    }
  });

  // Content list for schedule modal (returns media as content options)
  app.get("/api/content/list", async (_req, res) => {
    try {
      const allMedia = await storage.getAllMedia();
      res.json(allMedia.map((m) => ({ id: m.id, name: m.name, type: m.type })));
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch content list" });
    }
  });

  app.post("/api/media", async (req, res) => {
    try {
      const mediaData = insertMediaSchema.parse(req.body);
      const mediaItem = await storage.createMedia(mediaData);
      res.status(201).json(mediaItem);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      res.status(500).json({ error: "Failed to create media" });
    }
  });

  app.post(
    "/api/media/upload",
    uploadMemory.single("file"),
    async (req, res) => {
      try {
        if (!req.file) {
          return res.status(400).json({ error: "No file uploaded" });
        }

        // Generate unique filename
        const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
        const ext = path.extname(req.file.originalname);
        const filename = uniqueSuffix + ext;

        // Upload buffer to Supabase Storage bucket "media"
        const { error: uploadError } = await supabaseAdmin.storage
          .from("media")
          .upload(filename, req.file.buffer, {
            contentType: req.file.mimetype,
            upsert: false,
          });

        if (uploadError) {
          console.error("Supabase Storage upload error:", uploadError);
          return res.status(500).json({ error: "Failed to upload to storage" });
        }

        // Get permanent public URL
        const { data: urlData } = supabaseAdmin.storage
          .from("media")
          .getPublicUrl(filename);

        const fileUrl = urlData.publicUrl;
        const fileType = req.file.mimetype.startsWith("video") ? "video" : "image";

        const mediaItem = await storage.createMedia({
          name: req.file.originalname,
          type: fileType,
          url: fileUrl,
          size: req.file.size,
          duration: fileType === "video" ? 30 : 10,
        });

        res.status(201).json({
          message: "File uploaded",
          media: normalizeMediaRow(req, mediaItem as any),
        });
      } catch (error) {
        console.error("Media upload error:", error);
        res.status(500).json({ error: "Failed to upload file" });
      }
    },
  );

  app.delete("/api/media/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const deleted = await storage.deleteMedia(id);
      if (!deleted) {
        return res.status(404).json({ error: "Media not found" });
      }
      res.json({ message: "Media deleted" });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete media" });
    }
  });

  // =====================================================
  // CONTENT PLAYLISTS API
  // =====================================================

  app.get("/api/content-playlists", async (req, res) => {
    try {
      const playlistsResult = await pool.query(`
        SELECT
          cp.id,
          cp.name,
          cp.description
        FROM content_playlists cp
        ORDER BY cp.id DESC
      `);

      const playlistIds = playlistsResult.rows
        .map((r: any) => Number(r.id))
        .filter((n: number) => Number.isFinite(n));

      const itemsByPlaylist = new Map<number, any[]>();

      if (playlistIds.length > 0) {
        const itemsResult = await pool.query(
          `
          SELECT
            pi.id AS "itemId",
            pi.playlist_id,
            pi.media_id,
            pi.duration,
            pi.volume,
            pi.position,
            m.id,
            m.name,
            m.type,
            m.url
          FROM playlist_items pi
          LEFT JOIN media m ON m.id = pi.media_id
          WHERE pi.playlist_id = ANY($1::int[])
          ORDER BY pi.playlist_id ASC, pi.position ASC, pi.id ASC
          `,
          [playlistIds]
        );

        for (const row of itemsResult.rows) {
          const playlistId = Number(row.playlist_id);
          const current = itemsByPlaylist.get(playlistId) || [];

          current.push(
            normalizeMediaRow(req, {
              id: row.id,
              name: row.name,
              type: row.type,
              url: row.url,
              itemId: row.itemId,
              duration: row.duration,
              volume: row.volume,
              position: row.position,
            })
          );

          itemsByPlaylist.set(playlistId, current);
        }
      }

      const payload = playlistsResult.rows.map((playlist: any) => {
        const items = itemsByPlaylist.get(Number(playlist.id)) || [];
        return {
          id: playlist.id,
          name: playlist.name,
          description: playlist.description,
          item_count: items.length,
          items,
        };
      });

      return res.json(payload);
    } catch (error) {
      console.error("Fetch playlists error:", error);
      return res.status(500).json({ error: "Failed to fetch playlists" });
    }
  });

  app.post("/api/content-playlists", async (req, res) => {
    try {
      const name = String(req.body?.name || "").trim();
      const description =
        typeof req.body?.description === "string" && req.body.description.trim()
          ? req.body.description.trim()
          : null;

      if (!name) {
        return res.status(400).json({ error: "Name is required" });
      }

      const result = await pool.query(
        `
        INSERT INTO content_playlists (name, description)
        VALUES ($1, $2)
        RETURNING id, name, description
        `,
        [name, description]
      );

      return res.status(201).json({
        ...result.rows[0],
        item_count: 0,
        items: [],
      });
    } catch (error) {
      console.error("Create playlist error:", error);
      return res.status(500).json({ error: "Failed to create playlist" });
    }
  });

  app.delete("/api/content-playlists/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "Invalid playlist id" });
      }

      await pool.query(`DELETE FROM playlist_items WHERE playlist_id = $1`, [id]);
      await pool.query(`DELETE FROM playlist_assignments WHERE playlist_id = $1`, [id]);

      const result = await pool.query(
        `DELETE FROM content_playlists WHERE id = $1 RETURNING id`,
        [id]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Playlist not found" });
      }

      return res.json({ message: "Playlist deleted" });
    } catch (error) {
      console.error("Delete playlist error:", error);
      return res.status(500).json({ error: "Failed to delete playlist" });
    }
  });

  app.post("/api/content-playlists/:id/items", async (req, res) => {
    try {
      const playlistId = parseInt(req.params.id);
      const { mediaId, mediaIds, duration } = req.body;

      const idsToAdd = mediaIds ? mediaIds : (mediaId ? [mediaId] : []);

      if (idsToAdd.length === 0) {
        return res.status(400).json({ error: "No media IDs provided" });
      }

      const posResult = await pool.query(
        `SELECT COALESCE(MAX(position), -1) + 1 as next_pos FROM playlist_items WHERE playlist_id = $1`,
        [playlistId]
      );
      let position = posResult.rows[0].next_pos;

      const insertedItems = [];
      for (const id of idsToAdd) {
        const result = await pool.query(
          `INSERT INTO playlist_items (playlist_id, media_id, position, duration) VALUES ($1, $2, $3, $4) RETURNING *`,
          [playlistId, id, position, duration || 10]
        );
        insertedItems.push(result.rows[0]);
        position++;
      }

      return res.status(201).json(insertedItems);
    } catch (error) {
      console.error("Add playlist item error:", error);
      return res.status(500).json({ error: "Failed to add item to playlist" });
    }
  });

  app.delete("/api/content-playlists/:playlistId/items/:itemId", async (req, res) => {
    try {
      const itemId = parseInt(req.params.itemId);
      const result = await pool.query(`DELETE FROM playlist_items WHERE id = $1 RETURNING *`, [itemId]);
      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Item not found" });
      }
      return res.json({ message: "Item removed from playlist" });
    } catch (error) {
      console.error("Remove playlist item error:", error);
      return res.status(500).json({ error: "Failed to remove item from playlist" });
    }
  });

  app.patch("/api/playlist-items/:itemId", async (req, res) => {
    try {
      const itemId = parseInt(req.params.itemId);
      const { duration, volume } = req.body;

      const updates: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      if (duration !== undefined) {
        updates.push(`duration = $${paramIndex++}`);
        values.push(duration);
      }
      if (volume !== undefined) {
        updates.push(`volume = $${paramIndex++}`);
        values.push(volume);
      }

      if (updates.length === 0) {
        return res.status(400).json({ error: "No fields to update" });
      }

      values.push(itemId);
      const result = await pool.query(
        `UPDATE playlist_items SET ${updates.join(", ")} WHERE id = $${paramIndex} RETURNING *`,
        values
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Item not found" });
      }

      return res.json(result.rows[0]);
    } catch (error) {
      console.error("Update playlist item error:", error);
      return res.status(500).json({ error: "Failed to update playlist item" });
    }
  });

  app.post("/api/content-playlists/:id/assign", async (req, res) => {
    try {
      const playlistId = parseInt(req.params.id);
      const { deviceId } = req.body;
      if (!deviceId) {
        return res.status(400).json({ error: "Device ID is required" });
      }

      await pool.query(
        `DELETE FROM playlist_assignments WHERE playlist_id = $1 AND device_id = $2`,
        [playlistId, deviceId]
      );

      const result = await pool.query(
        `INSERT INTO playlist_assignments (playlist_id, device_id) VALUES ($1, $2) RETURNING *`,
        [playlistId, deviceId]
      );
      return res.status(201).json(result.rows[0]);
    } catch (error) {
      console.error("Assign playlist error:", error);
      return res.status(500).json({ error: "Failed to assign playlist" });
    }
  });

  app.get("/api/content-playlists/:id/assignments", async (req, res) => {
    try {
      const playlistId = parseInt(req.params.id);
      const result = await pool.query(`
        SELECT pa.*, s.name as device_name 
        FROM playlist_assignments pa
        LEFT JOIN screens s ON s.device_id = pa.device_id
        WHERE pa.playlist_id = $1
      `, [playlistId]);
      return res.json(result.rows);
    } catch (error) {
      console.error("Fetch assignments error:", error);
      return res.status(500).json({ error: "Failed to fetch assignments" });
    }
  });

  app.delete("/api/content-playlists/:playlistId/assignments/:deviceId", async (req, res) => {
    try {
      const playlistId = parseInt(req.params.playlistId);
      const { deviceId } = req.params;
      const result = await pool.query(
        `DELETE FROM playlist_assignments WHERE playlist_id = $1 AND device_id = $2 RETURNING *`,
        [playlistId, deviceId]
      );
      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Assignment not found" });
      }
      return res.json({ message: "Assignment removed" });
    } catch (error) {
      console.error("Remove assignment error:", error);
      return res.status(500).json({ error: "Failed to remove assignment" });
    }
  });

  // Reorder playlist items
  app.patch("/api/content-playlists/:id/reorder", async (req, res) => {
    try {
      const playlistId = parseInt(req.params.id);
      const { orderedItemIds } = req.body; // array of itemIds in new order

      if (!Array.isArray(orderedItemIds) || orderedItemIds.length === 0) {
        return res.status(400).json({ error: "orderedItemIds array required" });
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (let i = 0; i < orderedItemIds.length; i++) {
          await client.query(
            `UPDATE playlist_items SET position = $1 WHERE id = $2 AND playlist_id = $3`,
            [i, orderedItemIds[i], playlistId]
          );
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      return res.json({ message: "Reordered successfully" });
    } catch (error) {
      console.error("Reorder playlist error:", error);
      return res.status(500).json({ error: "Failed to reorder playlist" });
    }
  });

  // Playlist Routes
  app.get("/api/playlists/:screenId", async (req, res) => {
    try {
      const screenId = parseInt(req.params.screenId);
      const playlistEntries = await storage.getPlaylistsByScreenId(screenId);

      const allMedia = await storage.getAllMedia();
      const mediaMap = new Map(allMedia.map((m) => [m.id, m]));

      const result = playlistEntries.map((p) => {
        const mediaItem = mediaMap.get(p.mediaId);
        return {
          playlist_id: p.id,
          position: p.position,
          duration_override: p.durationOverride,
          ...mediaItem,
        };
      });

      res.json(result);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch playlist" });
    }
  });

  app.post(
    "/api/playlists",
    authenticateJWT as any,
    async (req: Request, res) => {
      try {
        const { screen_id, media_id, position, duration_override } = req.body;

        const entry = await storage.createPlaylistEntry({
          screenId: parseInt(screen_id),
          mediaId: parseInt(media_id),
          position: position || 0,
          durationOverride: duration_override
            ? parseInt(duration_override)
            : undefined,
        });

        res.status(201).json(entry);
      } catch (error) {
        res.status(500).json({ error: "Failed to create playlist entry" });
      }
    },
  );

  app.delete(
    "/api/playlists/:id",
    authenticateJWT as any,
    async (req: Request, res) => {
      try {
        const id = parseInt(req.params.id);
        const deleted = await storage.deletePlaylistEntry(id);
        if (!deleted) {
          return res.status(404).json({ error: "Playlist entry not found" });
        }
        res.json({ message: "Playlist entry deleted" });
      } catch (error) {
        res.status(500).json({ error: "Failed to delete playlist entry" });
      }
    },
  );

  // Content API for player displays
  app.get("/api/content", async (_req, res) => {
    try {
      const allMedia = await storage.getAllMedia();
      // Return media as displayable content
      const content = allMedia.map((item) =>
        normalizeMediaRow(req, {
          id: item.id,
          type: item.type,
          url: item.url,
          name: item.name,
          duration: item.duration || 10, // default 10 seconds per slide
        }),
      );
      res.json(content);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch content" });
    }
  });

  // Content for specific screen
  app.get("/api/content/:screenId", async (req, res) => {
    try {
      const screenId = parseInt(req.params.screenId);
      const screen = await storage.getScreen(screenId);
      if (!screen) {
        return res.status(404).json({ error: "Screen not found" });
      }

      // For now, return all media - later can be filtered by screen assignment
      const allMedia = await storage.getAllMedia();
      const content = allMedia.map((item) =>
        normalizeMediaRow(req, {
          id: item.id,
          type: item.type,
          url: item.url,
          name: item.name,
          duration: item.duration || 10,
        }),
      );

      res.json({
        screen: {
          id: screen.id,
          name: screen.name,
          deviceId: screen.deviceId,
        },
        content,
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch content" });
    }
  });

  // Template Routes
  app.get("/api/templates", async (_req, res) => {
    try {
      const allTemplates = await storage.getAllTemplates();
      res.json(allTemplates);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch templates" });
    }
  });

  app.post("/api/templates", async (req, res) => {
    try {
      const templateData = insertTemplateSchema.parse(req.body);
      const template = await storage.createTemplate(templateData);
      res.status(201).json(template);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      res.status(500).json({ error: "Failed to create template" });
    }
  });

  app.get("/api/templates/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const template = await storage.getTemplate(id);
      if (!template) {
        return res.status(404).json({ error: "Template not found" });
      }
      res.json(template);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch template" });
    }
  });

  // ── GET /api/templates/:id/render ─────────────────────────────────────────
  // Self-contained HTML renderer for Android WebView template playback.
  // PUBLIC — no auth required (Android WebView cannot send JWT headers).
// ── GET /api/templates/:id/render ──────────────────────────────────────────
// Self-contained HTML renderer for Android WebView template playback.
// PUBLIC — no auth required (Android WebView cannot send JWT headers).
//
// Supported element types:
//   image, video, text, clock, date, rss, ticker, playlist, weather, stocks
//
// RSS/ticker data is fetched SERVER-SIDE via /api/rss-proxy to avoid
// CORS and Samsung WebView compatibility issues with third-party proxies.

app.get("/api/templates/:id/render", async (req, res) => {
  try {
    const { id } = req.params;
    const template = await storage.getTemplate(id);
    if (!template) return res.status(404).send("<h1>Template not found</h1>");

    const elements: any[] = template.elements || (template as any).layout?.elements || [];
    const bg = (template as any).background || (template as any).layout?.background || "#0f1117";
    const w = (template as any).width  || 1920;
    const h = (template as any).height || 1080;

    // Build the backend base URL for server-side proxy calls from the rendered page
    const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
    const host  = (req.headers["x-forwarded-host"] as string || req.get("host") || "").split(",")[0].trim();
    const backendBase = `${proto}://${host}`;

    const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${template.name || "Template"}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100vw;height:100vh;background:${bg};overflow:hidden;font-family:'Inter','Segoe UI',sans-serif}
#canvas{position:absolute;inset:0}
.zone{position:absolute;overflow:hidden}
/* Images & video */
.zone img,.zone video{width:100%;height:100%;object-fit:cover}
/* Text */
.text-zone{display:flex;align-items:center;justify-content:center;padding:8px}
/* Clock / Date */
.center-zone{width:100%;height:100%;display:flex;align-items:center;justify-content:center}
/* RSS card list */
.rss-wrap{width:100%;height:100%;overflow:hidden;padding:10px 12px;display:flex;flex-direction:column;gap:0}
.rss-header{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;opacity:.6;margin-bottom:8px;display:flex;align-items:center;gap:6px}
.rss-header-dot{width:6px;height:6px;border-radius:50%;background:#4ade80;display:inline-block}
.rss-items{flex:1;overflow:hidden;display:flex;flex-direction:column;gap:0}
.rss-item{padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.07);overflow:hidden;display:flex;align-items:flex-start;gap:8px;flex-shrink:0}
.rss-item-bullet{color:#4ade80;flex-shrink:0;margin-top:2px}
.rss-item-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
/* Ticker */
.ticker-outer{width:100%;height:100%;display:flex;align-items:center;overflow:hidden;position:relative}
.ticker-label{flex-shrink:0;font-weight:700;padding:0 12px;height:100%;display:flex;align-items:center;font-size:.85em;letter-spacing:.05em;text-transform:uppercase}
.ticker-track{flex:1;overflow:hidden;position:relative;height:100%}
.ticker-inner{white-space:nowrap;position:absolute;top:50%;transform:translateY(-50%);will-change:transform}
@keyframes tickerL{from{transform:translateY(-50%) translateX(100vw)}to{transform:translateY(-50%) translateX(-100%)}}
@keyframes tickerR{from{transform:translateY(-50%) translateX(-100%)}to{transform:translateY(-50%) translateX(100vw)}}
/* Stocks */
.stocks-wrap{width:100%;height:100%;overflow:hidden;padding:8px 10px;display:flex;flex-direction:column;gap:4px}
.stocks-header{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;opacity:.5;margin-bottom:4px}
.stock-row{display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.06)}
.stock-sym{font-weight:700;letter-spacing:.04em}
.stock-price{font-variant-numeric:tabular-nums}
.stock-chg{font-size:.85em;padding:1px 5px;border-radius:3px;font-variant-numeric:tabular-nums}
.up{color:#4ade80;background:rgba(74,222,128,.12)}
.dn{color:#f87171;background:rgba(248,113,113,.12)}
/* Playlist zone */
.playlist-zone{width:100%;height:100%;position:relative;background:#000}
.playlist-zone img,.playlist-zone video{position:absolute;inset:0;width:100%;height:100%}
/* Weather */
.weather-wrap{width:100%;height:100%;overflow:hidden;padding:10px;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:4px}
.weather-icon{font-size:3em;line-height:1}
.weather-temp{font-size:2.2em;font-weight:700}
.weather-desc{font-size:.9em;opacity:.7;text-transform:capitalize}
.weather-loc{font-size:.75em;opacity:.5;margin-top:2px}
/* Fade-in animation for content */
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
.fade-in{animation:fadeIn .4s ease}
</style>
</head><body>
<div id="canvas"></div>
<script>
'use strict';
const CANVAS_W=${w}, CANVAS_H=${h};
const BACKEND='${backendBase}';
const elements=${JSON.stringify(elements)};

// ── Curated feed presets ────────────────────────────────────────────────────
const FEED_PRESETS = {
  // International News
  'bbc_world':    { label:'BBC World News',   url:'https://feeds.bbci.co.uk/news/world/rss.xml' },
  'bbc_tech':     { label:'BBC Technology',   url:'https://feeds.bbci.co.uk/news/technology/rss.xml' },
  'reuters_world':{ label:'Reuters World',    url:'https://feeds.reuters.com/reuters/worldNews' },
  'reuters_biz':  { label:'Reuters Business', url:'https://feeds.reuters.com/reuters/businessNews' },
  'aljazeera':    { label:'Al Jazeera',       url:'https://www.aljazeera.com/xml/rss/all.xml' },
  'ap_top':       { label:'AP Top News',      url:'https://rsshub.app/apnews/topics/ap-top-news' },
  // Tech
  'techcrunch':   { label:'TechCrunch',       url:'https://techcrunch.com/feed/' },
  'verge':        { label:'The Verge',        url:'https://www.theverge.com/rss/index.xml' },
  'hackernews':   { label:'Hacker News',      url:'https://hnrss.org/frontpage' },
  // Business & Finance
  'ft':           { label:'Financial Times',  url:'https://www.ft.com/rss/home/uk' },
  'cnbc_top':     { label:'CNBC Top News',    url:'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
  'bloomberg':    { label:'Bloomberg Markets', url:'https://feeds.bloomberg.com/markets/news.rss' },
  // MENA / Arabic
  'mamlaka':      { label:'Mamlaka TV',         url:'https://www.almamlakatv.com/feed.xml' },
  'aljazeera_ar': { label:'Al Jazeera Arabic',  url:'https://www.aljazeera.net/xml/rss/all.xml' },
  'bbc_arabic':   { label:'BBC Arabic',         url:'https://feeds.bbci.co.uk/arabic/rss.xml' },
  'france24_ar':  { label:'France 24 Arabic',   url:'https://www.france24.com/ar/rss' },
  // Sports
  'bbc_sport':    { label:'BBC Sport',        url:'https://feeds.bbci.co.uk/sport/rss.xml' },
  'espn':         { label:'ESPN Headlines',   url:'https://www.espn.com/espn/rss/news' },
};

// ── Embed widget presets (third-party iframes) ──────────────────────────────
const EMBED_PRESETS = {
  'arabiaweather_amman': { label:'Arabia Weather — Amman',  url:'http://widgets.media.devops.arabiaweather.com/widget/DAN' },
  'arabiaweather_doha':  { label:'Arabia Weather — Doha',   url:'https://widgets.media.devops.arabiaweather.com/widget/DAN-DOHA' },
  'equiti_ticker':       { label:'Equiti Price Ticker',      url:'https://www.equiti.com/price-ticker/' },
};

// ── Scale helper ────────────────────────────────────────────────────────────
function sp(el) {
  const sx = window.innerWidth  / CANVAS_W;
  const sy = window.innerHeight / CANVAS_H;
  return { l: el.x*sx, t: el.y*sy, w: (el.w||200)*sx, h: (el.h||100)*sy, sx, sy };
}

// ── RSS fetch via backend proxy (avoids CORS + WebView issues) ──────────────
async function fetchRss(url, max) {
  if (!url) return [];
  try {
    const r = await fetch(BACKEND + '/api/rss-proxy?url=' + encodeURIComponent(url),
      { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.items || []).slice(0, max || 8).map(i => i.title).filter(Boolean);
  } catch { return []; }
}

// ── Resolve feed URL from preset or custom ──────────────────────────────────
function resolveFeedUrl(el, urlField) {
  const preset = el.feedPreset || el.rssPreset || el.tickerPreset;
  if (preset && FEED_PRESETS[preset]) return FEED_PRESETS[preset].url;
  return el[urlField] || '';
}

// ── Zone factory ────────────────────────────────────────────────────────────
async function renderEl(el) {
  const p   = sp(el);
  const div = document.createElement('div');
  div.className = 'zone';
  div.style.cssText = [
    'left:'   + p.l + 'px',
    'top:'    + p.t + 'px',
    'width:'  + p.w + 'px',
    'height:' + p.h + 'px',
    el.borderRadius ? 'border-radius:' + (el.borderRadius * p.sx) + 'px' : '',
    el.zIndex != null ? 'z-index:' + el.zIndex : (el.z != null ? 'z-index:' + el.z : ''),
    el.bgColor && el.type !== 'ticker' ? 'background:' + el.bgColor : '',
    el.opacity != null ? 'opacity:' + el.opacity : '',
    el.shadow ? 'box-shadow:0 4px 24px rgba(0,0,0,.4)' : '',
  ].filter(Boolean).join(';') + ';';

  const type = el.type || 'text';

  // ── IMAGE ─────────────────────────────────────────────────────────────────
  if (type === 'image') {
    if (!el.url) { div.style.background = '#1a1a2e'; return div; }
    const img = document.createElement('img');
    img.src = el.url;
    img.style.objectFit = el.fit || 'cover';
    img.className = 'fade-in';
    div.appendChild(img);
  }

  // ── VIDEO ─────────────────────────────────────────────────────────────────
  else if (type === 'video') {
    if (!el.url) { div.style.background = '#000'; return div; }
    const v = document.createElement('video');
    v.src = el.url; v.autoplay = true; v.muted = true; v.loop = true; v.playsInline = true;
    v.style.objectFit = el.fit || 'cover';
    div.appendChild(v);
  }

  // ── TEXT ──────────────────────────────────────────────────────────────────
  else if (type === 'text') {
    div.classList.add('text-zone');
    div.style.background = el.bgColor || 'transparent';
    const s = document.createElement('span');
    s.textContent = el.text || '';
    s.style.cssText = [
      'color:' + (el.color || '#fff'),
      'font-size:' + ((el.fontSize || 24) * p.sx) + 'px',
      'font-family:' + (el.fontFamily || 'Inter'),
      'font-weight:' + (el.fontWeight || (el.bold ? 700 : 400)),
      'font-style:' + (el.italic ? 'italic' : 'normal'),
      'text-decoration:' + (el.underline ? 'underline' : 'none'),
      'text-align:' + (el.textAlign || el.align || 'center'),
      'white-space:pre-wrap',
      'word-break:break-word',
      'width:100%',
      el.lineHeight ? 'line-height:' + el.lineHeight : '',
      el.letterSpacing ? 'letter-spacing:' + el.letterSpacing + 'em' : '',
    ].filter(Boolean).join(';');
    div.appendChild(s);
  }

  // ── CLOCK ─────────────────────────────────────────────────────────────────
  else if (type === 'clock') {
    div.style.background = el.bgColor || 'rgba(15,23,42,0.8)';
    div.style.borderRadius = ((el.borderRadius || 4) * p.sx) + 'px';
    const c = document.createElement('div');
    c.className = 'center-zone';
    const s = document.createElement('span');
    s.style.cssText = 'color:' + (el.color || '#fff') + ';font-size:' + ((el.fontSize || 48) * p.sx) + 'px;font-family:' + (el.fontFamily || 'Inter') + ';font-weight:700;font-variant-numeric:tabular-nums';
    const fmt = el.format || 'HH:mm';
    function tick() {
      const n = new Date(); const pad = x => String(x).padStart(2,'0');
      let t = fmt.replace('HH',pad(n.getHours())).replace('mm',pad(n.getMinutes())).replace('ss',pad(n.getSeconds()));
      if (fmt.includes('hh')) {
        const h12 = n.getHours() % 12 || 12;
        t = t.replace('hh', pad(h12)).replace('A', n.getHours() < 12 ? 'AM' : 'PM');
      }
      s.textContent = t;
    }
    tick(); setInterval(tick, 1000);
    c.appendChild(s); div.appendChild(c);
  }

  // ── DATE ──────────────────────────────────────────────────────────────────
  else if (type === 'date') {
    div.style.background = el.bgColor || 'rgba(15,23,42,0.8)';
    const MONTHS_LONG  = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const DAYS_LONG    = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const DAYS_SHORT   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const c = document.createElement('div'); c.className = 'center-zone';
    const s = document.createElement('span');
    s.style.cssText = 'color:' + (el.color || '#fff') + ';font-size:' + ((el.fontSize || 32) * p.sx) + 'px;font-family:' + (el.fontFamily || 'Inter') + ';font-weight:600;text-align:center';
    const n = new Date(); const pad = x => String(x).padStart(2,'0');
    s.textContent = (el.format || 'MMMM DD, YYYY')
      .replace('DDDD', DAYS_LONG[n.getDay()])
      .replace('DDD',  DAYS_SHORT[n.getDay()])
      .replace('MMMM', MONTHS_LONG[n.getMonth()])
      .replace('MMM',  MONTHS_SHORT[n.getMonth()])
      .replace('YYYY', n.getFullYear())
      .replace('MM',   pad(n.getMonth() + 1))
      .replace('DD',   pad(n.getDate()));
    c.appendChild(s); div.appendChild(c);
  }

  // ── RSS CARD LIST ─────────────────────────────────────────────────────────
  else if (type === 'rss') {
    div.style.background = el.bgColor || 'rgba(10,15,30,0.92)';
    div.style.border      = '1px solid rgba(74,222,128,0.12)';
    div.style.borderRadius = ((el.borderRadius || 6) * p.sx) + 'px';
    const wrap = document.createElement('div'); wrap.className = 'rss-wrap';

    // Header row
    const hdr = document.createElement('div'); hdr.className = 'rss-header';
    hdr.style.color = el.headerColor || '#4ade80';
    hdr.style.fontSize = (10 * p.sx) + 'px';
    const dot = document.createElement('span'); dot.className = 'rss-header-dot';
    dot.style.background = el.headerColor || '#4ade80';
    hdr.appendChild(dot);
    const feedUrl = resolveFeedUrl(el, 'rssUrl');
    const presetLabel = (el.feedPreset && FEED_PRESETS[el.feedPreset]) ? FEED_PRESETS[el.feedPreset].label : (el.rssLabel || 'Live Feed');
    hdr.appendChild(document.createTextNode(' ' + presetLabel.toUpperCase()));
    wrap.appendChild(hdr);

    // Items container
    const listEl = document.createElement('div'); listEl.className = 'rss-items';
    wrap.appendChild(listEl);
    div.appendChild(wrap);

    // Async fill
    if (feedUrl) {
      fetchRss(feedUrl, el.rssMaxItems || 6).then(headlines => {
        listEl.innerHTML = '';
        if (!headlines.length) {
          listEl.innerHTML = '<div style="opacity:.4;font-size:' + (12*p.sx) + 'px;padding:8px 0">No headlines available</div>';
          return;
        }
        headlines.forEach(h => {
          const item = document.createElement('div'); item.className = 'rss-item fade-in';
          item.style.fontSize = ((el.fontSize || 13) * p.sx) + 'px';
          item.style.color = el.color || 'rgba(255,255,255,0.88)';
          const bullet = document.createElement('span'); bullet.className = 'rss-item-bullet';
          bullet.style.color = el.headerColor || '#4ade80';
          bullet.textContent = '›';
          const text = document.createElement('span'); text.className = 'rss-item-text';
          text.textContent = h;
          item.appendChild(bullet); item.appendChild(text);
          listEl.appendChild(item);
        });
      });
    } else {
      listEl.innerHTML = '<div style="opacity:.35;font-size:' + (12*p.sx) + 'px;padding:8px 0">Configure RSS URL in template designer</div>';
    }

    // Auto-refresh every 5 minutes
    setInterval(() => {
      if (!feedUrl) return;
      fetchRss(feedUrl, el.rssMaxItems || 6).then(headlines => {
        if (!headlines.length) return;
        listEl.innerHTML = '';
        headlines.forEach(h => {
          const item = document.createElement('div'); item.className = 'rss-item fade-in';
          item.style.fontSize = ((el.fontSize || 13) * p.sx) + 'px';
          item.style.color = el.color || 'rgba(255,255,255,0.88)';
          const bullet = document.createElement('span'); bullet.className = 'rss-item-bullet';
          bullet.style.color = el.headerColor || '#4ade80'; bullet.textContent = '›';
          const text = document.createElement('span'); text.className = 'rss-item-text'; text.textContent = h;
          item.appendChild(bullet); item.appendChild(text); listEl.appendChild(item);
        });
      });
    }, 5 * 60 * 1000);
  }

  // ── TICKER ────────────────────────────────────────────────────────────────
  else if (type === 'ticker') {
    div.style.background = el.tickerBg || '#0f172a';
    const outer = document.createElement('div'); outer.className = 'ticker-outer';

    // Optional label badge
    const labelText = el.tickerLabel || (el.feedPreset && FEED_PRESETS[el.feedPreset] ? FEED_PRESETS[el.feedPreset].label : null);
    if (labelText) {
      const label = document.createElement('div'); label.className = 'ticker-label';
      label.style.cssText = 'background:' + (el.tickerColor || '#4ade80') + ';color:#000;font-size:' + (11 * p.sx) + 'px';
      label.textContent = labelText;
      outer.appendChild(label);
    }

    const track = document.createElement('div'); track.className = 'ticker-track';
    const inner = document.createElement('div'); inner.className = 'ticker-inner';
    inner.style.cssText = 'color:' + (el.tickerColor || '#fff') + ';font-size:' + ((el.fontSize || 20) * p.sx) + 'px;font-family:' + (el.fontFamily || 'Inter');
    track.appendChild(inner); outer.appendChild(track); div.appendChild(outer);

    async function startTicker() {
      let text = el.tickerText || '';
      const feedUrl = resolveFeedUrl(el, 'tickerRssUrl');
      if (feedUrl) {
        const items = await fetchRss(feedUrl, el.tickerItems || 20);
        if (items.length) text = items.join('   \u00B7   ');
      }
      if (!text) text = 'No ticker content — configure RSS URL or text in template designer';
      inner.textContent = text;

      // Calculate animation duration based on text length and speed
      const speed = (el.tickerSpeed || 80) * p.sx; // px/sec
      const trackW = track.offsetWidth || p.w;
      const textW  = inner.scrollWidth || text.length * ((el.fontSize || 20) * p.sx * 0.6);
      const totalDist = trackW + textW;
      const dur = totalDist / speed;
      const dir = el.tickerDirection === 'right' ? 'tickerR' : 'tickerL';
      inner.style.animationName = dir;
      inner.style.animationDuration = dur + 's';
      inner.style.animationTimingFunction = 'linear';
      inner.style.animationIterationCount = 'infinite';
    }

    startTicker();
    // Refresh ticker content every 10 minutes
    setInterval(startTicker, 10 * 60 * 1000);
  }

  // ── PLAYLIST ZONE ─────────────────────────────────────────────────────────
  else if (type === 'playlist') {
    div.style.background = '#000';
    const pWrap = document.createElement('div'); pWrap.className = 'playlist-zone';
    div.appendChild(pWrap);

    const items = (el.playlistItems || []).filter(i => i.url || i.mediaUrl);
    if (!items.length) {
      pWrap.innerHTML = '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,.25);font-size:' + (14*p.sx) + 'px">No playlist items</div>';
    } else {
      let idx = 0;
      let timer = null;

      function playItem(i) {
        pWrap.innerHTML = '';
        const item = items[i];
        const url  = item.url || item.mediaUrl || '';
        const mtype = (item.type || item.mediaType || '').toLowerCase();
        const dur  = (item.duration || 10) * 1000;

        if (mtype === 'video' || /\\.mp4|webm|ogg/i.test(url)) {
          const v = document.createElement('video');
          v.src = url; v.autoplay = true; v.muted = !item.volume || item.volume === 0; v.playsInline = true;
          v.style.objectFit = el.fit || 'cover';
          v.className = 'fade-in';
          v.onended = () => advance();
          v.onerror = () => { if (timer) clearTimeout(timer); advance(); };
          pWrap.appendChild(v);
          // Fallback timer in case video doesn't end (e.g. looping source)
          timer = setTimeout(advance, dur + 2000);
        } else {
          const img = document.createElement('img');
          img.src = url;
          img.style.objectFit = el.fit || 'cover';
          img.className = 'fade-in';
          pWrap.appendChild(img);
          timer = setTimeout(advance, dur);
        }
      }

      function advance() {
        if (timer) clearTimeout(timer);
        idx = (idx + 1) % items.length;
        if (!el.playlistLoop && idx === 0) return; // stop if no loop
        playItem(idx);
      }

      if (el.playlistAutoplay !== false) playItem(0);
    }
  }

  // ── WEATHER ───────────────────────────────────────────────────────────────
  else if (type === 'weather') {
    div.style.background = el.bgColor || 'rgba(10,15,35,0.9)';
    div.style.borderRadius = ((el.borderRadius || 8) * p.sx) + 'px';
    const wrap = document.createElement('div'); wrap.className = 'weather-wrap';

    const lat  = el.weatherLat  || 31.9454; // default: Amman
    const lon  = el.weatherLon  || 35.9284;
    const unit = el.weatherUnit || 'C';
    const loc  = el.weatherLocation || 'Your Location';

    wrap.innerHTML = '<div class="weather-icon" style="font-size:' + (48*p.sy) + 'px">⛅</div>'
      + '<div class="weather-temp" style="color:' + (el.color||'#fff') + ';font-size:' + (48*p.sy) + 'px">--°' + unit + '</div>'
      + '<div class="weather-desc" style="color:' + (el.color||'rgba(255,255,255,.7)') + ';font-size:' + (16*p.sy) + 'px">Loading...</div>'
      + '<div class="weather-loc" style="color:rgba(255,255,255,.4);font-size:' + (12*p.sy) + 'px">' + loc + '</div>';

    const apiUnit = unit === 'F' ? 'imperial' : 'metric';
    const wUrl = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon + '&current_weather=true&temperature_unit=' + (unit==='F'?'fahrenheit':'celsius');
    fetch(wUrl, { signal: AbortSignal.timeout(8000) }).then(r => r.json()).then(d => {
      const cw = d.current_weather;
      if (!cw) return;
      const WMO = {0:'☀️',1:'🌤',2:'⛅',3:'☁️',45:'🌫',48:'🌫',51:'🌦',53:'🌧',55:'🌧',61:'🌧',63:'🌧',65:'🌧',71:'🌨',73:'🌨',75:'🌨',80:'🌦',81:'🌧',82:'🌧',95:'⛈',96:'⛈',99:'⛈'};
      const icon = WMO[cw.weathercode] || '🌡️';
      const temp = Math.round(cw.temperature);
      wrap.children[0].textContent = icon;
      wrap.children[1].textContent = temp + '°' + unit;
      wrap.children[2].textContent = cw.is_day ? 'Clear' : 'Night';
    }).catch(() => {});

    div.appendChild(wrap);
  }

  // ── STOCKS / FINANCIAL TICKER ─────────────────────────────────────────────
  else if (type === 'stocks') {
    div.style.background = el.bgColor || 'rgba(5,10,25,0.95)';
    div.style.borderRadius = ((el.borderRadius || 4) * p.sx) + 'px';
    const wrap = document.createElement('div'); wrap.className = 'stocks-wrap';

    const symbols = el.stockSymbols || ['BTC', 'ETH', 'AAPL', 'MSFT', 'TSLA'];
    const hdr = document.createElement('div'); hdr.className = 'stocks-header';
    hdr.style.cssText = 'color:rgba(255,255,255,.4);font-size:' + (9*p.sy) + 'px';
    hdr.textContent = (el.stocksLabel || 'MARKET DATA').toUpperCase();
    wrap.appendChild(hdr);

    // Use Yahoo Finance unofficial endpoint via backend proxy
    symbols.forEach(sym => {
      const row = document.createElement('div'); row.className = 'stock-row';
      row.style.fontSize = ((el.fontSize || 14) * p.sy) + 'px';
      const s = document.createElement('span'); s.className = 'stock-sym'; s.style.color = el.color || '#fff'; s.textContent = sym;
      const price = document.createElement('span'); price.className = 'stock-price'; price.style.color = el.color || '#fff'; price.textContent = '--';
      const chg = document.createElement('span'); chg.className = 'stock-chg up'; chg.textContent = '--';
      row.appendChild(s); row.appendChild(price); row.appendChild(chg);
      wrap.appendChild(row);

      // Fetch via backend proxy
      fetch(BACKEND + '/api/stocks-proxy?symbol=' + encodeURIComponent(sym), { signal: AbortSignal.timeout(6000) })
        .then(r => r.json())
        .then(d => {
          if (d.price != null) { price.textContent = d.price; }
          if (d.change != null) {
            const up = parseFloat(d.change) >= 0;
            chg.className = 'stock-chg ' + (up ? 'up' : 'dn');
            chg.textContent = (up ? '+' : '') + d.change + '%';
          }
        }).catch(() => {});
    });

    // Refresh every 60 seconds
    setInterval(() => location.reload(), 60 * 1000);
    div.appendChild(wrap);
  }

  // ── EMBED (iframe) ───────────────────────────────────────────────────────
  // For third-party widgets: Arabia Weather, Equiti price ticker, etc.
  // Renders the URL in a sandboxed iframe — always live, no scraping needed.
  else if (type === 'embed') {
    const embedPreset = el.embedPreset && EMBED_PRESETS[el.embedPreset];
    const src = (embedPreset ? embedPreset.url : null) || el.embedUrl || el.url || '';
    if (!src) {
      div.style.background = 'rgba(255,255,255,.05)';
      div.innerHTML = '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,.3);font-size:' + (13*p.sx) + 'px">Set embed URL in designer</div>';
    } else {
      const frame = document.createElement('iframe');
      frame.src = src;
      frame.style.cssText = 'width:100%;height:100%;border:none;display:block;';
      // Scale the iframe content if the zone is smaller than the widget's native size
      if (el.embedScale && el.embedScale !== 1) {
        frame.style.transformOrigin = 'top left';
        frame.style.transform = 'scale(' + el.embedScale + ')';
        frame.style.width = (100 / el.embedScale) + '%';
        frame.style.height = (100 / el.embedScale) + '%';
      }
      frame.setAttribute('scrolling', el.embedScroll ? 'yes' : 'no');
      frame.setAttribute('frameborder', '0');
      frame.setAttribute('allowtransparency', 'true');
      // Allow all features needed by weather/finance widgets
      frame.setAttribute('allow', 'geolocation; autoplay; fullscreen');
      div.appendChild(frame);
    }
  }

  // ── UNKNOWN ───────────────────────────────────────────────────────────────
  else {
    div.style.background = 'rgba(255,0,0,.1)';
    div.style.border = '1px dashed rgba(255,0,0,.3)';
    div.innerHTML = '<div style="color:rgba(255,255,255,.3);font-size:11px;padding:8px">Unknown zone type: ' + type + '</div>';
  }

  return div;
}

// ── Main init ────────────────────────────────────────────────────────────────
(async () => {
  const canvas = document.getElementById('canvas');
  const sorted = [...elements].sort((a, b) =>
    (a.z != null ? a.z : a.zIndex || 0) - (b.z != null ? b.z : b.zIndex || 0)
  );
  for (const el of sorted) {
    const zone = await renderEl(el);
    canvas.appendChild(zone);
  }
})();

// ── Auto-reload every 5 minutes to refresh all content ──────────────────────
setTimeout(() => location.reload(), 5 * 60 * 1000);
</script>
</body></html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Content-Security-Policy",
      "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; " +
      "script-src * 'unsafe-inline' 'unsafe-eval'; " +
      "style-src * 'unsafe-inline'; " +
      "img-src * data: blob:; " +
      "media-src * blob:; " +
      "connect-src *;"
    );
    return res.send(html);
  } catch (err) {
    console.error("Template render error:", err);
    return res.status(500).send("<h1>Template render failed</h1>");
  }
});

// ── GET /api/stocks-proxy?symbol=AAPL ──────────────────────────────────────
// Server-side stock price fetch — avoids CORS from device WebView.
// Uses Yahoo Finance unofficial quote endpoint (no API key needed).
app.get("/api/stocks-proxy", async (req: Request, res: Response) => {
  const { symbol } = req.query;
  if (!symbol || typeof symbol !== "string") {
    return res.status(400).json({ error: "symbol is required" });
  }
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return res.status(502).json({ error: "upstream_failed" });
    const d: any = await r.json();
    const meta = d?.chart?.result?.[0]?.meta;
    if (!meta) return res.status(502).json({ error: "no_data" });
    const price  = meta.regularMarketPrice?.toFixed(2) ?? null;
    const prev   = meta.chartPreviousClose ?? meta.previousClose ?? null;
    const change = price && prev ? (((parseFloat(price) - prev) / prev) * 100).toFixed(2) : null;
    res.json({ symbol: symbol.toUpperCase(), price, change, currency: meta.currency || "USD" });
  } catch {
    res.status(504).json({ error: "timeout" });
  }
});

  app.patch("/api/templates/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const { name, layout } = req.body;
      const template = await storage.updateTemplate(id, { name, layout });
      if (!template) {
        return res.status(404).json({ error: "Template not found" });
      }
      res.json(template);
    } catch (error) {
      res.status(500).json({ error: "Failed to update template" });
    }
  });

  // Full template update (for auto-save)
  app.put("/api/templates/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const { name, orientation, elements, background, watermark } = req.body;
      
      // Store in both layout (for backwards compatibility) and direct columns
      const layout = {
        orientation,
        elements,
        background,
        watermark,
      };
      
      const template = await storage.updateTemplate(id, { 
        name, 
        layout,
        orientation,
        elements,
        background,
        watermark
      });
      if (!template) {
        return res.status(404).json({ error: "Template not found" });
      }
      res.json(template);
    } catch (error) {
      console.error("Template update error:", error);
      res.status(500).json({ error: "Failed to update template" });
    }
  });

  // Update template layout
  app.put("/api/templates/:templateId/layout", async (req, res) => {
    try {
      const { templateId } = req.params;
      const { layout } = req.body;
      const template = await storage.updateTemplate(templateId, { layout });
      if (!template) {
        return res.status(404).json({ error: "Template not found" });
      }
      res.json(template);
    } catch (error) {
      res.status(500).json({ error: "Failed to update layout" });
    }
  });

  // Get template layout
  app.get("/api/templates/:templateId/layout", async (req, res) => {
    try {
      const { templateId } = req.params;
      const template = await storage.getTemplate(templateId);
      if (!template) {
        return res.status(404).json({ error: "Template not found" });
      }
      res.json(template.layout);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch layout" });
    }
  });

  app.delete("/api/templates/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const deleted = await storage.deleteTemplate(id);
      if (!deleted) {
        return res.status(404).json({ error: "Template not found" });
      }
      res.json({ message: "Template deleted" });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete template" });
    }
  });

  // Template Playlist Items Routes
  app.get("/api/templates/:templateId/playlist", async (req, res) => {
    try {
      const { templateId } = req.params;
      const items = await storage.getTemplatePlaylistItems(templateId);
      res.json(items);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch playlist" });
    }
  });

  app.post("/api/templates/:templateId/playlist", async (req, res) => {
    try {
      const { templateId } = req.params;
      const { contentType, contentUrl, orderIndex } = req.body;
      const item = await storage.createTemplatePlaylistItem({
        templateId,
        contentType,
        contentUrl,
        orderIndex: orderIndex || 0,
      });
      res.status(201).json(item);
    } catch (error) {
      res.status(500).json({ error: "Failed to add playlist item" });
    }
  });

  app.put("/api/templates/:templateId/playlist", async (req, res) => {
    try {
      const { updates } = req.body;
      for (const u of updates) {
        await storage.updateTemplatePlaylistItemOrder(u.id, u.order_index);
      }
      res.json({ message: "Playlist updated" });
    } catch (error) {
      res.status(500).json({ error: "Failed to update playlist" });
    }
  });

  app.delete("/api/templates/playlist/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const deleted = await storage.deleteTemplatePlaylistItem(id);
      if (!deleted) {
        return res.status(404).json({ error: "Playlist item not found" });
      }
      res.json({ message: "Deleted" });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete playlist item" });
    }
  });

  // Groups Routes
  app.get("/api/groups", async (_req, res) => {
    try {
      const allGroups = await storage.getAllGroups();
      res.json(allGroups);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch groups" });
    }
  });

  app.get("/api/groups-with-counts", async (_req, res) => {
    try {
      const result = await pool.query(`
        WITH RECURSIVE group_descendants AS (
          SELECT id, id as root_id FROM device_groups
          UNION ALL
          SELECT dg.id, gd.root_id
          FROM device_groups dg
          JOIN group_descendants gd ON dg.parent_id::text = gd.id::text
        ),
        device_counts AS (
          SELECT 
            gd.root_id as group_id,
            COUNT(DISTINCT dgm.device_id) as total_count
          FROM group_descendants gd
          LEFT JOIN device_group_map dgm ON gd.id::text = dgm.group_id::text
          GROUP BY gd.root_id
        )
        SELECT 
          dg.*,
          COALESCE(dc.total_count, 0)::int as device_count
        FROM device_groups dg
        LEFT JOIN device_counts dc ON dg.id = dc.group_id
        ORDER BY dg.name
      `);
      res.json(result.rows);
    } catch (error) {
      console.error("Get groups with counts error:", error);
      res.status(500).json({ error: "Failed to fetch groups" });
    }
  });

  app.post("/api/groups/:id/icon/clear", requireRole("admin"), async (req, res) => {
    try {
      const { id } = req.params;
      await storage.updateGroupIcon(id, null as any);
      res.json({ success: true });
    } catch (error) {
      console.error("Clear group icon error:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.post("/api/groups", requireRole("admin"), async (req, res) => {
    try {
      const { name, icon_url, parentId: rawParentId } = req.body;

      if (!name) {
        return res.status(400).json({ error: "Name required" });
      }

      // Parse parentId - handle jsTree node IDs like 'group_xxx' or 'root-pdn'
      let parentId: string | null = null;
      if (rawParentId && rawParentId !== "root-pdn" && rawParentId !== "#") {
        parentId = rawParentId.replace("group_", "");
      }

      // Check for duplicate name under same parent (case-insensitive, IS NOT DISTINCT FROM for NULL handling)
      const existingGroup = await storage.getGroupByNameAndParent(
        name,
        parentId,
      );
      if (existingGroup) {
        return res
          .status(400)
          .json({
            error: "A group with this name already exists in this folder.",
          });
      }

      const group = await storage.createGroup({
        name,
        iconUrl: icon_url,
        parentId,
      });
      res.json(group);
    } catch (error) {
      console.error("create group error", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.get("/api/groups/:groupId/devices", async (req, res) => {
    try {
      const { groupId } = req.params;
      const result = await pool.query(
        `SELECT s.device_id, s.name, s.location, s.status, s.last_seen,
                s.is_online, s.temperature, s.free_storage, s.signal_strength,
                s.current_content as current_content_id
         FROM device_group_map dgm
         JOIN screens s ON dgm.device_id = s.device_id
         WHERE dgm.group_id = $1`,
        [groupId]
      );
      res.json(result.rows);
    } catch (error) {
      console.error("Get group devices error:", error);
      res.status(500).json({ error: "Failed to get group devices" });
    }
  });

  app.delete("/api/groups/:groupId/devices/:deviceId", requireRole("admin"), async (req, res) => {
    try {
      const { groupId, deviceId } = req.params;
      await pool.query(
        `DELETE FROM device_group_map WHERE group_id = $1 AND device_id = $2`,
        [groupId, deviceId]
      );
      res.json({ success: true });
    } catch (error) {
      console.error("Remove device from group error:", error);
      res.status(500).json({ error: "Failed to remove device from group" });
    }
  });

  app.get("/api/device-groups", async (_req, res) => {
    try {
      const result = await pool.query(
        `SELECT dg.*, 
                COALESCE((SELECT COUNT(*) FROM device_group_map dgm WHERE dgm.group_id = dg.id), 0)::int as device_count,
                COALESCE((SELECT COUNT(*) FROM device_groups child WHERE child.parent_id = dg.id), 0)::int as subgroup_count
         FROM device_groups dg
         WHERE dg.parent_id IS NULL
         ORDER BY dg.name`
      );
      res.json(result.rows);
    } catch (error) {
      console.error("Get root device groups error:", error);
      res.status(500).json({ error: "Failed to get device groups" });
    }
  });

  app.get("/api/groups/:groupId/subgroups", async (req, res) => {
    try {
      const { groupId } = req.params;
      const result = await pool.query(
        `SELECT dg.*, 
                COALESCE((SELECT COUNT(*) FROM device_group_map dgm WHERE dgm.group_id = dg.id), 0)::int as device_count,
                COALESCE((SELECT COUNT(*) FROM device_groups child WHERE child.parent_id = dg.id::text), 0)::int as subgroup_count
         FROM device_groups dg
         WHERE dg.parent_id = $1
         ORDER BY dg.name`,
        [groupId]
      );
      res.json(result.rows);
    } catch (error) {
      console.error("Get subgroups error:", error);
      res.status(500).json({ error: "Failed to get subgroups" });
    }
  });

  app.get("/api/groups/:groupId", async (req, res) => {
    try {
      const { groupId } = req.params;
      const result = await pool.query(
        `SELECT dg.*, 
                COALESCE((SELECT COUNT(*) FROM device_group_map dgm WHERE dgm.group_id = dg.id), 0)::int as device_count
         FROM device_groups dg
         WHERE dg.id::text = $1`,
        [groupId]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Group not found" });
      }
      res.json(result.rows[0]);
    } catch (error) {
      console.error("Get group error:", error);
      res.status(500).json({ error: "Failed to get group" });
    }
  });

  app.get("/api/groups/:groupId/path", async (req, res) => {
    try {
      const { groupId } = req.params;
      const result = await pool.query(
        `WITH RECURSIVE group_path AS (
          SELECT id, name, parent_id, 1 as depth
          FROM device_groups
          WHERE id::text = $1
          UNION ALL
          SELECT dg.id, dg.name, dg.parent_id, gp.depth + 1
          FROM device_groups dg
          JOIN group_path gp ON dg.id::text = gp.parent_id
        )
        SELECT id, name FROM group_path ORDER BY depth DESC`,
        [groupId]
      );
      res.json(result.rows);
    } catch (error) {
      console.error("Get group path error:", error);
      res.status(500).json({ error: "Failed to get group path" });
    }
  });

  app.post(
    "/api/groups/:groupId/devices",
    requireRole("admin"),
    async (req, res) => {
      try {
        const { groupId } = req.params;
        const { deviceIds } = req.body;
        for (const deviceId of deviceIds) {
          await storage.addDeviceToGroup(deviceId, groupId);
        }
        res.json({ message: "Devices added to group" });
      } catch (error) {
        res.status(500).json({ error: "Failed to add devices to group" });
      }
    },
  );

  // Group rename
  app.post("/api/groups/:id/rename", requireRole("admin"), async (req, res) => {
    try {
      const rawId = req.params.id;
      const { name } = req.body;

      // Parse jsTree node ID (e.g., 'group_xxx')
      const id = rawId.replace("group_", "");

      if (!name) {
        return res.status(400).json({ error: "Name required" });
      }

      // Find current group to get parent_id
      const currentGroup = await storage.getGroupById(id);
      if (!currentGroup) {
        return res.status(404).json({ error: "Group not found" });
      }

      // Duplicate check (excluding current group)
      const existingGroup = await storage.getGroupByNameAndParentExcluding(
        name,
        currentGroup.parentId,
        id,
      );
      if (existingGroup) {
        return res
          .status(400)
          .json({
            error: "A group with this name already exists in this folder.",
          });
      }

      await storage.updateGroupName(id, name);
      res.json({ success: true });
    } catch (error) {
      console.error("rename group error", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Device group rename (alias for jsTree)
  app.post(
    "/api/device-groups/:id/rename",
    requireRole("admin"),
    async (req, res) => {
      try {
        const rawId = req.params.id;
        const { name } = req.body;

        // Parse jsTree node ID (e.g., 'group_xxx')
        const id = rawId.replace("group_", "");

        if (!name) {
          return res.status(400).json({ error: "Name required" });
        }

        const currentGroup = await storage.getGroupById(id);
        if (!currentGroup) {
          return res.status(404).json({ error: "Group not found" });
        }

        const existingGroup = await storage.getGroupByNameAndParentExcluding(
          name,
          currentGroup.parentId,
          id,
        );
        if (existingGroup) {
          return res
            .status(400)
            .json({
              error: "A group with this name already exists in this folder.",
            });
        }

        await storage.updateGroupName(id, name);
        res.json({ success: true });
      } catch (error) {
        console.error("rename group error", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  // Group icon upload
  app.post(
    "/api/groups/:id/icon",
    requireRole("admin"),
    groupIconUpload.single("icon"),
    async (req, res) => {
      const { id } = req.params;
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const iconUrl = `/uploads/group-icons/${req.file.filename}`;

      try {
        await storage.updateGroupIcon(id, iconUrl);
        res.json({ success: true, iconUrl });
      } catch (error) {
        console.error("update icon error", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  // Device group icon upload (alias for jsTree)
  app.post(
    "/api/device-groups/:id/icon",
    requireRole("admin"),
    groupIconUpload.single("icon"),
    async (req, res) => {
      const rawId = req.params.id;
      const id = rawId.replace("group_", "");

      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const iconUrl = `/uploads/group-icons/${req.file.filename}`;

      try {
        await storage.updateGroupIcon(id, iconUrl);
        res.json({ success: true, iconUrl });
      } catch (error) {
        console.error("update icon error", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  // Clear/reset group icon
  app.post(
    "/api/device-groups/:id/icon/clear",
    requireRole("admin"),
    async (req, res) => {
      const rawId = req.params.id;
      const id = rawId.replace("group_", "");

      try {
        await storage.updateGroupIcon(id, null as any);
        res.json({ success: true });
      } catch (error) {
        console.error("clear group icon error", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  // Assign template to group
  app.post(
    "/api/device-groups/:id/template",
    requireRole("admin"),
    async (req, res) => {
      const rawId = req.params.id;
      const id = rawId.replace("group_", "");
      const { templateId } = req.body;

      try {
        await storage.updateGroupTemplate(id, templateId || null);
        res.json({ success: true });
      } catch (error) {
        console.error("assign template error", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  // Get all devices in a group (including nested groups)
  app.get("/api/device-groups/:id/devices", async (req, res) => {
    const rawId = req.params.id;
    const id = rawId.replace("group_", "");

    try {
      const result = await pool.query(`
        WITH RECURSIVE group_tree AS (
          SELECT id::text FROM device_groups WHERE id = $1::uuid
          UNION ALL
          SELECT dg.id::text FROM device_groups dg
          JOIN group_tree gt ON dg.parent_id::text = gt.id
        )
        SELECT s.device_id, s.name
        FROM screens s
        JOIN device_group_map dgm ON s.device_id = dgm.device_id
        WHERE dgm.group_id::text IN (SELECT id FROM group_tree)
      `, [id]);

      res.json(result.rows.map((r: any) => ({ device_id: r.device_id, name: r.name })));
    } catch (error) {
      console.error("get group devices error:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Push content to all devices in a group
  app.post("/api/device-groups/:id/push-content", async (req, res) => {
    const rawId = req.params.id;
    const id = rawId.replace("group_", "");
    const { contentId, contentName, contentUrl, contentType } = req.body;

    try {
      // Get all devices in this group (including nested groups via recursive query)
      const result = await pool.query(`
        WITH RECURSIVE group_tree AS (
          SELECT id FROM device_groups WHERE id = $1
          UNION ALL
          SELECT dg.id FROM device_groups dg
          JOIN group_tree gt ON dg.parent_id = gt.id
        )
        SELECT s.device_id, s.name
        FROM screens s
        WHERE s.group_id IN (SELECT id FROM group_tree)
      `, [id]);

      const devices = result.rows.map((r: any) => ({ device_id: r.device_id, name: r.name }));
      
      if (devices.length === 0) {
        return res.json({ success: true, deviceCount: 0, devices: [], message: "No devices in this group" });
      }

      // Create command for each device
      for (const device of devices) {
        await pool.query(
          `INSERT INTO device_commands (device_id, payload, sent, executed)
           VALUES ($1, $2, false, false)`,
          [device.device_id, JSON.stringify({
            type: "PLAY_CONTENT",
            contentId,
            contentName,
            contentUrl: toAbsoluteMediaUrl(req, contentUrl) || absolutizeAssetUrl(req, contentUrl) || contentUrl,
            contentType,
          })]
        );
      }

      res.json({ success: true, deviceCount: devices.length, devices });
    } catch (error) {
      console.error("push content to group error:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Assign device to group (updates screens.group_id)
  app.post("/api/device/:deviceId/group", async (req, res) => {
    const { deviceId } = req.params;
    const { groupId } = req.body;

    try {
      await pool.query(
        `UPDATE screens SET group_id = $1 WHERE device_id = $2`,
        [groupId, deviceId],
      );
      res.json({ success: true });
    } catch (error) {
      console.error("assign device to group error:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Device assignment endpoint - resolves template/schedules with group inheritance
  // Supports both /api/device/ (singular) and /api/devices/ (plural)
  app.get(
    ["/api/device/:deviceId/assignment", "/api/devices/:deviceId/assignment"],
    async (req, res) => {
      const { deviceId } = req.params;

      try {
        // Get device info - use getScreenByDeviceId since deviceId is a string like "DEV-XXXX"
        const device = await storage.getScreenByDeviceId(deviceId);
        if (!device) {
          return res.status(404).json({ error: "Device not found" });
        }

        // Get device's group from junction table
        const deviceGroupId = await storage.getDeviceGroupId(deviceId);

        // Resolve template with inheritance (device → group → parent → ... → root)
        let resolvedTemplate: any = null;
        let templateSource = "none";

        // Check device's direct template assignment first (via templateSchedule)
        const deviceSchedules = await storage.getSchedulesByDevice(deviceId);
        const now = new Date();
        const currentTime = now.toTimeString().slice(0, 5); // HH:MM format

        // Find active device schedule
        const activeDeviceSchedule = deviceSchedules.find((s) => {
          if (!s.startTime || !s.endTime) return false;
          return currentTime >= s.startTime && currentTime <= s.endTime;
        });

        if (activeDeviceSchedule && activeDeviceSchedule.templateId) {
          resolvedTemplate = await storage.getTemplate(
            activeDeviceSchedule.templateId,
          );
          templateSource = "device_schedule";
        }

        // If no active device schedule, walk up group hierarchy
        if (!resolvedTemplate && deviceGroupId) {
          const groupChain = await storage.getGroupAncestorChain(deviceGroupId);

          for (const group of groupChain) {
            // Check group's assigned template
            if (group.assignedTemplate) {
              resolvedTemplate = await storage.getTemplate(
                group.assignedTemplate,
              );
              templateSource = `group:${group.id}`;
              break;
            }

            // Check group schedules
            const groupSchedules = await storage.getSchedulesByGroup(group.id);
            const activeGroupSchedule = groupSchedules.find((s) => {
              if (!s.startTime || !s.endTime) return false;
              return currentTime >= s.startTime && currentTime <= s.endTime;
            });

            if (activeGroupSchedule && activeGroupSchedule.templateId) {
              resolvedTemplate = await storage.getTemplate(
                activeGroupSchedule.templateId,
              );
              templateSource = `group_schedule:${group.id}`;
              break;
            }
          }
        }

        // Collect all applicable schedules (device + inherited group schedules)
        const allSchedules: any[] = [];

        // Add device schedules
        for (const s of deviceSchedules) {
          if (s.templateId) {
            const template = await storage.getTemplate(s.templateId);
            allSchedules.push({
              ...s,
              template,
              source: "device",
            });
          }
        }

        // Add group schedules with inheritance
        if (deviceGroupId) {
          const groupChain = await storage.getGroupAncestorChain(deviceGroupId);
          for (const group of groupChain) {
            const groupSchedules = await storage.getSchedulesByGroup(group.id);
            for (const s of groupSchedules) {
              if (s.templateId) {
                const template = await storage.getTemplate(s.templateId);
                allSchedules.push({
                  ...s,
                  template,
                  source: `group:${group.name}`,
                });
              }
            }
          }
        }

        // Sort schedules by start time
        allSchedules.sort((a, b) => {
          const timeA = a.startTime || "00:00";
          const timeB = b.startTime || "00:00";
          return timeA.localeCompare(timeB);
        });

        // Get playlist items and zones for resolved template
        let playlist: any[] = [];
        let zones: any[] = [];

        if (resolvedTemplate) {
          playlist = await storage.getTemplatePlaylistItems(
            resolvedTemplate.id,
          );
          // Parse zones from template layout JSON
          try {
            const layout =
              typeof resolvedTemplate.layout === "string"
                ? JSON.parse(resolvedTemplate.layout)
                : resolvedTemplate.layout;
            zones = layout?.zones || [];
          } catch {
            zones = [];
          }
        }

        // Build proper response matching Android AssignmentResponse structure
        let templatePayload = null;

        if (resolvedTemplate) {
          templatePayload = {
            id: resolvedTemplate.id,
            name: resolvedTemplate.name,
            backgroundColor:
              resolvedTemplate.backgroundColor ||
              resolvedTemplate.bgColor ||
              null,
            backgroundImage: resolvedTemplate.backgroundImage || null,
            zones: zones,
            playlist: playlist,
          };
        }

        return res.json({
          success: true,
          template: templatePayload,
          error: null,
        });
      } catch (error) {
        console.error("device assignment error", error);
        res
          .status(500)
          .json({ success: false, template: null, error: "Server error" });
      }
    },
  );

  // Device schedule endpoint - returns all schedules including inherited from groups
  app.get(
    ["/api/device/:deviceId/schedule", "/api/devices/:deviceId/schedule"],
    async (req, res) => {
      const { deviceId } = req.params;

      try {
        // Get device's group from junction table
        const deviceGroupId = await storage.getDeviceGroupId(deviceId);

        // Collect all ancestor group IDs
        const allGroupIds: string[] = [];
        if (deviceGroupId) {
          const groupChain = await storage.getGroupAncestorChain(deviceGroupId);
          groupChain.forEach((g) => allGroupIds.push(g.id));
        }

        // Get device schedules
        const deviceSchedules = await storage.getSchedulesByDevice(deviceId);

        // Get group schedules for all ancestors
        const groupSchedules: any[] = [];
        for (const groupId of allGroupIds) {
          const schedules = await storage.getSchedulesByGroup(groupId);
          schedules.forEach((s) =>
            groupSchedules.push({ ...s, inheritedFrom: groupId }),
          );
        }

        // Merge and sort by start time
        const allSchedules = [
          ...deviceSchedules.map((s) => ({
            ...s,
            targetType: "device",
            targetId: deviceId,
          })),
          ...groupSchedules.map((s) => ({
            ...s,
            targetType: "group",
            targetId: s.groupId,
          })),
        ].sort((a, b) => {
          const timeA = a.startTime || "00:00";
          const timeB = b.startTime || "00:00";
          return timeA.localeCompare(timeB);
        });

        res.json(allSchedules);
      } catch (error) {
        console.error("Schedule merge error:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  // Device status routes for admin dashboard


  app.get("/api/devices/info", async (_req, res) => {
    try {
      const allScreens = await storage.getAllScreens();
      const deviceInfo: Record<string, any> = {};
      allScreens.forEach((s) => {
        deviceInfo[s.deviceId] = {
          online: s.status === "online",
          content: s.currentContent,
          lastOnline: s.lastSeen || new Date().toISOString(),
        };
      });
      res.json(deviceInfo);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch device info" });
    }
  });

  // Move device to a different group
  app.post("/api/devices/:deviceId/move", async (req, res) => {
    const { deviceId } = req.params;
    const { groupId } = req.body;

    try {
      await storage.updateScreenGroup(deviceId, groupId || null);
      res.json({ success: true });
    } catch (error) {
      console.error("move device error", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Delete group
  app.delete("/api/groups/:id", requireRole("admin"), async (req, res) => {
    try {
      const { id } = req.params;
      await storage.deleteGroup(id);
      res.json({ success: true });
    } catch (error) {
      console.error("delete group error", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Move group to different parent
  app.post(
    ["/api/groups/:id/move", "/api/device-groups/:id/move"],
    requireRole("admin"),
    async (req, res) => {
      try {
        const rawId = req.params.id;
        const id = rawId.replace("group_", "");
        const rawParentId = req.body.parentId;
        const parentId =
          rawParentId === "root-pdn" || rawParentId === "#"
            ? null
            : rawParentId?.replace("group_", "");
        await storage.updateGroupParent(id, parentId || null);
        res.json({ success: true });
      } catch (error) {
        console.error("move group error", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  // Device Tree for jsTree
  app.get("/api/devices/tree", async (_req, res) => {
    try {
      const [allGroups, allScreens, deviceCounts] = await Promise.all([
        storage.getAllGroups(),
        storage.getAllScreensWithGroup(),
        storage.getDeviceCountsByGroup(),
      ]);

      const rootId = "root-pdn";
      const childrenByParent: Record<string, any[]> = {};

      // Count root-level (ungrouped) devices
      let rootOnline = 0;
      let rootOffline = 0;
      allScreens.forEach((d) => {
        if (!d.groupId) {
          if (d.status === "online") rootOnline++;
          else rootOffline++;
        }
      });

      // Build lookup for groups with counts
      allGroups.forEach((g) => {
        const parent = g.parentId ? `group_${g.parentId}` : rootId;
        const counts = deviceCounts[g.id] || { online: 0, offline: 0 };
        if (!childrenByParent[parent]) childrenByParent[parent] = [];
        childrenByParent[parent].push({
          id: `group_${g.id}`,
          text: `${g.name} (${counts.online}/${counts.offline})`,
          type: "group",
          icon: g.iconUrl || "fa fa-folder",
        });
      });

      // Build lookup for devices
      allScreens.forEach((d) => {
        const parent = d.groupId ? `group_${d.groupId}` : rootId;
        if (!childrenByParent[parent]) childrenByParent[parent] = [];
        childrenByParent[parent].push({
          id: `device_${d.deviceId}`,
          text: d.name || d.deviceId,
          type: "device",
          icon:
            d.status === "online"
              ? "fa fa-tv text-success"
              : "fa fa-tv text-danger",
          data: {
            deviceId: d.deviceId,
            status: d.status,
          },
        });
      });

      // Recursive function to build nested tree
      const buildNode = (
  id: string,
  text: string,
  type: string,
  icon?: string,
): any => {
  const node: any = { id, text, type };
  if (icon) node.icon = icon;
  const children = childrenByParent[id];
  if (children && children.length > 0) {
    node.children = children.map((c: any) =>
      buildNode(c.id, c.text, c.type, c.icon),
    );
          node.state = { opened: true };
        }
        return node;
      }

      // Calculate total counts for root
      let totalOnline = rootOnline;
      let totalOffline = rootOffline;
      Object.values(deviceCounts).forEach((c: any) => {
        totalOnline += c.online;
        totalOffline += c.offline;
      });

      const tree = [
        buildNode(
          rootId,
          `PDN (${totalOnline}/${totalOffline})`,
          "root",
          "fa fa-home",
        ),
      ];

      res.json(tree);
    } catch (error) {
      console.error("tree error", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  return httpServer;
}
