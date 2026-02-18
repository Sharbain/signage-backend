import { Request, Response, NextFunction } from "express";

// Only bypass auth in development mode (never in production)
const isDevelopment = process.env.NODE_ENV !== 'production';

export function requireRole(...allowed: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Skip authentication in development mode only
    if (isDevelopment) {
      (req as any).user = { role: 'admin', email: 'dev@localhost' };
      return next();
    }

    const role = (req as any).user?.role;
    if (!role) return res.status(401).json({ error: "Not logged in" });

    if (allowed.includes(role) || allowed.includes('any')) {
      return next();
    }

    return res.status(403).json({ error: "Forbidden" });
  };
}
