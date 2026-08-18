import {
  ConflictError,
  ExternalError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  QuillaError,
  UnauthorizedError,
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
    if (err instanceof ForbiddenError) return 403;
    if (err instanceof NotFoundError) return 404;
    if (err instanceof ConflictError) return 409;
    if (err instanceof ExternalError) return 502;
    if (err instanceof InternalError) return 500;
    return 500;
  }
}
