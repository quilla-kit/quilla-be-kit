import { UnauthorizedError } from '@quilla-kit/errors';
import { HttpAttributes } from '@quilla-kit/http';
import { describe, expect, it, vi } from 'vitest';
import { bearerTokenMiddleware } from '../../src/token/bearer-token.middleware.js';
import { fakeHttpRequest } from '../helpers/fake-http-request.js';
import { makeToken, makeTokenService } from '../helpers/test-factories.js';

describe('bearerTokenMiddleware', () => {
  it('populates HttpAttributes.VERIFIED_TOKEN and calls next on a valid Bearer token', async () => {
    const token = makeToken();
    const tokenService = makeTokenService({ verify: async () => token });
    const middleware = bearerTokenMiddleware({ tokenService });

    const request = fakeHttpRequest({ headers: { authorization: 'Bearer abc.def.ghi' } });
    const next = vi.fn(async () => {});

    await middleware(request, next);

    expect(request.getAttribute(HttpAttributes.VERIFIED_TOKEN)).toBe(token);
    expect(next).toHaveBeenCalledOnce();
  });

  it('accepts the Bearer scheme case-insensitively', async () => {
    const tokenService = makeTokenService();
    const middleware = bearerTokenMiddleware({ tokenService });

    const request = fakeHttpRequest({ headers: { authorization: 'bearer abc.def.ghi' } });
    const next = vi.fn(async () => {});

    await middleware(request, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('throws UnauthorizedError when Authorization header is missing', async () => {
    const middleware = bearerTokenMiddleware({ tokenService: makeTokenService() });
    const next = vi.fn(async () => {});

    await expect(middleware(fakeHttpRequest(), next)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(next).not.toHaveBeenCalled();
  });

  it('throws UnauthorizedError when scheme is not Bearer', async () => {
    const middleware = bearerTokenMiddleware({ tokenService: makeTokenService() });
    const request = fakeHttpRequest({ headers: { authorization: 'Basic dXNlcjpwYXNz' } });

    await expect(middleware(request, vi.fn())).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('wraps verification failures in UnauthorizedError while preserving the cause', async () => {
    const inner = new Error('invalid signature');
    const tokenService = makeTokenService({
      verify: async () => {
        throw inner;
      },
    });
    const middleware = bearerTokenMiddleware({ tokenService });
    const request = fakeHttpRequest({ headers: { authorization: 'Bearer broken' } });

    await expect(middleware(request, vi.fn())).rejects.toMatchObject({
      name: 'UnauthorizedError',
      cause: inner,
    });
  });

  it('throws UnauthorizedError when the token reports itself as expired', async () => {
    const tokenService = makeTokenService({
      verify: async () => makeToken({ isExpired: () => true }),
    });
    const middleware = bearerTokenMiddleware({ tokenService });
    const request = fakeHttpRequest({ headers: { authorization: 'Bearer expired' } });

    await expect(middleware(request, vi.fn())).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
