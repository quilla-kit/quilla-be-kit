import type { SessionData } from '../../src/session/session-data.type.js';
import type { SessionStore } from '../../src/session/session-store.interface.js';
import type { TokenService } from '../../src/token/token-service.interface.js';
import type { Token } from '../../src/token/token.interface.js';

export function makeToken(overrides: Partial<Token> = {}): Token {
  return {
    userId: 'user-1',
    scopeId: 'scope-1',
    securityStamp: 'stamp-v1',
    scope: ['user:read'],
    issuedAt: new Date('2026-01-01T00:00:00Z'),
    expiresAt: new Date('2099-01-01T00:00:00Z'),
    isExpired: () => false,
    ...overrides,
  };
}

export function makeTokenService(impl: Partial<TokenService> = {}): TokenService {
  return {
    sign: async () => 'signed',
    verify: async () => makeToken(),
    ...impl,
  };
}

export function makeSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    securityStamp: 'stamp-v1',
    displayName: 'Alice',
    userType: 'customer',
    ...overrides,
  };
}

export function makeSessionStore(data: SessionData | null): SessionStore {
  return {
    get: async () => data,
    set: async () => {},
    delete: async () => {},
  };
}
