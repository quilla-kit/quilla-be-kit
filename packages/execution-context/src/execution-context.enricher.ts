import type { LogEnricherContribution, LogEntryEnricher } from '@quilla-be-kit/observability';
import type { ExecutionContextProvider } from './execution-context.provider.js';

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
  constructor(private readonly provider: ExecutionContextProvider) {}

  enrich(): LogEnricherContribution {
    try {
      const ctx = this.provider.getContext();
      // Session is flattened into top-level log fields so log queries and
      // dashboards filter by scopeId/userId without navigating a nested
      // object. The log shape stays flat even though the context groups.
      return {
        context: {
          ...(ctx.session ? { scopeId: ctx.session.scopeId, userId: ctx.session.userId } : {}),
          actorType: ctx.actorType,
          correlationId: ctx.correlationId,
        },
      };
    } catch {
      return {};
    }
  }
}
