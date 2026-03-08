import { WebSocketServer, WebSocket } from "ws";
import { Server } from "http";
import jwt from "jsonwebtoken";
import { IncomingMessage } from "http";

const JWT_SECRET = process.env.JWT_SECRET || "";

// All connected CMS dashboard clients
const dashboardClients = new Set<WebSocket>();

export function initWebSocketServer(httpServer: Server) {
  try {
    const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

    wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
      try {
        const url = new URL(req.url || "", "http://localhost");
        const token = url.searchParams.get("token");

        if (!token) {
          ws.close(4001, "missing_token");
          return;
        }

        jwt.verify(token, JWT_SECRET);
        dashboardClients.add(ws);

        ws.on("close", () => dashboardClients.delete(ws));
        ws.on("error", () => dashboardClients.delete(ws));

        ws.send(JSON.stringify({ type: "connected" }));
      } catch {
        ws.close(4003, "invalid_token");
      }
    });

    wss.on("error", (err) => {
      console.error("[ws] WebSocketServer error:", err);
    });

    console.log("[ws] WebSocket server ready on /ws");
  } catch (err) {
    console.error("[ws] FAILED to init WebSocket server:", err);
  }
}

export function broadcastDeviceStatus(deviceId: string, isOnline: boolean, extra?: Record<string, any>) {
  if (dashboardClients.size === 0) return;

  const message = JSON.stringify({
    type: "device_status",
    deviceId,
    isOnline,
    timestamp: new Date().toISOString(),
    ...extra,
  });

  for (const client of dashboardClients) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(message);
      } catch {
        dashboardClients.delete(client);
      }
    }
  }
}
