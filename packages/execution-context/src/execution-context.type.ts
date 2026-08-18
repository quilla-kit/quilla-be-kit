import type { ActorType } from '@quilla-be-kit/ddd';
import type { AuthSession } from './auth-session.type.js';

/**
 * Per-operation execution context. Carries the actor type, correlation
 * id, execution attempt id, and (when authenticated) the caller's
 * `AuthSession`.
 *
 * `correlationId` identifies the logical operation and can span retries —
 * a consumer that retries a request may deliberately reuse it.
 * `executionAttemptId` identifies this physical attempt: it is freshly
 * minted every time a context is established and is never accepted as
 * caller input, so a retried call can't smuggle in a stale value. The
 * pairing mirrors a trace/span relationship without borrowing tracing
 * vocabulary. Named `executionAttemptId` rather than the shorter
 * `attemptId` to stay visually distinct from the unrelated numeric
 * `attempt` retry counter already logged by `@quilla-be-kit/messaging`'s
 * event consumer.
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
  readonly executionAttemptId: string;
  readonly session?: AuthSession;
};
