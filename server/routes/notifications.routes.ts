/**
 * notifications.routes.ts
 *
 * API for managing org notification settings and reading in-app notifications.
 *
 * Endpoints:
 *   GET  /api/notifications              — list unread in-app notifications
 *   POST /api/notifications/:id/read     — mark notification as read
 *   POST /api/notifications/read-all     — mark all as read
 *   GET  /api/notifications/settings     — get org notification settings
 *   PUT  /api/notifications/settings     — update org notification settings
 *   POST /api/notifications/test         — send a test alert to all channels
 */

import type { Express, Request, Response } from "express";
import { authenticateJWT } from "../middleware/auth";
import { requireRole } from "../middleware/permissions";
import { pool } from "../db";
import { fireAlert } from "../alertEngine";

export function registerNotificationRoutes(app: Express) {

  // ── In-app notifications ───────────────────────────────────────────────────

  app.get(
    "/api/notifications",
    authenticateJWT,
    async (req: Request, res: Response) => {
      try {
        const orgId = req.user?.orgId;
        const limit = Math.min(Number(req.query.limit ?? 50), 200);
        const unreadOnly = req.query.unread === "true";

        let query = `
          SELECT id, type, level, title, message, device_id,
                 is_read, created_at, payload
          FROM notifications
          WHERE 1=1
        `;
        const params: any[] = [];
        let idx = 1;

        if (orgId) {
          query += ` AND org_id = $${idx++}`;
          params.push(orgId);
        }
        if (unreadOnly) {
          query += ` AND is_read = false`;
        }

        query += ` ORDER BY created_at DESC LIMIT $${idx++}`;
        params.push(limit);

        const result = await pool.query(query, params);
        return res.json(result.rows);
      } catch (err) {
        console.error("GET /api/notifications error:", err);
        return res.status(500).json({ error: "Failed to fetch notifications" });
      }
    },
  );

  app.post(
    "/api/notifications/:id/read",
    authenticateJWT,
    async (req: Request, res: Response) => {
      try {
        const { id } = req.params;
        await pool.query(
          `UPDATE notifications SET is_read = true WHERE id = $1`,
          [id],
        );
        return res.json({ ok: true });
      } catch (err) {
        console.error("POST /api/notifications/:id/read error:", err);
        return res.status(500).json({ error: "Failed to mark notification read" });
      }
    },
  );

  app.post(
    "/api/notifications/read-all",
    authenticateJWT,
    async (req: Request, res: Response) => {
      try {
        const orgId = req.user?.orgId;
        await pool.query(
          `UPDATE notifications SET is_read = true WHERE org_id = $1`,
          [orgId],
        );
        return res.json({ ok: true });
      } catch (err) {
        console.error("POST /api/notifications/read-all error:", err);
        return res.status(500).json({ error: "Failed to mark all notifications read" });
      }
    },
  );

  // ── Notification settings ──────────────────────────────────────────────────

  app.get(
    "/api/notifications/settings",
    authenticateJWT,
    requireRole("admin", "manager"),
    async (req: Request, res: Response) => {
      try {
        const orgId = req.user?.orgId;
        if (!orgId) return res.status(400).json({ error: "No org context" });

        const result = await pool.query(
          `SELECT settings FROM organizations WHERE id = $1 LIMIT 1`,
          [orgId],
        );

        const settings = result.rows[0]?.settings ?? {};
        const notifications = settings.notifications ?? {
          inApp:   { enabled: true },
          email:   { enabled: false, addresses: [] },
          webhook: { enabled: false, url: "" },
        };

        return res.json(notifications);
      } catch (err) {
        console.error("GET /api/notifications/settings error:", err);
        return res.status(500).json({ error: "Failed to fetch settings" });
      }
    },
  );

  app.put(
    "/api/notifications/settings",
    authenticateJWT,
    requireRole("admin"),
    async (req: Request, res: Response) => {
      try {
        const orgId = req.user?.orgId;
        if (!orgId) return res.status(400).json({ error: "No org context" });

        const { inApp, email, webhook } = req.body;

        // Validate webhook URL if provided
        if (webhook?.enabled && webhook?.url) {
          try { new URL(webhook.url); } catch {
            return res.status(400).json({ error: "Invalid webhook URL" });
          }
        }

        // Merge into existing org settings (preserve other settings keys)
        await pool.query(
          `UPDATE organizations
           SET settings = jsonb_set(
             COALESCE(settings, '{}'),
             '{notifications}',
             $2::jsonb
           )
           WHERE id = $1`,
          [
            orgId,
            JSON.stringify({
              inApp:   { enabled: inApp?.enabled   ?? true },
              email:   {
                enabled:   email?.enabled   ?? false,
                addresses: email?.addresses ?? [],
              },
              webhook: {
                enabled: webhook?.enabled ?? false,
                url:     webhook?.url     ?? "",
                secret:  webhook?.secret  ?? "",
              },
            }),
          ],
        );

        return res.json({ ok: true, message: "Notification settings updated" });
      } catch (err) {
        console.error("PUT /api/notifications/settings error:", err);
        return res.status(500).json({ error: "Failed to update settings" });
      }
    },
  );

  // ── Test alert ─────────────────────────────────────────────────────────────

  app.post(
    "/api/notifications/test",
    authenticateJWT,
    requireRole("admin"),
    async (req: Request, res: Response) => {
      try {
        const orgId = req.user?.orgId;
        if (!orgId) return res.status(400).json({ error: "No org context" });

        // Get any device from this org for the test
        const deviceResult = await pool.query(
          `SELECT device_id, name FROM screens WHERE org_id = $1 LIMIT 1`,
          [orgId],
        );

        const device = deviceResult.rows[0];
        if (!device) {
          return res.status(400).json({ error: "No devices found for this org" });
        }

        // Force fire a test alert bypassing cooldown
        await fireAlert({
          type:       "device_offline",
          severity:   "warning",
          deviceId:   device.device_id,
          deviceName: device.name,
          orgId,
          meta:       { test: true, message: "This is a test alert from Lumina Signage" },
        });

        return res.json({ ok: true, message: "Test alert sent to all enabled channels" });
      } catch (err) {
        console.error("POST /api/notifications/test error:", err);
        return res.status(500).json({ error: "Failed to send test alert" });
      }
    },
  );
}
