import { beforeEach, describe, expect, it } from 'vitest';
import { BaseWriteDao } from '../../src/dao/base-write.dao.js';
import { OptimisticLockError } from '../../src/errors/optimistic-lock.error.js';
import { FakeExecutionContextProvider } from '../helpers/fake-context-provider.js';
import { FakeDatabase } from '../helpers/fake-database.js';
import { FakeWriteQueryBuilder } from '../helpers/fake-query-builder.js';

type UserRow = {
  id: string;
  name: string;
  created_at?: Date;
  updated_at?: Date;
  inserted_by?: string;
  updated_by?: string;
};

class UserDao extends BaseWriteDao<UserRow> {
  protected readonly tableName = 'users';
}

describe('BaseWriteDao', () => {
  let db: FakeDatabase;
  let qb: FakeWriteQueryBuilder;
  let ctxProvider: FakeExecutionContextProvider;
  let dao: UserDao;

  beforeEach(() => {
    db = new FakeDatabase();
    qb = new FakeWriteQueryBuilder();
    ctxProvider = new FakeExecutionContextProvider({
      actorType: 'user',
      userId: 'user-42',
      correlationId: 'corr-1',
    });
    dao = new UserDao(db, qb, ctxProvider);
  });

  describe('create', () => {
    it('injects inserted_by and updated_by from the execution context', async () => {
      await dao.create({ id: 'u1', name: 'Alice' });

      expect(qb.insertCalls).toHaveLength(1);
      expect(qb.insertCalls[0]?.rows[0]).toEqual({
        id: 'u1',
        name: 'Alice',
        inserted_by: 'user-42',
        updated_by: 'user-42',
      });
    });

    it('strips created_at and updated_at from input (DB-generated)', async () => {
      await dao.create({
        id: 'u1',
        name: 'Alice',
        created_at: new Date(),
        updated_at: new Date(),
      });

      const inserted = qb.insertCalls[0]?.rows[0];
      expect(inserted).not.toHaveProperty('created_at');
      expect(inserted).not.toHaveProperty('updated_at');
    });

    it('passes trx through to the db when present', async () => {
      await dao.create({ id: 'u1', name: 'Alice' }, db.transaction);
      expect(db.calls[0]?.viaTrx).toBe(true);
    });
  });

  describe('createMany', () => {
    it('no-ops on empty array', async () => {
      await dao.createMany([]);
      expect(qb.insertCalls).toHaveLength(0);
    });

    it('prepares each row with audit fields', async () => {
      await dao.createMany([
        { id: 'u1', name: 'a' },
        { id: 'u2', name: 'b' },
      ]);

      const inserted = qb.insertCalls[0]?.rows;
      expect(inserted).toHaveLength(2);
      expect(inserted?.[0]).toMatchObject({ inserted_by: 'user-42' });
      expect(inserted?.[1]).toMatchObject({ inserted_by: 'user-42' });
    });
  });

  describe('update', () => {
    beforeEach(() => {
      db.transaction.queryResults.push({ rows: [], rowCount: 1 });
    });

    it('injects updated_by but not inserted_by', async () => {
      await dao.update({ id: 'u1', name: 'Alice2' }, db.transaction);

      const set = qb.updateCalls[0]?.set;
      expect(set).toMatchObject({ name: 'Alice2', updated_by: 'user-42' });
      expect(set).not.toHaveProperty('inserted_by');
    });

    it('strips id and immutable fields from set clause', async () => {
      await dao.update(
        {
          id: 'u1',
          name: 'Alice2',
          inserted_by: 'old-user',
          created_at: new Date(),
        },
        db.transaction,
      );

      const set = qb.updateCalls[0]?.set;
      expect(set).not.toHaveProperty('id');
      expect(set).not.toHaveProperty('inserted_by');
      expect(set).not.toHaveProperty('created_at');
      expect(set).not.toHaveProperty('updated_at');
    });

    it('passes updated_at as optimisticLock when present', async () => {
      const updatedAt = new Date('2026-01-01');
      await dao.update({ id: 'u1', name: 'x', updated_at: updatedAt }, db.transaction);

      expect(qb.updateCalls[0]?.optimisticLock).toEqual({
        column: 'updated_at',
        expected: updatedAt,
      });
    });

    it('omits optimisticLock when updated_at is absent', async () => {
      await dao.update({ id: 'u1', name: 'x' }, db.transaction);
      expect(qb.updateCalls[0]?.optimisticLock).toBeUndefined();
    });

    it('throws OptimisticLockError when rowCount is 0 and updated_at was provided', async () => {
      db.transaction.queryResults = [{ rows: [], rowCount: 0 }];

      await expect(
        dao.update({ id: 'u1', name: 'x', updated_at: new Date() }, db.transaction),
      ).rejects.toThrow(OptimisticLockError);
    });

    it('does not throw when rowCount is 0 but no optimistic lock was requested', async () => {
      db.transaction.queryResults = [{ rows: [], rowCount: 0 }];

      await expect(dao.update({ id: 'u1', name: 'x' }, db.transaction)).resolves.toBeUndefined();
    });
  });

  describe('delete', () => {
    it('passes id as where clause to the query builder', async () => {
      await dao.delete('u1');
      expect(qb.deleteCalls[0]?.where).toEqual({ id: 'u1' });
    });
  });

  describe('deleteMany', () => {
    it('no-ops on empty array', async () => {
      await dao.deleteMany([]);
      expect(qb.deleteCalls).toHaveLength(0);
    });

    it('passes ids array as where clause', async () => {
      await dao.deleteMany(['u1', 'u2']);
      expect(qb.deleteCalls[0]?.where).toEqual({ id: ['u1', 'u2'] });
    });
  });

  describe('findOneForUpdate', () => {
    it('uses selectForUpdate on the query builder', async () => {
      db.transaction.queryResults = [{ rows: [{ id: 'u1', name: 'a' }] }];

      const row = await dao.findOneForUpdate({ id: 'u1' }, db.transaction);
      expect(qb.selectForUpdate).toHaveBeenCalledTimes(1);
      expect(row).toEqual({ id: 'u1', name: 'a' });
    });

    it('returns null when no rows match', async () => {
      db.transaction.queryResults = [{ rows: [] }];
      const row = await dao.findOneForUpdate({ id: 'u1' }, db.transaction);
      expect(row).toBeNull();
    });
  });
});
