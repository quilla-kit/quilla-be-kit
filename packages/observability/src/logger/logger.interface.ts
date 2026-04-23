export type LogParams = {
  /**
   * PII bucket. If a `LogObfuscator` is configured on the factory, values
   * here are obfuscated before the entry is emitted. Keys are preserved.
   */
  readonly data?: Record<string, unknown>;
  /**
   * Operational, non-PII bucket. Never obfuscated. Use this for durations,
   * counts, feature flags, etc.
   */
  readonly meta?: Record<string, unknown>;
};

export interface Logger {
  debug(message: string, params?: LogParams): void;
  info(message: string, params?: LogParams): void;
  warn(message: string, params?: LogParams): void;
  error(message: string, error?: unknown, params?: LogParams): void;
  /**
   * Returns a child logger scoped to a specific method, function, or region
   * of code. The `location` is rendered on every entry emitted through it.
   */
  forMethod(name: string): Logger;
  /**
   * Returns a child logger that merges `meta` into every emitted entry's
   * `meta` bucket. Useful for per-handler or per-request annotation
   * (event id, correlation id, subject id) without threading through every
   * call site. Per-call `params.meta` wins over the baked-in meta on key
   * collisions.
   */
  withMeta(meta: Record<string, unknown>): Logger;
}
