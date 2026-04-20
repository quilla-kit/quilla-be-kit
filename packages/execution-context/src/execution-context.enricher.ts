import type { LogEnricherContribution, LogEntryEnricher } from '@quilla-kit/observability';
import type { ExecutionContextProvider } from './execution-context.provider.js';

/**
 * `LogEntryEnricher` that bridges `@quilla-kit/execution-context` into
 * `@quilla-kit/observability`. Registered with the logger factory so every
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
      return {
        context: {
          ...(ctx.scopeId !== undefined ? { scopeId: ctx.scopeId } : {}),
          ...(ctx.userId !== undefined ? { userId: ctx.userId } : {}),
          actorType: ctx.actorType,
          correlationId: ctx.correlationId,
        },
      };
    } catch {
      return {};
    }
  }
}
