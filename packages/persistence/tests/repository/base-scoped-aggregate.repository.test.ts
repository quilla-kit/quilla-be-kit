import { beforeEach, describe, expect, it } from 'vitest';
import { BaseWriteDao } from '../../src/dao/base-write.dao.js';
import { CrossScopeAccessError } from '../../src/errors/cross-scope-access.error.js';
import { BaseScopedAggregateRepository } from '../../src/repository/base-scoped-aggregate.repository.js';
import type { PersistenceMapper } from '../../src/repository/mapper.interface.js';
import { FakeExecutionContextProvider } from '../helpers/fake-context-provider.js';
import { FakeDatabase } from '../helpers/fake-database.js';
import { FakeWriteQueryBuilder } from '../helpers/fake-query-builder.js';
import { TestAggregate } from '../helpers/test.aggregate.js';

type AggRow = {
  id: string;
  scope_id: string;
  name: string;
  created_at?: Date;
  updated_at?: Date;
};

class AggDao extends BaseWriteDao<AggRow> {
  protected readonly tableName = 'aggs';
}

class TestMapper implements PersistenceMapper<TestAggregate, AggRow> {
  toDomain(row: AggRow): TestAggregate {
    return new TestAggregate({ id: row.id, name: row.name }, row.id);
  }
  toPersistence(agg: TestAggregate): AggRow {
    return {
      id: agg.id,
      scope_id: 'scope-1',
      name: (agg as unknown as { props: { name: string } }).props.name,
    };
  }
}

class ScopedRepo extends BaseScopedAggregateRepository<TestAggregate, AggRow> {}

describe('BaseScopedAggregateRepository', () => {
  let db: FakeDatabase;
  let qb: FakeWriteQueryBuilder;
  let ctxProvider: FakeExecutionContextProvider;
  let dao: AggDao;
  let repo: ScopedRepo;

  beforeEach(() => {
    db = new FakeDatabase();
    qb = new FakeWriteQueryBuilder();
    ctxProvider = new FakeExecutionContextProvider({
      actorType: 'user',
      userId: 'u1',
      correlationId: 'c1',
    });
    dao = new AggDao(db, qb, ctxProvider);
    repo = new ScopedRepo(new TestMapper(), dao);
  });

  describe('loadByIdAndScopeOrFail', () => {
    it('returns the aggregate when scope matches', async () => {
      db.queryResults.push({
        rows: [{ id: 'a1', scope_id: 'scope-1', name: 'foo' }],
      });

      const agg = await repo.loadByIdAndScopeOrFail('a1', 'scope-1');
      expect(agg.id).toBe('a1');
    });

    it('throws CrossScopeAccessError when row has a different scope', async () => {
      db.queryResults.push({
        rows: [{ id: 'a1', scope_id: 'scope-OTHER', name: 'foo' }],
      });

      await expect(repo.loadByIdAndScopeOrFail('a1', 'scope-1')).rejects.toThrow(
        CrossScopeAccessError,
      );
    });

    it('throws CrossScopeAccessError when no row found', async () => {
      db.queryResults.push({ rows: [] });

      await expect(repo.loadByIdAndScopeOrFail('missing', 'scope-1')).rejects.toThrow(
        CrossScopeAccessError,
      );
    });
  });

  describe('loadForUpdateByIdAndScopeOrFail', () => {
    it('registers the aggregate in the UoW context on success', async () => {
      db.transaction.queryResults.push({
        rows: [{ id: 'a1', scope_id: 'scope-1', name: 'foo' }],
      });

      const registered: unknown[] = [];
      const ctx = {
        trx: db.transaction,
        registerAggregate: (...aggs: unknown[]) => registered.push(...aggs),
        registerIntegrationEvent: () => {},
      };

      const agg = await repo.loadForUpdateByIdAndScopeOrFail(
        'a1',
        'scope-1',
        ctx as Parameters<typeof repo.loadForUpdateByIdAndScopeOrFail>[2],
      );

      expect(registered).toHaveLength(1);
      expect(registered[0]).toBe(agg);
    });

    it('throws on scope mismatch', async () => {
      db.transaction.queryResults.push({
        rows: [{ id: 'a1', scope_id: 'other', name: 'foo' }],
      });

      const ctx = {
        trx: db.transaction,
        registerAggregate: () => {},
        registerIntegrationEvent: () => {},
      };

      await expect(
        repo.loadForUpdateByIdAndScopeOrFail(
          'a1',
          'scope-1',
          ctx as Parameters<typeof repo.loadForUpdateByIdAndScopeOrFail>[2],
        ),
      ).rejects.toThrow(CrossScopeAccessError);
    });
  });
});
