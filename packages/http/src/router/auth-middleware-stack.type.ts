import type { HttpMiddleware } from '../request/http-middleware.type.js';

/**
 * Router runs phases in fixed order regardless of key declaration —
 * `tokenVerification` first, then `sessionLoad` if present. Phase
 * misordering is a type error, not a runtime bug.
 */
export type AuthMiddlewareStack = {
  /** Must populate `HttpAttributes.VERIFIED_TOKEN` on success. */
  readonly tokenVerification: HttpMiddleware;
  /** Optional — omit for services that verify tokens but don't load sessions. */
  readonly sessionLoad?: HttpMiddleware;
};
