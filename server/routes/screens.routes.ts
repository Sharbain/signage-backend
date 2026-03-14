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

export async function registerScreensRoutes(app: Express) {

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

      // Check for template assignment.
      // FIX: device_template_assignments.template_id is INTEGER but templates.id
      // is VARCHAR UUID. We resolve the UUID with a two-step query: get the
      // integer assignment id first, then look up the template UUID directly.
      const templateAssignResult = await pool.query(
        `SELECT template_id AS int_id, assigned_at AT TIME ZONE 'UTC' AS assigned_at
         FROM device_template_assignments
         WHERE device_id = $1
         ORDER BY assigned_at DESC LIMIT 1`,
        [deviceId],
      );

      let templateRow: { template_uuid: string; template_name: string; assigned_at: string } | null = null;
      if (templateAssignResult.rows.length > 0) {
        const intId = templateAssignResult.rows[0].int_id;
        const assignedAt = templateAssignResult.rows[0].assigned_at;
        // Look up the template UUID using numeric_id if the column exists,
        // otherwise fall back to selecting by creation order.
        const tRes = await pool.query(
          `SELECT id AS template_uuid, name AS template_name FROM templates
           WHERE numeric_id = $1 LIMIT 1`,
          [intId],
        ).catch(() => ({ rows: [] as any[] }));

        if (tRes.rows.length > 0) {
          templateRow = { ...tRes.rows[0], assigned_at: assignedAt };
        } else {
          // Fallback: row by insertion order (works when no numeric_id column yet)
          const tFallback = await pool.query(
            `SELECT id AS template_uuid, name AS template_name FROM templates
             ORDER BY created_at ASC LIMIT 1 OFFSET ($1::int - 1)`,
            [intId],
          ).catch(() => ({ rows: [] as any[] }));
          if (tFallback.rows.length > 0) {
            templateRow = { ...tFallback.rows[0], assigned_at: assignedAt };
          }
        }
      }

      // Resolve most recent assigned playlist
      const assignmentResult = await pool.query(
        `SELECT pa.playlist_id, pa.assigned_at AT TIME ZONE 'UTC' AS assigned_at,
                cp.name AS playlist_name, cp.description AS playlist_description
         FROM playlist_assignments pa
         JOIN content_playlists cp ON cp.id = pa.playlist_id
         WHERE pa.device_id = $1
         ORDER BY pa.assigned_at DESC, pa.id DESC
         LIMIT 1`,
        [deviceId],
      );

      const jobResult = await pool.query(
        `SELECT id FROM publish_jobs
         WHERE device_id = $1 AND status IN ('pending', 'downloading')
         ORDER BY started_at DESC LIMIT 1`,
        [deviceId],
      );

      const templateRow_resolved = templateRow;
      const playlistRow = assignmentResult.rows[0];

      // Template always wins if assigned — playlist assignments are cleared on template publish.
      // We keep the timestamp check as a secondary guard but template takes priority.
      if (templateRow_resolved) {
        return res.json({
          screen: { id: screen.id, deviceId: screen.deviceId, name: screen.name, resolution: screen.resolution },
          playlist: [],
          assignment: null,
          templateId: templateRow_resolved.template_uuid,
          templateName: templateRow_resolved.template_name,
          refreshInterval: 300,
          publishJobId: jobResult.rows[0]?.id ?? null,
        });
      }

      // No playlist assigned — return empty
      if (!playlistRow) {
        return res.json({
          screen: { id: screen.id, deviceId: screen.deviceId, name: screen.name, resolution: screen.resolution },
          playlist: [],
          assignment: null,
          refreshInterval: 300,
          publishJobId: jobResult.rows[0]?.id ?? null,
        });
      }

      const playlistId = Number(playlistRow.playlist_id);

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

      return res.json({
        screen: { id: screen.id, deviceId: screen.deviceId, name: screen.name, resolution: screen.resolution },
        assignment: {
          playlistId,
          playlistName: playlistRow.playlist_name,
          playlistDescription: playlistRow.playlist_description,
          assignedAt: playlistRow.assigned_at,
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

  // ---------------------------------------------------------------------------
  // Proof of Play — DB migration (runs once on startup, idempotent)
  // ---------------------------------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS proof_of_play (
      id            BIGSERIAL    PRIMARY KEY,
      device_id     TEXT         NOT NULL,
      media_id      INTEGER,
      media_name    TEXT         NOT NULL,
      media_type    TEXT,
      playlist_id   INTEGER,
      duration_ms   INTEGER,
      played_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_pop_device_played
    ON proof_of_play (device_id, played_at DESC)
  `);

  // ---------------------------------------------------------------------------
  // POST /api/devices/:deviceId/proof-of-play
  // Android calls this when each media item finishes playing.
  // Body: { mediaId?, mediaName, mediaType?, playlistId?, durationMs? }
  // Auth: device token (same as heartbeat)
  // ---------------------------------------------------------------------------
  app.post("/api/devices/:deviceId/proof-of-play", async (req, res) => {
    try {
      const deviceId = String(req.params.deviceId || "").trim();
      if (!deviceId) return res.status(400).json({ error: "missing_device_id" });

      const verified = await verifyDeviceTokenOrFail(req, res, deviceId);
      if (!verified) return;

      const { mediaId, mediaName, mediaType, playlistId, durationMs } = req.body;
      if (!mediaName) return res.status(400).json({ error: "mediaName is required" });

      const result = await pool.query(
        `INSERT INTO proof_of_play
           (device_id, media_id, media_name, media_type, playlist_id, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, played_at AS "playedAt"`,
        [
          deviceId,
          mediaId    ? Number(mediaId)    : null,
          mediaName,
          mediaType  ?? null,
          playlistId ? Number(playlistId) : null,
          durationMs ? Number(durationMs) : null,
        ],
      );

      return res.status(201).json({
        ok: true,
        id: result.rows[0].id,
        playedAt: result.rows[0].playedAt,
      });
    } catch (err) {
      console.error("proof-of-play error:", err);
      return res.status(500).json({ error: "failed_to_record_play" });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /api/devices/:deviceId/proof-of-play
  // Dashboard reads this to show playback history.
  // Query params: ?limit=50&before=<ISO timestamp>
  // Auth: JWT (dashboard)
  // ---------------------------------------------------------------------------
  app.get("/api/devices/:deviceId/proof-of-play", async (req, res) => {
    try {
      const deviceId = String(req.params.deviceId || "").trim();
      const limit  = Math.min(Number(req.query.limit ?? 50), 200);
      const before = req.query.before ? new Date(req.query.before as string) : null;

      const params: any[] = [deviceId, limit];
      let whereExtra = "";
      if (before && !isNaN(before.getTime())) {
        params.push(before);
        whereExtra = `AND played_at < $3`;
      }

      const result = await pool.query(
        `SELECT
           id,
           device_id   AS "deviceId",
           media_id    AS "mediaId",
           media_name  AS "mediaName",
           media_type  AS "mediaType",
           playlist_id AS "playlistId",
           duration_ms AS "durationMs",
           played_at   AS "playedAt"
         FROM proof_of_play
         WHERE device_id = $1 ${whereExtra}
         ORDER BY played_at DESC
         LIMIT $2`,
        params,
      );

      res.json(result.rows);
    } catch (err) {
      console.error("get proof-of-play error:", err);
      res.status(500).json({ error: "failed_to_get_play_log" });
    }
  });
}
