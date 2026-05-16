import { UnauthorizedError } from '@quilla-be-kit/errors';
import { HttpAttributes, type HttpMiddleware } from '@quilla-be-kit/http';
import type { TokenService } from './token-service.interface.js';

export type BearerTokenMiddlewareOptions = {
  readonly tokenService: TokenService;
};

const BEARER_PATTERN = /^Bearer\s+(.+)$/i;

export function bearerTokenMiddleware(options: BearerTokenMiddlewareOptions): HttpMiddleware {
  const { tokenService } = options;
  return async (request, next) => {
    const header = request.getHeader('authorization');
    if (!header) {
      throw new UnauthorizedError({ message: 'Missing Authorization header' });
    }

    const match = BEARER_PATTERN.exec(header.trim());
    if (!match) {
      throw new UnauthorizedError({ message: 'Authorization header must use Bearer scheme' });
    }
    const raw = match[1] as string;

    let token: Awaited<ReturnType<TokenService['verify']>>;
    try {
      token = await tokenService.verify(raw);
    } catch (cause) {
      throw new UnauthorizedError({ message: 'Token verification failed', cause });
    }

    if (token.isExpired()) {
      throw new UnauthorizedError({ message: 'Token expired' });
    }

    request.setAttribute(HttpAttributes.VERIFIED_TOKEN, token);
    await next();
  };
}
