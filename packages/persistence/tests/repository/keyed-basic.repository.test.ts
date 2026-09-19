import { beforeEach, describe, expect, it } from 'vitest';
import type { AuditPolicy } from '../../src/dao/audit-policy.type.js';
import { BaseWriteDao } from '../../src/dao/base-write.dao.js';
import { KeyedWriteDao } from '../../src/dao/keyed-write.dao.js';
import type { WriteDbAdapter } from '../../src/db-adapter/write-db-adapter.interface.js';
import { BaseBasicRepository } from '../../src/repository/base-basic.repository.js';
import { KeyedBasicRepository } from '../../src/repository/keyed-basic.repository.js';
import { FakeExecutionContextProvider } from '../helpers/fake-context-provider.js';
import { FakeDatabaseTransaction } from '../helpers/fake-database.js';
import { FakeWriteDbAdapter } from '../helpers/fake-db-adapter.js';

type LineRow = { order_id: string; line_no: number; qty: number; modified_at?: Date };

class LineDao extends KeyedWriteDao<LineRow, 'order_id' | 'line_no'> {
  protected readonly tableName = 'lines';
  protected readonly keyColumns = ['order_id', 'line_no'] as const;
  protected override readonly auditPolicy: AuditPolicy = { updatedAt: 'modified_at' };
}

class LineRepo extends KeyedBasicRepository<LineRow, 'order_id' | 'line_no'> {}

type ThingRow = { id: string; name: string; updated_at?: Date };

class ThingDao extends BaseWriteDao<ThingRow> {
  protected readonly tableName = 'things';
}

// Written exactly as against 4.2.0: constructor, argument shapes, protected writeDao.
class ThingRepo extends BaseBasicRepository<ThingRow> {
  peek(): BaseWriteDao<ThingRow> {
    return this.writeDao;
  }
}

// A custom adapter implementing only the original eight methods must still type-check.
class MinimalAdapter implements WriteDbAdapter {
  insert = async () => ({ rows: [], rowCount: 0 });
  update = async () => ({ rows: [], rowCount: 0 });
  updateMany = async () => ({ rows: [], rowCount: 0 });
  delete = async () => ({ rows: [], rowCount: 0 });
  find = async () => [];
  findForUpdate = async () => [];
  exists = async () => false;
  count = async () => 0;
}

describe('KeyedBasicRepository', () => {
  let adapter: FakeWriteDbAdapter;
  let ctx: FakeExecutionContextProvider;
  let trx: FakeDatabaseTransaction;

  beforeEach(() => {
    adapter = new FakeWriteDbAdapter();
    ctx = new FakeExecutionContextProvider({
      actorType: 'user',
      correlationId: 'c',
      executionAttemptId: 'a',
      session: { scopeId: 's', userId: 'u' },
    });
    trx = new FakeDatabaseTransaction();
  });

  it('addresses composite keys and locks on the DAO-declared audit column', async () => {
    const repo = new LineRepo(new LineDao(adapter, ctx));
    const expected = new Date('2024-01-01T00:00:00.000Z');
    await repo.update({ order_id: 'o1', line_no: 1, qty: 2, modified_at: expected }, trx);
    expect(adapter.updateCalls[0]?.opts.where).toEqual({ order_id: 'o1', line_no: 1 });
    expect(adapter.updateCalls[0]?.opts.optimisticLock).toEqual({
      column: 'modified_at',
      expected,
    });

    await repo.delete({ order_id: 'o1', line_no: 1, modified_at: expected }, trx);
    expect(adapter.deleteCalls[0]?.opts.optimisticLock).toEqual({
      column: 'modified_at',
      expected,
    });

    await repo.deleteMany([{ order_id: 'o1', line_no: 1 }], trx);
    expect(adapter.deleteCalls[1]?.opts.where).toEqual({ order_id: 'o1', line_no: 1 });
  });

  it('delegates create, createMany and updateMany', async () => {
    const repo = new LineRepo(new LineDao(adapter, ctx));
    await repo.create({ order_id: 'o1', line_no: 1, qty: 1 }, trx);
    await repo.createMany([{ order_id: 'o1', line_no: 2, qty: 1 }], trx);
    await repo.updateMany([{ order_id: 'o1', line_no: 1, qty: 5 }], trx);
    expect(adapter.insertCalls).toHaveLength(2);
    expect(adapter.updateManyCalls[0]?.opts.keyColumns).toEqual(['order_id', 'line_no']);
  });
});

describe('BaseBasicRepository compatibility', () => {
  it('keeps its 4.2.0 call shapes and protected writeDao', async () => {
    const adapter = new FakeWriteDbAdapter();
    const ctx = new FakeExecutionContextProvider({
      actorType: 'user',
      correlationId: 'c',
      executionAttemptId: 'a',
      session: { scopeId: 's', userId: 'u' },
    });
    const dao = new ThingDao(adapter, ctx);
    const repo = new ThingRepo(dao);
    const at = new Date();
    await repo.update({ id: 't1', name: 'x', updated_at: at });
    await repo.delete({ id: 't1', updated_at: at });
    await repo.deleteMany(['t1', 't2']);
    expect(repo.peek()).toBe(dao);
    expect(adapter.updateCalls[0]?.opts.optimisticLock).toEqual({
      column: 'updated_at',
      expected: at,
    });
    expect(adapter.deleteCalls[0]?.opts.optimisticLock).toEqual({
      column: 'updated_at',
      expected: at,
    });
    expect(adapter.deleteCalls[1]?.opts.where).toEqual({ id: ['t1', 't2'] });
  });

  it('accepts a custom adapter that lacks the optional methods', () => {
    const dao = new ThingDao(new MinimalAdapter(), {} as FakeExecutionContextProvider);
    expect(dao).toBeInstanceOf(ThingDao);
  });
});
