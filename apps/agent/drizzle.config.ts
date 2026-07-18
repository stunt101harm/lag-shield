import { config as loadEnvironment } from 'dotenv';
import { defineConfig } from 'drizzle-kit';
import { fileURLToPath } from 'node:url';

loadEnvironment({
  path: fileURLToPath(new URL('../../.env', import.meta.url)),
  quiet: true,
});

export default defineConfig({
  dialect: 'postgresql',
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      'postgresql://lagshield:lagshield@localhost:5432/lagshield',
  },
  out: './drizzle',
  schema: './src/db/schema.ts',
  strict: true,
  verbose: true,
});
