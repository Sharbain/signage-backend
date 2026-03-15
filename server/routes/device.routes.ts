import { Router } from "express";
import type { Express, Request, Response } from "express";
import { authenticateDevice } from "../middleware/auth";
import { pool } from "../db";

/**
 * Enterprise Device Routes (MDM backbone)
 *
 * PR-PHASE2: Consolidated singular + plural route aliases here.
 * Previously routes.ts had duplicate handlers at lines 1462-1527.
 * Those duplicates must be REMOVED from routes.ts — this file is
 * now the single source of truth for all device command routes.
 *
 * Routes registered (both singular legacy + plural canonical):
 *   POST /api/device/:deviceId/heartbeat
 *   GET  /api/device/:deviceId/commands
 *   GET  /api/devices/:deviceId/commands   ← canonical (Android uses this)
 *   POST /api/device/:deviceId/commands/:commandId/ack
 *   POST /api/devices/:deviceId/commands/:commandId/ack ← canonical
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

      const body = (req.body || {}) as Record<string, any>;
      const patch: Record<string, any> = {};

      if (typeof body.currentContent === "string") patch.currentContent = body.currentContent;
      if (typeof body.currentContentName === "string") patch.currentContentName = body.currentContentName;
      if (typeof body.temperature === "number") patch.temperature = body.temperature;
      if (typeof body.freeStorage === "number") patch.freeStorage = body.freeStorage;
      if (typeof body.batteryLevel === "number") patch.batteryLevel = body.batteryLevel;
      if (typeof body.signalStrength === "number") patch.signalStrength = body.signalStrength;
      if (typeof body.latitude === "number") patch.latitude = body.latitude;
      if (typeof body.longitude === "number") patch.longitude = body.longitude;
      if (Array.isArray(body.errors)) patch.errors = body.errors;

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
        const columns: string[] = [];
        const values: any[] = [deviceId];

        columns.push(`last_seen = NOW()`);
        columns.push(`is_online = TRUE`);
        columns.push(`status = COALESCE($2, status)`);
        values.push(typeof body.status === "string" ? body.status : null);

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

        return res.json({ ok: true });
      } catch (err) {
        console.error("heartbeat error:", err);
        return res.status(500).json({ error: "heartbeat_failed" });
      }
    },
  );

  // -------------------------------------------------------
  // GET commands — shared handler for both route variants
  // Android polls /api/devices/:deviceId/commands (plural)
  // Legacy clients use /api/device/:deviceId/commands (singular)
  // Both go to the same handler — single source of truth
  // -------------------------------------------------------
  const handleGetCommands = async (req: Request, res: Response) => {
    const deviceId = String(req.params.deviceId || "").trim();
    if (!deviceId) return res.status(400).json({ error: "missing_device_id" });

    try {
      await pool.query(
        `UPDATE screens
         SET last_seen = NOW(), is_online = TRUE, status = 'online'
         WHERE device_id = $1`,
        [deviceId],
      );

      const result = await pool.query(
        `SELECT id, payload
         FROM device_commands
         WHERE device_id = $1
           AND sent = FALSE
           AND executed = FALSE
         ORDER BY created_at ASC
         LIMIT 50`,
        [deviceId],
      );

      if (result.rows.length > 0) {
        const ids: number[] = result.rows
          .map((r: any) => Number(r.id))
          .filter((n) => Number.isFinite(n));

        if (ids.length > 0) {
          await pool.query(
            `UPDATE device_commands SET sent = TRUE WHERE id = ANY($1::int[])`,
            [ids],
          );
        }
      }

      const out = result.rows.map((r: any) => {
        let payload: any = r.payload;
        if (typeof payload === "string") {
          try { payload = JSON.parse(payload); } catch { payload = { payload }; }
        }
        if (!payload || typeof payload !== "object") payload = { payload };
        return { id: r.id, ...payload };
      });

      return res.json(out);
    } catch (err) {
      console.error("Error fetching commands:", err);
      return res.json([]); // enterprise resilience: never crash player
    }
  };

  router.get("/device/:deviceId/commands",  authenticateDevice, handleGetCommands);
  router.get("/devices/:deviceId/commands", authenticateDevice, handleGetCommands);

  // -------------------------------------------------------
  // POST ack — shared handler for both route variants
  // -------------------------------------------------------
  const handleAck = async (req: Request, res: Response) => {
    const deviceId  = String(req.params.deviceId || "").trim();
    const commandId = Number(req.params.commandId);

    if (!deviceId) return res.status(400).json({ error: "missing_device_id" });
    if (!Number.isFinite(commandId)) return res.status(400).json({ error: "invalid_command_id" });

    try {
      await pool.query(
        `UPDATE screens
         SET last_seen = NOW(), is_online = TRUE, status = 'online'
         WHERE device_id = $1`,
        [deviceId],
      );

      const result = await pool.query(
        `UPDATE device_commands
         SET executed = TRUE, executed_at = NOW()
         WHERE id = $1 AND device_id = $2
         RETURNING id`,
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
  };

  router.post("/device/:deviceId/commands/:commandId/ack",  authenticateDevice, handleAck);
  router.post("/devices/:deviceId/commands/:commandId/ack", authenticateDevice, handleAck);

  app.use("/api", router);
}
