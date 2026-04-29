/**
 * Developer-facing input to `TokenService.sign()`. Field names are readable
 * by design; implementations are expected to map this to the compact
 * `TokenClaims` wire format when encoding the JWT.
 */
export type SignTokenPayload = {
  readonly userId: string;
  readonly scopeId: string;
  readonly securityStamp: string;
  readonly scope?: readonly string[];
};
