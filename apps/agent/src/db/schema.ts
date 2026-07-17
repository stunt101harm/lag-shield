import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const systemMetadata = pgTable('system_metadata', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
    .notNull()
    .defaultNow(),
});
