import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { getJobLeaseSchema } from '../../src/postgres/get-job-lease-schema.js';

export const PG_URL = process.env.JOBS_PG_URL;

export function createPool(): pg.Pool {
  return new pg.Pool({ connectionString: PG_URL, max: 20 });
}

export async function createTable(pool: pg.Pool): Promise<string> {
  const table = `job_leases_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  await pool.query(getJobLeaseSchema({ table }));
  return table;
}

export async function dropTable(pool: pg.Pool, table: string): Promise<void> {
  await pool.query(`DROP TABLE IF EXISTS ${table}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
