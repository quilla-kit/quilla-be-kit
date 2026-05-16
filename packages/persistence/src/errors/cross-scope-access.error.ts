import { NotFoundError } from '@quilla-be-kit/errors';

export class CrossScopeAccessError extends NotFoundError {
  override readonly code = 'CROSS_SCOPE_ACCESS';

  constructor(options: {
    readonly entity: string;
    readonly id: string | readonly string[];
    readonly scopeId: string;
  }) {
    super({
      message: `${options.entity} not found in scope`,
      context: {
        entity: options.entity,
        id: options.id,
        scopeId: options.scopeId,
      },
    });
  }
}
