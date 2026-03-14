/**
 * publish-jobs.routes.ts
 * Routes: /api/publish-jobs (CRUD + queue)
 *
 * Extracted from monolithic routes.ts.
 * Depends on: pool, broadcastPublishJobUpdate, auth middleware,
 *             toAbsoluteMediaUrl / absolutizeAssetUrl (_shared)
 */

import type { Express } from "express";
import { pool } from "../db";
import { broadcastPublishJobUpdate } from "../ws";
import { requireRole } from "../middleware/permissions";
import { authenticateJWT, authenticateUserOrDevice } from "../middleware/auth";
import { toAbsoluteMediaUrl, absolutizeAssetUrl } from "./_shared";

// ---------------------------------------------------------------------------
// DB migration: ensure files_downloaded / files_total columns exist
// ---------------------------------------------------------------------------
async function migratePublishJobsTable() {
  try {
    await pool.query(
      `ALTER TABLE publish_jobs ADD COLUMN IF NOT EXISTS files_downloaded INTEGER DEFAULT 0`,
    );
    await pool.query(
      `ALTER TABLE publish_jobs ADD COLUMN IF NOT EXISTS files_total INTEGER DEFAULT 0`,
    );
  } catch {
    /* columns already exist */
  }
}

// ---------------------------------------------------------------------------
// Helper: upsert an "instant" single-media device playlist
// (kept here because it's only used by /queue)
// ---------------------------------------------------------------------------
async function upsertInstantDevicePlaylist(
  client: any,
  deviceId: string,
  mediaId: number,
): Promise<{ playlistId: number; playlistName: string }> {
  const playlistName = `__instant__${deviceId}`;

  const existingPlaylist = await client.query(
    `SELECT id FROM content_playlists WHERE name = $1 ORDER BY id DESC LIMIT 1`,
    [playlistName],
  );

  let playlistId: number;

  if (existingPlaylist.rowCount && existingPlaylist.rows[0]?.id) {
    playlistId = Number(existingPlaylist.rows[0].id);
  } else {
    const created = await client.query(
      `INSERT INTO content_playlists (name, description, created_at, updated_at)
       VALUES ($1, $2, NOW(), NOW())
       RETURNING id`,
      [playlistName, `Instant publish playlist for ${deviceId}`],
    );
    playlistId = Number(created.rows[0].id);
  }

  // Replace the single item each time (instant publish = one piece of content)
  await client.query(`DELETE FROM playlist_items WHERE playlist_id = $1`, [playlistId]);
  await client.query(
    `INSERT INTO playlist_items (playlist_id, media_id, position, duration, volume, created_at)
     VALUES ($1, $2, 0, 10, 100, NOW())`,
    [playlistId, mediaId],
  );

  await client.query(
    `INSERT INTO playlist_assignments (playlist_id, device_id, assigned_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (playlist_id, device_id) DO UPDATE SET assigned_at = NOW()`,
    [playlistId, deviceId],
  );

  return { playlistId, playlistName };
}

// ---------------------------------------------------------------------------
// Register routes
// ---------------------------------------------------------------------------
export async function registerPublishJobRoutes(app: Express) {
  await migratePublishJobsTable();

  // GET /api/publish-jobs — list active jobs
  app.get("/api/publish-jobs", async (_req, res) => {
    try {
      const result = await pool.query(
        `SELECT
          id,
          device_id          AS "deviceId",
          device_name        AS "deviceName",
          content_type       AS "contentType",
          content_id         AS "contentId",
          content_name       AS "contentName",
          status,
          progress,
          total_bytes        AS "totalBytes",
          downloaded_bytes   AS "downloadedBytes",
          COALESCE(files_downloaded, 0) AS "filesDownloaded",
          COALESCE(files_total, 0)      AS "filesTotal",
          error_message      AS "errorMessage",
          started_at         AS "startedAt",
          completed_at       AS "completedAt"
        FROM publish_jobs
        WHERE status != 'archived'
        ORDER BY started_at DESC
        LIMIT 100`,
      );
      res.json(result.rows);
    } catch (err) {
      console.error("Get publish jobs error:", err);
      res.status(500).json({ error: "Failed to get publish jobs" });
    }
  });

  // POST /api/publish-jobs — simple create (no queue logic)
  app.post("/api/publish-jobs", async (req, res) => {
    try {
      const { deviceId, deviceName, contentType, contentId, contentName, totalBytes } =
        req.body;

      if (!deviceId || !deviceName || !contentType || contentId === undefined || !contentName) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      const result = await pool.query(
        `INSERT INTO publish_jobs
           (device_id, device_name, content_type, content_id, content_name, total_bytes)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING
           id,
           device_id    AS "deviceId",
           device_name  AS "deviceName",
           content_type AS "contentType",
           content_id   AS "contentId",
           content_name AS "contentName",
           status,
           progress,
           total_bytes  AS "totalBytes",
           started_at   AS "startedAt"`,
        [deviceId, deviceName, contentType, contentId, contentName, totalBytes || null],
      );
      res.status(201).json(result.rows[0]);
    } catch (err) {
      console.error("Create publish job error:", err);
      res.status(500).json({ error: "Failed to create publish job" });
    }
  });

  // POST /api/publish-jobs/queue — one-shot publish with playlist assignment + device command
  app.post(
    "/api/publish-jobs/queue",
    authenticateJWT,
    requireRole("admin", "manager"),
    async (req, res) => {
      const client = await pool.connect();
      try {
        const {
          deviceId,
          deviceName,
          contentType,
          contentId,
          contentName,
          contentUrl,
          totalBytes,
          playlistId: publishPlaylistId,
          templateId: publishTemplateId,
        } = req.body;

        if (!deviceId || !contentName) {
          return res.status(400).json({ error: "deviceId and contentName are required" });
        }

        const normalizedType = String(contentType || "media").trim().toLowerCase();
        const isPlaylistPublish = normalizedType === "playlist" && publishPlaylistId != null;
        const isTemplatePublish = normalizedType === "template" && publishTemplateId != null;
        const isMediaPublish = !isPlaylistPublish && !isTemplatePublish;

        if (isMediaPublish && !contentUrl) {
          return res.status(400).json({ error: "contentUrl is required for media publish" });
        }

        const normalizedContentType = String(contentType || "media").trim().toLowerCase();
        // For template publishes, contentId is a UUID — we store it separately
        // in device_template_assignments, so publish_jobs.content_id can be null
        const numericContentId =
          isTemplatePublish
            ? null
            : contentId == null || contentId === "" || !Number.isFinite(Number(contentId))
              ? null
              : Number(contentId);

        const screenResult = await client.query(
          `SELECT name FROM screens WHERE device_id = $1 LIMIT 1`,
          [deviceId],
        );
        const resolvedDeviceName =
          String(deviceName || screenResult.rows[0]?.name || deviceId).trim() || deviceId;

        const normalizedContentUrl =
          toAbsoluteMediaUrl(req, contentUrl) ||
          absolutizeAssetUrl(req, contentUrl) ||
          contentUrl;

        await client.query("BEGIN");

        // Deduplicate: skip if identical job was created in the last 30 seconds
        const duplicate = await client.query(
          `SELECT id, device_id AS "deviceId", device_name AS "deviceName",
                  content_type AS "contentType", content_id AS "contentId",
                  content_name AS "contentName", status, progress,
                  total_bytes AS "totalBytes", downloaded_bytes AS "downloadedBytes",
                  error_message AS "errorMessage", started_at AS "startedAt",
                  completed_at AS "completedAt"
           FROM publish_jobs
           WHERE device_id = $1
             AND COALESCE(content_id, -1) = COALESCE($2, -1)
             AND content_name = $3
             AND content_type = $4
             AND status IN ('pending', 'downloading')
             AND started_at > NOW() - INTERVAL '30 seconds'
           ORDER BY started_at DESC
           LIMIT 1`,
          [deviceId, numericContentId, contentName, normalizedContentType],
        );

        if (duplicate.rowCount && duplicate.rows[0]) {
          return res.status(200).json({
            success: true,
            duplicate: true,
            publishJob: duplicate.rows[0],
            queued: null,
          });
        }

        // Archive old completed / failed jobs for this device + content
        await client.query(
          `UPDATE publish_jobs SET status = 'archived'
           WHERE device_id = $1 AND content_name = $2 AND content_type = $3
             AND status IN ('completed', 'failed')`,
          [deviceId, contentName, normalizedContentType],
        );

        // Create new publish job
        const publishJob = await client.query(
          `INSERT INTO publish_jobs (
              device_id, device_name, content_type, content_id,
              content_name, total_bytes, status, progress, files_total
           )
           VALUES ($1, $2, $3, $4, $5, $6, 'pending', 0, COALESCE($7, 0))
           RETURNING
             id,
             device_id    AS "deviceId",
             device_name  AS "deviceName",
             content_type AS "contentType",
             content_id   AS "contentId",
             content_name AS "contentName",
             status, progress,
             total_bytes  AS "totalBytes",
             started_at   AS "startedAt"`,
          [
            deviceId,
            resolvedDeviceName,
            normalizedContentType,
            numericContentId,
            contentName,
            totalBytes ?? null,
            null,
          ],
        );

        if (!publishJob.rows[0]) {
          await client.query("ROLLBACK");
          console.error("Queue publish job: INSERT returned no rows");
          return res.status(500).json({ error: "Failed to create publish job" });
        }

        // Handle playlist / media / template assignment
        let instantPlaylist: { playlistId: number; playlistName: string } | null = null;

        if (isPlaylistPublish) {
          await client.query(
            `INSERT INTO playlist_assignments (playlist_id, device_id, assigned_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (playlist_id, device_id) DO UPDATE SET assigned_at = NOW()`,
            [Number(publishPlaylistId), deviceId],
          );
          instantPlaylist = { playlistId: Number(publishPlaylistId), playlistName: contentName };
        } else if (isMediaPublish && numericContentId != null) {
          instantPlaylist = await upsertInstantDevicePlaylist(client, deviceId, numericContentId);
        }

        if (isTemplatePublish && publishTemplateId != null) {
          // Write the template assignment — store UUID string directly
          await client.query(
            `INSERT INTO device_template_assignments (device_id, template_id, assigned_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (device_id) DO UPDATE SET template_id = $2, assigned_at = NOW()`,
            [deviceId, String(publishTemplateId)],
          ).catch(() => { /* table may not exist yet */ });

          // CRITICAL: Clear all playlist assignments for this device so the
          // template always wins.
          await client.query(
            `DELETE FROM playlist_assignments WHERE device_id = $1`,
            [deviceId],
          ).catch(() => {});
        }

        // Build and queue device command
        const payload: any = {
          type: isTemplatePublish
            ? "load_template"
            : isPlaylistPublish
            ? "refresh_playlist"
            : "play_content",
          contentId: isTemplatePublish ? String(publishTemplateId) : numericContentId,
          contentName,
          contentUrl: isMediaPublish ? normalizedContentUrl : null,
          contentType: normalizedContentType,
          publishJobId: String(publishJob.rows[0].id),
          refreshPlaylist: true,
          playlistId: isPlaylistPublish
            ? Number(publishPlaylistId)
            : (instantPlaylist?.playlistId ?? null),
          templateId: isTemplatePublish ? String(publishTemplateId) : null,
        };

        const command = await client.query(
          `INSERT INTO device_commands (device_id, payload, sent, executed)
           VALUES ($1, $2, false, false)
           RETURNING id, created_at`,
          [deviceId, JSON.stringify(payload)],
        );

        await client.query("COMMIT");

        return res.status(201).json({
          success: true,
          publishJob: publishJob.rows[0],
          commandId: command.rows[0].id,
          instantPlaylist,
          queued: payload,
        });
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        console.error("Queue publish job error:", err);
        return res.status(500).json({ error: "Failed to queue publish job" });
      } finally {
        client.release();
      }
    },
  );

  // PATCH /api/publish-jobs/:id — update progress (called by Android)
  app.patch("/api/publish-jobs/:id", authenticateUserOrDevice, async (req, res) => {
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
      let p = 1;

      if (status !== undefined)           { updates.push(`status = $${p++}`);             values.push(status); }
      if (progress !== undefined)          { updates.push(`progress = $${p++}`);            values.push(progress); }
      if (downloadedBytes !== undefined)   { updates.push(`downloaded_bytes = $${p++}`);    values.push(downloadedBytes); }
      if (req.body.filesDownloaded !== undefined) { updates.push(`files_downloaded = $${p++}`); values.push(req.body.filesDownloaded); }
      if (req.body.filesTotal !== undefined)      { updates.push(`files_total = $${p++}`);      values.push(req.body.filesTotal); }
      if (errorMessage !== undefined)      { updates.push(`error_message = $${p++}`);       values.push(errorMessage); }
      if (status === "completed" || status === "failed") updates.push(`completed_at = NOW()`);
      updates.push(`updated_at = NOW()`);

      if (values.length === 0) {
        return res.status(400).json({ error: "No updates provided" });
      }

      values.push(id);
      const result = await pool.query(
        `UPDATE publish_jobs
         SET ${updates.join(", ")}
         WHERE id = $${p}
         RETURNING
           id,
           device_id          AS "deviceId",
           device_name        AS "deviceName",
           content_type       AS "contentType",
           content_id         AS "contentId",
           content_name       AS "contentName",
           status, progress,
           total_bytes        AS "totalBytes",
           downloaded_bytes   AS "downloadedBytes",
           error_message      AS "errorMessage",
           started_at         AS "startedAt",
           completed_at       AS "completedAt"`,
        values,
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Publish job not found" });
      }

      const updatedJob = result.rows[0];
      broadcastPublishJobUpdate(updatedJob); // instant WS push to Monitor
      res.json(updatedJob);
    } catch (err) {
      console.error("Update publish job error:", err);
      res.status(500).json({ error: "Failed to update publish job" });
    }
  });

  // DELETE /api/publish-jobs/:id
  app.delete("/api/publish-jobs/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const result = await pool.query(
        `DELETE FROM publish_jobs WHERE id = $1 RETURNING id`,
        [id],
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Publish job not found" });
      }

      res.json({ success: true, deletedId: id });
    } catch (err) {
      console.error("Delete publish job error:", err);
      res.status(500).json({ error: "Failed to delete publish job" });
    }
  });
}
