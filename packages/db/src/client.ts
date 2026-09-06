import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from './schema/index.js';

export type Schema = typeof schema;
export type Database = PostgresJsDatabase<Schema>;
export type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface DbConfig {
  url: string;
  /** pool size; use 1 for migrations */
  max?: number;
}

export interface DbHandle {
  db: Database;
  close: () => Promise<void>;
}

export function createDbClient(config: DbConfig): DbHandle {
  const client = postgres(config.url, { max: config.max ?? 10 });
  const db = drizzle(client, { schema });
  return { db, close: () => client.end() };
}
