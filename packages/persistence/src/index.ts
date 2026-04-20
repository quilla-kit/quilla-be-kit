// database
export type { Database } from './database/database.interface.js';
export type { DatabaseTransaction } from './database/database-transaction.interface.js';
export type { DatabaseResult } from './database/database-result.type.js';

// query
export type { FilterQuery } from './query/filter-query.type.js';
export type { SqlStatement } from './query/sql-statement.type.js';
export type {
  ReadQueryBuilder,
  SelectOptions,
  OrderBy,
} from './query/read-query-builder.interface.js';
export type {
  WriteQueryBuilder,
  InsertOptions,
  UpdateOptions,
  DeleteOptions,
  SelectForUpdateOptions,
  OptimisticLock,
} from './query/write-query-builder.interface.js';

// dao
export { BaseReadDao } from './dao/base-read.dao.js';
export { BaseWriteDao } from './dao/base-write.dao.js';

// repository
export { BaseBasicRepository } from './repository/base-basic.repository.js';
export { BaseAggregateRepository } from './repository/base-aggregate.repository.js';
export { BaseScopedAggregateRepository } from './repository/base-scoped-aggregate.repository.js';
export { BaseUnscopedAggregateRepository } from './repository/base-unscoped-aggregate.repository.js';
export type { PersistenceMapper } from './repository/mapper.interface.js';

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
