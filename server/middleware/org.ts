// server/middleware/org.ts
// Extracts org_id from JWT and exposes it on req.
// - Admins (role === "admin") get orgId = null → bypass all org filters
// - All other users get orgId from their token → filtered automatically

import { Request, Response, NextFunction } from "express";

export interface OrgRequest extends Request {
  orgId: string | null;  // null = admin (sees all orgs)
  userRole: string;
}

/**
 * requireOrgContext
 * Must be used AFTER authenticateJWT (which sets req.user).
 * Sets req.orgId for use in route handlers.
 */
export function requireOrgContext(req: Request, res: Response, next: NextFunction) {
  const user = (req as any).user;

  if (!user) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const orgReq = req as OrgRequest;
  orgReq.userRole = user.role;

  // Admins bypass org filtering (god mode)
  if (user.role === "admin") {
    orgReq.orgId = null;
    return next();
  }

  // All other users must have an org_id in their token
  if (!user.org_id) {
    return res.status(403).json({ error: "no_org_assigned", message: "Your account is not assigned to an organization." });
  }

  orgReq.orgId = user.org_id;
  return next();
}

/**
 * orgFilter
 * Returns a SQL WHERE clause fragment for org filtering.
 * Usage: const { clause, params } = orgFilter(req, existingParams)
 *
 * Example:
 *   const { clause, params } = orgFilter(req, []);
 *   const result = await pool.query(`SELECT * FROM screens${clause}`, params);
 */
export function orgFilter(
  req: Request,
  existingParams: any[] = [],
): { clause: string; params: any[] } {
  const orgId = (req as OrgRequest).orgId;

  // Admin sees everything
  if (orgId === null) {
    return { clause: "", params: existingParams };
  }

  const paramIndex = existingParams.length + 1;
  return {
    clause: ` WHERE org_id = $${paramIndex}`,
    params: [...existingParams, orgId],
  };
}

/**
 * orgFilterAnd
 * Same as orgFilter but uses AND instead of WHERE (for queries that already have a WHERE).
 */
export function orgFilterAnd(
  req: Request,
  existingParams: any[] = [],
): { clause: string; params: any[] } {
  const orgId = (req as OrgRequest).orgId;

  if (orgId === null) {
    return { clause: "", params: existingParams };
  }

  const paramIndex = existingParams.length + 1;
  return {
    clause: ` AND org_id = $${paramIndex}`,
    params: [...existingParams, orgId],
  };
}

/**
 * getOrgId
 * Helper to get org_id for INSERT queries.
 * Returns the user's org_id, or throws if not available.
 */
export function getOrgId(req: Request): string | null {
  return (req as OrgRequest).orgId;
}
