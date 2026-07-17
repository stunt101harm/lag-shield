import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from './schema.js';

export type DatabaseClient = postgres.Sql;

export function createDatabase(databaseUrl: string) {
  const client = postgres(databaseUrl, {
    max: 10,
    onnotice: () => undefined,
    prepare: false,
  });

  return {
    client,
    database: drizzle(client, { schema }),
  };
}
