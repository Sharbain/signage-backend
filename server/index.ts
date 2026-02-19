import express, { type Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { randomUUID } from "crypto";
import { registerRoutes } from "./routes";
import { createServer } from "http";

const app = express();
const httpServer = createServer(app);

/* --------------------------------------------------
   RAW BODY SUPPORT (used for webhooks if needed)
-------------------------------------------------- */
declare module "http" {
  interface IncomingMessage {
    rawBody?: unknown;
  }
}

/* --------------------------------------------------
   REQUEST ID
-------------------------------------------------- */
app.use((req, res, next) => {
  const existing = req.headers["x-request-id"];
  const requestId =
    (Array.isArray(existing) ? existing[0] : existing) || randomUUID();
  res.setHeader("x-request-id", requestId);
  (req as any).requestId = requestId;
  next();
});

/* --------------------------------------------------
   SECURITY BASELINE
-------------------------------------------------- */
app.use(helmet());

/* --------------------------------------------------
   CORS (PRODUCTION-SAFE + VERCEL AUTO SUPPORT)
-------------------------------------------------- */

// Comma-separated allowlist from environment
const corsOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const corsMiddleware = cors({
  origin: (origin, cb) => {
    // Allow non-browser clients (curl, server-to-server)
    if (!origin) return cb(null, true);

    // Allow ALL Vercel deployments automatically
    if (origin.endsWith(".vercel.app")) {
      return cb(null, true);
    }

    // If no env origins defined
    if (corsOrigins.length === 0) {
      if (process.env.NODE_ENV !== "production") {
        return cb(null, true);
      }
      return cb(new Error("CORS blocked"));
    }

    // Check allowlist
    if (corsOrigins.includes(origin)) {
      return cb(null, true);
    }

    return cb(new Error("CORS blocked"));
  },
  credentials: true,
});

app.use(corsMiddleware);

/* --------------------------------------------------
   RATE LIMITING
-------------------------------------------------- */

// Global API limit
app.use(
  "/api",
  rateLimit({
    windowMs: 60_000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

// Stricter auth limit
app.use(
  "/api/auth",
  rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

/* --------------------------------------------------
   BODY PARSERS
-------------------------------------------------- */
app.use(
  express.json({
    limit: "1mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false, limit: "1mb" }));

/* --------------------------------------------------
   REQUEST LOGGING
-------------------------------------------------- */
export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      const requestId = (req as any).requestId;
      log(
        `${req.method} ${path} ${res.statusCode} in ${duration}ms (rid=${requestId})`,
      );
    }
  });

  next();
});

/* --------------------------------------------------
   BOOTSTRAP
-------------------------------------------------- */
(async () => {
  await registerRoutes(httpServer, app);

  app.get("/", (_req, res) => {
    res.send("Signage API running");
  });

  app.get("/api/ping", (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "API route not found" });
  });

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    console.error("API ERROR:", { status, message, stack: err?.stack });
    res.status(status).json({ error: message });
  });

  const port = parseInt(process.env.PORT || "5000", 10);

  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`API listening on port ${port}`);
    },
  );
})();
