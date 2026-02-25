import { Router } from "express";
import type { Express } from "express";

export function registerAuthRoutes(app: Express) {
  const router = Router();

  // TODO: move these from routes.ts into here:
  // POST /api/auth/register
  // POST /api/auth/login
  // GET  /api/me
  // POST /api/me/preferences
  // admin user mgmt if you want: /api/admin/users...

  app.use("/api", router);
}