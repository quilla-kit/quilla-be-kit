import type { HttpMiddleware } from '../request/http-middleware.type.js';

export interface MiddlewareAdapter {
  application(mw: HttpMiddleware): unknown;
  router(mw: HttpMiddleware): unknown;
}
