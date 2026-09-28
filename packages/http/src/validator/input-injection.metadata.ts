import type { HeaderSourceMap } from './header-source.type.js';

export const BASE_SESSION_KEYS: readonly string[] = ['scopeId', 'userId'];

// OCC is a first-class concept in this toolkit (see the persistence
// package's `expectedUpdatedAt`), so `updatedAt` gets reserved-key treatment
// — sourced from `If-Match` unless a route overrides it via `headers`.
const DEFAULT_HEADER_MAP: HeaderSourceMap = { updatedAt: 'If-Match' };

export function effectiveHeaderMap(headers: HeaderSourceMap | undefined): HeaderSourceMap {
  return { ...DEFAULT_HEADER_MAP, ...headers };
}

// Router's auth stamp sets the stack's extra session keys here (base keys
// excluded); deliberately absent from the public `HttpAttributes`.
export const SESSION_KEYS_ATTRIBUTE = '__session_keys__';

export const FORBIDDEN_SESSION_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];
