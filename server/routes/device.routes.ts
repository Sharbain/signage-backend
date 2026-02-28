import { Router } from "express";
import type { Express } from "express";
import { authenticateDevice } from "../middleware/auth";

export function registerDeviceRoutes(app: Express) {
  const router = Router();

  // TODO: move these from routes.ts into here:
  // POST /api/device/activate
  // POST /api/device/register
  // POST /api/device/login
  // POST /api/device/:deviceId/heartbeat
  // GET  /api/device/:deviceId/commands
  // GET  /api/device/:deviceId/commands/history
  // POST /api/device/:deviceId/commands/:commandId/ack
  // screenshots/recording uploads...

  // Keep existing paths stable:
  app.use("/api", router);
}