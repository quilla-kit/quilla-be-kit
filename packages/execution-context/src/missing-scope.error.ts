import { InternalError, QuillaError } from '@quilla-be-kit/errors';

export class MissingScopeError extends InternalError {
  override readonly code = 'MISSING_SCOPE';

  constructor(options: { readonly actorType: string; readonly correlationId: string }) {
    super({
      message:
        'Execution scope is required but absent: the context has no session scope and no scopeId',
      context: { actorType: options.actorType, correlationId: options.correlationId },
    });
  }

  // Matches by code rather than instanceof so duplicate package installs still match.
  static override is(e: unknown): e is MissingScopeError {
    return QuillaError.is(e) && e.code === 'MISSING_SCOPE';
  }
}
