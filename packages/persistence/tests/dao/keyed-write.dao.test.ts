import type { ExecutionContextProvider } from '@quilla-be-kit/execution-context';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ActorProvider } from '../../src/dao/actor.provider.js';
import { resolveAuditPolicy } from '../../src/dao/audit-policy.resolver.js';
import type { AuditPolicy } from '../../src/dao/audit-policy.type.js';
import { KeyedWriteDao } from '../../src/dao/keyed-write.dao.js';
import { ALL_ROWS } from '../../src/dao/write-dao.interface.js';
import { OptimisticLockError } from '../../src/errors/optimistic-lock.error.js';
import { TooManyRowsError } from '../../src/errors/too-many-rows.error.js';
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

  describe('findManyForUpdate', () => {
    const where = { org_id: 'o1' };

    it('passes only table and where when unbounded', async () => {
      await new MembershipDao(adapter, ctx).findManyForUpdate({ where }, trx);
      expect(adapter.findForUpdateCalls[0]?.opts).toStrictEqual({ table: 'memberships', where });
      expect(adapter.findForUpdateCalls[0]?.trx).toBe(trx);
    });

    it('forwards limit and orderBy', async () => {
      const orderBy = [{ column: 'user_id', direction: 'asc' as const }];
      await new MembershipDao(adapter, ctx).findManyForUpdate({ where, limit: 10, orderBy }, trx);
      expect(adapter.findForUpdateCalls[0]?.opts).toStrictEqual({
        table: 'memberships',
        where,
        limit: 10,
        orderBy,
      });
    });

    it('forwards onLocked', async () => {
      await new MembershipDao(adapter, ctx).findManyForUpdate(
        { where, limit: 10, onLocked: 'skip' },
        trx,
      );
      expect(adapter.findForUpdateCalls[0]?.opts).toStrictEqual({
        table: 'memberships',
        where,
        limit: 10,
        onLocked: 'skip',
      });
    });

    it('ignores extra properties that would retarget the read', async () => {
      const wide = { where, table: 'other', columns: ['role'] };
      await new MembershipDao(adapter, ctx).findManyForUpdate(wide, trx);
      expect(adapter.findForUpdateCalls[0]?.opts).toStrictEqual({ table: 'memberships', where });
    });

    it.each([-1, 1.5, Number.NaN])('rejects limit %s', async (limit) => {
      await expect(
        new MembershipDao(adapter, ctx).findManyForUpdate({ where, limit }, trx),
      ).rejects.toThrow(/limit must be a non-negative integer/);
      expect(adapter.findForUpdateCalls).toHaveLength(0);
    });
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

  it('may be omitted when the policy records no actor', async () => {
    const dao = new MembershipDao(adapter);
    const row = { org_id: 'o1', user_id: 'u1', role: 'admin' };
    await dao.create(row);
    await dao.update(row);
    expect(adapter.insertCalls).toHaveLength(1);
    expect(adapter.updateCalls).toHaveLength(1);
  });

  it('throws on the first write that needs an actor when omitted', async () => {
    const dao = new CodeDao(adapter);
    await expect(dao.create({ code: 'A', label: 'a' })).rejects.toThrow(
      'codes: auditPolicy records an actor, but no contextProvider was given',
    );
    expect(adapter.insertCalls).toHaveLength(0);
  });

  it('accepts any object shaped like an actor provider', async () => {
    const userId: string | undefined = 'u-9';
    const dao = new CodeDao(adapter, { getContext: () => ({ session: { userId } }) });
    await dao.create({ code: 'A', label: 'a' });
    expect(adapter.insertCalls[0]?.opts.rows[0]).toMatchObject({ created_by: 'u-9' });
  });

  it('accepts an ExecutionContextProvider', () => {
    const fromKit: ActorProvider = provider satisfies ExecutionContextProvider;
    expect(fromKit).toBe(provider);
  });
});

type IssueRow = { issue_no: number; title: string; status: string | null };

class IssueDao extends KeyedWriteDao<IssueRow, 'issue_no'> {
  protected readonly tableName = 'issues';
  protected readonly keyColumns = ['issue_no'] as const;
  protected override readonly generatedColumns = ['issue_no'];
}

describe('KeyedWriteDao predicate methods', () => {
  let adapter: FakeWriteDbAdapter;
  let ctx: FakeExecutionContextProvider;
  let trx: FakeDatabaseTransaction;

  beforeEach(() => {
    adapter = new FakeWriteDbAdapter();
    ctx = new FakeExecutionContextProvider({
      actorType: 'user',
      correlationId: 'c',
      executionAttemptId: 'a',
      session: { scopeId: 's', userId: 'u-1' },
    });
    trx = new FakeDatabaseTransaction();
  });

  describe('updateBy', () => {
    it('updates a keyless table by predicate and reports the affected count', async () => {
      const dao = new LogDao(adapter);
      adapter.updateResults.push({ rows: [], rowCount: 4 });

      await expect(dao.updateBy({ message__contains: 'tmp' }, { message: 'x' }, trx)).resolves.toBe(
        4,
      );
      expect(adapter.updateCalls[0]).toEqual({
        opts: {
          table: 'logs',
          set: { message: 'x' },
          where: { message__contains: 'tmp' },
          audit: {},
        },
        trx,
      });
    });

    it('stamps audit columns exactly as update does', async () => {
      const dao = new IssueDao(adapter, ctx);
      await dao.update({ issue_no: 7, title: 't', status: 'open' });
      await dao.updateBy({ status: 'open' }, { title: 't' });

      const [byKey, byPredicate] = adapter.updateCalls;
      expect(byPredicate?.opts.audit).toEqual(byKey?.opts.audit);
      expect(byPredicate?.opts.set).toEqual({ title: 't', updated_by: 'u-1' });
    });

    it('may set key columns', async () => {
      const dao = new MembershipDao(adapter);
      await dao.updateBy({ org_id: 'o1' }, { user_id: 'u2' });
      expect(adapter.updateCalls[0]?.opts.set).toEqual({ user_id: 'u2' });
    });

    it.each([
      ['an empty set', {}, 'issues: updateBy: set has no columns'],
      ['an undefined value', { title: undefined }, 'issues: updateBy: set.title is undefined'],
      [
        'a generated column',
        { issue_no: 9 },
        'issues: updateBy: issue_no is an audit or generated column',
      ],
      [
        'an audit column',
        { updated_by: 'x' },
        'issues: updateBy: updated_by is an audit or generated column',
      ],
    ])('rejects %s', async (_case, set, message) => {
      const dao = new IssueDao(adapter, ctx);
      await expect(dao.updateBy({ status: 'open' }, set as Partial<IssueRow>)).rejects.toThrow(
        message,
      );
      expect(adapter.updateCalls).toHaveLength(0);
    });

    it('reaches every row only through ALL_ROWS', async () => {
      const dao = new LogDao(adapter);
      await dao.updateBy(ALL_ROWS, { message: 'x' });
      expect(adapter.updateCalls[0]?.opts).toMatchObject({ where: {}, allRows: true });
    });
  });

  describe('strict predicates', () => {
    class Filter {
      message = 'x';
    }

    it.each([
      ['an empty where', {}, 'an empty where reaches every row; pass ALL_ROWS'],
      ['an undefined value', { message: undefined }, 'where.message is undefined'],
      ['a class instance', new Filter(), 'where must be a plain object'],
      ['an empty __notIn', { message__notIn: [] }, 'where.message__notIn would match every row'],
      [
        'an empty __notInStrict',
        { message__notInStrict: [] },
        'where.message__notInStrict would match every row',
      ],
      [
        'an empty __contains',
        { message__contains: '' },
        'where.message__contains would match every row',
      ],
    ])('rejects %s on every predicate method', async (_case, where, reason) => {
      const dao = new LogDao(adapter);
      const predicate = where as Parameters<LogDao['deleteBy']>[0];
      await expect(dao.deleteBy(predicate)).rejects.toThrow(`logs: deleteBy: ${reason}`);
      await expect(dao.updateBy(predicate, { message: 'y' })).rejects.toThrow(
        `logs: updateBy: ${reason}`,
      );
      await expect(dao.findSingle(predicate)).rejects.toThrow(`logs: findSingle: ${reason}`);
      await expect(dao.findSingleForUpdate(predicate, trx)).rejects.toThrow(
        `logs: findSingleForUpdate: ${reason}`,
      );
      expect(adapter.deleteCalls).toHaveLength(0);
      expect(adapter.updateCalls).toHaveLength(0);
      expect(adapter.findCalls).toHaveLength(0);
      expect(adapter.findForUpdateCalls).toHaveLength(0);
    });

    it('accepts a null value — strict operators decide what it means', async () => {
      const dao = new IssueDao(adapter, ctx);
      await dao.deleteBy({ status__eq: null });
      expect(adapter.deleteCalls[0]?.opts.where).toEqual({ status__eq: null });
    });
  });

  describe('deleteBy', () => {
    it('deletes from a keyless table by predicate', async () => {
      const dao = new LogDao(adapter);
      adapter.deleteResults.push({ rows: [], rowCount: 5 });
      await expect(dao.deleteBy({ message__in: ['a', 'b'] }, trx)).resolves.toBe(5);
      expect(adapter.deleteCalls[0]).toEqual({
        opts: { table: 'logs', where: { message__in: ['a', 'b'] } },
        trx,
      });
    });

    it('passes ALL_ROWS to the adapter as allRows', async () => {
      const dao = new LogDao(adapter);
      await dao.deleteBy(ALL_ROWS);
      expect(adapter.deleteCalls[0]?.opts).toEqual({ table: 'logs', where: {}, allRows: true });
    });
  });

  describe('findSingle', () => {
    it('reads at most two rows and returns the only match', async () => {
      const dao = new LogDao(adapter);
      adapter.findResults.push([{ message: 'a' }]);
      await expect(dao.findSingle({ message: 'a' }, trx)).resolves.toEqual({ message: 'a' });
      expect(adapter.findCalls[0]).toEqual({
        opts: { table: 'logs', where: { message: 'a' }, limit: 2 },
        trx,
      });
    });

    it('returns null when nothing matches', async () => {
      await expect(new LogDao(adapter).findSingle({ message: 'a' })).resolves.toBeNull();
    });

    it('throws TooManyRowsError when two rows match', async () => {
      adapter.findResults.push([{ message: 'a' }, { message: 'a' }]);
      const error = await new LogDao(adapter).findSingle({ message: 'a' }).catch((e) => e);
      expect(error).toBeInstanceOf(TooManyRowsError);
      expect(error.context).toEqual({ entity: 'logs' });
    });

    it('reads without a filter for ALL_ROWS', async () => {
      await new LogDao(adapter).findSingle(ALL_ROWS);
      expect(adapter.findCalls[0]?.opts).toEqual({ table: 'logs', limit: 2 });
    });
  });

  describe('findSingleForUpdate', () => {
    it('locks at most two rows and passes onLocked through', async () => {
      const dao = new LogDao(adapter);
      adapter.findForUpdateResults.push([{ message: 'a' }]);
      await expect(
        dao.findSingleForUpdate({ message: 'a' }, trx, { onLocked: 'nowait' }),
      ).resolves.toEqual({ message: 'a' });
      expect(adapter.findForUpdateCalls[0]).toEqual({
        opts: { table: 'logs', where: { message: 'a' }, limit: 2, onLocked: 'nowait' },
        trx,
      });
    });

    it('throws TooManyRowsError when two rows match', async () => {
      adapter.findForUpdateResults.push([{ message: 'a' }, { message: 'b' }]);
      await expect(new LogDao(adapter).findSingleForUpdate(ALL_ROWS, trx)).rejects.toBeInstanceOf(
        TooManyRowsError,
      );
    });

    it("rejects 'skip' at the type level", () => {
      const dao = new LogDao(adapter);
      const typeOnly = () =>
        // @ts-expect-error - SKIP LOCKED could hide a second matching row
        dao.findSingleForUpdate({ message: 'a' }, trx, { onLocked: 'skip' });
      expect(typeOnly).toBeTypeOf('function');
    });
  });
});

describe('KeyedWriteDao undefined key values', () => {
  let adapter: FakeWriteDbAdapter;
  let trx: FakeDatabaseTransaction;
  const missing = { org_id: 'o1', user_id: undefined as unknown as string, role: 'r' };

  beforeEach(() => {
    adapter = new FakeWriteDbAdapter();
    trx = new FakeDatabaseTransaction();
  });

  it.each([
    ['update', (dao: MembershipDao) => dao.update(missing)],
    ['delete', (dao: MembershipDao) => dao.delete(missing)],
    ['updateMany', (dao: MembershipDao) => dao.updateMany([missing], trx)],
    ['findOneByKey', (dao: MembershipDao) => dao.findOneByKey(missing)],
    ['deleteMany', (dao: MembershipDao) => dao.deleteMany([missing])],
    [
      'findManyForUpdateByKeys',
      (dao: MembershipDao) => dao.findManyForUpdateByKeys({ keys: [missing] }, trx),
    ],
  ])('%s throws instead of matching nothing', async (operation, call) => {
    await expect(call(new MembershipDao(adapter))).rejects.toThrow(
      `memberships: ${operation}: key column user_id is undefined`,
    );
  });

  it('applies to the single-key array path too', async () => {
    const dao = new IssueDao(adapter);
    await expect(dao.deleteMany([{ issue_no: undefined as unknown as number }])).rejects.toThrow(
      'issues: deleteMany: key column issue_no is undefined',
    );
    expect(adapter.deleteCalls).toHaveLength(0);
  });
});
