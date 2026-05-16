import type { SignTokenPayload } from './sign-token-payload.type.js';
import type { Token } from './token.interface.js';

/**
 * Implementations throw on verification failure (invalid signature,
 * malformed payload, etc.); `bearerTokenMiddleware` wraps those throws
 * as `UnauthorizedError`, preserving the original in `cause`.
 * `options.expiresIn` on `sign` is in seconds.
 */
export interface TokenService {
  sign(payload: SignTokenPayload, options: { expiresIn: number }): Promise<string>;
  verify(token: string): Promise<Token>;
}
