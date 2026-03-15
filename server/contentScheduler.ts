/**
 * contentScheduler.ts — Enterprise content scheduling via pg-boss.
 */

import { pool } from "./db";

// Dynamically import pg-boss to bypass esbuild bundling entirely.
// Using dynamic import() ensures the module is resolved at runtime
// from node_modules — not statically analyzed or bundled by esbuild.
async function loadPgBoss() {
  const mod = await import("pg-boss");
  return mod.default ?? mod;
}

let boss: any = null;

interface ContentPushJob {
  scheduleId:  number;
  deviceId:    string;
  contentType: string;
  contentId:   string;
  contentName: string;
}

export async function startContentScheduler(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.warn("[scheduler] DATABASE_URL not set — disabled");
    return;
  }

  try {
    const PgBoss = await loadPgBoss();

    boss = new PgBoss({
      connectionString: process.env.DATABASE_URL,
      deleteAfterDays: 7,
      archiveFailedAfterSeconds: 60 * 60 * 24 * 7,
    });

    boss.on("error", (err: Error) => {
      console.error("[scheduler] pg-boss error:", err.message);
    });

    await boss.start();
    console.log("[scheduler] pg-boss started");

    await boss.work<ContentPushJob>(
      "content-push",
      { teamSize: 5, teamConcurrency: 2 },
      contentPushWorker,
    );

    await boss.schedule("schedule-check", "* * * * *", {}, { tz: "UTC" });
    await boss.work("schedule-check", scheduleCheckWorker);

    console.log("[scheduler] Content scheduler active — tick every 60s");
  } catch (err) {
    console.error("[scheduler] Failed to start:", err);
  }
}

export async function stopContentScheduler(): Promise<void> {
  if (boss) {
    await boss.stop();
    boss = null;
  }
}

async function scheduleCheckWorker(): Promise<void> {
  if (!boss) return;

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
      await boss.send("content-push", {
        scheduleId:  schedule.id,
        deviceId,
        contentType: schedule.contentType,
        contentId:   schedule.contentId,
        contentName: schedule.title,
      }, {
        singletonKey:     `sched-${schedule.id}-dev-${deviceId}`,
        singletonSeconds: 300,
        retryLimit:       3,
        retryDelay:       30,
        retryBackoff:     true,
      });
    }
  }
}

async function contentPushWorker(job: any): Promise<void> {
  const { scheduleId, deviceId, contentType, contentId, contentName } = job.data;
  console.log(`[scheduler] Push: ${contentType} "${contentName}" → ${deviceId}`);

  const payload = await buildPayload(contentType, contentId, contentName, scheduleId, job.id);
  if (!payload) return;

  await pool.query(
    `INSERT INTO device_commands (device_id, payload, sent, executed)
     VALUES ($1, $2, false, false)`,
    [deviceId, JSON.stringify(payload)],
  );

  console.log(`[scheduler] Command queued → ${deviceId}`);
}

async function buildPayload(
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
    const row = await pool.query(`SELECT url, name, type FROM media WHERE id = $1 LIMIT 1`, [contentId]);
    if (!row.rows[0]) { console.warn(`[scheduler] Media ${contentId} not found`); return null; }
    const m = row.rows[0];
    return { type: "play_content", contentId: Number(contentId), contentUrl: m.url, contentType: m.type, contentName: m.name, ...meta };
  }

  console.warn(`[scheduler] Unknown contentType: ${contentType}`);
  return null;
}

async function resolveDeviceIds(deviceId: string | null, groupId: string | null): Promise<string[]> {
  if (deviceId) return [deviceId];
  if (!groupId) return [];
  try {
    const r = await pool.query(`
      SELECT device_id FROM device_group_map     WHERE group_id::text = $1
      UNION
      SELECT device_id FROM device_group_members WHERE group_id::text = $1
    `, [groupId]);
    return r.rows.map((x: any) => x.device_id).filter(Boolean);
  } catch { return []; }
}

export async function triggerScheduleNow(scheduleId: number): Promise<void> {
  if (!boss) throw new Error("Scheduler not running");
  const r = await pool.query(`
    SELECT id, title, content_type AS "contentType", content_id AS "contentId",
           device_id AS "deviceId", group_id AS "groupId"
    FROM content_schedules WHERE id = $1 LIMIT 1
  `, [scheduleId]);
  if (!r.rows[0]) throw new Error(`Schedule ${scheduleId} not found`);
  const s = r.rows[0];
  const deviceIds = await resolveDeviceIds(s.deviceId, s.groupId);
  for (const deviceId of deviceIds) {
    await boss.send("content-push", {
      scheduleId: s.id, deviceId,
      contentType: s.contentType, contentId: s.contentId, contentName: s.title,
    }, { retryLimit: 3, retryDelay: 10, retryBackoff: true });
  }
}
