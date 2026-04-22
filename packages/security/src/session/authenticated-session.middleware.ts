import { UnauthorizedError } from '@quilla-kit/errors';
import type { ExecutionContextProvider } from '@quilla-kit/execution-context';
import { HttpAttributes, type HttpMiddleware } from '@quilla-kit/http';
import type { Token } from '../token/token.interface.js';
import type { SessionStore } from './session-store.interface.js';

export type AuthenticatedSessionMiddlewareOptions = {
  readonly sessionStore: SessionStore;
  readonly executionContextProvider: ExecutionContextProvider;
};

/**
 * `ExecutionContext` is immutable by design, so enrichment happens via a
 * nested `runWithContext(...)` for the remainder of the chain.
 */
export function authenticatedSessionMiddleware(
  options: AuthenticatedSessionMiddlewareOptions,
): HttpMiddleware {
  const { sessionStore, executionContextProvider } = options;
  return async (request, next) => {
    const token = request.getAttribute<Token>(HttpAttributes.VERIFIED_TOKEN);
    if (!token) {
      throw new UnauthorizedError({
        message: 'No verified token on request — bearerTokenMiddleware must run first',
      });
    }

    const session = await sessionStore.get(token.userId);
    if (!session) {
      throw new UnauthorizedError({ message: 'Session not found or expired' });
    }

    if (session.securityStamp !== token.securityStamp) {
      throw new UnauthorizedError({ message: 'Session revoked' });
    }

    const baseline = executionContextProvider.getContext();
    const enriched = {
      ...baseline,
      actorType: 'user' as const,
      userId: token.userId,
      scopeId: token.scopeId,
    };

    await executionContextProvider.runWithContext(enriched, next);
  };
}
