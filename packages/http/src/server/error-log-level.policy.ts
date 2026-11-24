import { QuillaError } from '@quilla-be-kit/errors';
import type { LogLevel, Logger } from '@quilla-be-kit/observability';
import type { ResolvedHttpError } from '../error/error-resolver.interface.js';

// Levels below `error` log only name, message and code — never the stack or error details.
export type ErrorLogLevelPolicy = (resolved: ResolvedHttpError, err: unknown) => LogLevel | 'off';

export const defaultErrorLogLevel: ErrorLogLevelPolicy = (resolved) =>
  resolved.httpCode >= 500 ? 'error' : 'warn';

const ERROR_LOG_LEVELS = {
  debug: true,
  info: true,
  warn: true,
  error: true,
  off: true,
} satisfies Record<LogLevel | 'off', true>;

// Never throws: adapters call this from their error hook, where a throw would cost the response.
export function logHttpError(
  logger: Logger,
  policy: ErrorLogLevelPolicy,
  err: Error,
  resolved: ResolvedHttpError,
): void {
  const { httpCode } = resolved;
  let level = defaultErrorLogLevel(resolved, err);
  try {
    const chosen = policy(resolved, err);
    if (Object.hasOwn(ERROR_LOG_LEVELS, chosen)) level = chosen;
  } catch (policyError) {
    logger.error('HTTP error log policy failed', policyError, { meta: { httpCode } });
  }

  if (level === 'off') return;
  if (level === 'error') {
    logger.error('HTTP error', err, { meta: { httpCode } });
    return;
  }
  const error = {
    name: err.name,
    message: err.message,
    ...(QuillaError.is(err) ? { code: err.code } : {}),
  };
  logger[level]('HTTP error', { meta: { httpCode, error } });
}
