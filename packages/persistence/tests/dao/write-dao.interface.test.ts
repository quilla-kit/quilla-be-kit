import { describe, expect, it, vi } from 'vitest';
import { BaseScopedAggregateRepository } from '../../src/aggregate/base-scoped-aggregate.repository.js';
import { BaseUnscopedAggregateRepository } from '../../src/aggregate/base-unscoped-aggregate.repository.js';
import type { PersistenceMapper } from '../../src/aggregate/mapper.interface.js';
import type { UnitOfWorkContext } from '../../src/aggregate/unit-of-work.js';
import type { IdWriteDao } from '../../src/dao/id-write-dao.interface.js';
import type { WriteDao } from '../../src/dao/write-dao.interface.js';
import { BaseBasicRepository } from '../../src/repository/base-basic.repository.js';
import { KeyedBasicRepository } from '../../src/repository/keyed-basic.repository.js';
import { FakeDatabaseTransaction } from '../helpers/fake-database.js';
import { TestAggregate } from '../helpers/test.aggregate.js';

type ItemRow = { id: string; scope_id: string; name: string };
type LineRow = { order_id: string; line_no: number; qty: number };

// Plain objects, no kit class: the repository bases only rely on the contract.
function plainWriteDao<TRow extends object, TKey extends keyof TRow & string>(
  rows: TRow[],
): WriteDao<TRow, TKey> {
  return {
    findOneByKey: vi.fn(async () => rows[0] ?? null),
    findOne: vi.fn(async () => rows[0] ?? null),
    findMany: vi.fn(async () => rows),
    existsBy: vi.fn(async () => rows.length > 0),
    countBy: vi.fn(async () => rows.length),
    findOneForUpdate: vi.fn(async () => rows[0] ?? null),
    findManyForUpdate: vi.fn(async () => rows),
    findManyForUpdateByKeys: vi.fn(async () => rows),
    create: vi.fn(async () => {}),
    createMany: vi.fn(async () => {}),
    createReturning: vi.fn(async (row: TRow) => row),
    createManyReturning: vi.fn(async (input: readonly TRow[]) => input),
    update: vi.fn(async () => 1),
    updateMany: vi.fn(async (input: readonly TRow[]) => input.length),
    delete: vi.fn(async () => 1),
    deleteMany: vi.fn(async (keys: readonly unknown[]) => keys.length),
    findSingle: vi.fn(async () => rows[0] ?? null),
    findSingleForUpdate: vi.fn(async () => rows[0] ?? null),
    updateBy: vi.fn(async () => rows.length),
    deleteBy: vi.fn(async () => rows.length),
  };
}

function plainIdWriteDao<TRow extends { id: string }>(rows: TRow[]): IdWriteDao<TRow> {
  return {
    ...plainWriteDao<TRow, 'id'>(rows),
    findOneById: vi.fn(async (id: string) => rows.find((row) => row.id === id) ?? null),
    deleteMany: vi.fn(async (ids: readonly unknown[]) => ids.length),
  };
}

class ItemMapper implements PersistenceMapper<TestAggregate, ItemRow> {
  toDomain(row: ItemRow): TestAggregate {
    return new TestAggregate({ id: row.id, name: row.name }, row.id);
  }
  toPersistence(agg: TestAggregate): ItemRow {
    const { name } = (agg as unknown as { props: { name: string } }).props;
    return { id: agg.id, scope_id: 's1', name };
  }
}

const uowContext = (): UnitOfWorkContext => ({
  trx: new FakeDatabaseTransaction(),
  registerAggregate: vi.fn(),
  registerEventSource: () => {},
  registerIntegrationEvent: vi.fn(),
});

const item: ItemRow = { id: 'i1', scope_id: 's1', name: 'first' };

describe('repository bases over a plain WriteDao implementation', () => {
  it('BaseUnscopedAggregateRepository loads and writes through it', async () => {
    class Repo extends BaseUnscopedAggregateRepository<
      TestAggregate,
      ItemRow,
      IdWriteDao<ItemRow>
    > {}
    const dao = plainIdWriteDao([item]);
    const repo = new Repo(new ItemMapper(), dao);

    expect((await repo.loadById('i1'))?.id).toBe('i1');
    await repo.create(TestAggregate.create('i2', 'second'), uowContext());
    expect(dao.create).toHaveBeenCalledWith(
      { id: 'i2', scope_id: 's1', name: 'second' },
      expect.anything(),
    );
  });

  it('BaseScopedAggregateRepository checks scope on the row it returns', async () => {
    class Repo extends BaseScopedAggregateRepository<TestAggregate, ItemRow, IdWriteDao<ItemRow>> {}
    const repo = new Repo(new ItemMapper(), plainIdWriteDao([item]));

    expect((await repo.loadByIdAndScopeOrFail('i1', 's1')).id).toBe('i1');
    await expect(repo.loadByIdAndScopeOrFail('i1', 's2')).rejects.toThrow();
  });

  it('BaseBasicRepository passes bare ids to deleteMany', async () => {
    class Repo extends BaseBasicRepository<ItemRow, IdWriteDao<ItemRow>> {}
    const dao = plainIdWriteDao([item]);
    await new Repo(dao).deleteMany(['i1', { id: 'i2' }]);
    expect(dao.deleteMany).toHaveBeenCalledWith(['i1', { id: 'i2' }], undefined);
  });

  it('KeyedBasicRepository addresses composite keys through it', async () => {
    type Dao = WriteDao<LineRow, 'order_id' | 'line_no'>;
    class Repo extends KeyedBasicRepository<LineRow, 'order_id' | 'line_no', Dao> {}
    const dao = plainWriteDao<LineRow, 'order_id' | 'line_no'>([]);
    await new Repo(dao).deleteMany([{ order_id: 'o1', line_no: 1 }]);
    expect(dao.deleteMany).toHaveBeenCalledWith([{ order_id: 'o1', line_no: 1 }], undefined);
  });

  it("types writeDao as the consumer's own contract, extra queries included", async () => {
    interface ItemWriteDao extends IdWriteDao<ItemRow> {
      findByName(name: string): Promise<ItemRow | null>;
    }
    class Repo extends BaseUnscopedAggregateRepository<TestAggregate, ItemRow, ItemWriteDao> {
      async loadByName(name: string): Promise<TestAggregate | null> {
        const row = await this.writeDao.findByName(name);
        return row ? this.mapper.toDomain(row) : null;
      }
    }
    const dao: ItemWriteDao = {
      ...plainIdWriteDao([item]),
      findByName: vi.fn(async (name: string) => (name === item.name ? item : null)),
    };

    expect((await new Repo(new ItemMapper(), dao).loadByName('first'))?.id).toBe('i1');
  });
});
