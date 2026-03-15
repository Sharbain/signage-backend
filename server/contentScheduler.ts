/**
 * contentScheduler.ts
 * PR-PHASE2: Enterprise content scheduling engine using pg-boss.
 *
 * Why pg-boss over setInterval:
 *   - Jobs persist in Postgres — survive server restarts and crashes
 *   - Distributed locking — safe with multiple server instances (scaling)
 *   - Built-in retry with exponential backoff
 *   - Full audit log in pgboss.job table — every execution is recorded
 *   - Cron scheduling built in — no manual interval management
 *
 * Architecture:
 *   - One recurring cron job: "schedule-check" runs every minute
 *   - For each active content_schedule, dispatches a "content-push" job
 *   - "content-push" jobs are deduplicated by singletonKey — one per
 *     (scheduleId + deviceId) per 5-minute window
 *   - Actual device command insertion happens in the "content-push" worker
 *
 * Audit trail:
 *   SELECT * FROM pgboss.job WHERE name = 'content-push' ORDER BY createdon DESC;
 */

import PgBossModule from "pg-boss";
// Handle both ESM default export and CJS module.exports patterns
const PgBoss = (PgBossModule as any).default ?? PgBossModule;
import { pool } from "./db";

let boss: PgBoss | null = null;

// ── Bootstrap ─────────────────────────────────────────────────────────────────

export async function startContentScheduler() {
  if (!process.env.DATABASE_URL) {
    console.warn("[scheduler] DATABASE_URL not set — scheduler disabled");
    return;
  }

  try {
    boss = new PgBoss({
      connectionString: process.env.DATABASE_URL,
      deleteAfterDays: 7,
      archiveFailedAfterSeconds: 60 * 60 * 24 * 7,
    });

    boss.on("error", (err) => {
      console.error("[scheduler] pg-boss error:", err);
    });

    await boss.start();
    console.log("[scheduler] pg-boss started");

    await boss.work<ContentPushPayload>(
      "content-push",
      { teamSize: 5, teamConcurrency: 2 },
      contentPushWorker,
    );

    await boss.schedule("schedule-check", "* * * * *", {}, { tz: "UTC" });
    await boss.work("schedule-check", scheduleCheckWorker);

    console.log("[scheduler] Content scheduler running — checking every minute");
  } catch (err) {
    console.error("[scheduler] Failed to start:", err);
  }
}

export async function stopContentScheduler() {
  if (boss) {
    await boss.stop();
    boss = null;
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface ContentPushPayload {
  scheduleId:  number;
  deviceId:    string;
  contentType: string;
  contentId:   string;
  contentName: string;
}

// ── Schedule check worker ─────────────────────────────────────────────────────

async function scheduleCheckWorker() {
  if (!boss) return;

  try {
    const result = await pool.query(`
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
        await boss!.send("content-push", {
          scheduleId:  schedule.id,
          deviceId,
          contentType: schedule.contentType,
          contentId:   schedule.contentId,
          contentName: schedule.title,
        } as ContentPushPayload, {
          // singletonKey prevents duplicate jobs within 5 minutes
          singletonKey:     `schedule-${schedule.id}-device-${deviceId}`,
          singletonSeconds: 300,
          retryLimit:       3,
          retryDelay:       30,
          retryBackoff:     true,
        });
      }
    }
  } catch (err) {
    console.error("[scheduler] Schedule check failed:", err);
    throw err;
  }
}

// ── Content push worker ───────────────────────────────────────────────────────

async function contentPushWorker(job: PgBossModule.Job<ContentPushPayload>) {
  const { scheduleId, deviceId, contentType, contentId, contentName } = job.data;

  console.log(`[scheduler] Push: ${contentType} "${contentName}" → ${deviceId} (schedule=${scheduleId})`);

  try {
    let payload: any;

    if (contentType === "template") {
      payload = {
        type: "load_template",
        templateId: contentId,
        contentName,
        contentType: "template",
        _scheduleId: String(scheduleId),
        _jobId: job.id,
      };
    } else if (contentType === "playlist") {
      payload = {
        type: "refresh_playlist",
        playlistId: Number(contentId),
        contentName,
        contentType: "playlist",
        _scheduleId: String(scheduleId),
        _jobId: job.id,
      };
    } else if (contentType === "media") {
      const mediaResult = await pool.query(
        `SELECT url, name, type FROM media WHERE id = $1 LIMIT 1`,
        [contentId],
      );
      if (!mediaResult.rows[0]) {
        console.warn(`[scheduler] Media ${contentId} not found — skipping`);
        return;
      }
      const media = mediaResult.rows[0];
      payload = {
        type: "play_content",
        contentId: Number(contentId),
        contentUrl: media.url,
        contentType: media.type,
        contentName: media.name,
        _scheduleId: String(scheduleId),
        _jobId: job.id,
      };
    } else {
      console.warn(`[scheduler] Unknown content type: ${contentType}`);
      return;
    }

    await pool.query(
      `INSERT INTO device_commands (device_id, payload, sent, executed)
       VALUES ($1, $2, false, false)`,
      [deviceId, JSON.stringify(payload)],
    );

    console.log(`[scheduler] Command queued: ${contentType} → ${deviceId}`);
  } catch (err) {
    console.error(`[scheduler] Push failed for ${deviceId}:`, err);
    throw err; // pg-boss retries with backoff
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function resolveDeviceIds(
  deviceId: string | null,
  groupId:  string | null,
): Promise<string[]> {
  if (deviceId) return [deviceId];
  if (!groupId)  return [];
  try {
    const result = await pool.query(`
      SELECT device_id FROM device_group_map     WHERE group_id::text = $1
      UNION
      SELECT device_id FROM device_group_members WHERE group_id::text = $1
    `, [groupId]);
    return result.rows.map((r: any) => r.device_id).filter(Boolean);
  } catch (err) {
    console.error(`[scheduler] Failed to resolve group ${groupId}:`, err);
    return [];
  }
}

// ── Manual trigger — "Push Now" button in CMS ─────────────────────────────────

export async function triggerScheduleNow(scheduleId: number): Promise<void> {
  if (!boss) throw new Error("Scheduler not running");

  const result = await pool.query(
    `SELECT id, title,
            content_type AS "contentType",
            content_id   AS "contentId",
            device_id    AS "deviceId",
            group_id     AS "groupId"
     FROM content_schedules WHERE id = $1 LIMIT 1`,
    [scheduleId],
  );
  if (!result.rows[0]) throw new Error(`Schedule ${scheduleId} not found`);

  const s = result.rows[0];
  const deviceIds = await resolveDeviceIds(s.deviceId, s.groupId);

  for (const deviceId of deviceIds) {
    await boss.send("content-push", {
      scheduleId: s.id,
      deviceId,
      contentType: s.contentType,
      contentId:   s.contentId,
      contentName: s.title,
    } as ContentPushPayload, {
      retryLimit:  3,
      retryDelay:  10,
      retryBackoff: true,
    });
  }
}
