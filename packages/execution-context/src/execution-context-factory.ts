import { randomUUID } from 'node:crypto';
import type { EventMetadata } from '@quilla-kit/ddd';
import type { ExecutionContext } from './execution-context.js';

export interface ExecutionContextFactory {
  /** For background operations (schedulers, startup jobs, workers). */
  createSystemContext(actorType: 'system' | 'job'): ExecutionContext;

  /**
   * Anonymous baseline context for the start of a request or handler.
   * Auth middleware replaces this with an enriched context via
   * `provider.runWithContext(...)` once the caller is identified.
   */
  createBaselineContext(input?: { correlationId?: string }): ExecutionContext;

  /**
   * Reconstructs the context that emitted an event, from its metadata.
   * Used by outbox forwarders and event consumers to preserve correlation
   * and actor identity across service boundaries.
   */
  createFromEventMetadata(metadata: EventMetadata): ExecutionContext;
}

export const executionContextFactory: ExecutionContextFactory = {
  createSystemContext(actorType) {
    return {
      actorType,
      correlationId: randomUUID(),
    };
  },

  createBaselineContext(input) {
    return {
      actorType: 'anonymous',
      correlationId: input?.correlationId ?? randomUUID(),
    };
  },

  createFromEventMetadata(metadata) {
    return {
      actorType: metadata.actorType,
      correlationId: metadata.correlationId,
      ...(metadata.scopeId !== undefined ? { scopeId: metadata.scopeId } : {}),
      ...(metadata.userId !== undefined ? { userId: metadata.userId } : {}),
    };
  },
};
