import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from './schema.js';

export type DatabaseClient = postgres.Sql;

export function createDatabase(databaseUrl: string) {
  const client = postgres(databaseUrl, {
    connect_timeout: 10,
    idle_timeout: 30,
    max: 10,
    max_lifetime: 60 * 30,
    onnotice: () => undefined,
    prepare: false,
  });

  return {
    client,
    database: drizzle(client, { schema }),
  };
}
