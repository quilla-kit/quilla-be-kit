import { randomUUID } from 'node:crypto';
import type { ActorAttributes, ActorType } from '@quilla-be-kit/ddd';
import type { ExecutionContext } from './execution-context.type.js';

/**
 * An `EventMetadata` instance or its parsed `toJSON()` form, which carries
 * `null` for an absent `scopeId`/`userId`.
 */
export type EventMetadataSource = {
  readonly actorType: ActorType;
  readonly correlationId: string;
  readonly scopeId?: string | null | undefined;
  readonly userId?: string | null | undefined;
  readonly actorAttributes?: ActorAttributes | undefined;
};

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
  createFromEventMetadata(metadata: EventMetadataSource): ExecutionContext;
}

export const executionContextFactory: ExecutionContextFactory = {
  createSystemContext(actorType) {
    return {
      actorType,
      correlationId: randomUUID(),
      executionAttemptId: randomUUID(),
    };
  },

  createBaselineContext(input) {
    return {
      actorType: 'anonymous',
      correlationId: input?.correlationId ?? randomUUID(),
      executionAttemptId: randomUUID(),
    };
  },

  createFromEventMetadata(metadata) {
    // An event carries session data iff both scopeId and userId are
    // strings. Half-populated metadata (only scopeId, only userId) comes from
    // non-auth contexts (system jobs that scoped writes without a user), and
    // parsed JSON carries `null` for absent ids — both reconstitute as
    // session-less contexts.
    const { scopeId, userId } = metadata;
    const session =
      typeof scopeId === 'string' && typeof userId === 'string'
        ? { ...actorAttributesOf(metadata), scopeId, userId }
        : undefined;

    return {
      actorType: metadata.actorType,
      correlationId: metadata.correlationId,
      executionAttemptId: randomUUID(),
      ...(session ? { session } : {}),
    };
  },
};

// Only primitives are copied, and the caller spreads `scopeId`/`userId` after
// the result, so attributes from untrusted JSON can't override the ids or
// smuggle in objects.
function actorAttributesOf(metadata: EventMetadataSource): Record<string, unknown> {
  const attributes = metadata.actorAttributes;
  if (attributes === null || typeof attributes !== 'object') return {};
  const copied: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      copied[key] = value;
    }
  }
  return copied;
}
