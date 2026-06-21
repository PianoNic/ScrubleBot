// Apply pending migrations, then (optionally) import any existing ndjson harvest
// data. This is what the "migrate" container runs once before the bots start.
//   DATABASE_URL=… bun run db/migrate.js            # schema only
//   DATABASE_URL=… IMPORT_NDJSON=1 bun run db/migrate.js   # schema + import files

import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { db, dbEnabled, closeDb } from './index.js';

if (!dbEnabled) {
  console.error('DATABASE_URL not set — nothing to migrate.');
  process.exit(1);
}

const migrationsFolder = new URL('./migrations', import.meta.url).pathname;
console.log('⏳ running migrations…');
await migrate(db, { migrationsFolder });
console.log('✅ schema up to date');

if (process.env.IMPORT_NDJSON === '1') {
  const { importNdjson } = await import('./import-ndjson.js');
  await importNdjson();
}

await closeDb();
