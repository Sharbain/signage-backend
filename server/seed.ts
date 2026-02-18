import { db } from "./db";
import { screens } from "@shared/schema";

const sampleScreens = [
  { deviceId: 'D-001', name: 'Main Lobby Wall', location: 'HQ - Floor 1', status: 'online', currentContent: 'Welcome Loop', resolution: '4K' },
  { deviceId: 'D-002', name: 'Cafeteria Menu', location: 'HQ - Floor 2', status: 'online', currentContent: 'Lunch Menu B', resolution: '1080p' },
  { deviceId: 'D-003', name: 'Elevator Bank A', location: 'HQ - Floor 1', status: 'offline', currentContent: 'Corporate News', resolution: '1080p' },
  { deviceId: 'D-004', name: 'Exec Boardroom', location: 'HQ - Floor 12', status: 'online', currentContent: 'Q3 Metrics', resolution: '4K' },
  { deviceId: 'D-005', name: 'Retail Window', location: 'Branch 42', status: 'online', currentContent: 'Summer Promo', resolution: '4K' },
];

async function seed() {
  for (const screen of sampleScreens) {
    const result = await db.insert(screens).values(screen).onConflictDoNothing({ target: screens.deviceId }).returning();
    if (result.length > 0) {
      console.log('Inserted:', screen.name);
    }
  }

  console.log('Sample data seeded successfully');
  process.exit(0);
}

seed();
