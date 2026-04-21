// database
export type { Database } from './database/database.interface.js';
export type { DatabaseTransaction } from './database/database-transaction.interface.js';
export type { DatabaseResult } from './database/database-result.type.js';
export type { DatabaseHealth } from './database/database-health.type.js';

// db-adapter
export type { FilterQuery } from './db-adapter/filter-query.type.js';
export type {
  ReadDbAdapter,
  SelectOptions,
  OrderBy,
} from './db-adapter/read-db-adapter.interface.js';
export type {
  WriteDbAdapter,
  InsertOptions,
  UpdateOptions,
  DeleteOptions,
  ExistsOptions,
  OptimisticLock,
} from './db-adapter/write-db-adapter.interface.js';

// dao
export { BaseReadDao } from './dao/base-read.dao.js';
export { BaseWriteDao } from './dao/base-write.dao.js';

// repository
export { BaseBasicRepository } from './repository/base-basic.repository.js';
export { BaseAggregateRepository } from './repository/base-aggregate.repository.js';
export { BaseScopedAggregateRepository } from './repository/base-scoped-aggregate.repository.js';
export { BaseUnscopedAggregateRepository } from './repository/base-unscoped-aggregate.repository.js';
export type { PersistenceMapper } from './repository/mapper.interface.js';
export { BasePersistenceMapper } from './repository/base-persistence.mapper.js';

// unit of work
export {
  UnitOfWork,
  type UnitOfWorkOptions,
} from './unit-of-work/unit-of-work.js';
export type { UnitOfWorkContext } from './unit-of-work/unit-of-work-context.type.js';
export type { OutboxWriter } from './unit-of-work/outbox-writer.interface.js';

// errors
export { CrossScopeAccessError } from './errors/cross-scope-access.error.js';
export { OptimisticLockError } from './errors/optimistic-lock.error.js';
