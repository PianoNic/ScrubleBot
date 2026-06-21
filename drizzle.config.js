// drizzle-kit config — `bun run db:generate` writes SQL migrations to db/migrations.
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './db/schema.js',
  out: './db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL || 'postgresql://scruble:scruble@127.0.0.1:5432/scruble',
  },
});
