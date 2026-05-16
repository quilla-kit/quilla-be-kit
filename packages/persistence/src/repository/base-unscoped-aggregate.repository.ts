import type { AggregateRoot } from '@quilla-be-kit/ddd';
import type { FilterQuery } from '../db-adapter/filter-query.type.js';
import type { UnitOfWorkContext } from '../unit-of-work/unit-of-work-context.type.js';
import { BaseAggregateRepository } from './base-aggregate.repository.js';

/**
 * Repository for global aggregates with no scope boundary (e.g. system
 * configuration, shared reference data). Returns `null` for missing rows
 * — absence is a legitimate state, not an access violation.
 */
export abstract class BaseUnscopedAggregateRepository<
  TAggregate extends AggregateRoot<object> & { id: string },
  TRow extends { id: string },
> extends BaseAggregateRepository<TAggregate, TRow> {
  async loadById(id: string): Promise<TAggregate | null> {
    const row = await this.writeDao.findOneById(id);
    return row ? this.mapper.toDomain(row) : null;
  }

  async loadForUpdateById(id: string, ctx: UnitOfWorkContext): Promise<TAggregate | null> {
    const row = await this.writeDao.findOneForUpdate({ id } as FilterQuery<TRow>, ctx.trx);
    if (!row) return null;
    const aggregate = this.mapper.toDomain(row);
    ctx.registerAggregate(aggregate);
    return aggregate;
  }
}
