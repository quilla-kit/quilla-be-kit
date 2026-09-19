import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditPolicy } from '../../src/dao/audit-policy.type.js';
import { BaseWriteDao } from '../../src/dao/base-write.dao.js';
import { KeyedWriteDao } from '../../src/dao/keyed-write.dao.js';
import type { KeySetOptions } from '../../src/db-adapter/write-db-adapter.interface.js';
import { FakeExecutionContextProvider } from '../helpers/fake-context-provider.js';
import { FakeDatabaseTransaction } from '../helpers/fake-database.js';
import { FakeWriteDbAdapter } from '../helpers/fake-db-adapter.js';

type LineRow = { order_id: string; line_no: number; qty: number };

class LineDao extends KeyedWriteDao<LineRow, 'order_id' | 'line_no'> {
  protected readonly tableName = 'lines';
  protected readonly keyColumns = ['order_id', 'line_no'] as const;
  protected override readonly auditPolicy: AuditPolicy = 'none';
}

type CodeRow = { code: string; label: string };

class CodeDao extends KeyedWriteDao<CodeRow, 'code'> {
  protected readonly tableName = 'codes';
  protected readonly keyColumns = ['code'] as const;
  protected override readonly auditPolicy: AuditPolicy = 'none';
}

class NoteDao extends KeyedWriteDao<{ body: string }, never> {
  protected readonly tableName = 'notes';
  protected readonly keyColumns = [] as const;
  protected override readonly auditPolicy: AuditPolicy = 'none';
}

type ThingRow = { id: string; name: string };

class ThingDao extends BaseWriteDao<ThingRow> {
  protected readonly tableName = 'things';
}

const keys = [
  { order_id: 'o1', line_no: 1 },
  { order_id: 'o2', line_no: 2 },
];

describe('KeyedWriteDao key-set operations', () => {
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

  describe('composite key, adapter implements the optional methods', () => {
    let deleteByKeys: ReturnType<typeof vi.fn>;
    let findByKeysForUpdate: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      deleteByKeys = vi.fn(async (_opts: KeySetOptions) => ({ rows: [], rowCount: 2 }));
      findByKeysForUpdate = vi.fn(async (_opts: KeySetOptions) => [
        { order_id: 'o1', line_no: 1, qty: 1 },
      ]);
      Object.assign(adapter, { deleteByKeys, findByKeysForUpdate });
    });

    it('deletes in one adapter call', async () => {
      await new LineDao(adapter, ctx).deleteMany(keys, trx);
      expect(deleteByKeys).toHaveBeenCalledTimes(1);
      expect(deleteByKeys).toHaveBeenCalledWith(
        { table: 'lines', keyColumns: ['order_id', 'line_no'], keys },
        trx,
      );
      expect(adapter.deleteCalls).toHaveLength(0);
    });

    it('locks in one adapter call', async () => {
      const rows = await new LineDao(adapter, ctx).findManyForUpdateByKeys(keys, trx);
      expect(findByKeysForUpdate).toHaveBeenCalledWith(
        { table: 'lines', keyColumns: ['order_id', 'line_no'], keys },
        trx,
      );
      expect(rows).toEqual([{ order_id: 'o1', line_no: 1, qty: 1 }]);
      expect(adapter.findForUpdateCalls).toHaveLength(0);
    });
  });

  describe('composite key, adapter lacks the optional methods', () => {
    it('falls back to one delete per key', async () => {
      await new LineDao(adapter, ctx).deleteMany(keys, trx);
      expect(adapter.deleteCalls.map((c) => c.opts.where)).toEqual(keys);
      expect(adapter.deleteCalls[0]?.trx).toBe(trx);
    });

    it('falls back to one locked read per key and concatenates results', async () => {
      adapter.findForUpdateResults.push([{ order_id: 'o1', line_no: 1, qty: 1 }]);
      adapter.findForUpdateResults.push([{ order_id: 'o2', line_no: 2, qty: 2 }]);
      const rows = await new LineDao(adapter, ctx).findManyForUpdateByKeys(keys, trx);
      expect(adapter.findForUpdateCalls.map((c) => c.opts.where)).toEqual(keys);
      expect(rows).toHaveLength(2);
    });
  });

  describe('single key column', () => {
    it('keeps the filter path even when the adapter implements the optional methods', async () => {
      const deleteByKeys = vi.fn();
      const findByKeysForUpdate = vi.fn();
      Object.assign(adapter, { deleteByKeys, findByKeysForUpdate });
      const dao = new CodeDao(adapter, ctx);
      await dao.deleteMany([{ code: 'A' }, { code: 'B' }], trx);
      await dao.findManyForUpdateByKeys([{ code: 'A' }, { code: 'B' }], trx);
      expect(adapter.deleteCalls[0]?.opts.where).toEqual({ code: ['A', 'B'] });
      expect(adapter.findForUpdateCalls[0]?.opts.where).toEqual({ code: ['A', 'B'] });
      expect(deleteByKeys).not.toHaveBeenCalled();
      expect(findByKeysForUpdate).not.toHaveBeenCalled();
    });

    it('BaseWriteDao keeps accepting bare ids and locks by id', async () => {
      const dao = new ThingDao(adapter, ctx);
      await dao.deleteMany(['t1', 't2']);
      await dao.findManyForUpdateByKeys([{ id: 't1' }], trx);
      expect(adapter.deleteCalls[0]?.opts.where).toEqual({ id: ['t1', 't2'] });
      expect(adapter.findForUpdateCalls[0]?.opts.where).toEqual({ id: ['t1'] });
    });
  });

  it('does nothing for empty key lists', async () => {
    const dao = new LineDao(adapter, ctx);
    await dao.deleteMany([], trx);
    expect(await dao.findManyForUpdateByKeys([], trx)).toEqual([]);
    expect(adapter.deleteCalls).toHaveLength(0);
    expect(adapter.findForUpdateCalls).toHaveLength(0);
  });

  it('refuses key-set operations on a table without a key', async () => {
    const dao = new NoteDao(adapter, ctx);
    await expect(dao.deleteMany([{} as never])).rejects.toThrow(/requires keyColumns/);
    await expect(dao.findManyForUpdateByKeys([{} as never], trx)).rejects.toThrow(
      /requires keyColumns/,
    );
  });
});
