import type { Logger } from '@quilla-be-kit/observability';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { cors } from 'hono/cors';
import { DefaultErrorResolver } from '../../error/default.resolver.js';
import type { ErrorResolver, ResolvedHttpError } from '../../error/error-resolver.interface.js';
import { RouteNotFoundError } from '../../error/route-not-found.error.js';
import { DefaultRequestDeserializer } from '../../request/default.deserializer.js';
import { DefaultResponseSerializer } from '../../request/default.serializer.js';
import { HttpAttributes } from '../../request/http-attributes.js';
import type { NormalizedRoute } from '../../router/normalized-route.type.js';
import type { Router } from '../../router/router.js';
import type { CorsOptions } from '../../server/cors.type.js';
import {
  type ErrorLogLevelPolicy,
  defaultErrorLogLevel,
  logHttpError,
} from '../../server/error-log-level.policy.js';
import type { HttpConventions } from '../../server/http-conventions.type.js';
import type { WebServer } from '../../server/web-server.interface.js';
import type { RequestValidator } from '../../validator/request-validator.interface.js';
import { getRequestAttributes } from './get-request-attributes.js';
import { HonoMiddlewareAdapter } from './hono-middleware.adapter.js';
import { HonoRequestAdapter } from './hono-request.adapter.js';

// Bypasses the configured conventions, which may be what failed.
const FALLBACK_ERROR_BODY = {
  error: { name: 'InternalError', message: 'Internal server error' },
} as const;

export type HonoServeHandle = {
  close(): Promise<void>;
};

export type HonoServeFn = (app: Hono, port: number) => HonoServeHandle;

export type HonoServerOptions = {
  readonly port: number;
  readonly router: Router;
  readonly serve: HonoServeFn;
  readonly requestValidator?: RequestValidator;
  readonly logger?: Logger;
  readonly errorLogLevel?: ErrorLogLevelPolicy;
  readonly cors?: CorsOptions;
  readonly conventions?: HttpConventions;
};

export class HonoServer implements WebServer {
  private readonly app = new Hono();
  private readonly requestAdapter: HonoRequestAdapter;
  private readonly middlewareAdapter: HonoMiddlewareAdapter;
  private readonly errorResolver: ErrorResolver;
  private readonly errorLogLevel: ErrorLogLevelPolicy;
  private bootstrapped = false;
  private handle: HonoServeHandle | undefined;

  constructor(private readonly options: HonoServerOptions) {
    this.errorResolver = options.conventions?.errorResolver ?? new DefaultErrorResolver();
    this.errorLogLevel = options.errorLogLevel ?? defaultErrorLogLevel;
    const responseSerializer =
      options.conventions?.responseSerializer ?? new DefaultResponseSerializer();
    const requestDeserializer =
      options.conventions?.requestDeserializer ?? new DefaultRequestDeserializer();
    this.requestAdapter = new HonoRequestAdapter(
      options.router.getExecutionContextProvider(),
      responseSerializer,
      requestDeserializer,
    );
    this.middlewareAdapter = new HonoMiddlewareAdapter(this.requestAdapter);
  }

  bootstrap(): void {
    if (this.bootstrapped) return;
    this.bootstrapped = true;

    // Must never throw: Hono re-enters onError once per middleware layer a
    // throw crosses, so a failing resolver or serializer would otherwise run
    // repeatedly and leave the response to the runtime.
    this.app.onError((err, c) => {
      try {
        const resolved = this.errorResolver.resolve(err);
        const response = this.renderError(c, resolved);
        if (this.options.logger)
          logHttpError(this.options.logger, this.errorLogLevel, err, resolved);
        return response;
      } catch (handlingError) {
        const meta = { httpCode: 500 };
        this.options.logger?.error('HTTP error handling failed', handlingError, { meta });
        this.options.logger?.error('HTTP error', err, { meta });
        return c.json(FALLBACK_ERROR_BODY, 500);
      }
    });

    // An unmatched route is the one response no handler produces; resolving it
    // like any other error keeps it on the configured conventions rather than
    // Hono's plain-text default. It is never logged.
    this.app.notFound((c) =>
      this.renderError(c, this.errorResolver.resolve(new RouteNotFoundError())),
    );

    if (this.options.cors) {
      const { origins, exposeHeaders } = this.options.cors;
      this.app.use(
        '*',
        cors({
          origin: (origin) => (origins.includes(origin) ? origin : null),
          allowMethods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
          allowHeaders: ['Content-Type', 'Authorization', 'If-Match', 'ETag'],
          exposeHeaders: [...new Set(['ETag', ...(exposeHeaders ?? [])])],
          credentials: true,
          maxAge: 86400,
        }),
      );
    }

    const validator = this.options.requestValidator;
    if (validator) {
      this.app.use('*', async (c, next) => {
        const attributes = getRequestAttributes(c);
        attributes.set(HttpAttributes.REQUEST_VALIDATOR, validator);
        await next();
      });
    }

    for (const route of this.options.router.getRoutes()) {
      this.registerRoute(route);
    }
  }

  async listen(): Promise<void> {
    if (!this.bootstrapped) this.bootstrap();
    this.handle = this.options.serve(this.app, this.options.port);
    this.options.logger?.info('HTTP server listening', { meta: { port: this.options.port } });
  }

  async close(): Promise<void> {
    if (!this.handle) return;
    await this.handle.close();
    this.handle = undefined;
    this.options.logger?.info('HTTP server closed');
  }

  private renderError(c: Context, { httpCode, body }: ResolvedHttpError): Response {
    return this.requestAdapter.writeResponse(c, { ...body, httpCode });
  }

  private registerRoute(route: NormalizedRoute): void {
    const stack: Array<(c: Context, next: Next) => Promise<void>> = [];
    for (const mw of route.middlewareChain) {
      stack.push(this.middlewareAdapter.wrap(mw));
    }
    const handler = this.requestAdapter.controller(route.handler);
    const method = route.httpMethod.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
    const register = this.app[method] as (path: string, ...handlers: unknown[]) => unknown;
    register.call(this.app, route.fullPath, ...stack, handler);
  }
}
