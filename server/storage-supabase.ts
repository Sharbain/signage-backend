import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
}

export const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

export type UploadFolder = "media" | "screenshots" | "recordings" | "thumbnails" | "group-icons" | "client-attachments";

const BUCKET = "media";

export async function uploadToSupabase(buffer: Buffer, originalName: string, mimeType: string, folder: UploadFolder): Promise<string> {
  const ext = originalName.includes(".") ? "." + originalName.split(".").pop()!.toLowerCase() : "";
  const filename = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
  const { error } = await supabaseAdmin.storage.from(BUCKET).upload(filename, buffer, { contentType: mimeType, upsert: false });
  if (error) throw new Error(`Supabase upload failed: ${error.message}`);
  const { data } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(filename);
  return data.publicUrl;
}

export async function deleteFromSupabase(publicUrl: string): Promise<void> {
  try {
    const marker = `/object/public/${BUCKET}/`;
    const idx = publicUrl.indexOf(marker);
    if (idx === -1) return;
    const filePath = publicUrl.slice(idx + marker.length);
    await supabaseAdmin.storage.from(BUCKET).remove([filePath]);
  } catch {
    console.warn("Failed to delete from Supabase Storage:", publicUrl);
  }
}
