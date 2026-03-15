/**
 * alertEngine.ts
 *
 * Enterprise alert engine for Lumina Signage.
 *
 * Responsibilities:
 *   1. Evaluate alert conditions (device offline, command failures, etc.)
 *   2. Deduplicate — never fire the same alert twice within the cooldown window
 *   3. Fan out to enabled channels (in-app, email, webhook) per org settings
 *   4. Record every alert in the notifications table for audit
 *
 * Alert types:
 *   device_offline       — no heartbeat for OFFLINE_THRESHOLD_MINUTES
 *   device_online        — device recovered after being offline
 *   command_failed       — command failed MAX_COMMAND_FAILURES times
 *   storage_critical     — free storage below STORAGE_CRITICAL_MB
 *   schedule_failed      — scheduled content push failed
 *
 * Deduplication:
 *   In-memory Map tracks last alert time per (orgId + deviceId + alertType).
 *   Alerts are suppressed within ALERT_COOLDOWN_MS window.
 *   Map is cleared on server restart — acceptable tradeoff (brief double-fire
 *   on restart vs complexity of persisting cooldown state).
 *
 * Adding a new alert type:
 *   1. Add to AlertType union
 *   2. Call fireAlert() with the new type
 *   3. Add a human-readable message in formatMessage()
 *   That's it — routing, dedup, and dispatch are automatic.
 */

import nodemailer from "nodemailer";
import { pool } from "./db";

// ── Types ─────────────────────────────────────────────────────────────────────

export type AlertType =
  | "device_offline"
  | "device_online"
  | "command_failed"
  | "storage_critical"
  | "schedule_failed";

export type AlertSeverity = "info" | "warning" | "critical";

export interface AlertEvent {
  type:       AlertType;
  severity:   AlertSeverity;
  deviceId:   string;
  deviceName: string;
  orgId:      string;
  meta?:      Record<string, unknown>; // extra context (error message, command type, etc.)
}

interface NotificationSettings {
  inApp:   { enabled: boolean };
  email:   { enabled: boolean; addresses: string[] };
  webhook: { enabled: boolean; url: string; secret?: string };
}

// ── Config ────────────────────────────────────────────────────────────────────

const ALERT_COOLDOWN_MS        = 60 * 60 * 1000; // 1 hour per alert type per device
const OFFLINE_THRESHOLD_MINUTES = 5;
const STORAGE_CRITICAL_MB       = 500;
const MAX_COMMAND_FAILURES      = 3;

// ── Deduplication state ───────────────────────────────────────────────────────

// key: `${orgId}:${deviceId}:${alertType}` → last fired timestamp
const lastAlertAt = new Map<string, number>();

function isDuplicate(event: AlertEvent): boolean {
  const key = `${event.orgId}:${event.deviceId}:${event.type}`;
  const last = lastAlertAt.get(key);
  if (!last) return false;
  return Date.now() - last < ALERT_COOLDOWN_MS;
}

function markAlertFired(event: AlertEvent): void {
  const key = `${event.orgId}:${event.deviceId}:${event.type}`;
  lastAlertAt.set(key, Date.now());
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function fireAlert(event: AlertEvent): Promise<void> {
  if (isDuplicate(event)) {
    return; // Suppressed within cooldown window
  }

  markAlertFired(event);

  const settings = await getNotificationSettings(event.orgId);
  const { title, message } = formatMessage(event);

  // Fan out to all enabled channels concurrently
  await Promise.allSettled([
    settings.inApp.enabled
      ? dispatchInApp(event, title, message)
      : Promise.resolve(),

    settings.email.enabled && settings.email.addresses.length > 0
      ? dispatchEmail(event, title, message, settings.email.addresses)
      : Promise.resolve(),

    settings.webhook.enabled && settings.webhook.url
      ? dispatchWebhook(event, title, message, settings.webhook)
      : Promise.resolve(),
  ]);

  console.log(
    `[alerts] ${event.severity.toUpperCase()} ${event.type} — device=${event.deviceId} org=${event.orgId}`,
  );
}

// ── Alert formatters ──────────────────────────────────────────────────────────

function formatMessage(event: AlertEvent): { title: string; message: string } {
  const d = event.deviceName || event.deviceId;
  const meta = event.meta ?? {};

  switch (event.type) {
    case "device_offline":
      return {
        title:   `⚠️ Device Offline: ${d}`,
        message: `Device "${d}" has not sent a heartbeat in ${OFFLINE_THRESHOLD_MINUTES}+ minutes and is now marked offline.`,
      };

    case "device_online":
      return {
        title:   `✅ Device Back Online: ${d}`,
        message: `Device "${d}" has reconnected and is now online.`,
      };

    case "command_failed":
      return {
        title:   `❌ Command Failed: ${d}`,
        message: `Command "${meta.commandType ?? "unknown"}" failed ${MAX_COMMAND_FAILURES} times on device "${d}". Last error: ${meta.lastError ?? "unknown"}.`,
      };

    case "storage_critical":
      return {
        title:   `🚨 Critical Storage: ${d}`,
        message: `Device "${d}" has critically low storage: ${meta.freeMb ?? "?"}MB remaining (threshold: ${STORAGE_CRITICAL_MB}MB).`,
      };

    case "schedule_failed":
      return {
        title:   `⚠️ Schedule Push Failed: ${d}`,
        message: `Failed to push scheduled content "${meta.contentName ?? "unknown"}" to device "${d}".`,
      };

    default:
      return {
        title:   `Alert: ${event.type}`,
        message: `Alert on device "${d}": ${JSON.stringify(meta)}`,
      };
  }
}

// ── In-app dispatch ───────────────────────────────────────────────────────────

async function dispatchInApp(
  event: AlertEvent,
  title: string,
  message: string,
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO notifications
         (type, level, title, message, device_id, org_id, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        event.type,
        event.severity,
        title,
        message,
        event.deviceId,
        event.orgId,
        JSON.stringify(event.meta ?? {}),
      ],
    );
  } catch (err) {
    console.error("[alerts] dispatchInApp failed:", err);
  }
}

// ── Email dispatch ────────────────────────────────────────────────────────────

async function dispatchEmail(
  event: AlertEvent,
  title: string,
  message: string,
  addresses: string[],
): Promise<void> {
  if (!process.env.SMTP_HOST) {
    console.warn("[alerts] Email alert skipped — SMTP_HOST not configured");
    return;
  }

  try {
    const transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   Number(process.env.SMTP_PORT ?? 587),
      secure: process.env.SMTP_SECURE === "true",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    await transporter.sendMail({
      from:    process.env.SMTP_FROM ?? "alerts@lumina-signage.com",
      to:      addresses.join(", "),
      subject: title,
      text:    message,
      html:    formatEmailHtml(title, message, event),
    });
  } catch (err) {
    console.error("[alerts] dispatchEmail failed:", err);
  }
}

function formatEmailHtml(
  title: string,
  message: string,
  event: AlertEvent,
): string {
  const severityColor = {
    info:     "#3b82f6",
    warning:  "#f59e0b",
    critical: "#ef4444",
  }[event.severity];

  return `
    <!DOCTYPE html>
    <html>
    <body style="font-family:system-ui,sans-serif;background:#f9fafb;padding:24px">
      <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1)">
        <div style="background:${severityColor};padding:16px 24px">
          <h2 style="color:#fff;margin:0;font-size:16px">${title}</h2>
        </div>
        <div style="padding:24px">
          <p style="color:#374151;line-height:1.6">${message}</p>
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0">
          <table style="width:100%;font-size:13px;color:#6b7280">
            <tr><td style="padding:4px 0"><strong>Device</strong></td><td>${event.deviceName} (${event.deviceId})</td></tr>
            <tr><td style="padding:4px 0"><strong>Severity</strong></td><td style="text-transform:capitalize">${event.severity}</td></tr>
            <tr><td style="padding:4px 0"><strong>Time</strong></td><td>${new Date().toUTCString()}</td></tr>
          </table>
        </div>
        <div style="background:#f9fafb;padding:12px 24px;font-size:12px;color:#9ca3af">
          Lumina Signage — Alert System
        </div>
      </div>
    </body>
    </html>
  `.trim();
}

// ── Webhook dispatch ──────────────────────────────────────────────────────────

async function dispatchWebhook(
  event: AlertEvent,
  title: string,
  message: string,
  config: { url: string; secret?: string },
): Promise<void> {
  try {
    const body = JSON.stringify({
      // Standard payload — works with Slack, Teams, PagerDuty, custom webhooks
      type:       event.type,
      severity:   event.severity,
      title,
      message,
      deviceId:   event.deviceId,
      deviceName: event.deviceName,
      orgId:      event.orgId,
      meta:       event.meta ?? {},
      timestamp:  new Date().toISOString(),
      // Slack-compatible text field
      text: `${title}\n${message}`,
    });

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent":   "Lumina-Signage-Alerts/1.0",
    };

    // Optional HMAC signature for webhook verification
    if (config.secret) {
      const crypto = await import("crypto");
      const sig = crypto
        .createHmac("sha256", config.secret)
        .update(body)
        .digest("hex");
      headers["X-Lumina-Signature"] = `sha256=${sig}`;
    }

    const res = await fetch(config.url, { method: "POST", headers, body });

    if (!res.ok) {
      console.warn(`[alerts] Webhook returned ${res.status}: ${config.url}`);
    }
  } catch (err) {
    console.error("[alerts] dispatchWebhook failed:", err);
  }
}

// ── Notification settings ─────────────────────────────────────────────────────

async function getNotificationSettings(orgId: string): Promise<NotificationSettings> {
  const defaults: NotificationSettings = {
    inApp:   { enabled: true },
    email:   { enabled: false, addresses: [] },
    webhook: { enabled: false, url: "" },
  };

  try {
    const result = await pool.query(
      `SELECT settings FROM organizations WHERE id = $1 LIMIT 1`,
      [orgId],
    );

    if (!result.rows[0]) return defaults;

    const settings = result.rows[0].settings ?? {};
    const notif = settings.notifications ?? {};

    return {
      inApp: {
        enabled: notif.inApp?.enabled ?? true,
      },
      email: {
        enabled:   notif.email?.enabled   ?? false,
        addresses: notif.email?.addresses ?? [],
      },
      webhook: {
        enabled: notif.webhook?.enabled ?? false,
        url:     notif.webhook?.url     ?? "",
        secret:  notif.webhook?.secret,
      },
    };
  } catch (err) {
    console.error("[alerts] getNotificationSettings failed:", err);
    return defaults;
  }
}

// ── Public helpers called by other modules ────────────────────────────────────

/**
 * Called by the device watchdog when a device goes offline.
 */
export async function alertDeviceOffline(
  deviceId:   string,
  deviceName: string,
  orgId:      string,
): Promise<void> {
  await fireAlert({
    type:       "device_offline",
    severity:   "warning",
    deviceId,
    deviceName,
    orgId,
  });
}

/**
 * Called by the heartbeat handler when a previously-offline device reconnects.
 */
export async function alertDeviceOnline(
  deviceId:   string,
  deviceName: string,
  orgId:      string,
): Promise<void> {
  // Clear the offline cooldown so a future offline alert fires immediately
  const key = `${orgId}:${deviceId}:device_offline`;
  lastAlertAt.delete(key);

  await fireAlert({
    type:       "device_online",
    severity:   "info",
    deviceId,
    deviceName,
    orgId,
  });
}

/**
 * Called by MDM command tracking when a command exceeds failure threshold.
 */
export async function alertCommandFailed(
  deviceId:    string,
  deviceName:  string,
  orgId:       string,
  commandType: string,
  lastError:   string,
): Promise<void> {
  await fireAlert({
    type:      "command_failed",
    severity:  "critical",
    deviceId,
    deviceName,
    orgId,
    meta: { commandType, lastError, threshold: MAX_COMMAND_FAILURES },
  });
}

/**
 * Called by the heartbeat handler when storage drops below critical threshold.
 */
export async function alertStorageCritical(
  deviceId:   string,
  deviceName: string,
  orgId:      string,
  freeMb:     number,
): Promise<void> {
  await fireAlert({
    type:      "storage_critical",
    severity:  "critical",
    deviceId,
    deviceName,
    orgId,
    meta: { freeMb, thresholdMb: STORAGE_CRITICAL_MB },
  });
}

export { OFFLINE_THRESHOLD_MINUTES, STORAGE_CRITICAL_MB, MAX_COMMAND_FAILURES };
