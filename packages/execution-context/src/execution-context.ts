import type { ActorType } from '@quilla-kit/ddd';

/**
 * Per-operation execution context. Carries the actor, scope, user, and
 * correlation information for a single logical operation.
 *
 * Consumers that need session data, roles, permissions, or any other
 * product-shaped fields extend this type by intersection. See the
 * package README's "Extension pattern" section.
 */
export type ExecutionContext = {
  readonly scopeId?: string;
  readonly actorType: ActorType;
  readonly userId?: string;
  readonly correlationId: string;
};
