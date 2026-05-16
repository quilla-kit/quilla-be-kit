import type { SerializedError } from './log-entry.type.js';

export interface LogErrorSerializer {
  /**
   * Serialize `error` into a `SerializedError`. Return `undefined` for errors
   * this serializer does not handle — `StructuredLogger` falls back to its
   * default serialization in that case.
   */
  serialize(error: unknown): SerializedError | undefined;
}
