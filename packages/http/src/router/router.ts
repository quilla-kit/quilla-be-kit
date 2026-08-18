import type { ExecutionContextProvider } from '@quilla-be-kit/execution-context';
import {
  type RouteDefinition,
  getControllerAuthStack,
  getControllerPrefix,
  getControllerRoutes,
  getControllerVersion,
} from '../decorator/route.metadata.js';
import { HttpAttributes } from '../request/http-attributes.js';
import type { HttpMiddleware } from '../request/http-middleware.type.js';
import type { HttpRequest } from '../request/http-request.interface.js';
import type { HttpResponse } from '../request/http-response.type.js';
import type { AuthMiddlewareStack } from './auth-middleware-stack.type.js';
import type { ControllerRegistration } from './controller-registration.type.js';
import type { NormalizedRoute } from './normalized-route.type.js';
import type { RouterExecutionContextOptions, RouterOptions } from './router-options.type.js';

type Registration = ControllerRegistration & {
  readonly modulePrefix: string;
  readonly moduleVersion: string | undefined;
  readonly moduleAuthStack: string | undefined;
  readonly moduleMiddlewares: readonly HttpMiddleware[];
};

export class Router<S extends string = string> {
  private readonly routes: readonly NormalizedRoute[];
  private readonly executionContextProvider: ExecutionContextProvider | undefined;

  constructor(options: RouterOptions<S>) {
    const { authStacks, defaultAuthStack } = options;
    const authChains = buildAuthChains(authStacks);
    const declared = declaredList(authChains);

    if (authStacks && authChains.size === 0) {
      throw new Error(
        'Router: `authStacks` is empty — every non-public route would run unauthenticated. Omit the option entirely for a service with no authentication.',
      );
    }
    if (authChains.size > 0 && !options.executionContext) {
      throw new Error(
        'Router: `authStacks` requires `executionContext` — auth middlewares depend on an active ExecutionContext scope. Wire `{ provider }` on the `executionContext` option.',
      );
    }
    if (authChains.size > 0 && defaultAuthStack === undefined) {
      throw new Error(
        `Router: \`defaultAuthStack\` is required when \`authStacks\` is declared (declared: ${declared}). Name the stack routes fall back to.`,
      );
    }
    if (defaultAuthStack !== undefined && !authChains.has(defaultAuthStack)) {
      throw new Error(
        `Router: \`defaultAuthStack: "${defaultAuthStack}"\` is not a declared stack — declared: ${declared}`,
      );
    }

    this.executionContextProvider = options.executionContext?.provider;

    const systemMiddleware = options.executionContext
      ? buildExecutionContextMiddleware(options.executionContext)
      : undefined;
    const globalMiddlewares = options.globalMiddlewares ?? [];

    const registrations: Registration[] = [];
    for (const raw of options.controllers ?? []) {
      registrations.push({
        ...normalizeRegistration(raw),
        modulePrefix: '',
        moduleVersion: undefined,
        moduleAuthStack: undefined,
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
          moduleVersion: meta.version,
          moduleAuthStack: meta.authStack,
          moduleMiddlewares: meta.middlewares ?? [],
        });
      }
    }

    assertDeclaredStacks(registrations, authChains, declared);

    this.routes = buildRoutes(registrations, {
      systemMiddleware,
      globalMiddlewares,
      authChains,
      declared,
      defaultAuthStack,
    });
  }

  getRoutes(): readonly NormalizedRoute[] {
    return this.routes;
  }

  getExecutionContextProvider(): ExecutionContextProvider | undefined {
    return this.executionContextProvider;
  }
}

function buildExecutionContextMiddleware(options: RouterExecutionContextOptions): HttpMiddleware {
  const header = options.correlationIdHeader ?? 'x-correlation-id';
  const { provider } = options;
  return async (request, next) => {
    const correlationId = request.getHeader(header);
    const ctx = provider.factory.createBaselineContext(
      correlationId !== null ? { correlationId } : undefined,
    );
    await provider.runWithContext(ctx, next);
  };
}

function buildAuthChains(
  stacks: Readonly<Partial<Record<string, AuthMiddlewareStack>>> | undefined,
): ReadonlyMap<string, readonly HttpMiddleware[]> {
  const chains = new Map<string, readonly HttpMiddleware[]>();
  if (!stacks) return chains;
  for (const [name, stack] of Object.entries(stacks)) {
    if (!stack) continue;
    // Records the stack that authenticated the request, so guards can assert
    // scheme identity — `scopes` are one flat namespace shared across stacks.
    const stamp: HttpMiddleware = async (request, next) => {
      request.setAttribute(HttpAttributes.AUTH_STACK, name);
      await next();
    };
    const chain: HttpMiddleware[] = [stamp, stack.credentialVerification];
    if (stack.sessionLoad) chain.push(stack.sessionLoad);
    chains.set(name, chain);
  }
  return chains;
}

function declaredList(authChains: ReadonlyMap<string, readonly HttpMiddleware[]>): string {
  return [...authChains.keys()].join(', ') || '(none)';
}

// Runs before route building so a stack typo is never masked by a duplicate-path
// collision on the same controller.
function assertDeclaredStacks(
  registrations: readonly Registration[],
  authChains: ReadonlyMap<string, readonly HttpMiddleware[]>,
  declared: string,
): void {
  const violations: string[] = [];
  for (const reg of registrations) {
    const controllerName = reg.controller.constructor.name;
    const controllerStack = getControllerAuthStack(reg.controller);
    if (controllerStack !== undefined && !authChains.has(controllerStack)) {
      violations.push(
        `  @Controller on "${controllerName}" declares unknown auth stack "${controllerStack}"`,
      );
    }
    if (reg.moduleAuthStack !== undefined && !authChains.has(reg.moduleAuthStack)) {
      violations.push(
        `  module registering "${controllerName}" declares unknown auth stack "${reg.moduleAuthStack}"`,
      );
    }
  }
  if (violations.length > 0) {
    throw new Error(
      `Router: unknown auth stack(s) — declared stacks: ${declared}\n${violations.join('\n')}`,
    );
  }
}

type ChainContext = {
  readonly systemMiddleware: HttpMiddleware | undefined;
  readonly globalMiddlewares: readonly HttpMiddleware[];
  readonly authChains: ReadonlyMap<string, readonly HttpMiddleware[]>;
  readonly declared: string;
  readonly defaultAuthStack: string | undefined;
};

function buildRoutes(
  registrations: readonly Registration[],
  chain: ChainContext,
): readonly NormalizedRoute[] {
  const normalized: NormalizedRoute[] = [];
  const seen = new Map<string, string>();
  const stackViolations: string[] = [];

  for (const reg of registrations) {
    const controllerPrefix = getControllerPrefix(reg.controller);
    const controllerVersion = getControllerVersion(reg.controller);
    const controllerAuthStack = getControllerAuthStack(reg.controller);
    const controllerName = reg.controller.constructor.name;
    const routeDefs = getControllerRoutes(reg.controller);

    for (const def of routeDefs) {
      const effectiveVersion = def.version ?? controllerVersion ?? reg.moduleVersion ?? '';
      const fullPath = joinPath(
        reg.modulePrefix,
        effectiveVersion,
        reg.prefix ?? '',
        controllerPrefix,
        def.path,
      );
      const site = `${controllerName}.${def.handlerMethodName}`;
      const key = `${def.httpMethod} ${fullPath}`;
      const existing = seen.get(key);
      if (existing) {
        throw new Error(`Duplicate route: ${key} declared in both "${existing}" and "${site}"`);
      }
      seen.set(key, site);

      if (def.public && def.authStack !== undefined) {
        stackViolations.push(
          `  "${site}" is a *Public route but declares \`authStack: "${def.authStack}"\` — public routes skip the auth phase, so the stack would never run`,
        );
      }

      const resolvedAuthStack = def.public
        ? undefined
        : (def.authStack ?? controllerAuthStack ?? reg.moduleAuthStack ?? chain.defaultAuthStack);

      // The lookup IS the guard — no `?? []` fallback anywhere near the auth
      // segment, so an unresolvable stack can never degrade to "no auth".
      let authChain: readonly HttpMiddleware[] = [];
      if (resolvedAuthStack !== undefined) {
        const resolved = chain.authChains.get(resolvedAuthStack);
        if (!resolved) {
          stackViolations.push(`  "${site}" resolves to unknown auth stack "${resolvedAuthStack}"`);
        } else {
          authChain = resolved;
        }
      }

      // `authChain` is already empty on public routes — `resolvedAuthStack` is
      // undefined there — so this needs no second public check.
      const registrationMiddlewares = reg.middlewares ?? [];
      const middlewareChain: HttpMiddleware[] = [];
      if (chain.systemMiddleware) middlewareChain.push(chain.systemMiddleware);
      middlewareChain.push(...chain.globalMiddlewares, ...authChain);
      middlewareChain.push(...reg.moduleMiddlewares, ...registrationMiddlewares);

      normalized.push({
        httpMethod: def.httpMethod,
        fullPath,
        public: def.public,
        authStack: resolvedAuthStack,
        middlewareChain,
        handler: buildHandler(reg.controller, def),
        handlerMethodName: def.handlerMethodName,
        controllerName,
        specificity: computeSpecificity(fullPath),
      });
    }
  }

  if (stackViolations.length > 0) {
    throw new Error(
      `Router: invalid auth stack selection — declared stacks: ${chain.declared}\n${stackViolations.join('\n')}`,
    );
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
