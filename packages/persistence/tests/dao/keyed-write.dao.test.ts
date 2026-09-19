import { beforeEach, describe, expect, it } from 'vitest';
import { resolveAuditPolicy } from '../../src/dao/audit-columns.js';
import type { AuditPolicy } from '../../src/dao/audit-policy.type.js';
import { KeyedWriteDao } from '../../src/dao/keyed-write.dao.js';
import { OptimisticLockError } from '../../src/errors/optimistic-lock.error.js';
import {
  FakeExecutionContextProvider,
  ThrowingExecutionContextProvider,
} from '../helpers/fake-context-provider.js';
import { FakeDatabaseTransaction } from '../helpers/fake-database.js';
import { FakeWriteDbAdapter } from '../helpers/fake-db-adapter.js';

type MembershipRow = { org_id: string; user_id: string; role: string };

class MembershipDao extends KeyedWriteDao<MembershipRow, 'org_id' | 'user_id'> {
  protected readonly tableName = 'memberships';
  protected readonly keyColumns = ['org_id', 'user_id'] as const;
  protected override readonly auditPolicy: AuditPolicy = 'none';
}

type CodeRow = { code: string; label: string; modified_at?: Date; created_by?: string };

class CodeDao extends KeyedWriteDao<CodeRow, 'code'> {
  protected readonly tableName = 'codes';
  protected readonly keyColumns = ['code'] as const;
  protected override readonly auditPolicy: AuditPolicy = {
    updatedAt: 'modified_at',
    insertedBy: 'created_by',
  };
}

type LogRow = { message: string };

class LogDao extends KeyedWriteDao<LogRow, never> {
  protected readonly tableName = 'logs';
  protected readonly keyColumns = [] as const;
  protected override readonly auditPolicy: AuditPolicy = 'none';
}

describe('resolveAuditPolicy', () => {
  it('resolves the kit columns', () => {
    expect(resolveAuditPolicy('kit')).toEqual({
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      insertedBy: 'inserted_by',
      updatedBy: 'updated_by',
    });
  });

  it('resolves none to no columns', () => {
    expect(resolveAuditPolicy('none')).toEqual({});
  });

  it('keeps only declared string entries of a map', () => {
    expect(resolveAuditPolicy({ updatedAt: 'modified_at', createdAt: false })).toEqual({
      updatedAt: 'modified_at',
    });
  });
});

describe('KeyedWriteDao', () => {
  let adapter: FakeWriteDbAdapter;
  let ctx: FakeExecutionContextProvider;
  let trx: FakeDatabaseTransaction;

  beforeEach(() => {
    adapter = new FakeWriteDbAdapter();
    ctx = new FakeExecutionContextProvider({
      actorType: 'user',
      correlationId: 'corr-1',
      executionAttemptId: 'attempt-1',
      session: { scopeId: 'scope-1', userId: 'user-42' },
    });
    trx = new FakeDatabaseTransaction();
  });

  describe('composite key with no audit columns', () => {
    let dao: MembershipDao;
    beforeEach(() => {
      dao = new MembershipDao(adapter, ctx);
    });

    it('inserts rows untouched and stamps nothing', async () => {
      await dao.create({ org_id: 'o1', user_id: 'u1', role: 'admin' });
      expect(adapter.insertCalls[0]?.opts.rows[0]).toEqual({
        org_id: 'o1',
        user_id: 'u1',
        role: 'admin',
      });
      expect(adapter.insertCalls[0]?.opts.audit).toEqual({});
    });

    it('updates by every key column and never SETs them', async () => {
      await dao.update({ org_id: 'o1', user_id: 'u1', role: 'member' });
      const opts = adapter.updateCalls[0]?.opts;
      expect(opts?.where).toEqual({ org_id: 'o1', user_id: 'u1' });
      expect(opts?.set).toEqual({ role: 'member' });
      expect(opts?.audit).toEqual({});
      expect(opts?.optimisticLock).toBeUndefined();
    });

    it('does not lock even when a row carries an updated_at value', async () => {
      await dao.update({ org_id: 'o1', user_id: 'u1', role: 'x', updated_at: new Date() });
      expect(adapter.updateCalls[0]?.opts.optimisticLock).toBeUndefined();
      expect(adapter.updateCalls[0]?.opts.set).toHaveProperty('updated_at');
    });

    it('passes the key columns to updateMany and keeps them in each row', async () => {
      await dao.updateMany(
        [
          { org_id: 'o1', user_id: 'u1', role: 'a' },
          { org_id: 'o1', user_id: 'u2', role: 'b' },
        ],
        trx,
      );
      const opts = adapter.updateManyCalls[0]?.opts;
      expect(opts?.keyColumns).toEqual(['org_id', 'user_id']);
      expect(opts?.rows[0]).toEqual({ org_id: 'o1', user_id: 'u1', role: 'a' });
    });

    it('returns 0 from updateMany without touching the adapter when there are no rows', async () => {
      await expect(dao.updateMany([], trx)).resolves.toBe(0);
      expect(adapter.updateManyCalls).toHaveLength(0);
    });

    it('returns the affected row count from updateMany', async () => {
      adapter.updateManyResults.push({ rows: [], rowCount: 2 });
      const rows = [
        { org_id: 'o1', user_id: 'u1', role: 'a' },
        { org_id: 'o1', user_id: 'u2', role: 'b' },
      ];
      await expect(dao.updateMany(rows, trx)).resolves.toBe(2);
    });

    it('finds one by key', async () => {
      adapter.findResults.push([{ org_id: 'o1', user_id: 'u1', role: 'a' }]);
      await dao.findOneByKey({ org_id: 'o1', user_id: 'u1' });
      expect(adapter.findCalls[0]?.opts.where).toEqual({ org_id: 'o1', user_id: 'u1' });
    });

    it('deletes one composite key per statement in deleteMany', async () => {
      await dao.deleteMany(
        [
          { org_id: 'o1', user_id: 'u1' },
          { org_id: 'o1', user_id: 'u2' },
        ],
        trx,
      );
      expect(adapter.deleteCalls.map((c) => c.opts.where)).toEqual([
        { org_id: 'o1', user_id: 'u1' },
        { org_id: 'o1', user_id: 'u2' },
      ]);
      expect(adapter.deleteCalls[0]?.trx).toBe(trx);
    });
  });

  describe('mapped audit columns', () => {
    let dao: CodeDao;
    beforeEach(() => {
      dao = new CodeDao(adapter, ctx);
    });

    it('stamps only the declared columns and passes only timestamps to the adapter', async () => {
      await dao.create({ code: 'A', label: 'a' });
      expect(adapter.insertCalls[0]?.opts.rows[0]).toEqual({
        code: 'A',
        label: 'a',
        created_by: 'user-42',
      });
      expect(adapter.insertCalls[0]?.opts.audit).toEqual({ updatedAt: 'modified_at' });
    });

    it('locks on the mapped updatedAt column', async () => {
      const expected = new Date('2024-01-01T00:00:00.000Z');
      await dao.update({ code: 'A', label: 'b', modified_at: expected });
      const opts = adapter.updateCalls[0]?.opts;
      expect(opts?.optimisticLock).toEqual({ column: 'modified_at', expected });
      expect(opts?.set).toEqual({ label: 'b' });
    });

    it('throws OptimisticLockError with the key when nothing matched', async () => {
      adapter.updateResults.push({ rows: [], rowCount: 0 });
      await expect(
        dao.update({ code: 'A', label: 'b', modified_at: new Date() }),
      ).rejects.toBeInstanceOf(OptimisticLockError);
    });

    it('locks deletes on the mapped column', async () => {
      const expected = new Date();
      await dao.delete({ code: 'A', modified_at: expected });
      expect(adapter.deleteCalls[0]?.opts.optimisticLock).toEqual({
        column: 'modified_at',
        expected,
      });
    });

    it('deletes many single-key rows in one statement', async () => {
      await dao.deleteMany([{ code: 'A' }, { code: 'B' }]);
      expect(adapter.deleteCalls).toHaveLength(1);
      expect(adapter.deleteCalls[0]?.opts.where).toEqual({ code: ['A', 'B'] });
    });
  });

  describe('table without a key', () => {
    let dao: LogDao;
    beforeEach(() => {
      dao = new LogDao(adapter, ctx);
    });

    it('still inserts', async () => {
      await dao.create({ message: 'hi' });
      expect(adapter.insertCalls).toHaveLength(1);
    });

    it('refuses every keyed operation', async () => {
      const key = {} as never;
      await expect(dao.update({ message: 'x' })).rejects.toThrow(/requires keyColumns/);
      await expect(dao.updateMany([{ message: 'x' }], trx)).rejects.toThrow(/requires keyColumns/);
      await expect(dao.delete(key)).rejects.toThrow(/requires keyColumns/);
      await expect(dao.deleteMany([key])).rejects.toThrow(/requires keyColumns/);
      await expect(dao.findOneByKey(key)).rejects.toThrow(/requires keyColumns/);
      expect(adapter.updateCalls).toHaveLength(0);
      expect(adapter.deleteCalls).toHaveLength(0);
    });
  });
});

const makeCtx = () =>
  new FakeExecutionContextProvider({
    actorType: 'user',
    correlationId: 'corr-1',
    executionAttemptId: 'attempt-1',
    session: { scopeId: 'scope-1', userId: 'user-42' },
  });

type TicketRow = { ticket_no: number; title: string; slug?: string };

class TicketDao extends KeyedWriteDao<TicketRow, 'ticket_no'> {
  protected readonly tableName = 'tickets';
  protected readonly keyColumns = ['ticket_no'] as const;
  protected override readonly auditPolicy: AuditPolicy = 'none';
  protected override readonly generatedColumns = ['ticket_no', 'slug'];
}

type StampedTicketRow = TicketRow & { created_at?: Date };

class StampedTicketDao extends KeyedWriteDao<StampedTicketRow, 'ticket_no'> {
  protected readonly tableName = 'stamped_tickets';
  protected readonly keyColumns = ['ticket_no'] as const;
  protected override readonly generatedColumns = ['ticket_no'];
}

describe('KeyedWriteDao generated columns', () => {
  let adapter: FakeWriteDbAdapter;
  let ctx: FakeExecutionContextProvider;
  let dao: TicketDao;
  let trx: FakeDatabaseTransaction;

  beforeEach(() => {
    adapter = new FakeWriteDbAdapter();
    ctx = makeCtx();
    dao = new TicketDao(adapter, ctx);
    trx = new FakeDatabaseTransaction();
  });

  it('omits generated columns from the insert', async () => {
    await dao.create({ ticket_no: 0, title: 'a', slug: 'ignored' });
    expect(adapter.insertCalls[0]?.opts.rows[0]).toEqual({ title: 'a' });
  });

  it('omits generated columns from the update but still addresses by key', async () => {
    await dao.update({ ticket_no: 7, title: 'b', slug: 'ignored' });
    const opts = adapter.updateCalls[0]?.opts;
    expect(opts?.set).toEqual({ title: 'b' });
    expect(opts?.where).toEqual({ ticket_no: 7 });
  });

  it('keeps the key column in updateMany rows and drops the other generated ones', async () => {
    await dao.updateMany([{ ticket_no: 7, title: 'b', slug: 'ignored' }], trx);
    expect(adapter.updateManyCalls[0]?.opts.rows[0]).toEqual({ ticket_no: 7, title: 'b' });
  });

  it('composes with the audit policy exclusions', async () => {
    const stamped = new StampedTicketDao(adapter, ctx);
    await stamped.create({ ticket_no: 0, title: 'a', created_at: new Date() });
    expect(adapter.insertCalls[0]?.opts.rows[0]).toEqual({
      title: 'a',
      inserted_by: 'user-42',
      updated_by: 'user-42',
    });
  });

  it('sends an empty set when every settable column is excluded', async () => {
    await dao.update({ ticket_no: 7, slug: 'x' } as never);
    expect(adapter.updateCalls[0]?.opts.set).toEqual({});
  });

  it('requests every column and hands back the stored row', async () => {
    adapter.insertResults.push({ rows: [{ ticket_no: 7, title: 'a', slug: 'a-7' }], rowCount: 1 });
    const row = await dao.createReturning({ ticket_no: 0, title: 'a' });
    expect(adapter.insertCalls[0]?.opts.returning).toBe('all');
    expect(row).toEqual({ ticket_no: 7, title: 'a', slug: 'a-7' });
  });

  it('leaves returning unset on a plain create', async () => {
    await dao.create({ ticket_no: 0, title: 'a' });
    expect(adapter.insertCalls[0]?.opts.returning).toBeUndefined();
  });

  it('throws when the adapter returns nothing', async () => {
    adapter.insertResults.push({ rows: [], rowCount: 1 });
    await expect(dao.createReturning({ ticket_no: 0, title: 'a' })).rejects.toThrow(
      /ignored `returning`/,
    );
  });

  it('returns every row from createManyReturning', async () => {
    adapter.insertResults.push({
      rows: [
        { ticket_no: 7, title: 'a' },
        { ticket_no: 8, title: 'b' },
      ],
      rowCount: 2,
    });
    const rows = await dao.createManyReturning([
      { ticket_no: 0, title: 'a' },
      { ticket_no: 0, title: 'b' },
    ]);
    expect(rows).toHaveLength(2);
    expect(adapter.insertCalls).toHaveLength(1);
  });

  it('never touches the adapter for an empty createManyReturning', async () => {
    await expect(dao.createManyReturning([])).resolves.toEqual([]);
    expect(adapter.insertCalls).toHaveLength(0);
  });
});

describe('KeyedWriteDao execution context', () => {
  let adapter: FakeWriteDbAdapter;
  let provider: ThrowingExecutionContextProvider;
  let trx: FakeDatabaseTransaction;

  beforeEach(() => {
    adapter = new FakeWriteDbAdapter();
    provider = new ThrowingExecutionContextProvider();
    trx = new FakeDatabaseTransaction();
  });

  it('is never read by a policy with no actor column', async () => {
    const dao = new MembershipDao(adapter, provider);
    const row = { org_id: 'o1', user_id: 'u1', role: 'admin' };
    await dao.create(row);
    await dao.createMany([row]);
    await dao.update(row);
    await dao.updateMany([row], trx);
    expect(provider.calls).toBe(0);
  });

  it('is read on insert when the policy declares insertedBy', async () => {
    const dao = new CodeDao(adapter, provider);
    await expect(dao.create({ code: 'A', label: 'a' })).rejects.toThrow(
      /ExecutionContext not available/,
    );
    expect(provider.calls).toBe(1);
  });

  it('is not read on update when the policy declares no updatedBy', async () => {
    const dao = new CodeDao(adapter, provider);
    await dao.update({ code: 'A', label: 'a' });
    await dao.updateMany([{ code: 'A', label: 'a' }], trx);
    expect(provider.calls).toBe(0);
  });
});
