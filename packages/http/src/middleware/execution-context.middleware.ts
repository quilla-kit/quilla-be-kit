import type {
  ExecutionContextFactory,
  ExecutionContextProvider,
} from '@quilla-kit/execution-context';
import type { HttpMiddleware } from '../request/http-middleware.type.js';

export type ExecutionContextMiddlewareOptions = {
  readonly provider: ExecutionContextProvider;
  readonly factory: ExecutionContextFactory;
  readonly correlationIdHeader?: string;
};

export function executionContextMiddleware(
  options: ExecutionContextMiddlewareOptions,
): HttpMiddleware {
  const header = options.correlationIdHeader ?? 'x-correlation-id';
  return async (request, next) => {
    const correlationId = request.getHeader(header) ?? undefined;
    const ctx = options.factory.createBaselineContext(
      correlationId !== undefined ? { correlationId } : {},
    );
    await options.provider.runWithContext(ctx, next);
  };
}
