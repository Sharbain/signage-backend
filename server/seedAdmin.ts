// server/seedAdmin.ts
import "dotenv/config";
import bcrypt from "bcrypt";
import { db } from "./db";
import { users } from "../shared/schema";
import { eq } from "drizzle-orm";

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL || "admin@lumina.local";
  const password = process.env.SEED_ADMIN_PASSWORD || "Admin123!";
  const role = process.env.SEED_ADMIN_ROLE || "admin";
  const name = process.env.SEED_ADMIN_NAME || "Admin";

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set. Add it to your environment or .env file.");
  }

  console.log(`Seeding admin: ${email} (${role})`);

  const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);

  if (existing.length > 0) {
    console.log("✅ Admin already exists. Nothing to do.");
    process.exit(0);
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const inserted = await db
    .insert(users)
    .values({
      email,
      passwordHash,
      role,
      name,
    })
    .returning();

  console.log("✅ Admin created:", { id: inserted[0].id, email: inserted[0].email, role: inserted[0].role });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ Seed failed:", err);
    process.exit(1);
  });
