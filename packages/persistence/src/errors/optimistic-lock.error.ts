import { ConflictError } from '@quilla-be-kit/errors';

export class OptimisticLockError extends ConflictError {
  override readonly code = 'OPTIMISTIC_LOCK';

  constructor(options: { readonly entity: string; readonly id: string }) {
    super({
      message: `${options.entity} was modified by another process`,
      context: { entity: options.entity, id: options.id },
    });
  }
}
