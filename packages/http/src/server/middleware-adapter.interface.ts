import type { HttpMiddleware } from '../request/http-middleware.type.js';

export interface MiddlewareAdapter {
  wrap(mw: HttpMiddleware): unknown;
}
