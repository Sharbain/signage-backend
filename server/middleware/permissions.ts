import { Request, Response, NextFunction } from "express";

// NOTE: This middleware assumes authenticateJWT has already run and populated req.user.
export function requireRole(...allowed: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const role = (req as any).user?.role;
    if (!role) return res.status(401).json({ error: "not_authenticated" });

    if (allowed.includes(role) || allowed.includes("any")) return next();
    return res.status(403).json({ error: "forbidden" });
  };
}
