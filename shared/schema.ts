import { sql } from "drizzle-orm";
import { pgTable, text, varchar, serial, timestamp, integer, jsonb, uuid, time, doublePrecision, bigint, boolean, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name"),
  role: varchar("role").notNull().default("restricted"),
  preferences: jsonb("preferences").$type<Record<string, any>>().default({}),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export const screens = pgTable("screens", {
  id: serial("id").primaryKey(),
  deviceId: text("device_id").notNull().unique(),
  name: text("name").notNull(),
  location: text("location").notNull(),
  status: text("status").notNull().default("offline"),
  currentContent: text("current_content"),
  currentContentName: text("current_content_name"),
  resolution: text("resolution").notNull().default("1080p"),
  lastSeen: timestamp("last_seen"),
  temperature: doublePrecision("temperature"),
  freeStorage: bigint("free_storage", { mode: "number" }),
  batteryLevel: integer("battery_level"),
  signalStrength: integer("signal_strength"),
  connectionType: text("connection_type").default("wifi"),
  isOnline: boolean("is_online").default(false),
  lastOffline: timestamp("last_offline"),
  latitude: doublePrecision("latitude"),
  longitude: doublePrecision("longitude"),
  errors: jsonb("errors").$type<string[]>().default([]),
  password: text("password"),
  groupId: uuid("group_id"),
  screenshot: text("screenshot"),
  screenshotAt: timestamp("screenshot_at"),
  thumbnail: text("thumbnail"),
  assignedTemplateId: uuid("assigned_template_id"),
});

export const insertScreenSchema = createInsertSchema(screens).omit({
  id: true,
});

export type InsertScreen = z.infer<typeof insertScreenSchema>;
export type Screen = typeof screens.$inferSelect;

export const deviceStatusLogs = pgTable("device_status_logs", {
  id: serial("id").primaryKey(),
  deviceId: text("device_id").notNull(),
  status: text("status"),
  currentContentId: text("current_content_id"),
  currentContentName: text("current_content_name"),
  batteryLevel: integer("battery_level"),
  temperature: doublePrecision("temperature"),
  freeStorage: bigint("free_storage", { mode: "number" }),
  signalStrength: integer("signal_strength"),
  isOnline: boolean("is_online"),
  latitude: doublePrecision("latitude"),
  longitude: doublePrecision("longitude"),
  errors: jsonb("errors").$type<string[]>(),
  timestamp: bigint("timestamp", { mode: "number" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertDeviceStatusLogSchema = createInsertSchema(deviceStatusLogs).omit({
  id: true,
  createdAt: true,
});

export type InsertDeviceStatusLog = z.infer<typeof insertDeviceStatusLogSchema>;
export type DeviceStatusLog = typeof deviceStatusLogs.$inferSelect;

export const deviceDataUsage = pgTable("device_data_usage", {
  id: serial("id").primaryKey(),
  deviceId: text("device_id").notNull(),
  bytesDownloaded: bigint("bytes_downloaded", { mode: "number" }).notNull().default(0),
  bytesUploaded: bigint("bytes_uploaded", { mode: "number" }).notNull().default(0),
  recordedAt: timestamp("recorded_at").defaultNow().notNull(),
});

export const insertDeviceDataUsageSchema = createInsertSchema(deviceDataUsage).omit({
  id: true,
  recordedAt: true,
});

export type InsertDeviceDataUsage = z.infer<typeof insertDeviceDataUsageSchema>;
export type DeviceDataUsage = typeof deviceDataUsage.$inferSelect;

export const media = pgTable("media", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  url: text("url").notNull(),
  size: integer("size"),
  duration: integer("duration"),
  uploadedAt: timestamp("uploaded_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at"),
  isExpired: boolean("is_expired").default(false),
});

export const insertMediaSchema = createInsertSchema(media).omit({
  id: true,
  uploadedAt: true,
  isExpired: true,
});

export type InsertMedia = z.infer<typeof insertMediaSchema>;
export type Media = typeof media.$inferSelect;

export const contents = pgTable("contents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  filename: text("filename"),
  type: text("type"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertContentSchema = createInsertSchema(contents).omit({
  id: true,
  createdAt: true,
});

export type InsertContent = z.infer<typeof insertContentSchema>;
export type Content = typeof contents.$inferSelect;

export const notifications = pgTable("notifications", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id"),
  type: text("type"),
  level: text("level"),
  title: text("title").notNull(),
  message: text("message").notNull(),
  deviceId: text("device_id"),
  createdAt: timestamp("created_at").defaultNow(),
  isRead: boolean("is_read").default(false),
});

export const insertNotificationSchema = createInsertSchema(notifications).omit({
  id: true,
  createdAt: true,
});

export type InsertNotification = z.infer<typeof insertNotificationSchema>;
export type Notification = typeof notifications.$inferSelect;

export const playlists = pgTable("playlists", {
  id: serial("id").primaryKey(),
  screenId: integer("screen_id").notNull(),
  mediaId: integer("media_id").notNull(),
  position: integer("position").default(0),
  durationOverride: integer("duration_override"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertPlaylistSchema = createInsertSchema(playlists).omit({
  id: true,
  createdAt: true,
});

export type InsertPlaylist = z.infer<typeof insertPlaylistSchema>;
export type Playlist = typeof playlists.$inferSelect;

export const contentPlaylists = pgTable("content_playlists", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertContentPlaylistSchema = createInsertSchema(contentPlaylists).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertContentPlaylist = z.infer<typeof insertContentPlaylistSchema>;
export type ContentPlaylist = typeof contentPlaylists.$inferSelect;

export const playlistItems = pgTable("playlist_items", {
  id: serial("id").primaryKey(),
  playlistId: integer("playlist_id").notNull(),
  mediaId: integer("media_id").notNull(),
  position: integer("position").default(0),
  duration: integer("duration").default(10),
  volume: integer("volume").default(100),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertPlaylistItemSchema = createInsertSchema(playlistItems).omit({
  id: true,
  createdAt: true,
});

export type InsertPlaylistItem = z.infer<typeof insertPlaylistItemSchema>;
export type PlaylistItem = typeof playlistItems.$inferSelect;

export const playlistAssignments = pgTable("playlist_assignments", {
  id: serial("id").primaryKey(),
  playlistId: integer("playlist_id").notNull(),
  deviceId: text("device_id").notNull(),
  assignedAt: timestamp("assigned_at").defaultNow().notNull(),
});

export const insertPlaylistAssignmentSchema = createInsertSchema(playlistAssignments).omit({
  id: true,
  assignedAt: true,
});

export type InsertPlaylistAssignment = z.infer<typeof insertPlaylistAssignmentSchema>;
export type PlaylistAssignment = typeof playlistAssignments.$inferSelect;

export const templates = pgTable("templates", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  layout: jsonb("layout"),
  orientation: text("orientation").notNull().default("landscape"),
  elements: jsonb("elements").$type<any[]>().default([]),
  background: jsonb("background").$type<Record<string, any>>().default({}),
  watermark: jsonb("watermark").$type<Record<string, any>>().default({}),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type TemplateZone = {
  id: string;
  name: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  playlist?: string[];
  
  // Styling
  angle?: number;
  borderColor?: string;
  borderWidth?: number;
  cornerRadius?: number;
  fillColor?: string;
  
  // Lock state
  locked?: boolean;
};

export type TemplateLayout = {
  zones: TemplateZone[];
};

export const insertTemplateSchema = createInsertSchema(templates).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertTemplate = z.infer<typeof insertTemplateSchema>;
export type Template = typeof templates.$inferSelect;

export const templatePlaylistItems = pgTable("template_playlist_items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  templateId: varchar("template_id").notNull(),
  contentType: text("content_type").notNull(),
  contentUrl: text("content_url"),
  orderIndex: integer("order_index").default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertTemplatePlaylistItemSchema = createInsertSchema(templatePlaylistItems).omit({
  id: true,
  createdAt: true,
});

export type InsertTemplatePlaylistItem = z.infer<typeof insertTemplatePlaylistItemSchema>;
export type TemplatePlaylistItem = typeof templatePlaylistItems.$inferSelect;

export const templateSchedule = pgTable("template_schedule", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  templateId: uuid("template_id").references(() => templates.id),
  contentId: text("content_id"),
  targetType: text("target_type").notNull().default('device'), // 'device' or 'group'
  targetId: text("target_id").notNull(),
  startTime: time("start_time"),
  endTime: time("end_time"),
  assignedAt: timestamp("assigned_at").defaultNow(),
});

export const insertTemplateScheduleSchema = createInsertSchema(templateSchedule).omit({
  id: true,
  assignedAt: true,
});

export type InsertTemplateSchedule = z.infer<typeof insertTemplateScheduleSchema>;
export type TemplateSchedule = typeof templateSchedule.$inferSelect;

export const deviceGroups = pgTable("device_groups", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  parentId: varchar("parent_id"),
  iconUrl: text("icon_url"),
  assignedTemplate: varchar("assigned_template"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("unique_name_per_parent").on(table.parentId, table.name)
]);

export const insertDeviceGroupSchema = createInsertSchema(deviceGroups).omit({
  id: true,
  createdAt: true,
});

export type InsertDeviceGroup = z.infer<typeof insertDeviceGroupSchema>;
export type DeviceGroup = typeof deviceGroups.$inferSelect;

export const deviceGroupMap = pgTable("device_group_map", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  deviceId: varchar("device_id").notNull(),
  groupId: varchar("group_id").notNull(),
});

export const insertDeviceGroupMapSchema = createInsertSchema(deviceGroupMap).omit({
  id: true,
});

export type InsertDeviceGroupMap = z.infer<typeof insertDeviceGroupMapSchema>;
export type DeviceGroupMap = typeof deviceGroupMap.$inferSelect;

export const schedule = pgTable("schedule", {
  id: serial("id").primaryKey(),
  contentId: text("content_id"),
  start: timestamp("start"),
  end: timestamp("end"),
});

export const insertScheduleSchema = createInsertSchema(schedule).omit({
  id: true,
});

export type InsertSchedule = z.infer<typeof insertScheduleSchema>;
export type Schedule = typeof schedule.$inferSelect;

export const contentSchedules = pgTable("content_schedules", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  contentType: text("content_type").notNull(),
  contentId: text("content_id").notNull(),
  deviceId: text("device_id"),
  groupId: text("group_id"),
  startTime: timestamp("start_time").notNull(),
  endTime: timestamp("end_time").notNull(),
  allDay: boolean("all_day").default(false),
  repeatType: text("repeat_type").default("none"),
  repeatEndDate: timestamp("repeat_end_date"),
  color: text("color").default("#3b82f6"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertContentScheduleSchema = createInsertSchema(contentSchedules).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertContentSchedule = z.infer<typeof insertContentScheduleSchema>;
export type ContentSchedule = typeof contentSchedules.$inferSelect;

export const scheduleGroupAssignments = pgTable("schedule_group_assignments", {
  id: serial("id").primaryKey(),
  scheduleId: integer("schedule_id").notNull(),
  groupId: varchar("group_id").notNull(),
});

export const insertScheduleGroupAssignmentSchema = createInsertSchema(scheduleGroupAssignments).omit({
  id: true,
});

export type InsertScheduleGroupAssignment = z.infer<typeof insertScheduleGroupAssignmentSchema>;
export type ScheduleGroupAssignment = typeof scheduleGroupAssignments.$inferSelect;

export const userGroupMap = pgTable("user_group_map", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid("user_id").references(() => users.id),
  groupId: uuid("group_id").references(() => deviceGroups.id),
});

export const insertUserGroupMapSchema = createInsertSchema(userGroupMap).omit({
  id: true,
});

export type InsertUserGroupMap = z.infer<typeof insertUserGroupMapSchema>;
export type UserGroupMap = typeof userGroupMap.$inferSelect;

export const userDeviceMap = pgTable("user_device_map", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid("user_id").references(() => users.id),
  deviceId: text("device_id"),
});

export const insertUserDeviceMapSchema = createInsertSchema(userDeviceMap).omit({
  id: true,
});

export type InsertUserDeviceMap = z.infer<typeof insertUserDeviceMapSchema>;
export type UserDeviceMap = typeof userDeviceMap.$inferSelect;

export const deviceCommands = pgTable("device_commands", {
  id: serial("id").primaryKey(),
  deviceId: text("device_id").notNull(),
  payload: jsonb("payload").$type<Record<string, any>>().notNull(),

  // Delivery + execution tracking (used by /api/commands/active and device polling routes)
  sent: boolean("sent").default(false).notNull(),
  executed: boolean("executed").default(false).notNull(),
  executedAt: timestamp("executed_at"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});


export const insertDeviceCommandSchema = createInsertSchema(deviceCommands).omit({
  id: true,
  createdAt: true,
});

export type InsertDeviceCommand = z.infer<typeof insertDeviceCommandSchema>;
export type DeviceCommand = typeof deviceCommands.$inferSelect;

export const clients = pgTable("clients", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  phone: text("phone"),
  email: text("email"),
  company: text("company"),
  position: text("position"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertClientSchema = createInsertSchema(clients).omit({
  id: true,
  createdAt: true,
});

export type InsertClient = z.infer<typeof insertClientSchema>;
export type Client = typeof clients.$inferSelect;

export const clientNotes = pgTable("client_notes", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  clientId: uuid("client_id").references(() => clients.id, { onDelete: "cascade" }).notNull(),
  note: text("note").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertClientNoteSchema = createInsertSchema(clientNotes).omit({
  id: true,
  createdAt: true,
});

export type InsertClientNote = z.infer<typeof insertClientNoteSchema>;
export type ClientNote = typeof clientNotes.$inferSelect;

export const clientCustomFields = pgTable("client_custom_fields", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  clientId: uuid("client_id").references(() => clients.id, { onDelete: "cascade" }).notNull(),
  fieldName: text("field_name").notNull(),
  fieldValue: text("field_value"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertClientCustomFieldSchema = createInsertSchema(clientCustomFields).omit({
  id: true,
  createdAt: true,
});

export type InsertClientCustomField = z.infer<typeof insertClientCustomFieldSchema>;
export type ClientCustomField = typeof clientCustomFields.$inferSelect;

export const clientAttachments = pgTable("client_attachments", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  clientId: uuid("client_id").references(() => clients.id, { onDelete: "cascade" }).notNull(),
  filename: text("filename").notNull(),
  originalName: text("original_name").notNull(),
  mimeType: text("mime_type").notNull(),
  size: integer("size").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertClientAttachmentSchema = createInsertSchema(clientAttachments).omit({
  id: true,
  createdAt: true,
});

export type InsertClientAttachment = z.infer<typeof insertClientAttachmentSchema>;
export type ClientAttachment = typeof clientAttachments.$inferSelect;

export const publishJobs = pgTable("publish_jobs", {
  id: serial("id").primaryKey(),
  deviceId: text("device_id").notNull(),
  deviceName: text("device_name").notNull(),
  contentType: text("content_type").notNull(),
  contentId: integer("content_id").notNull(),
  contentName: text("content_name").notNull(),
  status: text("status").default("pending").notNull(),
  progress: integer("progress").default(0).notNull(),
  totalBytes: integer("total_bytes"),
  downloadedBytes: integer("downloaded_bytes"),
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
});

export const insertPublishJobSchema = createInsertSchema(publishJobs).omit({
  id: true,
  startedAt: true,
  completedAt: true,
});

export type InsertPublishJob = z.infer<typeof insertPublishJobSchema>;
export type PublishJob = typeof publishJobs.$inferSelect;
