/**
 * Identity of the authenticated caller for a single operation. Present on
 * `ExecutionContext.session` iff the operation ran inside an authenticated
 * scope; absent for anonymous / system / job contexts.
 *
 * Consumers extend by intersection when they need richer session data
 * (roles, permissions, session id, issued-at, etc.). The toolkit only
 * requires `scopeId` + `userId` — the two fields every downstream concern
 * (audit, scope isolation, log enrichment) reads from.
 *
 * @example
 * ```ts
 * import type { AuthSession, ExecutionContext } from '@quilla-kit/execution-context';
 *
 * type AppAuthSession = AuthSession & {
 *   readonly sessionId: string;
 *   readonly roles: readonly string[];
 *   readonly authenticatedAt: Date;
 * };
 *
 * type AppExecutionContext = ExecutionContext & { session?: AppAuthSession };
 * ```
 */
export type AuthSession = {
  readonly scopeId: string;
  readonly userId: string;
};
