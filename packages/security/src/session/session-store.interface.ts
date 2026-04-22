import type { SessionData } from './session-data.type.js';

/** TTL is in seconds to match `TokenService.sign`'s `expiresIn`. */
export interface SessionStore {
  set(userId: string, data: SessionData, ttlSeconds: number): Promise<void>;
  get(userId: string): Promise<SessionData | null>;
  delete(userId: string): Promise<void>;
}
