import { InternalError, QuillaError } from '@quilla-be-kit/errors';

export class MissingSessionError extends InternalError {
  override readonly code = 'MISSING_SESSION';

  constructor(options: { readonly actorType: string; readonly correlationId: string }) {
    super({
      message: 'An authenticated session is required but the execution context has none',
      context: { actorType: options.actorType, correlationId: options.correlationId },
    });
  }

  // Matches by code rather than instanceof so duplicate package installs still match.
  static override is(e: unknown): e is MissingSessionError {
    return QuillaError.is(e) && e.code === 'MISSING_SESSION';
  }
}
