/**
 * contentScheduler.ts — Content scheduling engine.
 *
 * Uses node-cron (already a project dependency) for reliable cron execution.
 *
 * Architecture:
 *   - Cron fires every minute
 *   - Queries content_schedules for active windows
 *   - Deduplicates via device_commands table (5-min window)
 *   - Inserts device_command per target device
 *   - Retries handled by MDMCommandBus on the device side
 *
 * Scaling path:
 *   When running multiple server instances, replace node-cron with pg-boss
 *   after migrating the build system to ESM output. The job logic below
 *   (scheduleCheckWorker, contentPushWorker) moves unchanged.
 *
 * Audit trail:
 *   SELECT * FROM device_commands
 *   WHERE payload->>'_scheduledBy' = 'contentScheduler'
 *   ORDER BY created_at DESC;
 */

import cron from "node-cron";
import { pool } from "./db";

const DEDUP_WINDOW_MINUTES = 5;

export function startContentScheduler(): void {
  if (!process.env.DATABASE_URL) {
    console.warn("[scheduler] DATABASE_URL not set — disabled");
    return;
  }

  // Run immediately on start, then every minute
  scheduleCheckWorker().catch((err) =>
    console.error("[scheduler] Initial check failed:", err),
  );

  cron.schedule("* * * * *", () => {
    scheduleCheckWorker().catch((err) =>
      console.error("[scheduler] Tick failed:", err),
    );
  });

  console.log("[scheduler] Content scheduler active — tick every 60s");
}

// ── Core worker ───────────────────────────────────────────────────────────────

async function scheduleCheckWorker(): Promise<void> {
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
      await pushToDevice(deviceId, schedule).catch((err) =>
        console.error(`[scheduler] Push failed for ${deviceId}:`, err),
      );
    }
  }
}

async function pushToDevice(deviceId: string, schedule: any): Promise<void> {
  // Deduplication: skip if we queued this schedule for this device recently.
  // Prevents re-queuing on every tick while the schedule window is active.
  const recent = await pool.query(`
    SELECT id FROM device_commands
    WHERE device_id = $1
      AND payload->>'_scheduleId' = $2
      AND payload->>'_scheduledBy' = 'contentScheduler'
      AND created_at > NOW() - INTERVAL '${DEDUP_WINDOW_MINUTES} minutes'
    LIMIT 1
  `, [deviceId, String(schedule.id)]);

  if (recent.rows.length > 0) return;

  const payload = await buildPayload(schedule);
  if (!payload) return;

  await pool.query(
    `INSERT INTO device_commands (device_id, payload, sent, executed)
     VALUES ($1, $2, false, false)`,
    [deviceId, JSON.stringify(payload)],
  );

  console.log(`[scheduler] Queued: ${schedule.contentType} "${schedule.title}" → ${deviceId}`);
}

// ── Payload builder ───────────────────────────────────────────────────────────

async function buildPayload(schedule: any): Promise<Record<string, unknown> | null> {
  const meta = {
    _scheduleId:   String(schedule.id),
    _scheduledBy:  "contentScheduler",
  };

  if (schedule.contentType === "template") {
    return {
      type:        "load_template",
      templateId:  schedule.contentId,
      contentName: schedule.title,
      contentType: "template",
      ...meta,
    };
  }

  if (schedule.contentType === "playlist") {
    return {
      type:        "refresh_playlist",
      playlistId:  Number(schedule.contentId),
      contentName: schedule.title,
      contentType: "playlist",
      ...meta,
    };
  }

  if (schedule.contentType === "media") {
    const row = await pool.query(
      `SELECT url, name, type FROM media WHERE id = $1 LIMIT 1`,
      [schedule.contentId],
    );
    if (!row.rows[0]) {
      console.warn(`[scheduler] Media ${schedule.contentId} not found — skipping`);
      return null;
    }
    const m = row.rows[0];
    return {
      type:        "play_content",
      contentId:   Number(schedule.contentId),
      contentUrl:  m.url,
      contentType: m.type,
      contentName: m.name,
      ...meta,
    };
  }

  console.warn(`[scheduler] Unknown contentType: ${schedule.contentType}`);
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
    const r = await pool.query(`
      SELECT device_id FROM device_group_map     WHERE group_id::text = $1
      UNION
      SELECT device_id FROM device_group_members WHERE group_id::text = $1
    `, [groupId]);
    return r.rows.map((x: any) => x.device_id).filter(Boolean);
  } catch (err) {
    console.error(`[scheduler] resolveDeviceIds failed:`, err);
    return [];
  }
}

// ── Manual trigger — "Push Now" in CMS ───────────────────────────────────────

export async function triggerScheduleNow(scheduleId: number): Promise<void> {
  const r = await pool.query(`
    SELECT id, title,
           content_type AS "contentType",
           content_id   AS "contentId",
           device_id    AS "deviceId",
           group_id     AS "groupId"
    FROM content_schedules WHERE id = $1 LIMIT 1
  `, [scheduleId]);

  if (!r.rows[0]) throw new Error(`Schedule ${scheduleId} not found`);
  const s = r.rows[0];
  const deviceIds = await resolveDeviceIds(s.deviceId, s.groupId);

  for (const deviceId of deviceIds) {
    const payload = await buildPayload(s);
    if (!payload) continue;
    await pool.query(
      `INSERT INTO device_commands (device_id, payload, sent, executed)
       VALUES ($1, $2, false, false)`,
      [deviceId, JSON.stringify({ ...payload, _manual: true })],
    );
  }

  console.log(`[scheduler] Manual trigger: scheduleId=${scheduleId} → ${deviceIds.length} device(s)`);
}
