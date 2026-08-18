import type { HttpMiddleware } from '../request/http-middleware.type.js';

/**
 * One named authentication stack. Router runs phases in fixed order regardless
 * of key declaration — `credentialVerification` first, then `sessionLoad` if
 * present. Phase misordering is a type error, not a runtime bug.
 *
 * The phase is named for the credential rather than the token because a stack
 * may verify a JWT, an opaque token, an API key, or a client certificate. The
 * attribute it populates keeps the `VERIFIED_TOKEN` name, which is the
 * long-standing contract with `@quilla-be-kit/security`'s `Token`.
 */
export type AuthMiddlewareStack = {
  /** Must populate `HttpAttributes.VERIFIED_TOKEN` on success. */
  readonly credentialVerification: HttpMiddleware;
  /**
   * Optional — omit for services that verify credentials but don't load
   * sessions.
   *
   * When present it must populate `ExecutionContext.session` (`scopeId` +
   * `userId`) and set `actorType`, via a nested `runWithContext`. Downstream
   * toolkit surfaces treat session presence as the single source of truth for
   * auth-derived identity: `@ValidateRequest` injects `scopeId`/`userId` into
   * validated input only when `session` is set, so a stack that sets
   * `actorType` but omits `session` fails open — the handler runs with an
   * undefined scope instead of being rejected.
   */
  readonly sessionLoad?: HttpMiddleware;
};
