import type { AuthenticatedToken } from '@quilla-be-kit/http';

/**
 * `securityStamp` is the revocation marker — compared against the
 * `SessionStore` record's stamp. A mismatch rejects the token even when
 * its signature is still valid.
 */
export interface Token extends AuthenticatedToken {
  readonly userId: string;
  readonly scopeId: string;
  readonly securityStamp: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  isExpired(now?: Date): boolean;
}
