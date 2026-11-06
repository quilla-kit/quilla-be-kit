import type { Pool, QueryResult } from 'pg';

type ResultRow = Record<string, unknown>;

// Records queries and answers them from a queue; covers only what PgJobLeaseStore uses.
export class FakePgPool {
  calls: { sql: string; params: readonly unknown[] }[] = [];
  private resultQueue: ResultRow[][] = [];

  enqueue(rows: ResultRow[] = []): void {
    this.resultQueue.push(rows);
  }

  asPool(): Pool {
    return this as unknown as Pool;
  }

  async query(sql: string, params: readonly unknown[] = []): Promise<QueryResult<ResultRow>> {
    this.calls.push({ sql, params });
    const rows = this.resultQueue.shift() ?? [];
    return { command: 'SELECT', rowCount: rows.length, oid: 0, fields: [], rows };
  }

  lastCall(): { sql: string; params: readonly unknown[] } {
    const call = this.calls.at(-1);
    if (!call) throw new Error('no query was made');
    return call;
  }
}
