import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import { randomUUID } from "crypto";
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
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp|mp4|webm|mov/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype);
    if (ext && mime) cb(null, true);
    else cb(new Error("Only image/video files allowed"));
  },
});

// Screenshot upload configuration
const screenshotStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, screenshotsDir),
  filename: (req, file, cb) => {
    const deviceId = (req.params as { deviceId: string }).deviceId || "unknown";
    const timestamp = Date.now();
    cb(null, `${deviceId}-${timestamp}${path.extname(file.originalname)}`);
  },
});

const screenshotUpload = multer({
  storage: screenshotStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit for screenshots
  fileFilter: (_req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype);
    if (ext && mime) cb(null, true);
    else cb(new Error("Only image files allowed for screenshots"));
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
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit for recordings
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

// Simple in-memory command queue: { [deviceId]: [ { id, command, value, createdAt } ] }
const pendingCommands: {
  [deviceId: string]: Array<{
    id: string;
    command: string;
    value?: any;
    createdAt: Date;
  }>;
} = {};

// Track last uploaded screenshot/recording per device
const lastScreenshot: { [deviceId: string]: string } = {};
const lastRecording: { [deviceId: string]: string } = {};

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
    if (p.startsWith("/auth/")) return next();
    if (p === "/ping") return next();
    if (p === "/screens/register") return next();
    // Device claim (pairing) should not require user JWT
    if (p === "/device/claim") return next();
    if (p.startsWith("/device/")) return next();
    return authenticateJWT(req, res, next);
  });

  // Device API must use device token when a specific deviceId is present
  app.use("/api/device/:deviceId", authenticateDevice);

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
  app.get("/api/devices/:id/details", async (req, res) => {
    const { id } = req.params;

    try {
      const result = await pool.query(
        `
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
          s.brightness,
          s.volume,
          t.name AS "templateName"
        FROM screens s
        LEFT JOIN templates t ON s.assigned_template_id = t.id
        WHERE s.id::text = $1 OR s.device_id = $1
        LIMIT 1
        `,
        [id]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Device not found" });
      }

      const device = result.rows[0];
      res.json({
        id: device.device_id || device.id,
        name: device.name,
        status: device.is_online ? "Online" : "Offline",
        lastHeartbeat: device.lastHeartbeat,
        currentContentName: device.currentContentName,
        templateName: device.templateName,
        lastScreenshot: device.screenshot,
        screenshotAt: device.screenshotAt,
        thumbnail: device.thumbnail,
        signalStrength: device.signalStrength,
        connectionType: device.connectionType || "wifi",
        freeStorage: device.freeStorage,
        lastOffline: device.lastOffline,
        latitude: device.latitude,
        longitude: device.longitude,
        brightness: device.brightness ?? 100,
        volume: device.volume ?? 70,
      });
    } catch (err) {
      console.error("Device details error:", err);
      res.status(500).json({ error: "Failed to load device details" });
    }
  });

  // =====================================================
  // DEVICE SETTINGS (brightness/volume)
  // =====================================================
  app.post("/api/devices/:id/settings", async (req, res) => {
    const { id } = req.params;
    const { brightness, volume } = req.body;

    try {
      const updates: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      if (brightness !== undefined) {
        updates.push(`brightness = $${paramIndex++}`);
        values.push(brightness);
      }
      if (volume !== undefined) {
        updates.push(`volume = $${paramIndex++}`);
        values.push(volume);
      }

      if (updates.length === 0) {
        return res.status(400).json({ error: "No settings to update" });
      }

      values.push(id);
      await pool.query(
        `UPDATE screens SET ${updates.join(", ")} WHERE device_id = $${paramIndex} OR id::text = $${paramIndex}`,
        values
      );

      res.json({ success: true });
    } catch (err) {
      console.error("Update device settings error:", err);
      res.status(500).json({ error: "Failed to update settings" });
    }
  });

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
        SELECT name, device_id
        FROM screens
        WHERE is_online = false
        ORDER BY last_seen DESC
        LIMIT 10
      `);

      const alerts = result.rows.map((d) => ({
        message: `Device "${d.name}" has gone offline.`,
        deviceId: d.device_id,
        type: "offline",
      }));

      res.json({ alerts });
    } catch (err) {
      console.error("Alerts error:", err);
      res.status(500).json({ error: "failed_to_load_alerts" });
    }
  });

  // =====================================================
  // DASHBOARD LIVE CONTENT
  // =====================================================
  app.get("/api/dashboard/live-content", async (_req, res) => {
    try {
      const now = new Date();
      const dayOfWeek = now.getDay();
      const currentTime = now.toTimeString().slice(0, 8);

      const result = await pool.query(`
        SELECT 
          cs.id,
          cs.content_type,
          cs.content_id,
          CASE 
            WHEN cs.content_type = 'media' THEN m.name
            WHEN cs.content_type = 'playlist' THEN cp.name
            WHEN cs.content_type = 'template' THEN t.name
            ELSE 'Unknown'
          END as content_name,
          CASE 
            WHEN cs.content_type = 'media' THEN m.type
            ELSE cs.content_type
          END as type,
          COUNT(DISTINCT COALESCE(cs.device_id, dgm.device_id)) as device_count
        FROM content_schedules cs
        LEFT JOIN media m ON cs.content_type = 'media' AND cs.content_id::text = m.id::text
        LEFT JOIN content_playlists cp ON cs.content_type = 'playlist' AND cs.content_id::text = cp.id::text
        LEFT JOIN templates t ON cs.content_type = 'template' AND cs.content_id::text = t.id::text
        LEFT JOIN device_group_members dgm ON cs.group_id = dgm.group_id
        WHERE cs.is_active = true
          AND (cs.start_date IS NULL OR cs.start_date <= CURRENT_DATE)
          AND (cs.end_date IS NULL OR cs.end_date >= CURRENT_DATE)
          AND (
            cs.days_of_week IS NULL 
            OR cs.days_of_week = '{}' 
            OR $1 = ANY(cs.days_of_week)
          )
          AND (cs.start_time IS NULL OR cs.start_time <= $2::time)
          AND (cs.end_time IS NULL OR cs.end_time >= $2::time)
        GROUP BY cs.id, cs.content_type, cs.content_id, m.name, m.type, cp.name, t.name
        ORDER BY device_count DESC
        LIMIT 10
      `, [dayOfWeek, currentTime]);

      const content = result.rows.map(row => ({
        id: row.id,
        name: row.content_name || 'Unnamed Content',
        type: row.type || 'unknown',
        deviceCount: parseInt(row.device_count) || 1
      }));

      res.json({ content });
    } catch (err) {
      console.error("Live content error:", err);
      res.status(500).json({ error: "failed_to_load_live_content", content: [] });
    }
  });

  // =====================================================
  // ACTIVE COMMANDS STATUS (for progress tracking)
  // =====================================================
  app.get("/api/commands/active", async (req, res) => {
    try {
      // Get commands from last 5 minutes that are not yet fully executed
      const result = await pool.query(`
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
      `);

      const commands = result.rows.map(cmd => {
        const payload = typeof cmd.payload === 'string' ? JSON.parse(cmd.payload) : cmd.payload;
        let status = 'queued';
        let progress = 0;
        
        if (cmd.executed) {
          status = 'completed';
          progress = 100;
        } else if (cmd.sent) {
          status = 'delivering';
          progress = 50;
        }

        return {
          id: cmd.id,
          deviceId: cmd.device_id,
          deviceName: cmd.device_name || cmd.device_id,
          type: payload.type,
          contentName: payload.contentName || payload.type,
          status,
          progress,
          createdAt: cmd.created_at,
          executedAt: cmd.executed_at
        };
      });

      res.json({ commands });
    } catch (err) {
      console.error("Active commands error:", err);
      res.status(500).json({ error: "failed_to_fetch_active_commands" });
    }
  });

  // =====================================================
  // COMMAND HISTORY FOR DEVICE (CMS)
  // =====================================================
  // ✅ ADMIN (dashboard) - JWT protected
  app.get(
    "/api/admin/devices/:deviceId/commands/history",
    authenticateJWT,
    requireRole("admin", "manager"),
    async (req, res) => {
      const { deviceId } = req.params;

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
        console.error("Admin command history error:", err);
        return res.status(500).json({ error: "failed_to_fetch_command_history" });
      }
    },
  );

  // Device-scoped history (device auth) - keep for backwards compatibility
  app.get("/api/device/:deviceId/commands/history", async (req, res) => {
    const { deviceId } = req.params;

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
        [deviceId]
      );

      res.json(result.rows);
    } catch (err) {
      console.error("Command history error:", err);
      res.status(500).json({ error: "failed_to_fetch_command_history" });
    }
  });



 

        // DEVICE FETCHES ITS PENDING COMMANDS
        app.get("/api/device/:deviceId/commands", async (req, res) => {
          const { deviceId } = req.params;

          try {
            // 1️⃣ Fetch pending (unsent) commands
            const result = await pool.query(
              `
              SELECT id, payload
              FROM device_commands
              WHERE device_id = $1
                AND sent = false
              ORDER BY created_at ASC
              `,
              [deviceId]
            );

            // 2️⃣ Mark them as SENT (delivered to device)
            if (result.rows.length > 0) {
              const ids = result.rows.map((r) => r.id);

              await pool.query(
                `
                UPDATE device_commands
                SET sent = true
                WHERE id = ANY($1)
                `,
                [ids]
              );
            }

            // 3️⃣ Return payloads to device
            res.json(
              result.rows.map((r) => ({
                id: r.id,
                ...(typeof r.payload === "string"
                  ? JSON.parse(r.payload)
                  : r.payload),
              }))
            );
          } catch (err) {
            console.error("Error fetching commands:", err);
            res.json([]);
          }
        });

  // =====================================================
  // DEVICE ACKNOWLEDGES COMMAND EXECUTION
  // =====================================================
  app.post("/api/device/:deviceId/commands/:commandId/ack", async (req, res) => {
    const { deviceId, commandId } = req.params;

    try {
      const result = await pool.query(
        `
        UPDATE device_commands
        SET executed = true, executed_at = NOW()
        WHERE id = $1 AND device_id = $2
        RETURNING id
        `,
        [commandId, deviceId]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Command not found" });
      }

      console.log(`Command ${commandId} acknowledged by device ${deviceId}`);
      res.json({ success: true, commandId });
    } catch (err) {
      console.error("Error acknowledging command:", err);
      res.status(500).json({ error: "Failed to acknowledge command" });
    }
  });

  // DEVICE UPLOADS SCREENSHOT
  app.post(
    "/api/device/:deviceId/screenshot",
    screenshotUpload.single("file"),
    (req, res) => {
      const { deviceId } = req.params;

      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const filePath = `/uploads/screenshots/${req.file.filename}`;
      lastScreenshot[deviceId] = filePath;

      console.log(
        `Screenshot received from device ${deviceId}:`,
        req.file.filename,
      );

      res.json({ ok: true, filePath });
    },
  );

  // DEVICE UPLOADS VIDEO RECORDING
  app.post(
    "/api/device/:deviceId/record",
    recordingUpload.single("file"),
    (req, res) => {
      const { deviceId } = req.params;

      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const filePath = `/uploads/recordings/${req.file.filename}`;
      lastRecording[deviceId] = filePath;

      console.log(
        `Recording received from device ${deviceId}:`,
        req.file.filename,
      );

      res.json({ ok: true, filePath });
    },
  );

  // GET LAST SCREENSHOT FOR A DEVICE (CMS uses this)
  app.get("/api/device/:deviceId/screenshot", (req, res) => {
    const { deviceId } = req.params;
    const filePath = lastScreenshot[deviceId];

    if (!filePath) {
      return res.status(404).json({ error: "No screenshot available" });
    }

    res.json({ ok: true, filePath });
  });

  // GET LAST RECORDING FOR A DEVICE (CMS uses this)
  app.get("/api/device/:deviceId/recording", (req, res) => {
    const { deviceId } = req.params;
    const filePath = lastRecording[deviceId];

    if (!filePath) {
      return res.status(404).json({ error: "No recording available" });
    }

    res.json({ ok: true, filePath });
  });

  // Alternative endpoints returning null if not found (simpler for Android)
  app.get("/api/device/:deviceId/last-screenshot", (req, res) => {
    const { deviceId } = req.params;
    res.json({ file: lastScreenshot[deviceId] || null });
  });

  app.get("/api/device/:deviceId/last-recording", (req, res) => {
    const { deviceId } = req.params;
    res.json({ file: lastRecording[deviceId] || null });
  });

  // Serve latest screenshot image directly
  app.get("/api/device/:deviceId/screenshot/latest", (req, res) => {
    const { deviceId } = req.params;
    const screenshotPath = path.join(screenshotsDir, `${deviceId}_latest.png`);

    if (!fs.existsSync(screenshotPath)) {
      // Try to find any screenshot for this device
      const files = fs
        .readdirSync(screenshotsDir)
        .filter((f) => f.startsWith(deviceId));
      if (files.length > 0) {
        files.sort().reverse();
        return res.sendFile(path.join(screenshotsDir, files[0]));
      }
      return res.status(404).send("No screenshot available");
    }

    res.sendFile(screenshotPath);
  });

  app.post("/api/devices", async (req, res) => {
    try {
      const { name, location_branch } = req.body;

      if (!name) {
        return res.status(400).json({ error: "Device name is required" });
      }

      const device = await createDevice({ name, location_branch });
      return res.status(201).json({ device });
    } catch (error) {
      console.error("Error creating device:", error);
      return res.status(500).json({ error: "Failed to create device" });
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
        if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid_id" });

        const screen = await storage.getScreen(id);
        if (!screen) return res.status(404).json({ error: "screen_not_found" });

        const deviceToken = randomUUID();
        const hash = await bcrypt.hash(deviceToken, 10);
        await storage.updateScreen(id, { password: hash } as any);

        return res.json({ ok: true, deviceToken, screenId: id, deviceId: (screen as any).deviceId || (screen as any).device_id });
      } catch (e) {
        console.error("rotate-token error", e);
        return res.status(500).json({ error: "failed_to_rotate_token" });
      }
    },
  );

  // Screens Routes

  // Device self-registration endpoint
  app.post("/api/screens/register", async (req, res) => {
    try {
      const { deviceId, name, resolution, location } = req.body;

      if (!deviceId) {
        return res.status(400).json({ error: "deviceId is required" });
      }

      // Check if device already exists
      const existingScreen = await storage.getScreenByDeviceId(deviceId);
      if (existingScreen) {
        // If the device has no token yet, mint one (returned only on this register call)
        let deviceToken: string | null = null;
        if (!existingScreen.password) {
          deviceToken = randomUUID();
          const hash = await bcrypt.hash(deviceToken, 10);
          await storage.updateScreen(existingScreen.id, { password: hash } as any);
        }

        // Update last seen and return existing screen
        const updated = await storage.updateScreen(existingScreen.id, {
          lastSeen: new Date(),
          status: "online",
        });
        return res.json({ message: "Device reconnected", screen: updated, deviceToken });
      }

      // Create new screen
      const deviceToken = randomUUID();
      const hash = await bcrypt.hash(deviceToken, 10);
      const screen = await storage.createScreen({
        deviceId,
        name: name || `Screen ${deviceId}`,
        resolution: resolution || "1920x1080",
        location: location || "Unknown",
        status: "online",
        lastSeen: new Date(),
        password: hash,
      });

      res.status(201).json({ message: "Device registered", screen, deviceToken });
    } catch (error) {
      res.status(500).json({ error: "Failed to register device" });
    }
  });

  // Get playlist content for a device by deviceId
  app.get("/api/screens/:deviceId/playlist", async (req, res) => {
    try {
      const { deviceId } = req.params;

      // Find screen by deviceId
      const screen = await storage.getScreenByDeviceId(deviceId);
      if (!screen) {
        return res.status(404).json({ error: "Device not found" });
      }

      // Update last seen timestamp
      await storage.updateScreen(screen.id, {
        lastSeen: new Date(),
        status: "online",
      });

      // Get all media as playlist content (can be enhanced with actual playlist assignments later)
      const allMedia = await storage.getAllMedia();
      const playlist = allMedia.map((item) => ({
        id: item.id,
        type: item.type,
        url: item.url,
        name: item.name,
        duration: item.duration || 10,
      }));

      res.json({
        screen: {
          id: screen.id,
          deviceId: screen.deviceId,
          name: screen.name,
          resolution: screen.resolution,
        },
        playlist,
        refreshInterval: 300, // seconds until next playlist check
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch playlist" });
    }
  });

  // Device API endpoints (for Android/player clients)
  app.post("/api/device/register", async (req, res) => {
    try {
      const { deviceId, name, resolution, location } = req.body;

      if (!deviceId) {
        return res.status(400).json({ error: "deviceId is required" });
      }

      const existingScreen = await storage.getScreenByDeviceId(deviceId);
      if (existingScreen) {
        const updated = await storage.updateScreen(existingScreen.id, {
          lastSeen: new Date(),
          status: "online",
        });
        return res.json({ message: "Device updated", screen: updated });
      }

      const screen = await storage.createScreen({
        deviceId,
        name: name || `Screen ${deviceId}`,
        resolution: resolution || "1920x1080",
        location: location || "Unknown",
        status: "online",
        lastSeen: new Date(),
      });

      res.status(201).json({ message: "Device registered", screen });
    } catch (error) {
      res.status(500).json({ error: "Device register failed" });
    }
  });

      // ✅ ADMIN → DEVICE COMMAND (JWT protected)
      // This endpoint is used by the dashboard (NOT by the device).
      app.post(
        "/api/admin/devices/:deviceId/command",
        authenticateJWT,
        requireRole("admin", "manager"),
        async (req, res) => {
          const { deviceId } = req.params;
          const { type, value, state, duration } = req.body;

          if (!type) {
            return res.status(400).json({ error: "Command type is required" });
          }

          let payload: any;

          switch (type) {
            case "SET_VOLUME":
              payload = { type: "volume", value };
              break;

            case "SET_BRIGHTNESS":
              payload = { type: "brightness", value };
              break;

            case "MUTE":
              payload = { type: "volume", value: 0 };
              break;

            case "UNMUTE":
              payload = { type: "unmute" };
              break;

            case "SCREEN_OFF":
              payload = { type: "screen", state: "off" };
              break;

            case "SCREEN_ON":
              payload = { type: "screen", state: "on" };
              break;

            case "REBOOT":
              payload = { type: "reboot" };
              break;

            case "SCREENSHOT":
              payload = { type: "screenshot" };
              break;

            case "RECORD":
              payload = { type: "record", duration: duration || 10 };
              break;

            case "PLAY_CONTENT": {
              const { contentId, contentName, contentUrl, contentType } = req.body;
              payload = {
                type: "play_content",
                contentId,
                contentName,
                contentUrl,
                contentType,
              };
              // Also update the device's current content
              await pool.query(
                `UPDATE screens SET current_content = $1, current_content_name = $2 WHERE device_id = $3`,
                [contentId, contentName, deviceId],
              );
              break;
            }

            case "PING": {
              const { message } = req.body;
              payload = { type: "ping", message: message || "This Device is being pinged" };
              break;
            }

            case "SHUTDOWN":
              payload = { type: "shutdown" };
              break;

            case "POWER_ON":
              payload = { type: "power_on" };
              break;

            default:
              return res.status(400).json({ error: "Unknown command type" });
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
            queued: payload,
          });
        },
      );

      // ❌ Deprecated (was incorrectly protected by device auth)
      app.post("/api/device/:deviceId/command", (_req, res) => {
        return res.status(410).json({ error: "moved_to_/api/admin/devices/:deviceId/command" });
      });

  app.post("/api/device/:deviceId/heartbeat", async (req, res) => {
    const { deviceId } = req.params;
    const {
      brightness,
      volume,
      screenState,
      apkVersion,
      temperature,
      freeStorage,
      totalStorage,
      signalStrength,
      uptime,
      localIp,
      publicIp,
    } = req.body;

    try {
      await pool.query(
        `
        UPDATE screens SET
          last_seen = NOW(),
          brightness = $1,
          volume = $2,
          screen_state = $3,
          apk_version = $4,
          temperature = $5,
          free_storage = $6,
          total_storage = $7,
          signal_strength = $8,
          uptime = $9,
          local_ip = $10,
          public_ip = $11,
          is_online = TRUE
        WHERE device_id = $12
        `,
        [
          brightness,
          volume,
          screenState,
          apkVersion,
          temperature,
          freeStorage,
          totalStorage,
          signalStrength,
          uptime,
          localIp,
          publicIp,
          deviceId,
        ],
      );

      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "heartbeat_failed" });
    }
  });

  // =====================================================
  // DEVICE SCREENSHOT UPLOAD
  // =====================================================
  app.post("/api/device/:deviceId/screenshot", async (req, res) => {
    const { deviceId } = req.params;
    const { screenshot } = req.body;

    if (!screenshot) {
      return res.status(400).json({ error: "screenshot_required" });
    }

    try {
      await pool.query(
        `
        UPDATE screens SET
          screenshot = $1,
          screenshot_at = NOW()
        WHERE device_id = $2
        `,
        [screenshot, deviceId]
      );

      res.json({ success: true });
    } catch (err) {
      console.error("Screenshot upload error:", err);
      res.status(500).json({ error: "screenshot_upload_failed" });
    }
  });

  // =====================================================
  // DEVICE THUMBNAIL UPLOAD
  // =====================================================
  app.post(
    "/api/device/:deviceId/thumbnail",
    deviceThumbnailUpload.single("thumbnail"),
    async (req, res) => {
      const { deviceId } = req.params;
      const file = req.file;

      if (!file) {
        return res.status(400).json({ error: "No thumbnail file provided" });
      }

      try {
        const thumbnailUrl = `/uploads/device-thumbnails/${file.filename}`;
        
        await pool.query(
          `UPDATE screens SET thumbnail = $1 WHERE device_id = $2`,
          [thumbnailUrl, deviceId]
        );

        res.json({ success: true, thumbnail: thumbnailUrl });
      } catch (err) {
        console.error("Thumbnail upload error:", err);
        res.status(500).json({ error: "Failed to upload thumbnail" });
      }
    }
  );

  // Get device thumbnail
  app.get("/api/device/:deviceId/thumbnail", async (req, res) => {
    const { deviceId } = req.params;
    
    try {
      const result = await pool.query(
        `SELECT thumbnail FROM screens WHERE device_id = $1`,
        [deviceId]
      );
      
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
    status: z.enum(["playing", "idle", "error", "offline"]).optional(),
    currentContentId: z.string().nullable().optional(),
    currentContentName: z.string().nullable().optional(),
    batteryLevel: z.number().min(0).max(100).nullable().optional(),
    temperature: z.number().min(-50).max(150).nullable().optional(),
    freeStorage: z.number().min(0).nullable().optional(),
    signalStrength: z.number().min(-150).max(0).nullable().optional(),
    isOnline: z.boolean().nullable().optional(),
    latitude: z.number().min(-90).max(90).nullable().optional(),
    longitude: z.number().min(-180).max(180).nullable().optional(),
    errors: z.array(z.string()).nullable().optional(),
    timestamp: z.number().nullable().optional(),
  });

  app.post("/api/device/status", authenticateDevice, async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader) return res.status(401).json({ error: "Missing token" });

      const token = authHeader.split(" ")[1];

      const secret = process.env.JWT_SECRET;
      if (!secret) {
        console.error("JWT SECRET MISSING!");
        return res.status(500).json({ error: "JWT secret missing" });
      }

      let decoded;
      try {
        decoded = jwt.verify(token, secret);
      } catch (error) {
        console.error("JWT VERIFY ERROR:", error);
        return res.status(403).json({ error: "Invalid or expired token" });
      }

      const body = {
        ...req.body,
        isOnline: req.body.isOnline ?? req.body.is_online ?? true,
      };

      if (!body.device_id) {
        return res.status(400).json({ error: "device_id is required" });
      }

      await saveDeviceStatus(body);

      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to save device status" });
    }
  });

  app.post(
    "/api/device/status/auth",
    authenticateJWT as any,
    async (req: Request, res) => {
      try {
        const validatedData = deviceStatusSchema.parse(req.body);

        if (!validatedData.deviceId) {
          return res.status(400).json({ error: "deviceId is required" });
        }

        const screen = await storage.getScreenByDeviceId(
          validatedData.deviceId,
        );
        if (!screen) {
          return res.status(404).json({ error: "Device not found" });
        }

        await storage.createDeviceStatusLog({
          deviceId: validatedData.deviceId,
          status: validatedData.status ?? undefined,
          currentContentId: validatedData.currentContentId ?? undefined,
          currentContentName: validatedData.currentContentName ?? undefined,
          batteryLevel: validatedData.batteryLevel ?? undefined,
          temperature: validatedData.temperature ?? undefined,
          freeStorage: validatedData.freeStorage ?? undefined,
          signalStrength: validatedData.signalStrength ?? undefined,
          isOnline: validatedData.isOnline ?? undefined,
          latitude: validatedData.latitude ?? undefined,
          longitude: validatedData.longitude ?? undefined,
          errors: validatedData.errors ?? undefined,
          timestamp: validatedData.timestamp ?? Date.now(),
        });

        await storage.updateDeviceStatus(validatedData.deviceId, {
          status: validatedData.status ?? undefined,
          currentContent: validatedData.currentContentId ?? undefined,
          currentContentName: validatedData.currentContentName ?? undefined,
          batteryLevel: validatedData.batteryLevel ?? undefined,
          temperature: validatedData.temperature ?? undefined,
          freeStorage: validatedData.freeStorage ?? undefined,
          signalStrength: validatedData.signalStrength ?? undefined,
          isOnline: validatedData.isOnline ?? undefined,
          latitude: validatedData.latitude ?? undefined,
          longitude: validatedData.longitude ?? undefined,
          errors: validatedData.errors ?? undefined,
        });

        res.json({ success: true });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return res.status(400).json({ error: error.errors });
        }
        console.error("Device status endpoint error:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  app.post("/api/device/:deviceId/status", async (req, res) => {
    try {
      const { deviceId } = req.params;
      const validatedData = deviceStatusSchema.parse(req.body);

      const screen = await storage.getScreenByDeviceId(deviceId);
      if (!screen) {
        return res.status(404).json({ error: "Device not found" });
      }

      await storage.createDeviceStatusLog({
        deviceId,
        status: validatedData.status ?? undefined,
        currentContentId: validatedData.currentContentId ?? undefined,
        currentContentName: validatedData.currentContentName ?? undefined,
        batteryLevel: validatedData.batteryLevel ?? undefined,
        temperature: validatedData.temperature ?? undefined,
        freeStorage: validatedData.freeStorage ?? undefined,
        signalStrength: validatedData.signalStrength ?? undefined,
        isOnline: validatedData.isOnline ?? undefined,
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
        isOnline: validatedData.isOnline ?? undefined,
        latitude: validatedData.latitude ?? undefined,
        longitude: validatedData.longitude ?? undefined,
        errors: validatedData.errors ?? undefined,
      });

      res.json({ success: true, screen: updatedScreen });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      console.error("Device status endpoint error:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.get("/api/device/:deviceId/playlist", (req, res) => {
    const { deviceId } = req.params;

    const playlist = playlists[deviceId];

    if (!playlist) {
      return res.json({
        deviceId,
        lastUpdated: null,
        items: [],
      });
    }

    res.json(playlist);
  });

  app.post("/api/device/:deviceId/playlist", (req, res) => {
    const { deviceId } = req.params;
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
  app.delete("/api/device/:deviceId/playlist", (req, res) => {
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

  // RSS proxy for template designer preview
  app.get("/api/rss-proxy", async (req, res) => {
    const { url } = req.query;
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "URL is required" });
    }

    console.log("Fetching RSS from:", url);

    try {
      const response = await fetch(url);
      const text = await response.text();
      
      // Simple RSS parsing - try both RSS (<item>) and Atom (<entry>) formats
      const items: { title: string; description: string; link: string; pubDate: string; image?: string }[] = [];
      
      // Try RSS format first
      let itemMatches = text.match(/<item>[\s\S]*?<\/item>/g) || [];
      
      // If no RSS items, try Atom format
      if (itemMatches.length === 0) {
        itemMatches = text.match(/<entry>[\s\S]*?<\/entry>/g) || [];
      }
      
      console.log("Found", itemMatches.length, "feed items");
      
      for (const item of itemMatches.slice(0, 10)) {
        const title = item.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1]?.trim() || "";
        const description = item.match(/<(?:description|summary)[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/(?:description|summary)>/)?.[1]?.trim() || "";
        const link = item.match(/<link[^>]*href="([^"]+)"/) ?.[1] || item.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() || "";
        const pubDate = item.match(/<(?:pubDate|published|updated)>([\s\S]*?)<\/(?:pubDate|published|updated)>/)?.[1]?.trim() || "";
        
        // Extract image from various RSS formats
        let image: string | undefined;
        
        // Try media:content or media:thumbnail (common in news feeds like BBC, CNN)
        const mediaContent = item.match(/<media:content[^>]*url="([^"]+)"/)?.[1];
        const mediaThumbnail = item.match(/<media:thumbnail[^>]*url="([^"]+)"/)?.[1];
        
        // Try enclosure tag (podcasts and some RSS feeds)
        const enclosure = item.match(/<enclosure[^>]*url="([^"]+)"[^>]*type="image/)?.[1];
        
        // Try image tag directly in item
        const imageTag = item.match(/<image[^>]*>[\s\S]*?<url>([\s\S]*?)<\/url>/)?.[1]?.trim();
        
        // Try extracting image from description/content (img src in HTML)
        const imgInContent = item.match(/<img[^>]*src=["']([^"']+)["']/)?.[1];
        
        // Try content:encoded for embedded images
        const contentEncoded = item.match(/<content:encoded>[\s\S]*?<img[^>]*src=["']([^"']+)["']/)?.[1];
        
        image = mediaContent || mediaThumbnail || enclosure || imageTag || imgInContent || contentEncoded;
        
        if (title) {
          items.push({ title, description, link, pubDate, image });
        }
      }
      
      res.json({ items, isValidFeed: itemMatches.length > 0 });
    } catch (error) {
      console.error("RSS fetch error:", error);
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
      res.json(allScreens);
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
      res.json(result.rows);
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
      res.json(result.rows);
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
    upload.single("file"),
    async (req, res) => {
      try {
        if (!req.file) {
          return res.status(400).json({ error: "No file uploaded" });
        }

        const baseUrl =
          process.env.BASE_URL ||
          `http://localhost:${process.env.PORT || 5000}`;
        const fileUrl = `${baseUrl}/uploads/${req.file.filename}`;
        const fileType = req.file.mimetype.startsWith("video")
          ? "video"
          : "image";

        const mediaItem = await storage.createMedia({
          name: req.file.originalname,
          type: fileType,
          url: fileUrl,
          size: req.file.size,
          duration: fileType === "video" ? 30 : 10,
        });

        res.status(201).json({
          message: "File uploaded",
          media: mediaItem,
        });
      } catch (error) {
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
  
  app.get("/api/content-playlists", async (_req, res) => {
    try {
      const result = await pool.query(`
        SELECT 
          cp.*,
          COUNT(pi.id) as item_count,
          COALESCE(
            json_agg(
              json_build_object(
                'id', m.id, 
                'name', m.name, 
                'type', m.type, 
                'url', m.url,
                'itemId', pi.id,
                'duration', pi.duration,
                'volume', pi.volume,
                'position', pi.position
              ) ORDER BY pi.position
            ) FILTER (WHERE m.id IS NOT NULL), 
            '[]'
          ) as items
        FROM content_playlists cp
        LEFT JOIN playlist_items pi ON pi.playlist_id = cp.id
        LEFT JOIN media m ON m.id = pi.media_id
        GROUP BY cp.id
        ORDER BY cp.created_at DESC
      `);
      res.json(result.rows);
    } catch (error) {
      console.error("Fetch playlists error:", error);
      res.status(500).json({ error: "Failed to fetch playlists" });
    }
  });

  app.post("/api/content-playlists", async (req, res) => {
    try {
      const { name, description } = req.body;
      if (!name) {
        return res.status(400).json({ error: "Name is required" });
      }
      const result = await pool.query(
        `INSERT INTO content_playlists (name, description) VALUES ($1, $2) RETURNING *`,
        [name, description || null]
      );
      res.status(201).json(result.rows[0]);
    } catch (error) {
      console.error("Create playlist error:", error);
      res.status(500).json({ error: "Failed to create playlist" });
    }
  });

  app.delete("/api/content-playlists/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      await pool.query(`DELETE FROM playlist_items WHERE playlist_id = $1`, [id]);
      await pool.query(`DELETE FROM playlist_assignments WHERE playlist_id = $1`, [id]);
      const result = await pool.query(`DELETE FROM content_playlists WHERE id = $1 RETURNING *`, [id]);
      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Playlist not found" });
      }
      res.json({ message: "Playlist deleted" });
    } catch (error) {
      console.error("Delete playlist error:", error);
      res.status(500).json({ error: "Failed to delete playlist" });
    }
  });

  app.post("/api/content-playlists/:id/items", async (req, res) => {
    try {
      const playlistId = parseInt(req.params.id);
      const { mediaId, mediaIds, duration } = req.body;
      
      // Support both single mediaId and array of mediaIds
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
      
      res.status(201).json(insertedItems);
    } catch (error) {
      console.error("Add playlist item error:", error);
      res.status(500).json({ error: "Failed to add item to playlist" });
    }
  });

  app.delete("/api/content-playlists/:playlistId/items/:itemId", async (req, res) => {
    try {
      const itemId = parseInt(req.params.itemId);
      const result = await pool.query(`DELETE FROM playlist_items WHERE id = $1 RETURNING *`, [itemId]);
      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Item not found" });
      }
      res.json({ message: "Item removed from playlist" });
    } catch (error) {
      console.error("Remove playlist item error:", error);
      res.status(500).json({ error: "Failed to remove item from playlist" });
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
      
      res.json(result.rows[0]);
    } catch (error) {
      console.error("Update playlist item error:", error);
      res.status(500).json({ error: "Failed to update playlist item" });
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
      res.status(201).json(result.rows[0]);
    } catch (error) {
      console.error("Assign playlist error:", error);
      res.status(500).json({ error: "Failed to assign playlist" });
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
      res.json(result.rows);
    } catch (error) {
      console.error("Fetch assignments error:", error);
      res.status(500).json({ error: "Failed to fetch assignments" });
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
      res.json({ message: "Assignment removed" });
    } catch (error) {
      console.error("Remove assignment error:", error);
      res.status(500).json({ error: "Failed to remove assignment" });
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
      const content = allMedia.map((item) => ({
        id: item.id,
        type: item.type,
        url: item.url,
        name: item.name,
        duration: item.duration || 10, // default 10 seconds per slide
      }));
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
      const content = allMedia.map((item) => ({
        id: item.id,
        type: item.type,
        url: item.url,
        name: item.name,
        duration: item.duration || 10,
      }));

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
                COALESCE((SELECT COUNT(*) FROM device_groups child WHERE child.parent_id = dg.id::text), 0)::int as subgroup_count
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
            contentUrl,
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
          playlist = await storage.getPlaylistItemsByTemplate(
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
      function buildNode(
        id: string,
        text: string,
        type: string,
        icon?: string,
      ): any {
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

  // Schedule Routes
  app.get("/api/schedule", async (req, res) => {
    try {
      const { templateId, deviceId, groupId } = req.query;
      let scheduleList: any[] = [];
      if (templateId) {
        scheduleList = await storage.getSchedulesByTemplate(
          templateId as string,
        );
      } else if (deviceId) {
        scheduleList = await storage.getSchedulesByDevice(deviceId as string);
      } else if (groupId) {
        scheduleList = await storage.getSchedulesByGroup(groupId as string);
      } else {
        scheduleList = await storage.getAllSchedules();
      }
      res.json(scheduleList);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch schedules" });
    }
  });

  app.post("/api/schedule", async (req, res) => {
    try {
      const { templateId, deviceId, groupId, startTime, endTime } = req.body;
      if (!templateId)
        return res.status(400).json({ error: "templateId is required" });
      if (!startTime || !endTime)
        return res
          .status(400)
          .json({ error: "startTime and endTime are required" });

      const schedule = await storage.createSchedule({
        templateId,
        deviceId: deviceId || null,
        groupId: groupId || null,
        startTime,
        endTime,
      });
      res.json({ message: "Schedule assigned", data: schedule });
    } catch (error) {
      res.status(500).json({ error: "Failed to create schedule" });
    }
  });

  app.delete("/api/schedule/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const deleted = await storage.deleteSchedule(id);
      if (!deleted) {
        return res.status(404).json({ error: "Schedule not found" });
      }
      res.json({ message: "Schedule deleted" });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete schedule" });
    }
  });

  // Content Schedule Routes (for FullCalendar)
  app.get("/api/schedule/list", async (_req, res) => {
    try {
      const schedules = await storage.getContentSchedules();
      const events = schedules.map((s) => ({
        id: s.id.toString(),
        title: s.contentId || "Untitled",
        start: s.start,
        end: s.end,
        extendedProps: { contentId: s.contentId },
      }));
      res.json(events);
    } catch (error) {
      console.error("Failed to fetch content schedules:", error);
      res.status(500).json({ error: "Failed to fetch schedules" });
    }
  });

  app.post("/api/schedule/save", async (req, res) => {
    try {
      const { id, contentId, start, end } = req.body;
      if (!start || !end) {
        return res.status(400).json({ error: "start and end are required" });
      }

      const startDate = new Date(start);
      const endDate = new Date(end);

      // Check for overlap
      const hasOverlap = await storage.checkScheduleOverlap(
        startDate,
        endDate,
        id ? parseInt(id) : undefined,
      );

      if (hasOverlap) {
        return res
          .status(409)
          .json({ error: "Time slot overlaps with existing content." });
      }

      if (id) {
        // Update existing
        const updated = await storage.updateContentSchedule(parseInt(id), {
          contentId,
          start: startDate,
          end: endDate,
        });
        res.json({ message: "Schedule updated", data: updated });
      } else {
        // Create new
        const created = await storage.createContentSchedule({
          contentId,
          start: startDate,
          end: endDate,
        });
        res.json({ message: "Schedule created", data: created });
      }
    } catch (error) {
      console.error("Failed to save schedule:", error);
      res.status(500).json({ error: "Failed to save schedule" });
    }
  });

  app.post("/api/schedule/updateTime", async (req, res) => {
    try {
      const { id, start, end } = req.body;
      if (!id || !start || !end) {
        return res
          .status(400)
          .json({ error: "id, start, and end are required" });
      }

      const startDate = new Date(start);
      const endDate = new Date(end);

      // Check for overlap (exclude current event)
      const hasOverlap = await storage.checkScheduleOverlap(
        startDate,
        endDate,
        parseInt(id),
      );

      if (hasOverlap) {
        return res
          .status(409)
          .json({ error: "Time slot overlaps with existing content." });
      }

      const updated = await storage.updateContentSchedule(parseInt(id), {
        start: startDate,
        end: endDate,
      });

      if (!updated) {
        return res.status(404).json({ error: "Schedule not found" });
      }

      res.json({ message: "Schedule time updated", data: updated });
    } catch (error) {
      console.error("Failed to update schedule time:", error);
      res.status(500).json({ error: "Failed to update schedule time" });
    }
  });

  // Player schedule download - returns local_schedule.json format
  app.get("/api/schedule/download/:deviceId", async (req, res) => {
    try {
      const { deviceId } = req.params;

      // Get schedules for this device
      const deviceSchedules = await storage.getSchedulesByDevice(deviceId);

      if (deviceSchedules.length === 0) {
        return res.json({ templates: [] });
      }

      // Get all media for content lookup
      const allMedia = await storage.getAllMedia();
      const mediaMap = new Map(allMedia.map((m) => [m.id.toString(), m]));

      // Group schedules by template
      const templateScheduleMap = new Map<string, any[]>();
      for (const sched of deviceSchedules) {
        if (!sched.templateId) continue;
        if (!templateScheduleMap.has(sched.templateId)) {
          templateScheduleMap.set(sched.templateId, []);
        }
        templateScheduleMap.get(sched.templateId)!.push({
          start_time: sched.startTime?.toString().slice(0, 5) || "00:00",
          end_time: sched.endTime?.toString().slice(0, 5) || "23:59",
        });
      }

      // Build templates array
      const templates = [];

      for (const [templateId, schedules] of Array.from(
        templateScheduleMap.entries(),
      )) {
        const template = await storage.getTemplate(templateId);
        if (!template) continue;

        // Get layout from template
        const layout = (template.layout || { zones: [] }) as { zones?: any[] };

        // Collect all playlist items across zones
        const playlistItemsMap = new Map<string, any>();
        const zonesWithIds = [];

        if (layout.zones) {
          for (const zone of layout.zones) {
            const playlistIds: string[] = [];
            for (const itemRef of zone.playlist || []) {
              const itemId = itemRef.toString();
              playlistIds.push(itemId);

              // Add to playlistItems if not already there
              if (!playlistItemsMap.has(itemId)) {
                const media = mediaMap.get(itemId);
                if (media) {
                  const ext = media.url.split(".").pop() || "";
                  const localPath =
                    media.type === "live"
                      ? ""
                      : `Content/${media.name.replace(/\s+/g, "_")}.${ext}`;
                  playlistItemsMap.set(itemId, {
                    id: itemId,
                    type: media.type,
                    url: media.url,
                    localPath: localPath,
                  });
                } else {
                  // Direct URL reference
                  const ext = itemRef.split(".").pop() || "jpg";
                  playlistItemsMap.set(itemId, {
                    id: itemId,
                    type: itemRef.includes(".mp4") ? "video" : "image",
                    url: itemRef,
                    localPath: `Content/${itemId}.${ext}`,
                  });
                }
              }
            }

            zonesWithIds.push({
              id: zone.id,
              x: zone.x,
              y: zone.y,
              width: zone.width,
              height: zone.height,
              playlist: playlistIds,
            });
          }
        }

        templates.push({
          id: template.id,
          layout: { zones: zonesWithIds },
          playlistItems: Array.from(playlistItemsMap.values()),
          schedule: schedules,
        });
      }

      res.json({ templates });
    } catch (error) {
      res.status(500).json({ error: "Failed to download schedule" });
    }
  });

  // Serve admin dashboard
  app.get("/admin", (_req, res) => {
    res.sendFile(path.join(process.cwd(), "public", "admin.html"));
  });

  // Get current user profile
  app.get("/api/me", async (req, res) => {
    const userId = (req as any).user?.id;
    if (!userId) return res.status(401).json({ error: "Not logged in" });

    try {
      const { rows } = await pool.query(
        `SELECT id, email, name, role, preferences
         FROM users
         WHERE id = $1`,
        [userId],
      );
      if (!rows.length)
        return res.status(404).json({ error: "User not found" });

      res.json(rows[0]);
    } catch (err) {
      console.error("get user error", err);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Update user preferences
  app.post("/api/me/preferences", async (req, res) => {
    const userId = (req as any).user?.id;
    if (!userId) return res.status(401).json({ error: "Not logged in" });

    const { darkMode, rtl, notifSound } = req.body;

    try {
      await pool.query(
        `UPDATE users
         SET preferences = COALESCE(preferences, '{}'::jsonb) || $1::jsonb
         WHERE id = $2`,
        [JSON.stringify({ darkMode, rtl, notifSound }), userId],
      );
      res.json({ success: true });
    } catch (err) {
      console.error("update preferences error", err);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Get latest notifications for current user (or global admin)
  app.get("/api/notifications/latest", async (req, res) => {
    const userId = (req as any).user?.id || null;

    try {
      const result = await pool.query(
        `SELECT id, level, title, message, device_id, created_at, is_read
         FROM notifications
         WHERE (user_id IS NULL OR user_id = $1)
         ORDER BY created_at DESC
         LIMIT 10`,
        [userId],
      );

      res.json(result.rows);
    } catch (err) {
      console.error("notifications latest error", err);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Unread count
  app.get("/api/notifications/unread-count", async (req, res) => {
    const userId = (req as any).user?.id || null;

    try {
      const { rows } = await pool.query(
        `SELECT COUNT(*) AS cnt
         FROM notifications
         WHERE (user_id IS NULL OR user_id = $1)
           AND is_read = false`,
        [userId],
      );
      res.json({ count: Number(rows[0].cnt) });
    } catch (err) {
      console.error("notifications count error", err);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Mark all as read
  app.post("/api/notifications/mark-read", async (req, res) => {
    const userId = (req as any).user?.id || null;

    try {
      await pool.query(
        `UPDATE notifications
         SET is_read = true
         WHERE (user_id IS NULL OR user_id = $1)
           AND is_read = false`,
        [userId],
      );
      res.json({ success: true });
    } catch (err) {
      console.error("notifications mark-read error", err);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Global search API
  app.get("/api/search", async (req, res) => {
    const q = ((req.query.q as string) || "").trim();
    if (!q) return res.json([]);

    const like = `%${q}%`;

    try {
      // Devices (screens)
      const devices = (
        await pool.query(
          `SELECT device_id, name, location
         FROM screens
         WHERE device_id ILIKE $1 OR name ILIKE $1 OR location ILIKE $1
         LIMIT 10`,
          [like],
        )
      ).rows.map((d: any) => ({
        type: "device",
        id: d.device_id,
        label: `📺 ${d.name || d.device_id} (${d.location || "Unknown"})`,
      }));

      // Groups
      const groups = (
        await pool.query(
          `SELECT id, name
         FROM device_groups
         WHERE name ILIKE $1
         LIMIT 10`,
          [like],
        )
      ).rows.map((g: any) => ({
        type: "group",
        id: g.id,
        label: `📂 ${g.name}`,
      }));

      // Content
      const content = (
        await pool.query(
          `SELECT id, name, type
         FROM contents
         WHERE name ILIKE $1
         LIMIT 10`,
          [like],
        )
      ).rows.map((c: any) => ({
        type: "content",
        id: c.id,
        label: `🎞 ${c.name} (${c.type || "content"})`,
      }));

      res.json([...devices, ...groups, ...content]);
    } catch (err) {
      console.error("search error", err);
      res.status(500).json({ error: "Server error" });
    }
  });

  // =====================================================
  // CONTENT SCHEDULES - Calendar Scheduling API
  // =====================================================

  // Get all schedules (with optional date range filter)
  app.get("/api/content-schedules", async (req, res) => {
    try {
      const { start, end, deviceId, groupId } = req.query;
      
      let query = `
        SELECT cs.*, 
          CASE 
            WHEN cs.content_type = 'media' THEN m.name
            WHEN cs.content_type = 'playlist' THEN cp.name
            WHEN cs.content_type = 'template' THEN t.name
          END as content_name,
          s.name as device_name,
          dg.name as group_name
        FROM content_schedules cs
        LEFT JOIN media m ON cs.content_type = 'media' AND cs.content_id = m.id::text
        LEFT JOIN content_playlists cp ON cs.content_type = 'playlist' AND cs.content_id = cp.id::text
        LEFT JOIN templates t ON cs.content_type = 'template' AND cs.content_id = t.id::text
        LEFT JOIN screens s ON cs.device_id = s.device_id
        LEFT JOIN device_groups dg ON cs.group_id = dg.id::text
        WHERE 1=1
      `;
      
      const params: any[] = [];
      let paramIndex = 1;
      
      if (start) {
        query += ` AND cs.end_time >= $${paramIndex}`;
        params.push(start);
        paramIndex++;
      }
      
      if (end) {
        query += ` AND cs.start_time <= $${paramIndex}`;
        params.push(end);
        paramIndex++;
      }
      
      if (deviceId) {
        query += ` AND cs.device_id = $${paramIndex}`;
        params.push(deviceId);
        paramIndex++;
      }
      
      if (groupId) {
        query += ` AND cs.group_id = $${paramIndex}`;
        params.push(groupId);
        paramIndex++;
      }
      
      query += ` ORDER BY cs.start_time ASC`;
      
      const result = await pool.query(query, params);
      res.json(result.rows);
    } catch (err) {
      console.error("Get schedules error:", err);
      res.status(500).json({ error: "Failed to get schedules" });
    }
  });

  // Create a new schedule
  app.post("/api/content-schedules", async (req, res) => {
    try {
      const { title, contentType, contentId, deviceId, groupId, startTime, endTime, allDay, repeatType, repeatEndDate, color } = req.body;
      
      if (!title || !contentType || !contentId || !startTime || !endTime) {
        return res.status(400).json({ error: "Missing required fields" });
      }
      
      const result = await pool.query(
        `INSERT INTO content_schedules 
          (title, content_type, content_id, device_id, group_id, start_time, end_time, all_day, repeat_type, repeat_end_date, color)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [title, contentType, contentId, deviceId || null, groupId || null, startTime, endTime, allDay || false, repeatType || 'none', repeatEndDate || null, color || '#3b82f6']
      );
      
      res.json(result.rows[0]);
    } catch (err) {
      console.error("Create schedule error:", err);
      res.status(500).json({ error: "Failed to create schedule" });
    }
  });

  // Update a schedule
  app.put("/api/content-schedules/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const { title, contentType, contentId, deviceId, groupId, startTime, endTime, allDay, repeatType, repeatEndDate, color } = req.body;
      
      const result = await pool.query(
        `UPDATE content_schedules SET
          title = COALESCE($1, title),
          content_type = COALESCE($2, content_type),
          content_id = COALESCE($3, content_id),
          device_id = $4,
          group_id = $5,
          start_time = COALESCE($6, start_time),
          end_time = COALESCE($7, end_time),
          all_day = COALESCE($8, all_day),
          repeat_type = COALESCE($9, repeat_type),
          repeat_end_date = $10,
          color = COALESCE($11, color),
          updated_at = NOW()
         WHERE id = $12
         RETURNING *`,
        [title, contentType, contentId, deviceId || null, groupId || null, startTime, endTime, allDay, repeatType, repeatEndDate || null, color, id]
      );
      
      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Schedule not found" });
      }
      
      res.json(result.rows[0]);
    } catch (err) {
      console.error("Update schedule error:", err);
      res.status(500).json({ error: "Failed to update schedule" });
    }
  });

  // Delete a schedule
  app.delete("/api/content-schedules/:id", async (req, res) => {
    try {
      const { id } = req.params;
      
      const result = await pool.query(
        `DELETE FROM content_schedules WHERE id = $1 RETURNING id`,
        [id]
      );
      
      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Schedule not found" });
      }
      
      res.json({ success: true, deletedId: id });
    } catch (err) {
      console.error("Delete schedule error:", err);
      res.status(500).json({ error: "Failed to delete schedule" });
    }
  });

  // Get content options for scheduling (media, playlists, templates)
  app.get("/api/content-options", async (req, res) => {
    try {
      const [mediaResult, playlistResult, templateResult] = await Promise.all([
        pool.query(`SELECT id, name, type, url FROM media WHERE is_expired = false ORDER BY name`),
        pool.query(`SELECT id, name, description FROM content_playlists ORDER BY name`),
        pool.query(`SELECT id, name FROM templates ORDER BY name`)
      ]);
      
      res.json({
        media: mediaResult.rows,
        playlists: playlistResult.rows,
        templates: templateResult.rows
      });
    } catch (err) {
      console.error("Get content options error:", err);
      res.status(500).json({ error: "Failed to get content options" });
    }
  });

  // ============== CLIENT MANAGEMENT ==============

  // List all clients
  app.get("/api/clients", async (_req, res) => {
    try {
      const result = await pool.query(
        `SELECT * FROM clients ORDER BY name ASC`
      );
      res.json(result.rows);
    } catch (err) {
      console.error("List clients error:", err);
      res.status(500).json({ error: "Failed to list clients" });
    }
  });

  // Get single client with notes
  app.get("/api/clients/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const clientResult = await pool.query(
        `SELECT * FROM clients WHERE id = $1`,
        [id]
      );
      
      if (clientResult.rowCount === 0) {
        return res.status(404).json({ error: "Client not found" });
      }
      
      const notesResult = await pool.query(
        `SELECT * FROM client_notes WHERE client_id = $1 ORDER BY created_at DESC`,
        [id]
      );
      
      res.json({
        ...clientResult.rows[0],
        notes: notesResult.rows
      });
    } catch (err) {
      console.error("Get client error:", err);
      res.status(500).json({ error: "Failed to get client" });
    }
  });

  // Create client
  app.post("/api/clients", async (req, res) => {
    try {
      const { name, phone, email, company, position } = req.body;
      
      if (!name) {
        return res.status(400).json({ error: "Name is required" });
      }
      
      const result = await pool.query(
        `INSERT INTO clients (name, phone, email, company, position) 
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [name, phone || null, email || null, company || null, position || null]
      );
      
      res.status(201).json(result.rows[0]);
    } catch (err) {
      console.error("Create client error:", err);
      res.status(500).json({ error: "Failed to create client" });
    }
  });

  // Update client
  app.put("/api/clients/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const { name, phone, email, company, position } = req.body;
      
      const result = await pool.query(
        `UPDATE clients SET 
          name = COALESCE($1, name),
          phone = $2,
          email = $3,
          company = $4,
          position = $5
         WHERE id = $6 RETURNING *`,
        [name, phone || null, email || null, company || null, position || null, id]
      );
      
      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Client not found" });
      }
      
      res.json(result.rows[0]);
    } catch (err) {
      console.error("Update client error:", err);
      res.status(500).json({ error: "Failed to update client" });
    }
  });

  // Delete client
  app.delete("/api/clients/:id", async (req, res) => {
    try {
      const { id } = req.params;
      
      const result = await pool.query(
        `DELETE FROM clients WHERE id = $1 RETURNING id`,
        [id]
      );
      
      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Client not found" });
      }
      
      res.json({ success: true, deletedId: id });
    } catch (err) {
      console.error("Delete client error:", err);
      res.status(500).json({ error: "Failed to delete client" });
    }
  });

  // ============== CLIENT NOTES ==============

  // List notes for a client
  app.get("/api/clients/:clientId/notes", async (req, res) => {
    try {
      const { clientId } = req.params;
      const result = await pool.query(
        `SELECT * FROM client_notes WHERE client_id = $1 ORDER BY created_at DESC`,
        [clientId]
      );
      res.json(result.rows);
    } catch (err) {
      console.error("List client notes error:", err);
      res.status(500).json({ error: "Failed to list notes" });
    }
  });

  // Create note for a client
  app.post("/api/clients/:clientId/notes", async (req, res) => {
    try {
      const { clientId } = req.params;
      const { note } = req.body;
      
      if (!note) {
        return res.status(400).json({ error: "Note content is required" });
      }
      
      const result = await pool.query(
        `INSERT INTO client_notes (client_id, note) VALUES ($1, $2) RETURNING *`,
        [clientId, note]
      );
      
      res.status(201).json(result.rows[0]);
    } catch (err) {
      console.error("Create note error:", err);
      res.status(500).json({ error: "Failed to create note" });
    }
  });

  // Update note
  app.put("/api/clients/:clientId/notes/:noteId", async (req, res) => {
    try {
      const { noteId } = req.params;
      const { note } = req.body;
      
      const result = await pool.query(
        `UPDATE client_notes SET note = $1 WHERE id = $2 RETURNING *`,
        [note, noteId]
      );
      
      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Note not found" });
      }
      
      res.json(result.rows[0]);
    } catch (err) {
      console.error("Update note error:", err);
      res.status(500).json({ error: "Failed to update note" });
    }
  });

  // Delete note
  app.delete("/api/clients/:clientId/notes/:noteId", async (req, res) => {
    try {
      const { noteId } = req.params;
      
      const result = await pool.query(
        `DELETE FROM client_notes WHERE id = $1 RETURNING id`,
        [noteId]
      );
      
      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Note not found" });
      }
      
      res.json({ success: true, deletedId: noteId });
    } catch (err) {
      console.error("Delete note error:", err);
      res.status(500).json({ error: "Failed to delete note" });
    }
  });

  // ============== CLIENT CUSTOM FIELDS ==============

  // List custom fields for a client
  app.get("/api/clients/:clientId/fields", async (req, res) => {
    try {
      const { clientId } = req.params;
      const result = await pool.query(
        `SELECT * FROM client_custom_fields WHERE client_id = $1 ORDER BY field_name`,
        [clientId]
      );
      res.json(result.rows);
    } catch (err) {
      console.error("List custom fields error:", err);
      res.status(500).json({ error: "Failed to list custom fields" });
    }
  });

  // Create custom field
  app.post("/api/clients/:clientId/fields", async (req, res) => {
    try {
      const { clientId } = req.params;
      const { fieldName, fieldValue } = req.body;
      
      if (!fieldName) {
        return res.status(400).json({ error: "Field name is required" });
      }
      
      const result = await pool.query(
        `INSERT INTO client_custom_fields (client_id, field_name, field_value) 
         VALUES ($1, $2, $3) RETURNING *`,
        [clientId, fieldName, fieldValue || null]
      );
      
      res.status(201).json(result.rows[0]);
    } catch (err) {
      console.error("Create custom field error:", err);
      res.status(500).json({ error: "Failed to create custom field" });
    }
  });

  // Update custom field
  app.put("/api/clients/:clientId/fields/:fieldId", async (req, res) => {
    try {
      const { fieldId } = req.params;
      const { fieldName, fieldValue } = req.body;
      
      const result = await pool.query(
        `UPDATE client_custom_fields SET field_name = $1, field_value = $2 WHERE id = $3 RETURNING *`,
        [fieldName, fieldValue, fieldId]
      );
      
      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Custom field not found" });
      }
      
      res.json(result.rows[0]);
    } catch (err) {
      console.error("Update custom field error:", err);
      res.status(500).json({ error: "Failed to update custom field" });
    }
  });

  // Delete custom field
  app.delete("/api/clients/:clientId/fields/:fieldId", async (req, res) => {
    try {
      const { fieldId } = req.params;
      
      const result = await pool.query(
        `DELETE FROM client_custom_fields WHERE id = $1 RETURNING id`,
        [fieldId]
      );
      
      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Custom field not found" });
      }
      
      res.json({ success: true, deletedId: fieldId });
    } catch (err) {
      console.error("Delete custom field error:", err);
      res.status(500).json({ error: "Failed to delete custom field" });
    }
  });

  // ============== CLIENT FILE ATTACHMENTS ==============

  // List attachments for a client
  app.get("/api/clients/:clientId/attachments", async (req, res) => {
    try {
      const { clientId } = req.params;
      const result = await pool.query(
        `SELECT * FROM client_attachments WHERE client_id = $1 ORDER BY created_at DESC`,
        [clientId]
      );
      res.json(result.rows);
    } catch (err) {
      console.error("List attachments error:", err);
      res.status(500).json({ error: "Failed to list attachments" });
    }
  });

  // Upload attachment
  app.post("/api/clients/:clientId/attachments", clientAttachmentUpload.single("file"), async (req, res) => {
    try {
      const { clientId } = req.params;
      const file = req.file;
      
      if (!file) {
        return res.status(400).json({ error: "No file uploaded" });
      }
      
      const result = await pool.query(
        `INSERT INTO client_attachments (client_id, filename, original_name, mime_type, size) 
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [clientId, file.filename, file.originalname, file.mimetype, file.size]
      );
      
      res.status(201).json(result.rows[0]);
    } catch (err) {
      console.error("Upload attachment error:", err);
      res.status(500).json({ error: "Failed to upload attachment" });
    }
  });

  // Download attachment
  app.get("/api/clients/:clientId/attachments/:attachmentId/download", async (req, res) => {
    try {
      const { clientId, attachmentId } = req.params;
      
      const result = await pool.query(
        `SELECT * FROM client_attachments WHERE id = $1 AND client_id = $2`,
        [attachmentId, clientId]
      );
      
      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Attachment not found" });
      }
      
      const attachment = result.rows[0];
      const filePath = path.join(clientAttachmentsDir, attachment.filename);
      
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: "File not found on disk" });
      }
      
      res.setHeader("Content-Disposition", `attachment; filename="${attachment.original_name}"`);
      res.setHeader("Content-Type", attachment.mime_type);
      res.sendFile(filePath);
    } catch (err) {
      console.error("Download attachment error:", err);
      res.status(500).json({ error: "Failed to download attachment" });
    }
  });

  // Delete attachment
  app.delete("/api/clients/:clientId/attachments/:attachmentId", async (req, res) => {
    try {
      const { clientId, attachmentId } = req.params;
      
      const result = await pool.query(
        `SELECT filename FROM client_attachments WHERE id = $1 AND client_id = $2`,
        [attachmentId, clientId]
      );
      
      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Attachment not found" });
      }
      
      const filename = result.rows[0].filename;
      const filePath = path.join(clientAttachmentsDir, filename);
      
      // Delete from database
      await pool.query(`DELETE FROM client_attachments WHERE id = $1 AND client_id = $2`, [attachmentId, clientId]);
      
      // Delete file from disk
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      
      res.json({ success: true, deletedId: attachmentId });
    } catch (err) {
      console.error("Delete attachment error:", err);
      res.status(500).json({ error: "Failed to delete attachment" });
    }
  });

  // Publish Jobs API
  app.get("/api/publish-jobs", async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT 
          id, 
          device_id as "deviceId", 
          device_name as "deviceName", 
          content_type as "contentType", 
          content_id as "contentId", 
          content_name as "contentName", 
          status, 
          progress, 
          total_bytes as "totalBytes", 
          downloaded_bytes as "downloadedBytes", 
          error_message as "errorMessage", 
          started_at as "startedAt", 
          completed_at as "completedAt"
        FROM publish_jobs ORDER BY started_at DESC LIMIT 100`
      );
      res.json(result.rows);
    } catch (err) {
      console.error("Get publish jobs error:", err);
      res.status(500).json({ error: "Failed to get publish jobs" });
    }
  });

  app.post("/api/publish-jobs", async (req, res) => {
    try {
      const { deviceId, deviceName, contentType, contentId, contentName, totalBytes } = req.body;
      
      if (!deviceId || !deviceName || !contentType || contentId === undefined || !contentName) {
        return res.status(400).json({ error: "Missing required fields" });
      }
      
      const result = await pool.query(
        `INSERT INTO publish_jobs (device_id, device_name, content_type, content_id, content_name, total_bytes) 
         VALUES ($1, $2, $3, $4, $5, $6) 
         RETURNING id, device_id as "deviceId", device_name as "deviceName", content_type as "contentType", 
                   content_id as "contentId", content_name as "contentName", status, progress, 
                   total_bytes as "totalBytes", started_at as "startedAt"`,
        [deviceId, deviceName, contentType, contentId, contentName, totalBytes || null]
      );
      res.status(201).json(result.rows[0]);
    } catch (err) {
      console.error("Create publish job error:", err);
      res.status(500).json({ error: "Failed to create publish job" });
    }
  });

  app.patch("/api/publish-jobs/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const { status, progress, downloadedBytes, errorMessage } = req.body;
      
      const validStatuses = ["pending", "downloading", "completed", "failed"];
      if (status !== undefined && !validStatuses.includes(status)) {
        return res.status(400).json({ error: "Invalid status value" });
      }
      if (progress !== undefined && (progress < 0 || progress > 100)) {
        return res.status(400).json({ error: "Progress must be between 0 and 100" });
      }
      
      const updates: string[] = [];
      const values: any[] = [];
      let paramCount = 1;
      
      if (status !== undefined) {
        updates.push(`status = $${paramCount++}`);
        values.push(status);
      }
      if (progress !== undefined) {
        updates.push(`progress = $${paramCount++}`);
        values.push(progress);
      }
      if (downloadedBytes !== undefined) {
        updates.push(`downloaded_bytes = $${paramCount++}`);
        values.push(downloadedBytes);
      }
      if (errorMessage !== undefined) {
        updates.push(`error_message = $${paramCount++}`);
        values.push(errorMessage);
      }
      if (status === "completed" || status === "failed") {
        updates.push(`completed_at = NOW()`);
      }
      
      if (updates.length === 0) {
        return res.status(400).json({ error: "No updates provided" });
      }
      
      values.push(id);
      const result = await pool.query(
        `UPDATE publish_jobs SET ${updates.join(", ")} WHERE id = $${paramCount} 
         RETURNING id, device_id as "deviceId", device_name as "deviceName", content_type as "contentType", 
                   content_id as "contentId", content_name as "contentName", status, progress, 
                   total_bytes as "totalBytes", downloaded_bytes as "downloadedBytes", 
                   error_message as "errorMessage", started_at as "startedAt", completed_at as "completedAt"`,
        values
      );
      
      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Publish job not found" });
      }
      
      res.json(result.rows[0]);
    } catch (err) {
      console.error("Update publish job error:", err);
      res.status(500).json({ error: "Failed to update publish job" });
    }
  });

  app.delete("/api/publish-jobs/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const result = await pool.query(`DELETE FROM publish_jobs WHERE id = $1 RETURNING id`, [id]);
      
      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Publish job not found" });
      }
      
      res.json({ success: true, deletedId: id });
    } catch (err) {
      console.error("Delete publish job error:", err);
      res.status(500).json({ error: "Failed to delete publish job" });
    }
  });

  return httpServer;
}
