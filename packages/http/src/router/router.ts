import {
  type RouteDefinition,
  getControllerPrefix,
  getControllerRoutes,
} from '../decorator/route.metadata.js';
import type { HttpMiddleware } from '../request/http-middleware.type.js';
import type { HttpRequest } from '../request/http-request.interface.js';
import type { HttpResponse } from '../request/http-response.type.js';
import type { ControllerRegistration } from './controller-registration.type.js';
import type { NormalizedRoute } from './normalized-route.type.js';
import type { RouterOptions } from './router-options.type.js';

type Registration = ControllerRegistration & {
  readonly modulePrefix: string;
  readonly moduleMiddlewares: readonly HttpMiddleware[];
};

export class Router {
  private readonly routes: readonly NormalizedRoute[];
  private readonly globalMiddlewares: readonly HttpMiddleware[];
  private readonly authMiddlewares: readonly HttpMiddleware[];

  constructor(options: RouterOptions) {
    this.globalMiddlewares = options.globalMiddlewares ?? [];
    this.authMiddlewares = options.authMiddlewares ?? [];

    const registrations: Registration[] = [];
    for (const raw of options.controllers ?? []) {
      registrations.push({
        ...normalizeRegistration(raw),
        modulePrefix: '',
        moduleMiddlewares: [],
      });
    }
    for (const mod of options.modules ?? []) {
      const meta = mod.meta;
      if (!meta?.controllers) continue;
      for (const raw of meta.controllers) {
        registrations.push({
          ...normalizeRegistration(raw),
          modulePrefix: meta.prefix ?? '',
          moduleMiddlewares: meta.middlewares ?? [],
        });
      }
    }

    this.routes = buildRoutes(registrations);
  }

  getRoutes(): readonly NormalizedRoute[] {
    return this.routes;
  }

  getGlobalMiddlewares(): readonly HttpMiddleware[] {
    return this.globalMiddlewares;
  }

  getAuthMiddlewares(): readonly HttpMiddleware[] {
    return this.authMiddlewares;
  }
}

function buildRoutes(registrations: readonly Registration[]): readonly NormalizedRoute[] {
  const normalized: NormalizedRoute[] = [];
  const seen = new Map<string, string>();

  for (const reg of registrations) {
    const controllerPrefix = getControllerPrefix(reg.controller);
    const controllerName = reg.controller.constructor.name;
    const routeDefs = getControllerRoutes(reg.controller);

    for (const def of routeDefs) {
      const fullPath = joinPath(reg.modulePrefix, reg.prefix ?? '', controllerPrefix, def.path);
      const key = `${def.httpMethod} ${fullPath}`;
      const existing = seen.get(key);
      if (existing) {
        throw new Error(
          `Duplicate route: ${key} declared in both "${existing}" and "${controllerName}.${def.handlerMethodName}"`,
        );
      }
      seen.set(key, `${controllerName}.${def.handlerMethodName}`);

      normalized.push({
        httpMethod: def.httpMethod,
        fullPath,
        public: def.public,
        middlewares: [...reg.moduleMiddlewares, ...(reg.middlewares ?? [])],
        handler: buildHandler(reg.controller, def),
        handlerMethodName: def.handlerMethodName,
        controllerName,
        specificity: computeSpecificity(fullPath),
      });
    }
  }

  return normalized.sort(compareBySpecificity);
}

function normalizeRegistration(raw: object | ControllerRegistration): ControllerRegistration {
  if ('controller' in raw && typeof (raw as ControllerRegistration).controller === 'object') {
    return raw as ControllerRegistration;
  }
  return { controller: raw };
}

function joinPath(...segments: readonly string[]): string {
  const combined = segments
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => (s.startsWith('/') ? s : `/${s}`))
    .join('')
    .replace(/\/+/g, '/')
    .replace(/\/+$/, '');
  return combined.length === 0 ? '/' : combined;
}

function buildHandler(
  controller: object,
  def: RouteDefinition,
): (request: HttpRequest) => Promise<HttpResponse> {
  const methodName = def.handlerMethodName;
  const methodRef = (controller as Record<string, unknown>)[methodName];
  if (typeof methodRef !== 'function') {
    throw new Error(`Controller "${controller.constructor.name}" has no method "${methodName}"`);
  }
  return (request) =>
    (methodRef as (req: HttpRequest) => Promise<HttpResponse>).call(controller, request);
}

function computeSpecificity(path: string): number {
  const segments = path.split('/').filter(Boolean);
  let score = 0;
  for (const seg of segments) {
    if (seg.startsWith(':')) score += 2;
    else if (seg === '*') score += 1;
    else score += 3;
  }
  return score + segments.length;
}

function compareBySpecificity(a: NormalizedRoute, b: NormalizedRoute): number {
  if (a.specificity !== b.specificity) return b.specificity - a.specificity;
  return b.fullPath.length - a.fullPath.length;
}
