import { supabase } from "./supabaseClient";

export async function saveDeviceStatus(data: {
  device_id: string;
  status: string;
  currentContentId?: string | null;
  temperature: number;
  freeStorage: number;
  errors: string[];
}) {
  const { device_id, status, currentContentId, temperature, freeStorage, errors } = data;

  const { error } = await supabase
    .from("device_status_logs")
    .insert({
      device_id,
      status,
      current_content_id: currentContentId,
      temperature,
      free_storage: freeStorage,
      errors,
      timestamp: Date.now(),
    });

  if (error) throw error;
}

export async function saveFullDeviceStatus(data: {
  device_id: string;
  status?: string;
  currentContentId?: string | null;
  currentContentName?: string | null;
  batteryLevel?: number | null;
  temperature?: number | null;
  freeStorage?: number | null;
  signalStrength?: number | null;
  isOnline?: boolean | null;
  latitude?: number | null;
  longitude?: number | null;
  errors?: string[] | null;
  timestamp?: number | null;
}) {
  const { error } = await supabase
    .from("device_status_logs")
    .insert({
      device_id: data.device_id,
      status: data.status,
      current_content_id: data.currentContentId,
      current_content_name: data.currentContentName,
      battery_level: data.batteryLevel,
      temperature: data.temperature,
      free_storage: data.freeStorage,
      signal_strength: data.signalStrength,
      is_online: data.isOnline,
      latitude: data.latitude,
      longitude: data.longitude,
      errors: data.errors,
      timestamp: data.timestamp ?? Date.now(),
    });

  if (error) throw error;
}

export async function updateDeviceLastSeen(deviceId: string, isOnline: boolean = true) {
  const { error } = await supabase
    .from("screens")
    .update({
      last_seen: new Date().toISOString(),
      is_online: isOnline,
    })
    .eq("device_id", deviceId);

  if (error) throw error;
}
