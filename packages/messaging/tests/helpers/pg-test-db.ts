import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { getPostgresSchema } from '../../src/postgres/get-postgres-schema.js';

export const PG_URL = process.env.MESSAGING_PG_URL;

export type TestTables = { readonly eventsTable: string; readonly outboxTable: string };

export function createPool(): pg.Pool {
  return new pg.Pool({ connectionString: PG_URL, max: 20 });
}

export async function createTables(pool: pg.Pool): Promise<TestTables> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const tables = { eventsTable: `events_${suffix}`, outboxTable: `outbox_${suffix}` };
  await pool.query(getPostgresSchema(tables));
  return tables;
}

export async function dropTables(pool: pg.Pool, tables: TestTables): Promise<void> {
  await pool.query(`DROP TABLE IF EXISTS ${tables.eventsTable}, ${tables.outboxTable} CASCADE`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await sleep(10);
  }
}

// A pool whose first claim statement runs `hook` before the claim's verify step — the window
// where a concurrent claim can commit. Covers only what ClaimDao uses on a pool.
export function hookAfterClaimStatement(pool: pg.Pool, hook: () => Promise<void>): pg.Pool {
  let fired = false;
  const hooked = {
    query: pool.query.bind(pool),
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (sql: string, params?: unknown[]) => {
          const result = await client.query(sql, params);
          if (!fired && sql.includes('WITH claimed AS')) {
            fired = true;
            await hook();
          }
          return result;
        },
        release: () => client.release(),
      };
    },
  };
  return hooked as unknown as pg.Pool;
}
