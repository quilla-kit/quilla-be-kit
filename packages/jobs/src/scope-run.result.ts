export type ScopeRunResult<R> = {
  readonly succeeded: ReadonlyArray<{ readonly scopeId: string; readonly value: R }>;
  readonly failed: ReadonlyArray<{ readonly scopeId: string; readonly error: unknown }>;
  /** Scopes not run, or interrupted, because the job was aborted. */
  readonly skipped: readonly string[];
};
