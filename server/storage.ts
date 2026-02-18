import { db, pool } from "./db";
import { supabase } from "./supabaseClient";
import { users, screens, media, playlists, templates, templatePlaylistItems, templateSchedule, deviceGroups, deviceGroupMap, deviceStatusLogs, schedule, type User, type InsertUser, type Screen, type InsertScreen, type Media, type InsertMedia, type Playlist, type InsertPlaylist, type Template, type InsertTemplate, type TemplatePlaylistItem, type InsertTemplatePlaylistItem, type TemplateSchedule, type InsertTemplateSchedule, type DeviceGroup, type InsertDeviceGroup, type DeviceGroupMap, type InsertDeviceGroupMap, type InsertDeviceStatusLog, type DeviceStatusLog, type Schedule, type InsertSchedule } from "@shared/schema";
import { eq, asc, or, desc, and, lt, gt, ne, sql } from "drizzle-orm";

export interface DeviceStatusUpdate {
  status?: string;
  currentContent?: string;
  currentContentName?: string;
  temperature?: number;
  freeStorage?: number;
  batteryLevel?: number;
  signalStrength?: number;
  isOnline?: boolean;
  latitude?: number;
  longitude?: number;
  errors?: string[];
}

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  
  getAllScreens(): Promise<Screen[]>;
  getScreen(id: number): Promise<Screen | undefined>;
  getScreenByDeviceId(deviceId: string): Promise<Screen | undefined>;
  createScreen(screen: InsertScreen): Promise<Screen>;
  updateScreen(id: number, screen: Partial<InsertScreen>): Promise<Screen | undefined>;
  updateDeviceStatus(deviceId: string, status: DeviceStatusUpdate): Promise<Screen | undefined>;
  deleteScreen(id: number): Promise<boolean>;
  
  getAllMedia(): Promise<Media[]>;
  getMedia(id: number): Promise<Media | undefined>;
  createMedia(media: InsertMedia): Promise<Media>;
  deleteMedia(id: number): Promise<boolean>;

  getPlaylistsByScreenId(screenId: number): Promise<Playlist[]>;
  createPlaylistEntry(entry: InsertPlaylist): Promise<Playlist>;
  deletePlaylistEntry(id: number): Promise<boolean>;

  getAllTemplates(): Promise<Template[]>;
  getTemplate(id: string): Promise<Template | undefined>;
  createTemplate(template: InsertTemplate): Promise<Template>;
  updateTemplate(id: string, data: Partial<InsertTemplate>): Promise<Template | undefined>;
  deleteTemplate(id: string): Promise<boolean>;

  getTemplatePlaylistItems(templateId: string): Promise<TemplatePlaylistItem[]>;
  createTemplatePlaylistItem(item: InsertTemplatePlaylistItem): Promise<TemplatePlaylistItem>;
  updateTemplatePlaylistItemOrder(id: string, orderIndex: number): Promise<TemplatePlaylistItem | undefined>;
  deleteTemplatePlaylistItem(id: string): Promise<boolean>;

  getAllSchedules(): Promise<TemplateSchedule[]>;
  getSchedulesByTemplate(templateId: string): Promise<TemplateSchedule[]>;
  getSchedulesByDevice(deviceId: string): Promise<TemplateSchedule[]>;
  getSchedulesByGroup(groupId: string): Promise<TemplateSchedule[]>;
  createSchedule(schedule: InsertTemplateSchedule): Promise<TemplateSchedule>;
  deleteSchedule(id: string): Promise<boolean>;

  getAllGroups(): Promise<DeviceGroup[]>;
  createGroup(group: InsertDeviceGroup): Promise<DeviceGroup>;
  addDeviceToGroup(deviceId: string, groupId: string): Promise<DeviceGroupMap>;
  getDevicesByGroup(groupId: string): Promise<DeviceGroupMap[]>;
  getDeviceCountsByGroup(): Promise<Record<string, { online: number; offline: number }>>;

  createDeviceStatusLog(log: InsertDeviceStatusLog): Promise<DeviceStatusLog>;
  getDeviceStatusLogs(deviceId: string, limit?: number): Promise<DeviceStatusLog[]>;

  getContentSchedules(): Promise<Schedule[]>;
  getContentSchedule(id: number): Promise<Schedule | undefined>;
  createContentSchedule(data: InsertSchedule): Promise<Schedule>;
  updateContentSchedule(id: number, data: Partial<InsertSchedule>): Promise<Schedule | undefined>;
  deleteContentSchedule(id: number): Promise<boolean>;
  checkScheduleOverlap(start: Date, end: Date, excludeId?: number): Promise<boolean>;
}

export class DbStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.id, id)).limit(1);
    return result[0];
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.email, email)).limit(1);
    return result[0];
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const result = await db.insert(users).values(insertUser).returning();
    return result[0];
  }

  async getAllScreens(): Promise<Screen[]> {
    return db.select().from(screens);
  }

  async getAllScreensWithGroup(): Promise<(Screen & { groupId: string | null })[]> {
    const result = await db.execute(sql`
      SELECT s.*, m.group_id as "groupId"
      FROM screens s
      LEFT JOIN device_group_map m ON m.device_id = s.device_id
    `);
    return result.rows as (Screen & { groupId: string | null })[];
  }

  async getScreen(id: number): Promise<Screen | undefined> {
    const result = await db.select().from(screens).where(eq(screens.id, id)).limit(1);
    return result[0];
  }

  async getScreenByDeviceId(deviceId: string): Promise<Screen | undefined> {
    const result = await db.select().from(screens).where(eq(screens.deviceId, deviceId)).limit(1);
    return result[0];
  }

  async createScreen(screen: InsertScreen): Promise<Screen> {
    const result = await db.insert(screens).values(screen as any).returning();
    return result[0];
  }

  async updateScreen(id: number, screenUpdate: Partial<InsertScreen>): Promise<Screen | undefined> {
    const result = await db.update(screens).set(screenUpdate as any).where(eq(screens.id, id)).returning();
    return result[0];
  }

  async deleteScreen(id: number): Promise<boolean> {
    const result = await db.delete(screens).where(eq(screens.id, id)).returning();
    return result.length > 0;
  }

  async updateDeviceStatus(deviceId: string, statusUpdate: DeviceStatusUpdate): Promise<Screen | undefined> {
    const updateData: Record<string, unknown> = { lastSeen: new Date() };
    if (statusUpdate.status !== undefined) updateData.status = statusUpdate.status;
    if (statusUpdate.currentContent !== undefined) updateData.currentContent = statusUpdate.currentContent;
    if (statusUpdate.currentContentName !== undefined) updateData.currentContentName = statusUpdate.currentContentName;
    if (statusUpdate.temperature !== undefined) updateData.temperature = statusUpdate.temperature;
    if (statusUpdate.freeStorage !== undefined) updateData.freeStorage = statusUpdate.freeStorage;
    if (statusUpdate.batteryLevel !== undefined) updateData.batteryLevel = statusUpdate.batteryLevel;
    if (statusUpdate.signalStrength !== undefined) updateData.signalStrength = statusUpdate.signalStrength;
    if (statusUpdate.isOnline !== undefined) updateData.isOnline = statusUpdate.isOnline;
    if (statusUpdate.latitude !== undefined) updateData.latitude = statusUpdate.latitude;
    if (statusUpdate.longitude !== undefined) updateData.longitude = statusUpdate.longitude;
    if (statusUpdate.errors !== undefined) updateData.errors = statusUpdate.errors;
    
    const result = await db.update(screens)
      .set(updateData)
      .where(eq(screens.deviceId, deviceId))
      .returning();
    return result[0];
  }

  async getAllMedia(): Promise<Media[]> {
    return db.select().from(media);
  }

  async getMedia(id: number): Promise<Media | undefined> {
    const result = await db.select().from(media).where(eq(media.id, id)).limit(1);
    return result[0];
  }

  async createMedia(mediaItem: InsertMedia): Promise<Media> {
    const result = await db.insert(media).values(mediaItem).returning();
    return result[0];
  }

  async deleteMedia(id: number): Promise<boolean> {
    const result = await db.delete(media).where(eq(media.id, id)).returning();
    return result.length > 0;
  }

  async getPlaylistsByScreenId(screenId: number): Promise<Playlist[]> {
    return db.select().from(playlists).where(eq(playlists.screenId, screenId));
  }

  async createPlaylistEntry(entry: InsertPlaylist): Promise<Playlist> {
    const result = await db.insert(playlists).values(entry).returning();
    return result[0];
  }

  async deletePlaylistEntry(id: number): Promise<boolean> {
    const result = await db.delete(playlists).where(eq(playlists.id, id)).returning();
    return result.length > 0;
  }

  async getAllTemplates(): Promise<Template[]> {
    return db.select().from(templates);
  }

  async getTemplate(id: string): Promise<Template | undefined> {
    const result = await db.select().from(templates).where(eq(templates.id, id)).limit(1);
    return result[0];
  }

  async createTemplate(template: InsertTemplate): Promise<Template> {
    const result = await db.insert(templates).values(template).returning();
    return result[0];
  }

  async updateTemplate(id: string, data: Partial<InsertTemplate>): Promise<Template | undefined> {
    const result = await db.update(templates).set(data).where(eq(templates.id, id)).returning();
    return result[0];
  }

  async deleteTemplate(id: string): Promise<boolean> {
    const result = await db.delete(templates).where(eq(templates.id, id)).returning();
    return result.length > 0;
  }

  async getTemplatePlaylistItems(templateId: string): Promise<TemplatePlaylistItem[]> {
    return db.select().from(templatePlaylistItems)
      .where(eq(templatePlaylistItems.templateId, templateId))
      .orderBy(asc(templatePlaylistItems.orderIndex));
  }

  async createTemplatePlaylistItem(item: InsertTemplatePlaylistItem): Promise<TemplatePlaylistItem> {
    const result = await db.insert(templatePlaylistItems).values(item).returning();
    return result[0];
  }

  async updateTemplatePlaylistItemOrder(id: string, orderIndex: number): Promise<TemplatePlaylistItem | undefined> {
    const result = await db.update(templatePlaylistItems)
      .set({ orderIndex })
      .where(eq(templatePlaylistItems.id, id))
      .returning();
    return result[0];
  }

  async deleteTemplatePlaylistItem(id: string): Promise<boolean> {
    const result = await db.delete(templatePlaylistItems).where(eq(templatePlaylistItems.id, id)).returning();
    return result.length > 0;
  }

  async getAllSchedules(): Promise<TemplateSchedule[]> {
    return db.select().from(templateSchedule);
  }

  async getSchedulesByTemplate(templateId: string): Promise<TemplateSchedule[]> {
    return db.select().from(templateSchedule).where(eq(templateSchedule.templateId, templateId));
  }

  async getSchedulesByDevice(deviceId: string): Promise<TemplateSchedule[]> {
    return db.select().from(templateSchedule).where(
      and(eq(templateSchedule.targetType, 'device'), eq(templateSchedule.targetId, deviceId))
    );
  }

  async getSchedulesByGroup(groupId: string): Promise<TemplateSchedule[]> {
    return db.select().from(templateSchedule).where(
      and(eq(templateSchedule.targetType, 'group'), eq(templateSchedule.targetId, groupId))
    );
  }

  async createSchedule(schedule: InsertTemplateSchedule): Promise<TemplateSchedule> {
    const result = await db.insert(templateSchedule).values(schedule).returning();
    return result[0];
  }

  async deleteSchedule(id: string): Promise<boolean> {
    const result = await db.delete(templateSchedule).where(eq(templateSchedule.id, id)).returning();
    return result.length > 0;
  }

  async getAllGroups(): Promise<DeviceGroup[]> {
    return db.select().from(deviceGroups);
  }

  async getGroupByNameAndParent(name: string, parentId: string | null): Promise<DeviceGroup | undefined> {
    const result = await db.select().from(deviceGroups)
      .where(sql`${deviceGroups.parentId} IS NOT DISTINCT FROM ${parentId} AND LOWER(${deviceGroups.name}) = LOWER(${name})`)
      .limit(1);
    return result[0];
  }

  async getGroupByNameAndParentExcluding(name: string, parentId: string | null, excludeId: string): Promise<DeviceGroup | undefined> {
    const result = await db.select().from(deviceGroups)
      .where(sql`${deviceGroups.parentId} IS NOT DISTINCT FROM ${parentId} AND LOWER(${deviceGroups.name}) = LOWER(${name}) AND ${deviceGroups.id} <> ${excludeId}`)
      .limit(1);
    return result[0];
  }

  async getGroupById(id: string): Promise<DeviceGroup | undefined> {
    const result = await db.select().from(deviceGroups).where(eq(deviceGroups.id, id)).limit(1);
    return result[0];
  }

  async updateGroupName(id: string, name: string): Promise<void> {
    await db.update(deviceGroups).set({ name }).where(eq(deviceGroups.id, id));
  }

  async updateGroupParent(id: string, parentId: string | null): Promise<void> {
    await db.update(deviceGroups).set({ parentId }).where(eq(deviceGroups.id, id));
  }

  async createGroup(group: InsertDeviceGroup): Promise<DeviceGroup> {
    const result = await db.insert(deviceGroups).values(group).returning();
    return result[0];
  }

  async deleteGroup(id: string): Promise<boolean> {
    // First remove all device associations
    await db.delete(deviceGroupMap).where(eq(deviceGroupMap.groupId, id));
    // Then delete the group
    const result = await db.delete(deviceGroups).where(eq(deviceGroups.id, id)).returning();
    return result.length > 0;
  }

  async updateGroupIcon(id: string, iconUrl: string): Promise<void> {
    await db.update(deviceGroups).set({ iconUrl }).where(eq(deviceGroups.id, id));
  }

  async updateGroupTemplate(id: string, templateId: string | null): Promise<void> {
    await db.update(deviceGroups).set({ assignedTemplate: templateId }).where(eq(deviceGroups.id, id));
  }

  async updateScreenGroup(deviceId: string, groupId: string | null): Promise<void> {
    // Remove existing group association
    await db.delete(deviceGroupMap).where(eq(deviceGroupMap.deviceId, deviceId));
    // Add new group association if groupId is provided
    if (groupId) {
      await db.insert(deviceGroupMap).values({ deviceId, groupId });
    }
  }

  async addDeviceToGroup(deviceId: string, groupId: string): Promise<DeviceGroupMap> {
    const existing = await db.select().from(deviceGroupMap)
      .where(sql`${deviceGroupMap.deviceId} = ${deviceId} AND ${deviceGroupMap.groupId} = ${groupId}`)
      .limit(1);
    
    if (existing.length > 0) {
      return existing[0];
    }
    
    const result = await db.insert(deviceGroupMap).values({ deviceId, groupId }).returning();
    return result[0];
  }

  async getDevicesByGroup(groupId: string): Promise<DeviceGroupMap[]> {
    return db.select().from(deviceGroupMap).where(eq(deviceGroupMap.groupId, groupId));
  }

  async getDeviceCountsByGroup(): Promise<Record<string, { online: number; offline: number }>> {
    const result = await db.execute(sql`
      SELECT m.group_id, 
             COUNT(*) FILTER (WHERE s.status = 'online') AS online,
             COUNT(*) FILTER (WHERE s.status = 'offline') AS offline
      FROM screens s
      JOIN device_group_map m ON m.device_id = s.device_id
      GROUP BY m.group_id
    `);
    
    const counts: Record<string, { online: number; offline: number }> = {};
    (result.rows as any[]).forEach(row => {
      counts[row.group_id] = { 
        online: parseInt(row.online) || 0, 
        offline: parseInt(row.offline) || 0 
      };
    });
    return counts;
  }

  async getDeviceGroupId(deviceId: string): Promise<string | null> {
    const result = await db.select().from(deviceGroupMap).where(eq(deviceGroupMap.deviceId, deviceId)).limit(1);
    return result[0]?.groupId || null;
  }

  async getGroupAncestorChain(groupId: string): Promise<DeviceGroup[]> {
    const chain: DeviceGroup[] = [];
    let currentId: string | null = groupId;
    
    while (currentId) {
      const group = await this.getGroupById(currentId);
      if (!group) break;
      chain.push(group);
      currentId = group.parentId;
    }
    
    return chain;
  }

  async createDeviceStatusLog(log: InsertDeviceStatusLog): Promise<DeviceStatusLog> {
    const result = await db.insert(deviceStatusLogs).values(log as any).returning();
    return result[0];
  }

  async getDeviceStatusLogs(deviceId: string, limit: number = 100): Promise<DeviceStatusLog[]> {
    return db.select().from(deviceStatusLogs)
      .where(eq(deviceStatusLogs.deviceId, deviceId))
      .orderBy(desc(deviceStatusLogs.createdAt))
      .limit(limit);
  }

  async getContentSchedules(): Promise<Schedule[]> {
    return db.select().from(schedule).orderBy(asc(schedule.start));
  }

  async getContentSchedule(id: number): Promise<Schedule | undefined> {
    const result = await db.select().from(schedule).where(eq(schedule.id, id)).limit(1);
    return result[0];
  }

  async createContentSchedule(data: InsertSchedule): Promise<Schedule> {
    const result = await db.insert(schedule).values(data).returning();
    return result[0];
  }

  async updateContentSchedule(id: number, data: Partial<InsertSchedule>): Promise<Schedule | undefined> {
    const result = await db.update(schedule).set(data).where(eq(schedule.id, id)).returning();
    return result[0];
  }

  async deleteContentSchedule(id: number): Promise<boolean> {
    const result = await db.delete(schedule).where(eq(schedule.id, id)).returning();
    return result.length > 0;
  }

  async checkScheduleOverlap(start: Date, end: Date, excludeId?: number): Promise<boolean> {
    const conditions = [
      lt(schedule.start, end),
      gt(schedule.end, start)
    ];
    if (excludeId !== undefined) {
      conditions.push(ne(schedule.id, excludeId));
    }
    const overlapping = await db.select().from(schedule).where(and(...conditions)).limit(1);
    return overlapping.length > 0;
  }
}

export const storage = new DbStorage();

export async function saveDeviceStatus(data: {
  device_id: string;
  status?: string;
  currentContentId?: string | null;
  currentContentName?: string | null;
  temperature?: number;
  freeStorage?: number;
  batteryLevel?: number | null;
  signalStrength?: number | null;
  isOnline?: boolean;
  latitude?: number | null;
  longitude?: number | null;
  errors?: string[];
  timestamp?: number;
}) {
  await storage.createDeviceStatusLog({
    deviceId: data.device_id,
    status: data.status,
    currentContentId: data.currentContentId ?? undefined,
    currentContentName: data.currentContentName ?? undefined,
    temperature: data.temperature,
    freeStorage: data.freeStorage,
    batteryLevel: data.batteryLevel ?? undefined,
    signalStrength: data.signalStrength ?? undefined,
    isOnline: data.isOnline,
    latitude: data.latitude ?? undefined,
    longitude: data.longitude ?? undefined,
    errors: data.errors,
    timestamp: data.timestamp ?? Date.now(),
  });

  if (data.device_id) {
    await storage.updateDeviceStatus(data.device_id, {
      status: data.status,
      temperature: data.temperature,
      freeStorage: data.freeStorage,
      batteryLevel: data.batteryLevel ?? undefined,
      signalStrength: data.signalStrength ?? undefined,
      isOnline: data.isOnline,
      latitude: data.latitude ?? undefined,
      longitude: data.longitude ?? undefined,
      errors: data.errors,
    });
  }
}

export async function getDashboardSummary() {
  const allScreens = await storage.getAllScreens();
  
  const activeDevices = allScreens.filter(s => s.isOnline === true).length;
  const offlineDevices = allScreens.filter(s => s.isOnline === false || s.isOnline === null).length;

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const allLogs = await db.select().from(deviceStatusLogs);
  const todaysImpressions = allLogs.filter(log => {
    if (!log.createdAt) return false;
    return new Date(log.createdAt) >= todayStart;
  }).length;

  const monthlyRevenue = 0;

  return {
    activeDevices,
    offlineDevices,
    todaysImpressions,
    monthlyRevenue,
  };
}

export async function listDevicesForDashboard() {
  const allScreens = await storage.getAllScreens();
  return allScreens.map(screen => ({
    id: screen.id.toString(),
    name: screen.name,
    location_branch: screen.location,
    is_online: screen.isOnline ?? false,
  }));
}

export async function getDashboardAlerts() {
  const alerts: { id: number; type: "offline" | "expiry" | "default"; message: string }[] = [];
  const allScreens = await storage.getAllScreens();

  allScreens
    .filter(d => !d.isOnline)
    .forEach((d, idx) => {
      alerts.push({
        id: idx + 1,
        type: "offline",
        message: `Device "${d.name || d.id}" has gone offline.`,
      });
    });

  return alerts;
}

export async function listAllDevicesWithStatus() {
  const allScreens = await storage.getAllScreens();
  const allLogs = await db.select().from(deviceStatusLogs).orderBy(deviceStatusLogs.createdAt);

  const latest: Record<string, typeof allLogs[0]> = {};
  for (const log of allLogs) {
    if (log.deviceId) {
      latest[log.deviceId] = log;
    }
  }

  return allScreens.map((d) => ({
    id: d.id.toString(),
    name: d.name,
    location_branch: d.location,
    is_online: d.isOnline ?? false,
    last_seen: d.lastSeen,
    status: latest[d.deviceId || '']?.status || d.status || "unknown",
    current_content_id: latest[d.deviceId || '']?.currentContentId || d.currentContent || null,
    temperature: latest[d.deviceId || '']?.temperature || d.temperature || null,
    free_storage: latest[d.deviceId || '']?.freeStorage || d.freeStorage || null,
    battery_level: latest[d.deviceId || '']?.batteryLevel || d.batteryLevel || null,
    signal_strength: latest[d.deviceId || '']?.signalStrength || d.signalStrength || null,
    latitude: latest[d.deviceId || '']?.latitude || d.latitude || null,
    longitude: latest[d.deviceId || '']?.longitude || d.longitude || null,
    errors: latest[d.deviceId || '']?.errors || d.errors || [],
    last_status_at: latest[d.deviceId || '']?.createdAt || null,
  }));
}

export async function getDeviceDetails(deviceId: string) {
  const device = await db.select().from(screens).where(eq(screens.id, parseInt(deviceId))).limit(1);
  
  if (!device || device.length === 0) {
    throw new Error("Device not found");
  }

  const allLogs = await db.select().from(deviceStatusLogs)
    .where(eq(deviceStatusLogs.deviceId, device[0].deviceId || ''))
    .orderBy(deviceStatusLogs.createdAt);

  const history = allLogs.slice(-50).reverse();
  const latestStatus = history[0] || null;

  return {
    device: device[0],
    latestStatus,
    history,
  };
}

export async function createDevice(input: {
  name: string;
  location_branch?: string;
}) {
  const randomPart = Math.random().toString(36).substring(2, 10).toUpperCase();
  const deviceId = `DEV-${randomPart}`;

  const { name, location_branch } = input;

  const [created] = await db.insert(screens).values({
    deviceId,
    name,
    location: location_branch || "Unknown",
    status: "offline",
    isOnline: false,
  }).returning();

  return {
    id: created.id.toString(),
    device_id: deviceId,
    name,
    location_branch: location_branch || null,
  };
}

export async function createNotification({ 
  userId = null, 
  type, 
  level, 
  title, 
  message, 
  deviceId = null 
}: {
  userId?: string | null;
  type: string;
  level: string;
  title: string;
  message: string;
  deviceId?: string | null;
}) {
  await pool.query(
    `INSERT INTO notifications (user_id, type, level, title, message, device_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [userId, type, level, title, message, deviceId]
  );
}

export async function queueCommand(
  deviceId: string, 
  command: string, 
  params: Record<string, any> | null
) {
  const payload = { command, ...params };
  await pool.query(
    `INSERT INTO device_commands (device_id, payload, executed)
     VALUES ($1, $2, false)`,
    [deviceId, JSON.stringify(payload)]
  );
}

export async function getQueuedCommands(deviceId: string) {
  const { rows } = await pool.query(
    `SELECT id, payload 
     FROM device_commands
     WHERE device_id = $1 AND executed = FALSE
     ORDER BY created_at ASC`,
    [deviceId]
  );
  
  return rows.map((row: any) => {
    const { command, ...rest } = row.payload || {};
    return {
      id: row.id,
      command: command || "UNKNOWN",
      payload: Object.keys(rest).length > 0 ? rest : null
    };
  });
}

export async function markCommandExecuted(id: string | number) {
  await pool.query(
    `UPDATE device_commands
     SET executed = TRUE
     WHERE id = $1`,
    [id]
  );
}

export async function updateDeviceScreenshot(deviceId: string, filePath: string) {
  await pool.query(
    `UPDATE screens 
     SET last_screenshot = $2, last_seen = NOW()
     WHERE device_id = $1`,
    [deviceId, filePath]
  );
}

export async function updateDeviceRecording(deviceId: string, filePath: string) {
  await pool.query(
    `UPDATE screens 
     SET last_recording = $2, last_seen = NOW()
     WHERE device_id = $1`,
    [deviceId, filePath]
  );
}
