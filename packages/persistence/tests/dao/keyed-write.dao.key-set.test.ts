import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditPolicy } from '../../src/dao/audit-policy.type.js';
import { BaseWriteDao } from '../../src/dao/base-write.dao.js';
import { KeyedWriteDao } from '../../src/dao/keyed-write.dao.js';
import type {
  KeySetOptions,
  KeySetSelectOptions,
} from '../../src/db-adapter/write-db-adapter.interface.js';
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
      findByKeysForUpdate = vi.fn(async (_opts: KeySetSelectOptions) => [
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

    it('returns the affected row count from the single statement', async () => {
      await expect(new LineDao(adapter, ctx).deleteMany(keys, trx)).resolves.toBe(2);
    });

    it('locks in one adapter call', async () => {
      const rows = await new LineDao(adapter, ctx).findManyForUpdateByKeys({ keys }, trx);
      expect(findByKeysForUpdate).toHaveBeenCalledWith(
        { table: 'lines', keyColumns: ['order_id', 'line_no'], keys },
        trx,
      );
      expect(rows).toEqual([{ order_id: 'o1', line_no: 1, qty: 1 }]);
      expect(adapter.findForUpdateCalls).toHaveLength(0);
    });

    it('forwards limit and orderBy in the single locked read', async () => {
      const orderBy = [{ column: 'qty', direction: 'asc' as const }];
      await new LineDao(adapter, ctx).findManyForUpdateByKeys({ keys, limit: 1, orderBy }, trx);
      expect(findByKeysForUpdate).toHaveBeenCalledWith(
        { table: 'lines', keyColumns: ['order_id', 'line_no'], keys, limit: 1, orderBy },
        trx,
      );
    });
  });

  describe('composite key, adapter lacks the optional methods', () => {
    it('falls back to one delete per key', async () => {
      await new LineDao(adapter, ctx).deleteMany(keys, trx);
      expect(adapter.deleteCalls.map((c) => c.opts.where)).toEqual(keys);
      expect(adapter.deleteCalls[0]?.trx).toBe(trx);
    });

    it('sums the affected row counts across the per-key loop', async () => {
      adapter.deleteResults.push({ rows: [], rowCount: 1 }, { rows: [], rowCount: 1 });
      await expect(new LineDao(adapter, ctx).deleteMany(keys, trx)).resolves.toBe(2);
    });

    it('falls back to one locked read per key and concatenates results', async () => {
      adapter.findForUpdateResults.push([{ order_id: 'o1', line_no: 1, qty: 1 }]);
      adapter.findForUpdateResults.push([{ order_id: 'o2', line_no: 2, qty: 2 }]);
      const rows = await new LineDao(adapter, ctx).findManyForUpdateByKeys({ keys }, trx);
      expect(adapter.findForUpdateCalls.map((c) => c.opts.where)).toEqual(keys);
      expect(rows).toHaveLength(2);
    });

    it('stops locking once limit rows are returned', async () => {
      adapter.findForUpdateResults.push([{ order_id: 'o1', line_no: 1, qty: 1 }]);
      const rows = await new LineDao(adapter, ctx).findManyForUpdateByKeys({ keys, limit: 1 }, trx);
      expect(adapter.findForUpdateCalls).toHaveLength(1);
      expect(rows).toEqual([{ order_id: 'o1', line_no: 1, qty: 1 }]);
    });

    it('locks nothing for limit 0', async () => {
      const rows = await new LineDao(adapter, ctx).findManyForUpdateByKeys({ keys, limit: 0 }, trx);
      expect(adapter.findForUpdateCalls).toHaveLength(0);
      expect(rows).toEqual([]);
    });

    it.each([
      ['non-empty', keys],
      ['empty', []],
    ])('rejects orderBy for a %s key list without touching the adapter', async (_, input) => {
      const orderBy = [{ column: 'qty', direction: 'asc' as const }];
      await expect(
        new LineDao(adapter, ctx).findManyForUpdateByKeys({ keys: input, orderBy }, trx),
      ).rejects.toThrow(
        /orderBy on a composite key requires an adapter implementing findByKeysForUpdate/,
      );
      expect(adapter.findForUpdateCalls).toHaveLength(0);
    });
  });

  describe('single key column', () => {
    it('keeps the filter path even when the adapter implements the optional methods', async () => {
      const deleteByKeys = vi.fn();
      const findByKeysForUpdate = vi.fn();
      Object.assign(adapter, { deleteByKeys, findByKeysForUpdate });
      const dao = new CodeDao(adapter, ctx);
      await dao.deleteMany([{ code: 'A' }, { code: 'B' }], trx);
      await dao.findManyForUpdateByKeys({ keys: [{ code: 'A' }, { code: 'B' }] }, trx);
      expect(adapter.deleteCalls[0]?.opts.where).toEqual({ code: ['A', 'B'] });
      expect(adapter.findForUpdateCalls[0]?.opts.where).toEqual({ code: ['A', 'B'] });
      expect(deleteByKeys).not.toHaveBeenCalled();
      expect(findByKeysForUpdate).not.toHaveBeenCalled();
    });

    it('forwards limit and orderBy to the filter path', async () => {
      const orderBy = [{ column: 'label', direction: 'desc' as const }];
      await new CodeDao(adapter, ctx).findManyForUpdateByKeys(
        { keys: [{ code: 'A' }, { code: 'B' }], limit: 1, orderBy },
        trx,
      );
      expect(adapter.findForUpdateCalls[0]?.opts).toEqual({
        table: 'codes',
        where: { code: ['A', 'B'] },
        limit: 1,
        orderBy,
      });
    });

    it('BaseWriteDao keeps accepting bare ids and locks by id', async () => {
      const dao = new ThingDao(adapter, ctx);
      await dao.deleteMany(['t1', 't2']);
      await dao.findManyForUpdateByKeys({ keys: [{ id: 't1' }] }, trx);
      expect(adapter.deleteCalls[0]?.opts.where).toEqual({ id: ['t1', 't2'] });
      expect(adapter.findForUpdateCalls[0]?.opts.where).toEqual({ id: ['t1'] });
    });
  });

  it('does nothing for empty key lists', async () => {
    const dao = new LineDao(adapter, ctx);
    await dao.deleteMany([], trx);
    expect(await dao.findManyForUpdateByKeys({ keys: [] }, trx)).toEqual([]);
    expect(adapter.deleteCalls).toHaveLength(0);
    expect(adapter.findForUpdateCalls).toHaveLength(0);
  });

  it.each([-1, 1.5, Number.NaN])('rejects limit %s on every path', async (limit) => {
    const composite = new LineDao(adapter, ctx);
    await expect(composite.findManyForUpdateByKeys({ keys, limit }, trx)).rejects.toThrow(
      /limit must be a non-negative integer/,
    );
    Object.assign(adapter, { findByKeysForUpdate: vi.fn() });
    await expect(composite.findManyForUpdateByKeys({ keys, limit }, trx)).rejects.toThrow(
      /limit must be a non-negative integer/,
    );
    await expect(
      new CodeDao(adapter, ctx).findManyForUpdateByKeys({ keys: [{ code: 'A' }], limit }, trx),
    ).rejects.toThrow(/limit must be a non-negative integer/);
    expect(adapter.findForUpdateCalls).toHaveLength(0);
  });

  it('refuses key-set operations on a table without a key', async () => {
    const dao = new NoteDao(adapter, ctx);
    await expect(dao.deleteMany([{} as never])).rejects.toThrow(/requires keyColumns/);
    await expect(dao.findManyForUpdateByKeys({ keys: [{} as never] }, trx)).rejects.toThrow(
      /requires keyColumns/,
    );
  });
});
