/**
 * server/routes/groups.routes.ts
 *
 * Enterprise group management API using PostgreSQL ltree.
 *
 * Endpoints:
 *   GET    /api/groups/tree          — full tree for current user's scope
 *   GET    /api/groups               — flat list of groups
 *   GET    /api/groups/:id           — single group with children + devices
 *   POST   /api/groups               — create group
 *   PATCH  /api/groups/:id           — rename group
 *   DELETE /api/groups/:id           — delete group (with device check)
 *   POST   /api/groups/:id/move      — move group to new parent (updates ltree)
 *   GET    /api/groups/:id/devices   — devices in this group (not subtree)
 *   POST   /api/groups/:id/devices   — assign a device to this group
 *   DELETE /api/groups/:id/devices/:deviceId — remove device from group
 *   GET    /api/groups/:id/subtree-devices   — all devices in group + subgroups
 */

import type { Express, Request, Response } from "express";
import { pool } from "../db";
import { authenticateJWT } from "../middleware/auth";
import { requireRole } from "../middleware/permissions";
import { scopeToOrg } from "../middleware/scopeToOrg";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a name to a safe ltree label segment */
function toLabel(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 60) || "group";
}

/** Build a unique ltree label by appending a short random suffix */
function uniqueLabel(name: string, suffix: string): string {
  return `${toLabel(name)}_${suffix}`;
}

// ---------------------------------------------------------------------------
// Register routes
// ---------------------------------------------------------------------------
export function registerGroupRoutes(app: Express) {

  // All group routes require auth + scope injection
  const auth = [authenticateJWT, scopeToOrg];
  const ownerOnly = [...auth, requireRole("owner")];
  const ownerOrPublisher = [...auth, requireRole("owner", "publisher")];

  // ── GET /api/groups/tree ─────────────────────────────────────────────────
  // Returns the full group tree as a nested JSON structure.
  // Owners see all groups across all orgs.
  // Publishers/Reviewers see only their org's subtree.
  app.get("/api/groups/tree", ...auth, async (req: Request, res: Response) => {
    try {
      const scope = req.scope;

      let query: string;
      let params: any[];

      if (!scope || scope.isOwner) {
        // Owner: all groups, all orgs
        query = `
          SELECT
            g.id, g.org_id AS "orgId", g.parent_id AS "parentId",
            g.name, g.path::text AS path,
            o.name AS "orgName",
            COUNT(DISTINCT s.id)::int AS "deviceCount"
          FROM groups g
          LEFT JOIN organizations o ON o.id = g.org_id
          LEFT JOIN screens s ON s.new_group_id = g.id
          GROUP BY g.id, o.name
          ORDER BY g.path
        `;
        params = [];
      } else {
        // Scoped: only this org's groups
        query = `
          SELECT
            g.id, g.org_id AS "orgId", g.parent_id AS "parentId",
            g.name, g.path::text AS path,
            o.name AS "orgName",
            COUNT(DISTINCT s.id)::int AS "deviceCount"
          FROM groups g
          LEFT JOIN organizations o ON o.id = g.org_id
          LEFT JOIN screens s ON s.new_group_id = g.id
          WHERE g.org_id = $1
            ${scope.groupPath ? `AND g.path <@ $2::ltree` : ""}
          GROUP BY g.id, o.name
          ORDER BY g.path
        `;
        params = scope.groupPath
          ? [scope.orgId, scope.groupPath]
          : [scope.orgId];
      }

      const result = await pool.query(query, params);
      const flat = result.rows;

      // Build nested tree
      const map = new Map<number, any>();
      const roots: any[] = [];

      for (const row of flat) {
        map.set(row.id, { ...row, children: [] });
      }

      for (const row of flat) {
        const node = map.get(row.id)!;
        if (row.parentId && map.has(row.parentId)) {
          map.get(row.parentId)!.children.push(node);
        } else {
          roots.push(node);
        }
      }

      res.json({ tree: roots, flat });
    } catch (err) {
      console.error("Get groups tree error:", err);
      res.status(500).json({ error: "Failed to get groups tree" });
    }
  });

  // ── GET /api/groups ──────────────────────────────────────────────────────
  app.get("/api/groups", ...auth, async (req: Request, res: Response) => {
    try {
      const scope = req.scope;
      const orgId = req.query.orgId as string | undefined;

      let where = "TRUE";
      const params: any[] = [];

      if (!scope?.isOwner) {
        params.push(scope?.orgId);
        where = `g.org_id = $${params.length}`;
        if (scope?.groupPath) {
          params.push(scope.groupPath);
          where += ` AND g.path <@ $${params.length}::ltree`;
        }
      } else if (orgId) {
        params.push(orgId);
        where = `g.org_id = $${params.length}`;
      }

      const result = await pool.query(
        `SELECT
           g.id, g.org_id AS "orgId", g.parent_id AS "parentId",
           g.name, g.path::text AS path, g.created_at AS "createdAt",
           COUNT(DISTINCT s.id)::int AS "deviceCount"
         FROM groups g
         LEFT JOIN screens s ON s.new_group_id = g.id
         WHERE ${where}
         GROUP BY g.id
         ORDER BY g.path`,
        params,
      );

      res.json(result.rows);
    } catch (err) {
      console.error("Get groups error:", err);
      res.status(500).json({ error: "Failed to get groups" });
    }
  });

  // ── GET /api/groups/:id ──────────────────────────────────────────────────
  app.get("/api/groups/:id", ...auth, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const result = await pool.query(
        `SELECT
           g.id, g.org_id AS "orgId", g.parent_id AS "parentId",
           g.name, g.path::text AS path, g.created_at AS "createdAt",
           o.name AS "orgName",
           COUNT(DISTINCT s.id)::int AS "deviceCount",
           COUNT(DISTINCT c.id)::int AS "childCount"
         FROM groups g
         LEFT JOIN organizations o ON o.id = g.org_id
         LEFT JOIN screens s ON s.new_group_id = g.id
         LEFT JOIN groups c ON c.parent_id = g.id
         WHERE g.id = $1
         GROUP BY g.id, o.name`,
        [id],
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Group not found" });
      }

      // Also return direct children
      const children = await pool.query(
        `SELECT id, name, path::text AS path, parent_id AS "parentId"
         FROM groups WHERE parent_id = $1 ORDER BY name`,
        [id],
      );

      res.json({ ...result.rows[0], children: children.rows });
    } catch (err) {
      console.error("Get group error:", err);
      res.status(500).json({ error: "Failed to get group" });
    }
  });

  // ── POST /api/groups ─────────────────────────────────────────────────────
  app.post("/api/groups", ...ownerOrPublisher, async (req: Request, res: Response) => {
    try {
      const { name, parentId, orgId: bodyOrgId } = req.body;
      if (!name?.trim()) return res.status(400).json({ error: "name is required" });

      const scope = req.scope;
      const orgId = scope?.isOwner
        ? (bodyOrgId ?? scope?.orgId)
        : scope?.orgId;

      if (!orgId) return res.status(400).json({ error: "orgId is required" });

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        let parentPath: string | null = null;
        let resolvedParentId: number | null = parentId ? Number(parentId) : null;

        if (resolvedParentId) {
          const parentResult = await client.query(
            `SELECT path::text AS path FROM groups WHERE id = $1 AND org_id = $2`,
            [resolvedParentId, orgId],
          );
          if (parentResult.rowCount === 0) {
            await client.query("ROLLBACK");
            return res.status(400).json({ error: "Parent group not found in this org" });
          }
          parentPath = parentResult.rows[0].path;
        } else {
          // Root group for org — get org root path
          const orgResult = await client.query(
            `SELECT path::text AS path FROM groups WHERE org_id = $1 AND parent_id IS NULL LIMIT 1`,
            [orgId],
          );
          if (orgResult.rowCount === 0) {
            await client.query("ROLLBACK");
            return res.status(400).json({ error: "Org root group not found — run migration first" });
          }
          parentPath = orgResult.rows[0].path;
          resolvedParentId = (await client.query(
            `SELECT id FROM groups WHERE org_id = $1 AND parent_id IS NULL LIMIT 1`,
            [orgId],
          )).rows[0].id;
        }

        // Generate unique label
        const suffix = Date.now().toString(36).slice(-4);
        const label = uniqueLabel(name.trim(), suffix);
        const path = parentPath ? `${parentPath}.${label}` : label;

        const result = await client.query(
          `INSERT INTO groups (org_id, parent_id, name, path)
           VALUES ($1, $2, $3, $4::ltree)
           RETURNING id, org_id AS "orgId", parent_id AS "parentId", name, path::text AS path, created_at AS "createdAt"`,
          [orgId, resolvedParentId, name.trim(), path],
        );

        await client.query("COMMIT");
        res.status(201).json(result.rows[0]);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error("Create group error:", err);
      res.status(500).json({ error: "Failed to create group" });
    }
  });

  // ── PATCH /api/groups/:id ────────────────────────────────────────────────
  // Rename a group (path labels are not changed — only display name)
  app.patch("/api/groups/:id", ...ownerOrPublisher, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { name } = req.body;
      if (!name?.trim()) return res.status(400).json({ error: "name is required" });

      const result = await pool.query(
        `UPDATE groups SET name = $1, updated_at = NOW()
         WHERE id = $2
         RETURNING id, name, path::text AS path, updated_at AS "updatedAt"`,
        [name.trim(), id],
      );

      if (result.rowCount === 0) return res.status(404).json({ error: "Group not found" });
      res.json(result.rows[0]);
    } catch (err) {
      console.error("Rename group error:", err);
      res.status(500).json({ error: "Failed to rename group" });
    }
  });

  // ── DELETE /api/groups/:id ───────────────────────────────────────────────
  app.delete("/api/groups/:id", ...ownerOnly, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { force } = req.query;

      // Check for devices and children
      const check = await pool.query(
        `SELECT
           (SELECT COUNT(*) FROM screens WHERE new_group_id = $1)::int    AS "deviceCount",
           (SELECT COUNT(*) FROM groups  WHERE parent_id   = $1)::int    AS "childCount"`,
        [id],
      );

      const { deviceCount, childCount } = check.rows[0];

      if ((deviceCount > 0 || childCount > 0) && force !== "true") {
        return res.status(409).json({
          error: "Group has devices or subgroups",
          deviceCount,
          childCount,
          hint: "Add ?force=true to delete anyway (devices will be ungrouped)",
        });
      }

      if (force === "true") {
        // Ungroup devices first
        await pool.query(`UPDATE screens SET new_group_id = NULL WHERE new_group_id = $1`, [id]);
      }

      const result = await pool.query(
        `DELETE FROM groups WHERE id = $1 RETURNING id`,
        [id],
      );

      if (result.rowCount === 0) return res.status(404).json({ error: "Group not found" });
      res.json({ success: true, deletedId: Number(id) });
    } catch (err) {
      console.error("Delete group error:", err);
      res.status(500).json({ error: "Failed to delete group" });
    }
  });

  // ── POST /api/groups/:id/move ────────────────────────────────────────────
  // Move a group (and its entire subtree) to a new parent.
  // Updates ltree paths for the group and all descendants.
  app.post("/api/groups/:id/move", ...ownerOnly, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { newParentId } = req.body;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // Get current group
        const current = await client.query(
          `SELECT path::text AS path, org_id AS "orgId" FROM groups WHERE id = $1`,
          [id],
        );
        if (current.rowCount === 0) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "Group not found" });
        }

        const currentPath = current.rows[0].path;
        const orgId = current.rows[0].orgId;

        // Get new parent path
        let newParentPath: string;
        let resolvedNewParentId: number | null = newParentId ? Number(newParentId) : null;

        if (resolvedNewParentId) {
          const newParent = await client.query(
            `SELECT path::text AS path FROM groups WHERE id = $1 AND org_id = $2`,
            [resolvedNewParentId, orgId],
          );
          if (newParent.rowCount === 0) {
            await client.query("ROLLBACK");
            return res.status(400).json({ error: "New parent not found" });
          }
          newParentPath = newParent.rows[0].path;

          // Prevent moving to own descendant
          if (newParentPath.startsWith(currentPath + ".")) {
            await client.query("ROLLBACK");
            return res.status(400).json({ error: "Cannot move group into its own subtree" });
          }
        } else {
          // Move to org root
          const orgRoot = await client.query(
            `SELECT path::text AS path FROM groups WHERE org_id = $1 AND parent_id IS NULL LIMIT 1`,
            [orgId],
          );
          newParentPath = orgRoot.rows[0].path;
        }

        // Extract the leaf label from current path
        const currentLabel = currentPath.split(".").pop()!;
        const newPath = `${newParentPath}.${currentLabel}`;

        // Update this group and all descendants using ltree subpath replacement
        await client.query(
          `UPDATE groups
           SET path = ($3::ltree || subpath(path, nlevel($1::ltree)))::ltree,
               parent_id = CASE WHEN id = $4 THEN $5 ELSE parent_id END,
               updated_at = NOW()
           WHERE path <@ $1::ltree`,
          [currentPath, newPath, newParentPath, Number(id), resolvedNewParentId],
        );

        await client.query("COMMIT");

        const updated = await pool.query(
          `SELECT id, name, path::text AS path, parent_id AS "parentId" FROM groups WHERE id = $1`,
          [id],
        );
        res.json(updated.rows[0]);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error("Move group error:", err);
      res.status(500).json({ error: "Failed to move group" });
    }
  });

  // ── GET /api/groups/:id/devices ──────────────────────────────────────────
  // Devices directly in this group (not subtree)
  app.get("/api/groups/:id/devices", ...auth, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const result = await pool.query(
        `SELECT
           s.id, s.device_id AS "deviceId", s.name, s.status,
           s.is_online AS "isOnline", s.last_seen AS "lastSeen",
           s.org_id AS "orgId", s.new_group_id AS "groupId"
         FROM screens s
         WHERE s.new_group_id = $1
           AND COALESCE(s.archived, false) = false
         ORDER BY s.name`,
        [id],
      );
      res.json(result.rows);
    } catch (err) {
      console.error("Get group devices error:", err);
      res.status(500).json({ error: "Failed to get group devices" });
    }
  });

  // ── POST /api/groups/:id/devices ─────────────────────────────────────────
  // Assign a device to this group
  app.post("/api/groups/:id/devices", ...ownerOrPublisher, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { deviceId } = req.body; // screens.id (integer)

      if (!deviceId) return res.status(400).json({ error: "deviceId is required" });

      // Verify group exists
      const group = await pool.query(`SELECT id, org_id AS "orgId" FROM groups WHERE id = $1`, [id]);
      if (group.rowCount === 0) return res.status(404).json({ error: "Group not found" });

      const result = await pool.query(
        `UPDATE screens
         SET new_group_id = $1, org_id = $2, updated_at = NOW()
         WHERE id = $3
         RETURNING id, name, new_group_id AS "groupId"`,
        [id, group.rows[0].orgId, Number(deviceId)],
      );

      if (result.rowCount === 0) return res.status(404).json({ error: "Device not found" });
      res.json({ success: true, device: result.rows[0] });
    } catch (err) {
      console.error("Assign device to group error:", err);
      res.status(500).json({ error: "Failed to assign device to group" });
    }
  });

  // ── DELETE /api/groups/:id/devices/:deviceId ─────────────────────────────
  // Remove a device from a group (ungroup it)
  app.delete("/api/groups/:id/devices/:deviceId", ...ownerOrPublisher, async (req: Request, res: Response) => {
    try {
      const { deviceId } = req.params;

      const result = await pool.query(
        `UPDATE screens SET new_group_id = NULL, updated_at = NOW()
         WHERE id = $1 AND new_group_id = $2
         RETURNING id`,
        [Number(deviceId), Number(req.params.id)],
      );

      if (result.rowCount === 0) return res.status(404).json({ error: "Device not found in this group" });
      res.json({ success: true });
    } catch (err) {
      console.error("Remove device from group error:", err);
      res.status(500).json({ error: "Failed to remove device from group" });
    }
  });

  // ── GET /api/groups/:id/subtree-devices ──────────────────────────────────
  // All devices in this group AND all subgroups (recursive via ltree)
  // Used by bulk push modal to show full device tree
  app.get("/api/groups/:id/subtree-devices", ...auth, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      // Get the group's path first
      const groupResult = await pool.query(
        `SELECT path::text AS path FROM groups WHERE id = $1`,
        [id],
      );
      if (groupResult.rowCount === 0) return res.status(404).json({ error: "Group not found" });

      const groupPath = groupResult.rows[0].path;

      // Get all devices in this subtree using ltree <@
      const result = await pool.query(
        `SELECT
           s.id, s.device_id AS "deviceId", s.name, s.status,
           s.is_online AS "isOnline", s.last_seen AS "lastSeen",
           s.new_group_id AS "groupId",
           g.name AS "groupName", g.path::text AS "groupPath"
         FROM screens s
         JOIN groups g ON g.id = s.new_group_id
         WHERE g.path <@ $1::ltree
           AND COALESCE(s.archived, false) = false
         ORDER BY g.path, s.name`,
        [groupPath],
      );

      // Also get subgroups for the tree structure
      const subgroups = await pool.query(
        `SELECT id, name, path::text AS path, parent_id AS "parentId",
                COUNT(DISTINCT s.id)::int AS "deviceCount"
         FROM groups g
         LEFT JOIN screens s ON s.new_group_id = g.id
         WHERE g.path <@ $1::ltree
         GROUP BY g.id
         ORDER BY g.path`,
        [groupPath],
      );

      res.json({
        devices: result.rows,
        groups: subgroups.rows,
        totalDevices: result.rows.length,
      });
    } catch (err) {
      console.error("Get subtree devices error:", err);
      res.status(500).json({ error: "Failed to get subtree devices" });
    }
  });

  // ── GET /api/organizations ───────────────────────────────────────────────
  // List all organizations (owner only)
  app.get("/api/organizations", ...ownerOnly, async (_req: Request, res: Response) => {
    try {
      const result = await pool.query(
        `SELECT
           o.id, o.name, o.slug, o.plan, o.is_active AS "isActive",
           o.created_at AS "createdAt",
           COUNT(DISTINCT u.id)::int AS "userCount",
           COUNT(DISTINCT s.id)::int AS "deviceCount"
         FROM organizations o
         LEFT JOIN users u ON u.org_id = o.id
         LEFT JOIN screens s ON s.org_id = o.id
         GROUP BY o.id
         ORDER BY o.name`,
      );
      res.json(result.rows);
    } catch (err) {
      console.error("Get organizations error:", err);
      res.status(500).json({ error: "Failed to get organizations" });
    }
  });

  // ── POST /api/organizations ──────────────────────────────────────────────
  // Create a new organization + its root group (owner only)
  app.post("/api/organizations", ...ownerOnly, async (req: Request, res: Response) => {
    try {
      const { name, slug, plan = "starter" } = req.body;
      if (!name?.trim()) return res.status(400).json({ error: "name is required" });
      if (!slug?.trim()) return res.status(400).json({ error: "slug is required" });

      const safeSlug = slug.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // Create org
        const org = await client.query(
          `INSERT INTO organizations (name, slug, plan)
           VALUES ($1, $2, $3)
           RETURNING id, name, slug, plan, created_at AS "createdAt"`,
          [name.trim(), safeSlug, plan],
        );
        const orgId = org.rows[0].id;

        // Create root group for this org
        const rootPath = safeSlug;
        await client.query(
          `INSERT INTO groups (org_id, parent_id, name, path)
           VALUES ($1, NULL, $2, $3::ltree)`,
          [orgId, name.trim(), rootPath],
        );

        await client.query("COMMIT");
        res.status(201).json(org.rows[0]);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    } catch (err: any) {
      if (err.code === "23505") {
        return res.status(409).json({ error: "Organization slug already exists" });
      }
      console.error("Create organization error:", err);
      res.status(500).json({ error: "Failed to create organization" });
    }
  });
}
