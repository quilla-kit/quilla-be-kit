/**
 * Canonical wire-format JWT claims for tokens issued by a `TokenService`
 * implementation.
 *
 * Short keys are deliberate — JWTs travel in every authenticated request
 * header, so claim names are optimized for payload size, not readability.
 * Developer-facing types (`SignTokenPayload`, `Token`) keep full names;
 * implementers map between the two at the sign/parse boundary.
 *
 * | Claim | Maps to         |
 * | ----- | --------------- |
 * | `u`   | `userId`        |
 * | `si`  | `scopeId`       |
 * | `st`  | `securityStamp` |
 * | `s`   | `scopes`        |
 */
export type TokenClaims = {
  readonly u: string;
  readonly si: string;
  readonly st: string;
  readonly s?: readonly string[];
};
