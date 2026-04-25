import { randomUUID } from 'node:crypto';
import type { EventMetadata } from '@quilla-kit/ddd';
import type { ExecutionContext } from './execution-context.type.js';

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
    // An event carries session data iff both scopeId and userId are
    // present on the originating metadata. Half-populated metadata (only
    // scopeId, only userId) comes from non-auth contexts (system jobs
    // that scoped writes without a user) — those reconstitute as
    // session-less contexts.
    const session =
      metadata.scopeId !== undefined && metadata.userId !== undefined
        ? { scopeId: metadata.scopeId, userId: metadata.userId }
        : undefined;

    return {
      actorType: metadata.actorType,
      correlationId: metadata.correlationId,
      ...(session ? { session } : {}),
    };
  },
};
