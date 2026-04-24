import { describe, expect, it } from 'vitest';
import { BaseReadDao } from '../../src/dao/base-read.dao.js';
import { PgSqlQueryBuilder } from '../../src/postgres/pg-query-builder.js';
import type { ColumnResolver } from '../../src/query/column-resolver.interface.js';
import { DefaultColumnResolver } from '../../src/query/default.resolver.js';
import type { SqlQueryBuilder } from '../../src/query/sql-query-builder.interface.js';
import { FakeReadDbAdapter } from '../helpers/fake-db-adapter.js';

type UserRow = { id: string; name: string; createdAt: Date };

class TestReadDao extends BaseReadDao {
  listActive(): Promise<readonly UserRow[]> {
    const q = this.qb<UserRow>()
      .select(['id', 'name', 'createdAt'])
      .from('users')
      .filters({ isActive: true })
      .orderBy([{ createdAt: 'desc' }])
      .build();
    return this.findMany<UserRow>(q);
  }

  getById(id: string): Promise<UserRow | null> {
    const q = this.qb<UserRow>()
      .select(['id', 'name', 'createdAt'])
      .from('users')
      .filters({ id })
      .build();
    return this.findOne<UserRow>(q);
  }

  listPaginated(page: number, pageSize: number) {
    const q = this.qb<UserRow>().from('users').paginate({ page, pageSize }).build();
    return this.findPaginated<UserRow>(q, { page, pageSize });
  }

  nonPaginatedAsPaginated() {
    const q = this.qb<UserRow>().from('users').build();
    return this.findPaginated<UserRow>(q, { page: 1, pageSize: 10 });
  }
}

const builderFactory = (resolver: ColumnResolver): SqlQueryBuilder<unknown> =>
  new PgSqlQueryBuilder(resolver);

describe('BaseReadDao', () => {
  it('findMany routes through adapter.raw with builder output', async () => {
    const adapter = new FakeReadDbAdapter();
    adapter.rawResults = [[{ id: '1', name: 'Ada', createdAt: new Date(0) }]];
    const dao = new TestReadDao({ adapter, builderFactory });

    const rows = await dao.listActive();
    expect(rows).toHaveLength(1);
    expect(adapter.rawCalls).toHaveLength(1);
    expect(adapter.rawCalls[0]?.sql).toBe(
      'SELECT id, name, created_at AS "createdAt" FROM users WHERE is_active = $1 ORDER BY created_at DESC',
    );
    expect(adapter.rawCalls[0]?.params).toEqual([true]);
  });

  it('findOne returns null when adapter returns no rows', async () => {
    const adapter = new FakeReadDbAdapter();
    adapter.rawResults = [[]];
    const dao = new TestReadDao({ adapter, builderFactory });
    const result = await dao.getById('missing');
    expect(result).toBeNull();
  });

  it('findOne returns the first row', async () => {
    const adapter = new FakeReadDbAdapter();
    adapter.rawResults = [[{ id: '1', name: 'Ada', createdAt: new Date(0) }]];
    const dao = new TestReadDao({ adapter, builderFactory });
    const result = await dao.getById('1');
    expect(result).not.toBeNull();
    expect(result?.name).toBe('Ada');
  });

  it('findPaginated fires data and count queries in parallel and returns a paginated envelope', async () => {
    const adapter = new FakeReadDbAdapter();
    adapter.rawResults = [[{ id: '1' }, { id: '2' }], [{ count: '42' }]];
    const dao = new TestReadDao({ adapter, builderFactory });

    const result = await dao.listPaginated(2, 10);
    expect(result.total).toBe(42);
    expect(result.page).toBe(2);
    expect(result.pageSize).toBe(10);
    expect(result.rows).toHaveLength(2);
    expect(adapter.rawCalls).toHaveLength(2);
  });

  it('findPaginated throws when build() was not called with .paginate()', async () => {
    const adapter = new FakeReadDbAdapter();
    const dao = new TestReadDao({ adapter, builderFactory });
    await expect(dao.nonPaginatedAsPaginated()).rejects.toThrow(/countSql/);
  });

  it('column resolver overrides flow from DAO into every query', async () => {
    const adapter = new FakeReadDbAdapter();
    adapter.rawResults = [[]];
    const dao = new TestReadDao({
      adapter,
      builderFactory,
      columnResolver: new DefaultColumnResolver({ overrides: { scopeId: 'tenant_id' } }),
    });

    class WithScope extends TestReadDao {
      byScope(scopeId: string) {
        const q = this.qb<UserRow>().from('users').filters({ scopeId }).build();
        return this.findMany<UserRow>(q);
      }
    }
    const scopedDao = new WithScope({
      adapter,
      builderFactory,
      columnResolver: new DefaultColumnResolver({ overrides: { scopeId: 'tenant_id' } }),
    });
    await scopedDao.byScope('t1');
    expect(adapter.rawCalls[0]?.sql).toBe('SELECT * FROM users WHERE tenant_id = $1');
  });
});
