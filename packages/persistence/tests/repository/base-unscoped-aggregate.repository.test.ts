import { beforeEach, describe, expect, it } from 'vitest';
import { BaseWriteDao } from '../../src/dao/base-write.dao.js';
import { BaseUnscopedAggregateRepository } from '../../src/repository/base-unscoped-aggregate.repository.js';
import type { PersistenceMapper } from '../../src/repository/mapper.interface.js';
import { FakeExecutionContextProvider } from '../helpers/fake-context-provider.js';
import { FakeDatabase } from '../helpers/fake-database.js';
import { FakeWriteQueryBuilder } from '../helpers/fake-query-builder.js';
import { TestAggregate } from '../helpers/test.aggregate.js';

type AggRow = { id: string; name: string };

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
      name: (agg as unknown as { props: { name: string } }).props.name,
    };
  }
}

class UnscopedRepo extends BaseUnscopedAggregateRepository<TestAggregate, AggRow> {}

describe('BaseUnscopedAggregateRepository', () => {
  let db: FakeDatabase;
  let repo: UnscopedRepo;

  beforeEach(() => {
    db = new FakeDatabase();
    const qb = new FakeWriteQueryBuilder();
    const ctx = new FakeExecutionContextProvider({
      actorType: 'user',
      userId: 'u1',
      correlationId: 'c1',
    });
    const dao = new AggDao(db, qb, ctx);
    repo = new UnscopedRepo(new TestMapper(), dao);
  });

  it('returns null when loadById finds nothing (not a throw)', async () => {
    db.queryResults.push({ rows: [] });
    const agg = await repo.loadById('missing');
    expect(agg).toBeNull();
  });

  it('returns the aggregate when found', async () => {
    db.queryResults.push({
      rows: [{ id: 'a1', name: 'foo' }],
    });
    const agg = await repo.loadById('a1');
    expect(agg?.id).toBe('a1');
  });

  it('registers aggregate in UoW context on loadForUpdateById', async () => {
    db.transaction.queryResults.push({
      rows: [{ id: 'a1', name: 'foo' }],
    });

    const registered: unknown[] = [];
    const ctx = {
      trx: db.transaction,
      registerAggregate: (...aggs: unknown[]) => registered.push(...aggs),
      registerIntegrationEvent: () => {},
    };

    const agg = await repo.loadForUpdateById(
      'a1',
      ctx as Parameters<typeof repo.loadForUpdateById>[1],
    );
    expect(registered[0]).toBe(agg);
  });
});
