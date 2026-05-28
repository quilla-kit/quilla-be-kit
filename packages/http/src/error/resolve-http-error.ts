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
import type { HttpJsonResponse } from '../request/http-response.type.js';

export type ResolvedHttpError = {
  readonly httpCode: number;
  readonly body: Omit<HttpJsonResponse, 'httpCode'>;
};

export function resolveHttpError(err: unknown): ResolvedHttpError {
  if (QuillaError.is(err)) {
    const json = err.toJSON();
    return {
      httpCode: mapQuillaErrorToHttpCode(err),
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

function mapQuillaErrorToHttpCode(err: QuillaError): number {
  if (err instanceof ValidationError) return 400;
  if (err instanceof UnauthorizedError) return 401;
  if (err instanceof ForbiddenError) return 403;
  if (err instanceof NotFoundError) return 404;
  if (err instanceof ConflictError) return 409;
  if (err instanceof ExternalError) return 502;
  if (err instanceof InternalError) return 500;
  return 500;
}
