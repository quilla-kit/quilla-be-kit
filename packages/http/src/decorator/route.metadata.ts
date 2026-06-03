import type { RequestSource } from '../validator/request-source.type.js';

// Node 22 has no native Symbol.metadata; stage-3 decorator emit writes metadata
// via `Symbol.metadata`, so we install a shared well-known identity at module
// load before any decorated class is defined.
if ((Symbol as { metadata?: symbol }).metadata === undefined) {
  Object.defineProperty(Symbol, 'metadata', {
    value: Symbol.for('Symbol.metadata'),
    writable: false,
    configurable: false,
  });
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type RouteDefinition = {
  readonly handlerMethodName: string;
  readonly httpMethod: HttpMethod;
  readonly path: string;
  readonly public: boolean;
  readonly version?: string;
  readonly scopes?: readonly string[];
  readonly scopeMode?: 'any' | 'all';
  readonly validation?: {
    readonly schema: unknown;
    readonly sources: readonly RequestSource[];
  };
};

const CONTROLLER_PREFIX_KEY = Symbol.for('quilla-be-kit.http.controller-prefix');
const CONTROLLER_VERSION_KEY = Symbol.for('quilla-be-kit.http.controller-version');
const ROUTES_KEY = Symbol.for('quilla-be-kit.http.routes');

type MetadataBag = Record<string | symbol, unknown>;

export function setControllerPrefix(metadata: MetadataBag, prefix: string): void {
  metadata[CONTROLLER_PREFIX_KEY] = prefix;
}

// Returns `''` (not `undefined`) when unset: prefixes from every level are
// concatenated, so an absent level just contributes nothing — unlike version
// (see getControllerVersion), where one level wins by precedence.
export function getControllerPrefix(controllerInstance: object): string {
  for (const metadata of walkMetadata(controllerInstance)) {
    if (typeof metadata[CONTROLLER_PREFIX_KEY] === 'string') {
      return metadata[CONTROLLER_PREFIX_KEY] as string;
    }
  }
  return '';
}

export function setControllerVersion(metadata: MetadataBag, version: string | undefined): void {
  if (version === undefined) return;
  metadata[CONTROLLER_VERSION_KEY] = version;
}

// Returns `undefined` (not `''`) when unset so the router's nullish-coalescing
// precedence chain (route ?? controller ?? module) falls through correctly.
export function getControllerVersion(controllerInstance: object): string | undefined {
  for (const metadata of walkMetadata(controllerInstance)) {
    if (typeof metadata[CONTROLLER_VERSION_KEY] === 'string') {
      return metadata[CONTROLLER_VERSION_KEY] as string;
    }
  }
  return undefined;
}

export function addRoute(metadata: MetadataBag, route: RouteDefinition): void {
  const existing = (metadata[ROUTES_KEY] as RouteDefinition[] | undefined) ?? [];
  existing.push(route);
  metadata[ROUTES_KEY] = existing;
}

export function updateLastRoute(
  metadata: MetadataBag,
  methodName: string,
  patch: Partial<RouteDefinition>,
): void {
  const routes = metadata[ROUTES_KEY] as RouteDefinition[] | undefined;
  if (!routes) return;
  for (let i = routes.length - 1; i >= 0; i--) {
    const route = routes[i];
    if (route && route.handlerMethodName === methodName) {
      routes[i] = { ...route, ...patch };
      return;
    }
  }
}

export function getControllerRoutes(controllerInstance: object): readonly RouteDefinition[] {
  const collected: RouteDefinition[] = [];
  for (const metadata of walkMetadata(controllerInstance)) {
    const routes = metadata[ROUTES_KEY] as RouteDefinition[] | undefined;
    if (routes) collected.unshift(...routes);
  }
  return collected;
}

function* walkMetadata(instance: object): Generator<MetadataBag> {
  // biome-ignore lint/suspicious/noExplicitAny: prototype reflection is inherently untyped
  let ctor: any = instance.constructor;
  while (ctor && ctor !== Object) {
    const metadata = ctor[Symbol.metadata] as MetadataBag | null | undefined;
    if (metadata) yield metadata;
    const proto = ctor.prototype;
    ctor = proto ? Object.getPrototypeOf(proto)?.constructor : null;
  }
}
