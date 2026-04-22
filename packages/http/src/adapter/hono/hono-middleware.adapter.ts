import type { Context, Next } from 'hono';
import type { HttpMiddleware } from '../../request/http-middleware.type.js';
import type { MiddlewareAdapter } from '../../server/middleware-adapter.interface.js';
import type { HonoRequestAdapter } from './hono-request.adapter.js';

export class HonoMiddlewareAdapter implements MiddlewareAdapter {
  constructor(private readonly requestAdapter: HonoRequestAdapter) {}

  application(mw: HttpMiddleware): (c: Context, next: Next) => Promise<void> {
    return async (c, next) => {
      const request = await this.requestAdapter.toHttpRequest(c);
      await mw(request, next);
    };
  }

  router(mw: HttpMiddleware): (c: Context, next: Next) => Promise<void> {
    return async (c, next) => {
      const request = await this.requestAdapter.toHttpRequest(c);
      await mw(request, next);
    };
  }
}
