import type { AggregateRoot } from '@quilla-kit/ddd';
import type { FilterQuery } from '../db-adapter/filter-query.type.js';
import { CrossScopeAccessError } from '../errors/cross-scope-access.error.js';
import type { UnitOfWorkContext } from '../unit-of-work/unit-of-work-context.type.js';
import { BaseAggregateRepository } from './base-aggregate.repository.js';

/**
 * Repository for aggregates bound to a scope (tenant / workspace /
 * organization / project / etc.). Every load method takes `scopeId` and
 * throws `CrossScopeAccessError` on mismatch or miss — from the scope's
 * point of view, there is no such resource.
 */
export abstract class BaseScopedAggregateRepository<
  TAggregate extends AggregateRoot<object> & { id: string },
  TRow extends { id: string; scope_id: string },
> extends BaseAggregateRepository<TAggregate, TRow> {
  async loadByIdAndScopeOrFail(id: string, scopeId: string): Promise<TAggregate> {
    const row = await this.writeDao.findOneById(id);
    if (!row || row.scope_id !== scopeId) {
      throw new CrossScopeAccessError({
        entity: this.constructor.name,
        id,
        scopeId,
      });
    }
    return this.mapper.toDomain(row);
  }

  async loadForUpdateByIdAndScopeOrFail(
    id: string,
    scopeId: string,
    ctx: UnitOfWorkContext,
  ): Promise<TAggregate> {
    const row = await this.writeDao.findOneForUpdate({ id } as FilterQuery<TRow>, ctx.trx);
    if (!row || row.scope_id !== scopeId) {
      throw new CrossScopeAccessError({
        entity: this.constructor.name,
        id,
        scopeId,
      });
    }
    const aggregate = this.mapper.toDomain(row);
    ctx.registerAggregate(aggregate);
    return aggregate;
  }
}
