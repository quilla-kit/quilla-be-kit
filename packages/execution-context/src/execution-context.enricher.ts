import type { LogEnricherContribution, LogEntryEnricher } from '@quilla-be-kit/observability';
import type { ExecutionContextProvider } from './execution-context.provider.js';

export type ExecutionContextEnricherOptions = {
  /**
   * Extended session fields to log under `extra.session`. `extra` is not
   * obfuscated, so never list sensitive fields.
   */
  readonly sessionKeys?: readonly string[];
};

/**
 * `LogEntryEnricher` that bridges `@quilla-be-kit/execution-context` into
 * `@quilla-be-kit/observability`. Registered with the logger factory so every
 * emitted entry carries scope/user/actor/correlation from the active
 * execution context.
 *
 * Returns an empty contribution when no context is active (e.g. bootstrap
 * logs, logs emitted before a request scope is established) instead of
 * propagating the provider's throw.
 */
export class ExecutionContextEnricher implements LogEntryEnricher {
  private readonly sessionKeys: readonly string[];

  constructor(
    private readonly provider: ExecutionContextProvider,
    options: ExecutionContextEnricherOptions = {},
  ) {
    // `scopeId`/`userId` are already logged flat in `context`.
    this.sessionKeys = (options.sessionKeys ?? []).filter((k) => k !== 'scopeId' && k !== 'userId');
  }

  enrich(): LogEnricherContribution {
    try {
      const ctx = this.provider.getContext();
      // Session is flattened into top-level log fields so log queries and
      // dashboards filter by scopeId/userId without navigating a nested
      // object. The log shape stays flat even though the context groups.
      const sessionExtra = this.sessionExtra(ctx.session);
      return {
        context: {
          ...(ctx.session ? { scopeId: ctx.session.scopeId, userId: ctx.session.userId } : {}),
          actorType: ctx.actorType,
          correlationId: ctx.correlationId,
          executionAttemptId: ctx.executionAttemptId,
        },
        ...(sessionExtra ? { extra: { session: sessionExtra } } : {}),
      };
    } catch {
      return {};
    }
  }

  // Nested under `extra.session` so these keys cannot collide with flat
  // `extra` keys contributed by other enrichers.
  private sessionExtra(session: object | undefined): Record<string, unknown> | undefined {
    if (!session) return undefined;
    const source = session as Readonly<Record<string, unknown>>;
    let picked: Record<string, unknown> | undefined;
    for (const key of this.sessionKeys) {
      if (Object.hasOwn(source, key) && source[key] !== undefined) {
        picked ??= {};
        picked[key] = source[key];
      }
    }
    return picked;
  }
}
