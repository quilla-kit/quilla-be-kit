import { InternalError } from './internal.error.js';

export class UnknownError extends InternalError {
  override readonly code: string = 'UNKNOWN';

  constructor(options?: {
    readonly message?: string;
    readonly context?: Record<string, unknown>;
    readonly cause?: unknown;
  }) {
    super({
      message: options?.message ?? 'An unknown error occurred',
      ...(options?.context !== undefined ? { context: options.context } : {}),
      ...(options?.cause !== undefined ? { cause: options.cause } : {}),
    });
  }
}
