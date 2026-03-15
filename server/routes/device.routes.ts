import { Router } from "express";
import type { Express, Request, Response } from "express";
import { authenticateDevice } from "../middleware/auth";
import { pool } from "../db";
import { alertDeviceOnline } from "../alertEngine";

/**
 * Enterprise Device Routes (MDM backbone)
 * - Heartbeat: device reports status/metrics, server marks online + last_seen.
 * - Commands poll: device pulls unsent commands, server marks them sent (delivered).
 * - Commands ack: device confirms executed, server marks executed + executed_at.
 *
 * NOTE:
 * - device_commands.id is SERIAL (integer) in shared/schema.ts
 * - device_commands.device_id is TEXT (DEV-xxxx)
 */
export function registerDeviceRoutes(app: Express) {
  const router = Router();

  // -------------------------------------------------------
  // POST /api/device/:deviceId/heartbeat  (DEVICE AUTH)
  // -------------------------------------------------------
  router.post(
    "/device/:deviceId/heartbeat",
    authenticateDevice,
    async (req: Request, res: Response) => {
      const deviceId = String(req.params.deviceId || "").trim();
      if (!deviceId) return res.status(400).json({ error: "missing_device_id" });

      // Optional fields device may send (keep flexible)
      const body = (req.body || {}) as Record<string, any>;
      const patch: Record<string, any> = {};

      // "enterprise tolerant" updates: only set if provided
      if (typeof body.currentContent === "string") patch.currentContent = body.currentContent;
      if (typeof body.currentContentName === "string") patch.currentContentName = body.currentContentName;
      if (typeof body.temperature === "number") patch.temperature = body.temperature;
      if (typeof body.freeStorage === "number") patch.freeStorage = body.freeStorage;
      if (typeof body.batteryLevel === "number") patch.batteryLevel = body.batteryLevel;
      if (typeof body.signalStrength === "number") patch.signalStrength = body.signalStrength;
      if (typeof body.latitude === "number") patch.latitude = body.latitude;
      if (typeof body.longitude === "number") patch.longitude = body.longitude;
      if (Array.isArray(body.errors)) patch.errors = body.errors;

      // Explicit allowlist: maps body key -> exact DB column name
      // NEVER interpolate user-supplied keys into SQL directly
      const ALLOWED_PATCH_COLUMNS: Record<string, string> = {
        currentContent:     "current_content",
        currentContentName: "current_content_name",
        temperature:        "temperature",
        freeStorage:        "free_storage",
        batteryLevel:       "battery_level",
        signalStrength:     "signal_strength",
        latitude:           "latitude",
        longitude:          "longitude",
        errors:             "errors",
      };

      try {
        // Check if device was previously offline — needed for "back online" alert
        const prev = await pool.query(
          `SELECT is_online, name, org_id FROM screens WHERE device_id = $1 LIMIT 1`,
          [deviceId],
        );
        const wasOffline = prev.rows[0] && prev.rows[0].is_online === false;
        const deviceName = prev.rows[0]?.name ?? deviceId;
        const orgId      = prev.rows[0]?.org_id ?? null;

        // Mark online + last_seen always
        const columns: string[] = [];
        const values: any[] = [deviceId];

        // base columns (always)
        columns.push(`last_seen = NOW()`);
        columns.push(`is_online = TRUE`);
        columns.push(`status = COALESCE($2, status)`);
        values.push(typeof body.status === "string" ? body.status : null);

        // Safe patch: only whitelisted body keys, mapped to known column names
        let idx = values.length + 1;
        for (const [bodyKey, colName] of Object.entries(ALLOWED_PATCH_COLUMNS)) {
          if (patch[bodyKey] === undefined) continue;
          columns.push(`${colName} = $${idx}`);
          values.push(patch[bodyKey]);
          idx++;
        }

        await pool.query(
          `UPDATE screens SET ${columns.join(", ")} WHERE device_id = $1`,
          values,
        );

        // Fire "device back online" alert if it was previously offline
        if (wasOffline && orgId) {
          alertDeviceOnline(deviceId, deviceName, orgId).catch(
            (err) => console.error("[heartbeat] alertDeviceOnline failed:", err),
          );
        }

        return res.json({ ok: true });
      } catch (err) {
        console.error("heartbeat error:", err);
        return res.status(500).json({ error: "heartbeat_failed" });
      }
    },
  );

  // -------------------------------------------------------
  // GET /api/device/:deviceId/commands  (DEVICE AUTH)
  // - fetch unsent commands
  // - mark them sent=true
  // - return normalized payloads (id + payload spread)
  // -------------------------------------------------------
  router.get(
    "/device/:deviceId/commands",
    authenticateDevice,
    async (req: Request, res: Response) => {
      const deviceId = String(req.params.deviceId || "").trim();
      if (!deviceId) return res.status(400).json({ error: "missing_device_id" });

      try {
        // heartbeat on poll too (simple & reliable)
        await pool.query(
          `
          UPDATE screens
          SET last_seen = NOW(),
              is_online = TRUE,
              status = 'online'
          WHERE device_id = $1
          `,
          [deviceId],
        );

        const result = await pool.query(
          `
          SELECT id, payload
          FROM device_commands
          WHERE device_id = $1
            AND sent = FALSE
            AND executed = FALSE
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
              SET sent = TRUE
              WHERE id = ANY($1::int[])
              `,
              [ids],
            );
          }
        }

        const out = result.rows.map((r: any) => {
          // payload is jsonb -> usually already an object
          let payload: any = r.payload;

          // tolerate string payloads (legacy)
          if (typeof payload === "string") {
            try {
              payload = JSON.parse(payload);
            } catch {
              payload = { payload };
            }
          }

          if (!payload || typeof payload !== "object") payload = { payload };

          return { id: r.id, ...payload };
        });

        return res.json(out);
      } catch (err) {
        console.error("Error fetching commands:", err);
        // enterprise resilience: never crash player
        return res.json([]);
      }
    },
  );

  // -------------------------------------------------------
  // POST /api/device/:deviceId/commands/:commandId/ack (DEVICE AUTH)
  // Body can include { ok: true/false, error?: string, meta?: any }
  // -------------------------------------------------------
  router.post(
    "/device/:deviceId/commands/:commandId/ack",
    authenticateDevice,
    async (req: Request, res: Response) => {
      const deviceId = String(req.params.deviceId || "").trim();
      const commandId = Number(req.params.commandId);

      if (!deviceId) return res.status(400).json({ error: "missing_device_id" });
      if (!Number.isFinite(commandId)) return res.status(400).json({ error: "invalid_command_id" });

      try {
        // heartbeat on ack too
        await pool.query(
          `
          UPDATE screens
          SET last_seen = NOW(),
              is_online = TRUE,
              status = 'online'
          WHERE device_id = $1
          `,
          [deviceId],
        );

        const result = await pool.query(
          `
          UPDATE device_commands
          SET executed = TRUE,
              executed_at = NOW()
          WHERE id = $1
            AND device_id = $2
          RETURNING id
          `,
          [commandId, deviceId],
        );

        if (result.rowCount === 0) {
          return res.status(404).json({ error: "command_not_found" });
        }

        return res.json({ ok: true, commandId });
      } catch (err) {
        console.error("ack error:", err);
        return res.status(500).json({ error: "ack_failed" });
      }
    },
  );

  // Keep existing mount style stable:
  app.use("/api", router);
}
