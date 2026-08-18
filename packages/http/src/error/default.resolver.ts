import {
  ConflictError,
  ExternalError,
  ForbiddenError,
  GoneError,
  InternalError,
  NotFoundError,
  NotImplementedError,
  PaymentRequiredError,
  PreconditionFailedError,
  QuillaError,
  RateLimitError,
  TimeoutError,
  UnauthorizedError,
  UnavailableError,
  ValidationError,
} from '@quilla-be-kit/errors';
import type { ErrorResolver, ResolvedHttpError } from './error-resolver.interface.js';
import { getDeclaredHttpStatus } from './http-status-aware.interface.js';

export class DefaultErrorResolver implements ErrorResolver {
  resolve(err: unknown): ResolvedHttpError {
    if (QuillaError.is(err)) {
      const json = err.toJSON();
      return {
        httpCode: this.mapToHttpCode(err),
        body: {
          error: {
            name: json.name,
            message: json.message,
            ...(json.context !== undefined ? { details: json.context } : {}),
          },
        },
      };
    }

    return {
      httpCode: 500,
      body: {
        error: {
          name: 'InternalError',
          message: 'Internal server error',
        },
      },
    };
  }

  private mapToHttpCode(err: QuillaError): number {
    const declared = getDeclaredHttpStatus(err);
    if (declared !== undefined) return declared;

    if (err instanceof ValidationError) return 400;
    if (err instanceof UnauthorizedError) return 401;
    if (err instanceof PaymentRequiredError) return 402;
    if (err instanceof ForbiddenError) return 403;
    if (err instanceof NotFoundError) return 404;
    if (err instanceof ConflictError) return 409;
    if (err instanceof GoneError) return 410;
    if (err instanceof PreconditionFailedError) return 412;
    if (err instanceof RateLimitError) return 429;
    if (err instanceof InternalError) return 500;
    if (err instanceof NotImplementedError) return 501;
    if (err instanceof ExternalError) return 502;
    if (err instanceof UnavailableError) return 503;
    if (err instanceof TimeoutError) return 504;
    return 500;
  }
}
