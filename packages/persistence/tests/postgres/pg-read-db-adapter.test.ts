import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseResult } from '../../src/database/database-result.type.js';
import type { Database } from '../../src/database/database.interface.js';
import { PgReadDbAdapter } from '../../src/postgres/pg-read-db-adapter.js';

class StubDatabase implements Database {
  calls: { sql: string; params: readonly unknown[] }[] = [];
  resultQueue: DatabaseResult[] = [];

  constructor(private readonly columns: Record<string, Record<string, string>>) {}

  async query(sql: string, params: readonly unknown[] = []): Promise<DatabaseResult> {
    if (sql.includes('information_schema.columns')) {
      const tableName = String(params[0]);
      const cols = this.columns[tableName] ?? {};
      return {
        rows: Object.entries(cols).map(([column_name, data_type]) => ({
          column_name,
          data_type,
          udt_name: data_type,
        })),
      };
    }
    this.calls.push({ sql, params });
    return this.resultQueue.shift() ?? { rows: [] };
  }

  getDbTransaction = vi.fn();
  disconnect = vi.fn(async () => {});
  healthCheck = vi.fn(async () => ({ version: 'stub' }));
}

describe('PgReadDbAdapter', () => {
  let db: StubDatabase;
  let adapter: PgReadDbAdapter;

  beforeEach(() => {
    db = new StubDatabase({
      user_projections: { id: 'uuid', email: 'text', display_name: 'text' },
    });
    adapter = new PgReadDbAdapter(db);
  });

  it('emits SELECT *', async () => {
    await adapter.select({ table: 'user_projections' });
    expect(db.calls[0]?.sql).toBe('SELECT * FROM user_projections');
  });

  it('emits SELECT with explicit columns when provided', async () => {
    await adapter.select({
      table: 'user_projections',
      columns: ['id', 'email'],
    });
    expect(db.calls[0]?.sql).toBe('SELECT id, email FROM user_projections');
  });

  it('emits WHERE with type casts', async () => {
    await adapter.select({
      table: 'user_projections',
      where: { id: 'u1' },
    });
    expect(db.calls[0]?.sql).toBe('SELECT * FROM user_projections WHERE id = $1::UUID');
  });

  it('emits WHERE with = ANY for arrays', async () => {
    await adapter.select({
      table: 'user_projections',
      where: { id: ['u1', 'u2'] },
    });
    expect(db.calls[0]?.sql).toBe('SELECT * FROM user_projections WHERE id = ANY($1::UUID[])');
  });

  it('supports limit and orderBy', async () => {
    await adapter.select({
      table: 'user_projections',
      where: { email: 'a@b.c' },
      limit: 10,
      orderBy: [{ column: 'email', direction: 'asc' }],
    });
    const sql = db.calls[0]?.sql ?? '';
    expect(sql).toContain('ORDER BY email ASC');
    expect(sql).toContain('LIMIT 10');
  });

  it('never appends FOR UPDATE (read side is query-only)', async () => {
    await adapter.select({
      table: 'user_projections',
      where: { id: 'u1' },
    });
    expect(db.calls[0]?.sql).not.toContain('FOR UPDATE');
  });
});
