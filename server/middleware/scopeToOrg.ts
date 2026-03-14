/**
 * server/middleware/scopeToOrg.ts
 *
 * Tenant isolation middleware.
 * Injects req.scope into every authenticated request:
 *   - orgId       : the user's organization UUID
 *   - groupPath   : the ltree path of the user's root group (null = sees all)
 *   - role        : owner | publisher | reviewer
 *   - userId      : the user's UUID
 *   - isOwner     : true if role === 'owner' (super-admin, no restrictions)
 *
 * Owners (super-admins) get no restrictions — scope.isOwner = true means
 * all queries run without org/group filters.
 *
 * Publishers and Reviewers are scoped to their org + group subtree.
 */

import type { Request, Response, NextFunction } from "express";
import { pool } from "../db";

export interface OrgScope {
  userId: string;
  orgId: string | null;
  groupId: number | null;
  groupPath: string | null;
  role: "owner" | "publisher" | "reviewer";
  isOwner: boolean;
}

// Extend Express Request with scope
declare global {
  namespace Express {
    interface Request {
      scope?: OrgScope;
    }
  }
}

export async function scopeToOrg(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId = (req as any).user?.id;

    // No authenticated user — skip (other middleware handles 401)
    if (!userId) {
      next();
      return;
    }

    const result = await pool.query(
      `SELECT
         u.id,
         u.org_id     AS "orgId",
         u.group_id   AS "groupId",
         u.role,
         g.path::text AS "groupPath"
       FROM users u
       LEFT JOIN groups g ON g.id = u.group_id
       WHERE u.id = $1
       LIMIT 1`,
      [userId],
    );

    if (result.rowCount === 0) {
      next();
      return;
    }

    const row = result.rows[0];
    const role = row.role as "owner" | "publisher" | "reviewer";

    req.scope = {
      userId: String(row.id),
      orgId: row.orgId ?? null,
      groupId: row.groupId ?? null,
      groupPath: row.groupPath ?? null,
      role,
      isOwner: role === "owner",
    };

    next();
  } catch (err) {
    console.error("scopeToOrg error:", err);
    next(); // don't block the request — worst case queries return too much
  }
}

/**
 * Helper: build a WHERE clause fragment that filters by org.
 * Use in SQL queries on tables that have org_id.
 *
 * Example:
 *   const { clause, params } = orgFilter(req, ['o.org_id'], 1);
 *   pool.query(`SELECT * FROM screens o WHERE ${clause}`, params);
 */
export function orgFilter(
  req: Request,
  column = "org_id",
  startParam = 1,
): { clause: string; params: any[] } {
  const scope = req.scope;

  // Owner sees everything
  if (!scope || scope.isOwner) {
    return { clause: "TRUE", params: [] };
  }

  if (!scope.orgId) {
    return { clause: "FALSE", params: [] };
  }

  return {
    clause: `${column} = $${startParam}`,
    params: [scope.orgId],
  };
}

/**
 * Helper: build a WHERE clause that filters screens by the user's group subtree.
 * Uses ltree <@ operator for fast indexed subtree queries.
 *
 * Example:
 *   const { clause, params } = groupFilter(req, 'g.path', 1);
 */
export function groupFilter(
  req: Request,
  groupPathColumn = "g.path",
  startParam = 1,
): { clause: string; params: any[] } {
  const scope = req.scope;

  if (!scope || scope.isOwner) {
    return { clause: "TRUE", params: [] };
  }

  if (!scope.groupPath) {
    // User has no group — can only see ungrouped devices in their org
    return {
      clause: `${groupPathColumn} IS NULL`,
      params: [],
    };
  }

  return {
    clause: `${groupPathColumn} <@ $${startParam}::ltree`,
    params: [scope.groupPath],
  };
}
