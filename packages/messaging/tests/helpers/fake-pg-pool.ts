import type { Pool, PoolClient, QueryResult } from 'pg';

type ResultRow = Record<string, unknown>;

export class FakePgPool {
  calls: { sql: string; params: readonly unknown[] }[] = [];
  clientCalls: { sql: string; params: readonly unknown[] }[] = [];
  private resultQueue: QueryResult<ResultRow>[] = [];

  enqueue(rows: ResultRow[] = [], rowCount?: number): void {
    this.resultQueue.push({
      command: 'SELECT',
      rowCount: rowCount ?? rows.length,
      oid: 0,
      fields: [],
      rows,
    } as QueryResult<ResultRow>);
  }

  asPool(): Pool {
    return this as unknown as Pool;
  }

  async query(sql: string, params: readonly unknown[] = []): Promise<QueryResult<ResultRow>> {
    this.calls.push({ sql, params });
    return (
      this.resultQueue.shift() ??
      ({
        command: 'SELECT',
        rowCount: 0,
        oid: 0,
        fields: [],
        rows: [],
      } as QueryResult<ResultRow>)
    );
  }

  async connect(): Promise<PoolClient> {
    const self = this;
    const empty = {
      command: 'SELECT',
      rowCount: 0,
      oid: 0,
      fields: [],
      rows: [] as ResultRow[],
    } as QueryResult<ResultRow>;
    const client = {
      async query(sql: string, params: readonly unknown[] = []) {
        self.clientCalls.push({ sql, params });
        // Transaction control statements don't consume from the result queue.
        const upper = sql.trim().toUpperCase();
        if (upper === 'BEGIN' || upper === 'COMMIT' || upper === 'ROLLBACK') {
          return empty;
        }
        return self.resultQueue.shift() ?? empty;
      },
      release() {},
    };
    return client as unknown as PoolClient;
  }
}
