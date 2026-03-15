/**
 * contentScheduler.ts
 *
 * Enterprise content scheduling engine.
 *
 * Stack: pg-boss — Postgres-backed job queue.
 *
 * Why pg-boss:
 *   ✓ Jobs persist in the DB — survive server restarts, crashes, deploys
 *   ✓ Distributed locking — safe to run multiple server instances
 *   ✓ Built-in retry with exponential backoff
 *   ✓ Full audit log — every job execution recorded in pgboss.job
 *   ✓ Cron scheduling native — no manual interval management
 *   ✓ Deduplication via singletonKey — no double-execution
 *
 * Architecture:
 *   ┌─────────────────────────────────────────┐
 *   │  Cron: "schedule-check" (every minute)  │
 *   │  → scans content_schedules for active   │
 *   │    windows (start_time ≤ NOW ≤ end_time) │
 *   │  → dispatches "content-push" jobs       │
 *   └──────────────────┬──────────────────────┘
 *                      │ singletonKey per (scheduleId + deviceId)
 *                      │ prevents flooding on every tick
 *                      ▼
 *   ┌─────────────────────────────────────────┐
 *   │  Worker: "content-push"                 │
 *   │  → resolves content (template/playlist/ │
 *   │    media) → inserts device_command      │
 *   │  → retries 3× with backoff on failure   │
 *   └─────────────────────────────────────────┘
 *
 * Audit trail:
 *   SELECT * FROM pgboss.job
 *   WHERE name = 'content-push'
 *   ORDER BY createdon DESC;
 *
 * Manual trigger (future "Push Now" button):
 *   import { triggerScheduleNow } from "./contentScheduler";
 *   await triggerScheduleNow(scheduleId);
 */

import type PgBossType from "pg-boss";
import { pool } from "./db";

// pg-boss is kept external by the build script (script/build.ts FORCE_EXTERNAL).
// It must be loaded at runtime via require() — not bundled — because its ESM
// module format breaks when inlined into a CJS bundle by esbuild.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PgBoss: typeof PgBossType = require("pg-boss");

let boss: PgBossType | null = null;

// ── Types ─────────────────────────────────────────────────────────────────────

interface ContentPushJob {
  scheduleId:  number;
  deviceId:    string;
  contentType: string;
  contentId:   string;
  contentName: string;
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

export async function startContentScheduler(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.warn("[scheduler] DATABASE_URL not set — scheduler disabled");
    return;
  }

  try {
    boss = new PgBoss({
      connectionString: process.env.DATABASE_URL,
      // Completed jobs retained for 7 days — full audit trail
      deleteAfterDays: 7,
      // Failed jobs archived (not deleted) for post-mortem inspection
      archiveFailedAfterSeconds: 60 * 60 * 24 * 7,
    });

    boss.on("error", (err: Error) => {
      console.error("[scheduler] pg-boss error:", err.message);
    });

    await boss.start();
    console.log("[scheduler] pg-boss started");

    // Register the content-push worker
    // teamSize: up to 5 concurrent workers
    // teamConcurrency: 2 at a time per worker
    await boss.work<ContentPushJob>(
      "content-push",
      { teamSize: 5, teamConcurrency: 2 },
      contentPushWorker,
    );

    // Register the cron — fires every minute, UTC
    await boss.schedule("schedule-check", "* * * * *", {}, { tz: "UTC" });
    await boss.work("schedule-check", scheduleCheckWorker);

    console.log("[scheduler] Content scheduler active — tick every 60s");
  } catch (err) {
    // Non-fatal — API server continues even if scheduler fails
    console.error("[scheduler] Failed to start:", err);
  }
}

export async function stopContentScheduler(): Promise<void> {
  if (boss) {
    await boss.stop();
    boss = null;
    console.log("[scheduler] Stopped");
  }
}

// ── Schedule check ────────────────────────────────────────────────────────────

async function scheduleCheckWorker(): Promise<void> {
  if (!boss) return;

  const result = await pool.query<{
    id: number;
    title: string;
    contentType: string;
    contentId: string;
    deviceId: string | null;
    groupId: string | null;
  }>(`
    SELECT
      cs.id,
      cs.title,
      cs.content_type  AS "contentType",
      cs.content_id    AS "contentId",
      cs.device_id     AS "deviceId",
      cs.group_id      AS "groupId"
    FROM content_schedules cs
    WHERE cs.start_time <= NOW()
      AND cs.end_time   >= NOW()
      AND (cs.repeat_end_date IS NULL OR cs.repeat_end_date >= NOW())
    ORDER BY cs.start_time ASC
  `);

  if (result.rows.length === 0) return;
  console.log(`[scheduler] ${result.rows.length} active schedule(s)`);

  for (const schedule of result.rows) {
    const deviceIds = await resolveDeviceIds(schedule.deviceId, schedule.groupId);

    for (const deviceId of deviceIds) {
      // singletonKey = one job per (schedule + device) per 5-minute window.
      // Safe to run the check every minute without flooding device_commands.
      await boss!.send<ContentPushJob>(
        "content-push",
        {
          scheduleId:  schedule.id,
          deviceId,
          contentType: schedule.contentType,
          contentId:   schedule.contentId,
          contentName: schedule.title,
        },
        {
          singletonKey:     `sched-${schedule.id}-dev-${deviceId}`,
          singletonSeconds: 300,
          retryLimit:       3,
          retryDelay:       30,
          retryBackoff:     true,
        },
      );
    }
  }
}

// ── Content push worker ───────────────────────────────────────────────────────

async function contentPushWorker(
  job: PgBossType.Job<ContentPushJob>,
): Promise<void> {
  const { scheduleId, deviceId, contentType, contentId, contentName } = job.data;

  console.log(
    `[scheduler] Executing: ${contentType} "${contentName}" → ${deviceId} (scheduleId=${scheduleId})`,
  );

  const payload = await buildCommandPayload(
    contentType,
    contentId,
    contentName,
    scheduleId,
    job.id,
  );

  if (!payload) return; // logged inside buildCommandPayload

  await pool.query(
    `INSERT INTO device_commands (device_id, payload, sent, executed)
     VALUES ($1, $2, false, false)`,
    [deviceId, JSON.stringify(payload)],
  );

  console.log(`[scheduler] Command queued → ${deviceId}`);
}

// ── Payload builder ───────────────────────────────────────────────────────────

async function buildCommandPayload(
  contentType: string,
  contentId:   string,
  contentName: string,
  scheduleId:  number,
  jobId:       string,
): Promise<Record<string, unknown> | null> {
  const meta = { _scheduleId: String(scheduleId), _jobId: jobId };

  if (contentType === "template") {
    return { type: "load_template", templateId: contentId, contentName, contentType: "template", ...meta };
  }

  if (contentType === "playlist") {
    return { type: "refresh_playlist", playlistId: Number(contentId), contentName, contentType: "playlist", ...meta };
  }

  if (contentType === "media") {
    const row = await pool.query(
      `SELECT url, name, type FROM media WHERE id = $1 LIMIT 1`,
      [contentId],
    );
    if (!row.rows[0]) {
      console.warn(`[scheduler] Media ${contentId} not found — skipping`);
      return null;
    }
    const m = row.rows[0];
    return {
      type:        "play_content",
      contentId:   Number(contentId),
      contentUrl:  m.url,
      contentType: m.type,
      contentName: m.name,
      ...meta,
    };
  }

  console.warn(`[scheduler] Unknown contentType: ${contentType}`);
  return null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function resolveDeviceIds(
  deviceId: string | null,
  groupId:  string | null,
): Promise<string[]> {
  if (deviceId) return [deviceId];
  if (!groupId)  return [];

  try {
    const result = await pool.query<{ device_id: string }>(`
      SELECT device_id FROM device_group_map     WHERE group_id::text = $1
      UNION
      SELECT device_id FROM device_group_members WHERE group_id::text = $1
    `, [groupId]);
    return result.rows.map((r) => r.device_id).filter(Boolean);
  } catch (err) {
    console.error(`[scheduler] resolveDeviceIds failed for group ${groupId}:`, err);
    return [];
  }
}

// ── Manual trigger ────────────────────────────────────────────────────────────

/**
 * Immediately dispatch content for a schedule — used by the "Push Now"
 * button in the CMS without waiting for the next cron tick.
 */
export async function triggerScheduleNow(scheduleId: number): Promise<void> {
  if (!boss) throw new Error("Scheduler not running");

  const result = await pool.query(`
    SELECT id, title,
           content_type AS "contentType",
           content_id   AS "contentId",
           device_id    AS "deviceId",
           group_id     AS "groupId"
    FROM content_schedules WHERE id = $1 LIMIT 1
  `, [scheduleId]);

  if (!result.rows[0]) throw new Error(`Schedule ${scheduleId} not found`);
  const s = result.rows[0];

  const deviceIds = await resolveDeviceIds(s.deviceId, s.groupId);

  for (const deviceId of deviceIds) {
    await boss.send<ContentPushJob>("content-push", {
      scheduleId: s.id,
      deviceId,
      contentType: s.contentType,
      contentId:   s.contentId,
      contentName: s.title,
    }, {
      retryLimit:  3,
      retryDelay:  10,
      retryBackoff: true,
    });
  }

  console.log(`[scheduler] Manual trigger: scheduleId=${scheduleId} → ${deviceIds.length} device(s)`);
}
