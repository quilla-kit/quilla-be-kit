import { UnauthorizedError } from '@quilla-be-kit/errors';
import {
  AsyncExecutionContextProvider,
  executionContextFactory,
} from '@quilla-be-kit/execution-context';
import { HttpAttributes } from '@quilla-be-kit/http';
import { describe, expect, it, vi } from 'vitest';
import { authenticatedSessionMiddleware } from '../../src/session/authenticated-session.middleware.js';
import { fakeHttpRequest } from '../helpers/fake-http-request.js';
import { makeSession, makeSessionStore, makeToken } from '../helpers/test-factories.js';

function runWithBaseline<T>(
  provider: AsyncExecutionContextProvider,
  fn: () => Promise<T>,
): Promise<T> {
  return provider.runWithContext(executionContextFactory.createBaselineContext(), fn);
}

describe('authenticatedSessionMiddleware', () => {
  it('enriches the ExecutionContext with user identity on success', async () => {
    const provider = new AsyncExecutionContextProvider();
    const middleware = authenticatedSessionMiddleware({
      sessionStore: makeSessionStore(makeSession()),
      executionContextProvider: provider,
    });

    const request = fakeHttpRequest();
    request.setAttribute(HttpAttributes.VERIFIED_TOKEN, makeToken());

    let observed: ReturnType<typeof provider.getContext> | undefined;
    await runWithBaseline(provider, async () => {
      await middleware(request, async () => {
        observed = provider.getContext();
      });
    });

    expect(observed).toMatchObject({
      actorType: 'user',
      session: { scopeId: 'scope-1', userId: 'user-1' },
    });
  });

  it('preserves the baseline correlation id when enriching', async () => {
    const provider = new AsyncExecutionContextProvider();
    const middleware = authenticatedSessionMiddleware({
      sessionStore: makeSessionStore(makeSession()),
      executionContextProvider: provider,
    });

    const request = fakeHttpRequest();
    request.setAttribute(HttpAttributes.VERIFIED_TOKEN, makeToken());

    const baseline = executionContextFactory.createBaselineContext({ correlationId: 'corr-42' });
    let observed: ReturnType<typeof provider.getContext> | undefined;
    await provider.runWithContext(baseline, async () => {
      await middleware(request, async () => {
        observed = provider.getContext();
      });
    });

    expect(observed).toMatchObject({
      correlationId: 'corr-42',
      session: { userId: 'user-1' },
    });
  });

  it('throws UnauthorizedError when no verified token is on the request', async () => {
    const provider = new AsyncExecutionContextProvider();
    const middleware = authenticatedSessionMiddleware({
      sessionStore: makeSessionStore(makeSession()),
      executionContextProvider: provider,
    });
    const request = fakeHttpRequest();

    await expect(
      runWithBaseline(provider, () => middleware(request, vi.fn())),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('throws UnauthorizedError when the session store has no record', async () => {
    const provider = new AsyncExecutionContextProvider();
    const middleware = authenticatedSessionMiddleware({
      sessionStore: makeSessionStore(null),
      executionContextProvider: provider,
    });
    const request = fakeHttpRequest();
    request.setAttribute(HttpAttributes.VERIFIED_TOKEN, makeToken());

    await expect(
      runWithBaseline(provider, () => middleware(request, vi.fn())),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('throws UnauthorizedError on security-stamp mismatch (session revoked)', async () => {
    const provider = new AsyncExecutionContextProvider();
    const middleware = authenticatedSessionMiddleware({
      sessionStore: makeSessionStore(makeSession({ securityStamp: 'stamp-v2' })),
      executionContextProvider: provider,
    });
    const request = fakeHttpRequest();
    request.setAttribute(HttpAttributes.VERIFIED_TOKEN, makeToken({ securityStamp: 'stamp-v1' }));

    const next = vi.fn(async () => {});
    await expect(runWithBaseline(provider, () => middleware(request, next))).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    expect(next).not.toHaveBeenCalled();
  });
});
