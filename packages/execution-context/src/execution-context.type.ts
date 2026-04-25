import type { ActorType } from '@quilla-kit/ddd';
import type { AuthSession } from './auth-session.type.js';

/**
 * Per-operation execution context. Carries the actor type, correlation
 * id, and (when authenticated) the caller's `AuthSession`.
 *
 * `session` is present iff the operation ran inside an authenticated
 * scope — anonymous/system/job contexts leave it undefined. Every
 * toolkit surface that reads auth-derived identity (audit injection,
 * `@ValidateRequest`, log enrichment) treats session presence as the
 * single source of truth.
 *
 * Consumers that need richer session data, roles, permissions, or any
 * other product-shaped fields extend `AuthSession` by intersection and
 * narrow `ExecutionContext.session` to the extended shape. See the
 * package README's "Extension pattern" section.
 */
export type ExecutionContext = {
  readonly actorType: ActorType;
  readonly correlationId: string;
  readonly session?: AuthSession;
};
