/**
 * schedule.routes.ts
 * Routes: /api/schedule, /api/content-schedules, /api/content-options
 *
 * Extracted from monolithic routes.ts.
 */

import type { Express } from "express";
import path from "path";
import { pool } from "../db";
import { storage } from "../storage";

export function registerScheduleRoutes(app: Express) {

  // ---------------------------------------------------------------------------
  // Legacy schedule API (used by template scheduling)
  // ---------------------------------------------------------------------------

  app.get("/api/schedule", async (req, res) => {
    try {
      const { templateId, deviceId, groupId } = req.query;
      let scheduleList: any[] = [];
      if (templateId)     scheduleList = await storage.getSchedulesByTemplate(templateId as string);
      else if (deviceId)  scheduleList = await storage.getSchedulesByDevice(deviceId as string);
      else if (groupId)   scheduleList = await storage.getSchedulesByGroup(groupId as string);
      else                scheduleList = await storage.getAllSchedules();
      res.json(scheduleList);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch schedules" });
    }
  });

  app.post("/api/schedule", async (req, res) => {
    try {
      const { templateId, deviceId, groupId, startTime, endTime } = req.body;
      if (!templateId) return res.status(400).json({ error: "templateId is required" });
      if (!startTime || !endTime) return res.status(400).json({ error: "startTime and endTime are required" });
      if (!deviceId && !groupId) return res.status(400).json({ error: "deviceId or groupId is required" });

      const schedule = await storage.createSchedule({
        templateId,
        targetType: deviceId ? "device" : "group",
        targetId: deviceId ?? groupId,
        startTime,
        endTime,
      });
      res.json({ message: "Schedule assigned", data: schedule });
    } catch (error) {
      res.status(500).json({ error: "Failed to create schedule" });
    }
  });

  // Content schedule list (FullCalendar format)
  app.get("/api/schedule/list", async (_req, res) => {
    try {
      const schedules = await storage.getContentSchedules();
      const events = schedules.map((s) => ({
        id: s.id.toString(),
        title: s.contentId || "Untitled",
        start: s.start,
        end: s.end,
        extendedProps: { contentId: s.contentId },
      }));
      res.json(events);
    } catch (error) {
      console.error("Failed to fetch content schedules:", error);
      res.status(500).json({ error: "Failed to fetch schedules" });
    }
  });

  app.post("/api/schedule/save", async (req, res) => {
    try {
      const { id, contentId, start, end } = req.body;
      if (!start || !end) return res.status(400).json({ error: "start and end are required" });

      const startDate = new Date(start);
      const endDate   = new Date(end);
      const hasOverlap = await storage.checkScheduleOverlap(startDate, endDate, id ? parseInt(id) : undefined);
      if (hasOverlap) return res.status(409).json({ error: "Time slot overlaps with existing content." });

      if (id) {
        const updated = await storage.updateContentSchedule(parseInt(id), { contentId, start: startDate, end: endDate });
        res.json({ message: "Schedule updated", data: updated });
      } else {
        const created = await storage.createContentSchedule({ contentId, start: startDate, end: endDate });
        res.json({ message: "Schedule created", data: created });
      }
    } catch (error) {
      console.error("Failed to save schedule:", error);
      res.status(500).json({ error: "Failed to save schedule" });
    }
  });

  app.post("/api/schedule/updateTime", async (req, res) => {
    try {
      const { id, start, end } = req.body;
      if (!id || !start || !end) return res.status(400).json({ error: "id, start, and end are required" });

      const startDate = new Date(start);
      const endDate   = new Date(end);
      const hasOverlap = await storage.checkScheduleOverlap(startDate, endDate, parseInt(id));
      if (hasOverlap) return res.status(409).json({ error: "Time slot overlaps with existing content." });

      const updated = await storage.updateContentSchedule(parseInt(id), { start: startDate, end: endDate });
      if (!updated) return res.status(404).json({ error: "Schedule not found" });
      res.json({ message: "Schedule time updated", data: updated });
    } catch (error) {
      console.error("Failed to update schedule time:", error);
      res.status(500).json({ error: "Failed to update schedule time" });
    }
  });

  // Player schedule download — returns local_schedule.json format
  app.get("/api/schedule/download/:deviceId", async (req, res) => {
    try {
      const { deviceId } = req.params;
      const deviceSchedules = await storage.getSchedulesByDevice(deviceId);

      if (deviceSchedules.length === 0) return res.json({ templates: [] });

      const allMedia = await storage.getAllMedia();
      const mediaMap = new Map(allMedia.map((m) => [m.id.toString(), m]));

      const templateScheduleMap = new Map<string, any[]>();
      for (const sched of deviceSchedules) {
        if (!sched.templateId) continue;
        if (!templateScheduleMap.has(sched.templateId)) templateScheduleMap.set(sched.templateId, []);
        templateScheduleMap.get(sched.templateId)!.push({
          start_time: sched.startTime?.toString().slice(0, 5) || "00:00",
          end_time:   sched.endTime?.toString().slice(0, 5)   || "23:59",
        });
      }

      const templatesList = [];

      for (const [templateId, schedules] of Array.from(templateScheduleMap.entries())) {
        const template = await storage.getTemplate(templateId);
        if (!template) continue;

        const layout = (template.layout || { zones: [] }) as { zones?: any[] };
        const playlistItemsMap = new Map<string, any>();
        const zonesWithIds = [];

        if (layout.zones) {
          for (const zone of layout.zones) {
            const playlistIds: string[] = [];
            for (const itemRef of zone.playlist || []) {
              const itemId = itemRef.toString();
              playlistIds.push(itemId);
              if (!playlistItemsMap.has(itemId)) {
                const media = mediaMap.get(itemId);
                if (media) {
                  const ext = media.url.split(".").pop() || "";
                  const localPath = media.type === "live"
                    ? ""
                    : `Content/${media.name.replace(/\s+/g, "_")}.${ext}`;
                  playlistItemsMap.set(itemId, { id: itemId, type: media.type, url: media.url, localPath });
                } else {
                  const ext = itemRef.split(".").pop() || "jpg";
                  playlistItemsMap.set(itemId, {
                    id: itemId,
                    type: itemRef.includes(".mp4") ? "video" : "image",
                    url: itemRef,
                    localPath: `Content/${itemId}.${ext}`,
                  });
                }
              }
            }
            zonesWithIds.push({ id: zone.id, x: zone.x, y: zone.y, width: zone.width, height: zone.height, playlist: playlistIds });
          }
        }

        templatesList.push({
          id: template.id,
          layout: { zones: zonesWithIds },
          playlistItems: Array.from(playlistItemsMap.values()),
          schedule: schedules,
        });
      }

      res.json({ templates: templatesList });
    } catch (error) {
      res.status(500).json({ error: "Failed to download schedule" });
    }
  });

  // ---------------------------------------------------------------------------
  // Content schedules — FullCalendar / calendar UI
  // ---------------------------------------------------------------------------

  app.get("/api/content-schedules", async (req, res) => {
    try {
      const { start, end, deviceId, groupId } = req.query;

      let query = `
        SELECT cs.*,
          CASE
            WHEN cs.content_type = 'media'    THEN m.name
            WHEN cs.content_type = 'playlist' THEN cp.name
            WHEN cs.content_type = 'template' THEN t.name
          END AS content_name,
          s.name  AS device_name,
          dg.name AS group_name
        FROM content_schedules cs
        LEFT JOIN media m             ON cs.content_type = 'media'    AND cs.content_id = m.id::text
        LEFT JOIN content_playlists cp ON cs.content_type = 'playlist' AND cs.content_id = cp.id::text
        LEFT JOIN templates t          ON cs.content_type = 'template' AND cs.content_id = t.id::text
        LEFT JOIN screens s            ON cs.device_id = s.device_id
        LEFT JOIN device_groups dg     ON cs.group_id = dg.id::text
        WHERE 1=1`;

      const params: any[] = [];
      let paramIndex = 1;

      if (start)    { query += ` AND cs.end_time   >= $${paramIndex++}`; params.push(start); }
      if (end)      { query += ` AND cs.start_time <= $${paramIndex++}`; params.push(end); }
      if (deviceId) { query += ` AND cs.device_id = $${paramIndex++}`;   params.push(deviceId); }
      if (groupId)  { query += ` AND cs.group_id = $${paramIndex++}`;    params.push(groupId); }

      query += ` ORDER BY cs.start_time ASC`;

      const result = await pool.query(query, params);
      res.json(result.rows);
    } catch (err) {
      console.error("Get schedules error:", err);
      res.status(500).json({ error: "Failed to get schedules" });
    }
  });

  app.post("/api/content-schedules", async (req, res) => {
    try {
      const { title, contentType, contentId, deviceId, groupId, startTime, endTime, allDay, repeatType, repeatEndDate, color } = req.body;
      if (!title || !contentType || !contentId || !startTime || !endTime) {
        return res.status(400).json({ error: "Missing required fields" });
      }
      const result = await pool.query(
        `INSERT INTO content_schedules
           (title, content_type, content_id, device_id, group_id, start_time, end_time, all_day, repeat_type, repeat_end_date, color)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [title, contentType, contentId, deviceId || null, groupId || null, startTime, endTime,
         allDay || false, repeatType || "none", repeatEndDate || null, color || "#3b82f6"],
      );
      res.json(result.rows[0]);
    } catch (err) {
      console.error("Create schedule error:", err);
      res.status(500).json({ error: "Failed to create schedule" });
    }
  });

  app.put("/api/content-schedules/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const { title, contentType, contentId, deviceId, groupId, startTime, endTime, allDay, repeatType, repeatEndDate, color } = req.body;
      const result = await pool.query(
        `UPDATE content_schedules SET
           title           = COALESCE($1,  title),
           content_type    = COALESCE($2,  content_type),
           content_id      = COALESCE($3,  content_id),
           device_id       = $4,
           group_id        = $5,
           start_time      = COALESCE($6,  start_time),
           end_time        = COALESCE($7,  end_time),
           all_day         = COALESCE($8,  all_day),
           repeat_type     = COALESCE($9,  repeat_type),
           repeat_end_date = $10,
           color           = COALESCE($11, color),
           updated_at      = NOW()
         WHERE id = $12
         RETURNING *`,
        [title, contentType, contentId, deviceId || null, groupId || null,
         startTime, endTime, allDay, repeatType, repeatEndDate || null, color, id],
      );
      if (result.rowCount === 0) return res.status(404).json({ error: "Schedule not found" });
      res.json(result.rows[0]);
    } catch (err) {
      console.error("Update schedule error:", err);
      res.status(500).json({ error: "Failed to update schedule" });
    }
  });

  app.delete("/api/content-schedules/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const result = await pool.query(
        `DELETE FROM content_schedules WHERE id = $1 RETURNING id`,
        [id],
      );
      if (result.rowCount === 0) return res.status(404).json({ error: "Schedule not found" });
      res.json({ success: true, deletedId: id });
    } catch (err) {
      console.error("Delete schedule error:", err);
      res.status(500).json({ error: "Failed to delete schedule" });
    }
  });

  // GET /api/content-options — dropdown data for scheduling UI
  app.get("/api/content-options", async (_req, res) => {
    try {
      const [mediaResult, playlistResult, templateResult] = await Promise.all([
        pool.query(`SELECT id, name, type, url FROM media WHERE is_expired = false ORDER BY name`),
        pool.query(`SELECT id, name, description FROM content_playlists ORDER BY name`),
        pool.query(`SELECT id, name FROM templates ORDER BY name`),
      ]);
      res.json({ media: mediaResult.rows, playlists: playlistResult.rows, templates: templateResult.rows });
    } catch (err) {
      console.error("Get content options error:", err);
      res.status(500).json({ error: "Failed to get content options" });
    }
  });
}
