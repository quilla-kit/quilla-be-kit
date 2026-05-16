import { QuillaError } from './quilla.error.js';

type SerializedError = {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly cause?: string;
  readonly code?: string;
  readonly context?: Record<string, unknown>;
};

/**
 * Implements `LogErrorSerializer` from `@quilla-be-kit/observability` for
 * `QuillaError` instances. Surfaces `code` and `context` in log entries so
 * aggregators can filter and group by error category.
 *
 * Pass an instance to `createLoggerFactory({ errorSerializer })`. Non-
 * `QuillaError` values return `undefined` and fall through to the logger's
 * default serialization.
 */
export class QuillaErrorSerializer {
  serialize(error: unknown): SerializedError | undefined {
    if (!(error instanceof QuillaError)) return undefined;
    const json = error.toJSON();
    return {
      name: json.name,
      message: json.message,
      ...(error.stack !== undefined ? { stack: error.stack } : {}),
      ...(error.cause !== undefined ? { cause: String(error.cause) } : {}),
      code: json.code,
      ...(json.context !== undefined ? { context: json.context } : {}),
    };
  }
}
