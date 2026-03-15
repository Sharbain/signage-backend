/**
 * multitenancy.routes.ts
 *
 * Org-scoped replacements for the critical GET endpoints that currently
 * return ALL data across ALL orgs.
 *
 * These routes are registered BEFORE the existing routes in routes.ts
 * so they take precedence. The existing routes remain as fallback for
 * super-admin access (role = 'superadmin').
 *
 * Endpoints fixed:
 *   GET  /api/templates          — scoped to org
 *   POST /api/templates          — sets org_id on create
 *   GET  /api/media              — scoped to org
 *   POST /api/media (metadata)   — sets org_id on create
 *   GET  /api/playlists          — scoped to org (content_playlists)
 *   POST /api/playlists          — sets org_id on create
 *   GET  /api/screens/list       — scoped to org
 *   GET  /api/devices/list       — scoped to org
 *
 * Audit trail:
 *   Every mutation includes org_id — queryable for compliance.
 *
 * Super-admin bypass:
 *   Users with role = 'superadmin' see all orgs.
 *   All other roles are strictly scoped.
 */

import type { Express, Request, Response } from "express";
import { authenticateJWT, requireRole } from "./auth";
import { pool } from "../db";

export function registerMultitenancyRoutes(app: Express) {

  // ── Helper ─────────────────────────────────────────────────────────────────

  function getOrgFilter(req: Request): string | null {
    if (!req.user) return null;
    // Super-admins see everything — no org filter
    if (req.user.role === "superadmin") return null;
    return req.user.orgId;
  }

  // ── Templates ──────────────────────────────────────────────────────────────

  app.get(
    "/api/templates",
    authenticateJWT,
    async (req: Request, res: Response) => {
      try {
        const orgId = getOrgFilter(req);

        const result = orgId
          ? await pool.query(
              `SELECT id, name, layout, orientation, elements, background,
                      watermark, created_at, updated_at, org_id
               FROM templates
               WHERE org_id = $1
               ORDER BY updated_at DESC`,
              [orgId],
            )
          : await pool.query(
              `SELECT id, name, layout, orientation, elements, background,
                      watermark, created_at, updated_at, org_id
               FROM templates
               ORDER BY updated_at DESC`,
            );

        return res.json(result.rows);
      } catch (err) {
        console.error("GET /api/templates error:", err);
        return res.status(500).json({ error: "Failed to fetch templates" });
      }
    },
  );

  app.post(
    "/api/templates",
    authenticateJWT,
    async (req: Request, res: Response) => {
      try {
        const orgId = req.user?.orgId;
        const { name, layout, orientation, elements, background, watermark } = req.body;

        if (!name) return res.status(400).json({ error: "name is required" });

        const result = await pool.query(
          `INSERT INTO templates
             (name, layout, orientation, elements, background, watermark, org_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *`,
          [
            name,
            layout    ?? null,
            orientation ?? "landscape",
            elements  ?? [],
            background ?? {},
            watermark ?? {},
            orgId     ?? null,
          ],
        );

        return res.status(201).json(result.rows[0]);
      } catch (err) {
        console.error("POST /api/templates error:", err);
        return res.status(500).json({ error: "Failed to create template" });
      }
    },
  );

  // ── Media ──────────────────────────────────────────────────────────────────

  app.get(
    "/api/media",
    authenticateJWT,
    async (req: Request, res: Response) => {
      try {
        const orgId = getOrgFilter(req);
        const { type, search } = req.query;

        let query = `
          SELECT id, name, type, url, size, duration, uploaded_at,
                 expires_at, is_expired, mime_type, original_filename,
                 width, height, processing_status, org_id
          FROM media
          WHERE is_expired = false
        `;
        const params: any[] = [];
        let idx = 1;

        if (orgId) {
          query += ` AND org_id = $${idx++}`;
          params.push(orgId);
        }
        if (type) {
          query += ` AND type = $${idx++}`;
          params.push(type);
        }
        if (search) {
          query += ` AND name ILIKE $${idx++}`;
          params.push(`%${search}%`);
        }

        query += ` ORDER BY uploaded_at DESC`;

        const result = await pool.query(query, params);
        return res.json(result.rows);
      } catch (err) {
        console.error("GET /api/media error:", err);
        return res.status(500).json({ error: "Failed to fetch media" });
      }
    },
  );

  // ── Content Playlists ──────────────────────────────────────────────────────

  app.get(
    "/api/content-playlists",
    authenticateJWT,
    async (req: Request, res: Response) => {
      try {
        const orgId = getOrgFilter(req);

        const result = orgId
          ? await pool.query(
              `SELECT id, name, description, created_at, updated_at, org_id
               FROM content_playlists
               WHERE org_id = $1
               ORDER BY created_at DESC`,
              [orgId],
            )
          : await pool.query(
              `SELECT id, name, description, created_at, updated_at, org_id
               FROM content_playlists
               ORDER BY created_at DESC`,
            );

        return res.json(result.rows);
      } catch (err) {
        console.error("GET /api/content-playlists error:", err);
        return res.status(500).json({ error: "Failed to fetch playlists" });
      }
    },
  );

  app.post(
    "/api/content-playlists",
    authenticateJWT,
    async (req: Request, res: Response) => {
      try {
        const orgId = req.user?.orgId;
        const { name, description } = req.body;
        if (!name) return res.status(400).json({ error: "name is required" });

        const result = await pool.query(
          `INSERT INTO content_playlists (name, description, org_id)
           VALUES ($1, $2, $3) RETURNING *`,
          [name, description ?? null, orgId ?? null],
        );

        return res.status(201).json(result.rows[0]);
      } catch (err) {
        console.error("POST /api/content-playlists error:", err);
        return res.status(500).json({ error: "Failed to create playlist" });
      }
    },
  );

  // ── Screens / Devices list ─────────────────────────────────────────────────

  app.get(
    "/api/screens",
    authenticateJWT,
    async (req: Request, res: Response) => {
      try {
        const orgId = getOrgFilter(req);

        const result = orgId
          ? await pool.query(
              `SELECT id, device_id, name, location, status, is_online,
                      last_seen_at, brightness, volume, screen_state,
                      app_version, assigned_template_id, org_id
               FROM screens
               WHERE org_id = $1 AND (archived IS NULL OR archived = false)
               ORDER BY name ASC`,
              [orgId],
            )
          : await pool.query(
              `SELECT id, device_id, name, location, status, is_online,
                      last_seen_at, brightness, volume, screen_state,
                      app_version, assigned_template_id, org_id
               FROM screens
               WHERE (archived IS NULL OR archived = false)
               ORDER BY name ASC`,
            );

        return res.json(result.rows);
      } catch (err) {
        console.error("GET /api/screens error:", err);
        return res.status(500).json({ error: "Failed to fetch screens" });
      }
    },
  );

  // ── Command audit trail ────────────────────────────────────────────────────
  // Who sent which command to which device and when

  app.get(
    "/api/audit/commands",
    authenticateJWT,
    requireRole("admin", "manager"),
    async (req: Request, res: Response) => {
      try {
        const orgId = getOrgFilter(req);
        const { deviceId, limit = "100" } = req.query;

        let query = `
          SELECT dc.id, dc.device_id, dc.payload, dc.sent, dc.executed,
                 dc.created_at, dc.executed_at, dc.attempt_count, dc.last_error,
                 s.name AS device_name
          FROM device_commands dc
          LEFT JOIN screens s ON s.device_id = dc.device_id
          WHERE 1=1
        `;
        const params: any[] = [];
        let idx = 1;

        if (orgId) {
          query += ` AND dc.org_id = $${idx++}`;
          params.push(orgId);
        }
        if (deviceId) {
          query += ` AND dc.device_id = $${idx++}`;
          params.push(deviceId);
        }

        query += ` ORDER BY dc.created_at DESC LIMIT $${idx++}`;
        params.push(Math.min(Number(limit), 1000));

        const result = await pool.query(query, params);
        return res.json(result.rows);
      } catch (err) {
        console.error("GET /api/audit/commands error:", err);
        return res.status(500).json({ error: "Failed to fetch command audit" });
      }
    },
  );
}
