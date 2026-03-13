/**
 * screens.routes.ts
 * Android-facing endpoints: registration, playlist fetch, heartbeat.
 *
 * Extracted from monolithic routes.ts.
 */

import type { Express, Request, Response } from "express";
import { randomUUID } from "crypto";
import bcrypt from "bcrypt";
import { pool } from "../db";
import { storage, saveDeviceStatus } from "../storage";
import { normalizeMediaRow, verifyDeviceTokenOrFail } from "./_shared";

export function registerScreensRoutes(app: Express) {

  // ---------------------------------------------------------------------------
  // POST /api/screens/register — device self-registration
  // POST /api/device/register  — legacy alias
  // ---------------------------------------------------------------------------
  async function handleDeviceRegister(req: Request, res: Response) {
    try {
      const { deviceId, name, resolution, location } = req.body;
      if (!deviceId) return res.status(400).json({ error: "deviceId is required" });

      const existingScreen = await storage.getScreenByDeviceId(deviceId);
      if (existingScreen) {
        let deviceToken: string | null = null;
        if (!existingScreen.password) {
          deviceToken = randomUUID();
          const hash = await bcrypt.hash(deviceToken, 10);
          await storage.updateScreen(existingScreen.id, { password: hash } as any);
        }
        const updated = await storage.updateScreen(existingScreen.id, {
          lastSeen: new Date(),
          status: "online",
        });
        return res.json({ message: "Device reconnected", screen: updated, deviceToken });
      }

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
  }

  app.post("/api/screens/register", handleDeviceRegister);
  app.post("/api/device/register", handleDeviceRegister);

  // ---------------------------------------------------------------------------
  // GET /api/screens/:deviceId/playlist — primary Android playlist endpoint
  // ---------------------------------------------------------------------------
  app.get("/api/screens/:deviceId/playlist", async (req, res) => {
    try {
      const deviceId = String(req.params.deviceId || "").trim();
      if (!deviceId) return res.status(400).json({ error: "missing_device_id" });

      const verified = await verifyDeviceTokenOrFail(req, res, deviceId);
      if (!verified) return;

      const { screen } = verified;

      // Treat playlist fetch as a heartbeat
      await storage.updateScreen(screen.id, { lastSeen: new Date(), status: "online" });
      await pool.query(
        `UPDATE screens
         SET last_seen = NOW(), last_seen_at = NOW(), is_online = TRUE, status = 'online', updated_at = NOW()
         WHERE device_id = $1`,
        [deviceId],
      );

      // Resolve most recent assigned playlist
      const assignmentResult = await pool.query(
        `SELECT pa.playlist_id, pa.assigned_at,
                cp.name AS playlist_name, cp.description AS playlist_description
         FROM playlist_assignments pa
         JOIN content_playlists cp ON cp.id = pa.playlist_id
         WHERE pa.device_id = $1
         ORDER BY pa.assigned_at DESC, pa.id DESC
         LIMIT 1`,
        [deviceId],
      );

      // No playlist assigned — return empty + any active publish job id
      if (assignmentResult.rowCount === 0) {
        const jobResult = await pool.query(
          `SELECT id FROM publish_jobs
           WHERE device_id = $1 AND status IN ('pending', 'downloading')
           ORDER BY started_at DESC LIMIT 1`,
          [deviceId],
        );
        return res.json({
          screen: { id: screen.id, deviceId: screen.deviceId, name: screen.name, resolution: screen.resolution },
          playlist: [],
          assignment: null,
          refreshInterval: 300,
          publishJobId: jobResult.rows[0]?.id ?? null,
        });
      }

      const assignment = assignmentResult.rows[0];
      const playlistId = Number(assignment.playlist_id);

      const itemsResult = await pool.query(
        `SELECT
           pi.id AS item_id, pi.playlist_id, pi.media_id, pi.position,
           COALESCE(pi.duration, 10) AS duration,
           COALESCE(pi.volume, 100)  AS volume,
           m.id, m.name, m.type, m.url
         FROM playlist_items pi
         JOIN media m ON m.id = pi.media_id
         WHERE pi.playlist_id = $1
         ORDER BY pi.position ASC, pi.id ASC`,
        [playlistId],
      );

      const playlist = itemsResult.rows.map((row: any) =>
        normalizeMediaRow(req, {
          id: row.id,
          itemId: row.item_id,
          mediaId: row.media_id,
          playlistId: row.playlist_id,
          position: row.position,
          duration: row.duration,
          volume: row.volume,
          type: row.type,
          url: row.url,
          name: row.name,
        }),
      );

      const jobResult = await pool.query(
        `SELECT id FROM publish_jobs
         WHERE device_id = $1 AND status IN ('pending', 'downloading')
         ORDER BY started_at DESC LIMIT 1`,
        [deviceId],
      );

      return res.json({
        screen: { id: screen.id, deviceId: screen.deviceId, name: screen.name, resolution: screen.resolution },
        assignment: {
          playlistId,
          playlistName: assignment.playlist_name,
          playlistDescription: assignment.playlist_description,
          assignedAt: assignment.assigned_at,
        },
        playlist,
        refreshInterval: 300,
        publishJobId: jobResult.rows[0]?.id ?? null,
      });
    } catch (error) {
      console.error("playlist fetch error:", error);
      return res.status(500).json({ error: "Failed to fetch playlist" });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /api/devices/:deviceId/heartbeat  (canonical)
  // POST /api/device/:deviceId/heartbeat   (legacy alias)
  // ---------------------------------------------------------------------------
  async function handleDeviceHeartbeat(req: Request, res: Response) {
    try {
      const deviceId = String(req.params.deviceId || "").trim();
      if (!deviceId) return res.status(400).json({ error: "missing_device_id" });

      const verified = await verifyDeviceTokenOrFail(req, res, deviceId);
      if (!verified) return;

      const { screen } = verified;
      const body: any = req.body && typeof req.body === "object" ? req.body : {};

      // Flexible field mapping — supports older and newer client payloads
      const brightness     = body.brightness ?? body.displayBrightness ?? null;
      const volume         = body.volume ?? body.audioVolume ?? null;
      const screenState    = body.screenState ?? body.screen_state ?? body.playbackState ?? null;
      const apkVersion     = body.apkVersion ?? body.apk_version ?? body.appVersion ?? body.app_version ?? body?.app?.version ?? null;
      const temperature    = body.temperature ?? body.temp ?? null;
      const freeStorage    = body.freeStorage ?? body.free_storage ?? body?.storage?.freeMb ?? body?.storage?.free_storage_mb ?? null;
      const totalStorage   = body.totalStorage ?? body.total_storage ?? body?.storage?.totalMb ?? body?.storage?.total_storage_mb ?? null;
      const signalStrength = body.signalStrength ?? body.signal_strength ?? body.rssi ?? null;
      const uptime         = body.uptime ?? body.upTime ?? null;
      const localIp        = body.localIp ?? body.local_ip ?? null;
      const publicIp       = body.publicIp ?? body.public_ip ?? null;
      const latitude       = body.latitude ?? body.lat ?? body?.location?.latitude ?? null;
      const longitude      = body.longitude ?? body.lng ?? body.lon ?? body?.location?.longitude ?? null;
      const currentUrl     = (body.currentUrl ?? body.current_url ?? body?.playback?.currentUrl ?? null) as string | null;
      const lastError      = body?.playback?.lastError ?? body?.lastError ?? body?.last_error ?? null;

      const ip =
        String(req.headers["x-forwarded-for"] || "").split(",")[0]?.trim() ||
        (req.socket as any)?.remoteAddress ||
        null;

      await storage.updateScreen(screen.id, { lastSeen: new Date(), status: "online" });

      await pool.query(
        `UPDATE screens SET
           last_seen = NOW(), status = 'online', is_online = TRUE,
           brightness       = COALESCE($1,  brightness),
           volume           = COALESCE($2,  volume),
           screen_state     = COALESCE($3,  screen_state),
           apk_version      = COALESCE($4,  apk_version),
           temperature      = COALESCE($5,  temperature),
           free_storage     = COALESCE($6,  free_storage),
           total_storage    = COALESCE($7,  total_storage),
           signal_strength  = COALESCE($8,  signal_strength),
           uptime           = COALESCE($9,  uptime),
           local_ip         = COALESCE($10, local_ip),
           public_ip        = COALESCE($11, public_ip),
           latitude         = COALESCE($13, latitude),
           longitude        = COALESCE($14, longitude)
         WHERE device_id = $12`,
        [brightness, volume, screenState, apkVersion, temperature, freeStorage,
         totalStorage, signalStrength, uptime, localIp, publicIp, deviceId, latitude, longitude],
      );

      const errors: string[] = [];
      if (Array.isArray(body?.errors)) errors.push(...body.errors.map((x: any) => String(x)));
      if (lastError) errors.push(String(lastError));

      await saveDeviceStatus({
        device_id: deviceId,
        deviceId,
        isOnline: true,
        ip,
        appVersion: apkVersion,
        currentUrl,
        freeStorage: freeStorage == null ? null : Number(freeStorage),
        errors: errors.length ? errors : null,
        timestamp: Date.now(),
        payload: body,
      } as any);

      return res.json({ ok: true, serverTime: new Date().toISOString() });
    } catch (err) {
      console.error("heartbeat error:", err);
      return res.status(500).json({ error: "heartbeat_failed" });
    }
  }

  app.post("/api/devices/:deviceId/heartbeat", handleDeviceHeartbeat);
  app.post("/api/device/:deviceId/heartbeat",  handleDeviceHeartbeat);
}
