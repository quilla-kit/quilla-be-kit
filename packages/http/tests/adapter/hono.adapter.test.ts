import { NotFoundError } from '@quilla-kit/errors';
import { AsyncExecutionContextProvider } from '@quilla-kit/execution-context';
import { describe, expect, it } from 'vitest';
import { type HonoServeHandle, HonoServer } from '../../src/adapter/hono/hono.server.js';
import { Controller, Get, GetPublic, Post, ValidateRequest } from '../../src/decorator/index.js';
import type { HttpMiddleware } from '../../src/request/http-middleware.type.js';
import type { HttpRequest } from '../../src/request/http-request.interface.js';
import type { HttpResponse } from '../../src/request/http-response.type.js';
import type { AuthMiddlewareStack } from '../../src/router/auth-middleware-stack.type.js';
import { Router } from '../../src/router/router.js';
import type { RequestValidator } from '../../src/validator/request-validator.interface.js';

@Controller('/users')
class UsersController {
  @GetPublic('/healthz')
  async health(_req: HttpRequest): Promise<HttpResponse> {
    return { httpCode: 200, payload: { ok: true } };
  }

  @Get('/:id')
  async show(req: HttpRequest): Promise<HttpResponse> {
    const id = req.getParams().id;
    if (id === 'missing') throw new NotFoundError({ message: 'user not found' });
    return { httpCode: 200, payload: { id } };
  }

  @Post('/')
  @ValidateRequest({ name: 'string' }, ['body'])
  async create(req: HttpRequest): Promise<HttpResponse> {
    const input = req.getValidatedInput<{ name: string }>();
    return { httpCode: 201, payload: { created: input.name } };
  }
}

function buildServer(options: {
  validator?: RequestValidator;
  authMiddlewares?: AuthMiddlewareStack;
}): {
  server: HonoServer;
  fetch: (req: Request) => Promise<Response>;
} {
  const provider = new AsyncExecutionContextProvider();
  const router = new Router({
    controllers: [new UsersController()],
    executionContext: { provider },
    ...(options.authMiddlewares ? { authMiddlewares: options.authMiddlewares } : {}),
  });

  let capturedFetch: ((req: Request) => Promise<Response>) | undefined;
  const noopServe = (app: { fetch: (req: Request) => Promise<Response> }): HonoServeHandle => {
    capturedFetch = (req) => app.fetch(req);
    return { close: async () => {} };
  };

  const server = new HonoServer({
    port: 0,
    router,
    ...(options.validator ? { requestValidator: options.validator } : {}),
    serve: noopServe as never,
  });
  server.bootstrap();
  void server.listen();
  if (!capturedFetch) throw new Error('serve never captured fetch');
  return { server, fetch: capturedFetch };
}

describe('HonoServer adapter', () => {
  it('dispatches GET routes to the matching handler', async () => {
    const { fetch } = buildServer({});
    const res = await fetch(new Request('http://localhost/users/42'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ payload: { id: '42' } });
  });

  it('uses specificity ordering so static paths match before parametric ones', async () => {
    const { fetch } = buildServer({});
    const res = await fetch(new Request('http://localhost/users/healthz'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ payload: { ok: true } });
  });

  it('maps thrown QuillaError to structured HTTP error response', async () => {
    const { fetch } = buildServer({});
    const res = await fetch(new Request('http://localhost/users/missing'));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { name: string; message: string } };
    expect(body.error.name).toBe('NotFoundError');
    expect(body.error.message).toBe('user not found');
  });

  it('runs @ValidateRequest against the injected RequestValidator', async () => {
    const validator: RequestValidator = {
      validate: (_schema, input) => {
        if (typeof (input as { name?: unknown }).name === 'string') {
          return { success: true, data: input };
        }
        return { success: false, error: [{ path: 'name', message: 'required' }] };
      },
    };

    const { fetch } = buildServer({ validator });

    const ok = await fetch(
      new Request('http://localhost/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'alice' }),
      }),
    );
    expect(ok.status).toBe(201);
    expect(await ok.json()).toEqual({ payload: { created: 'alice' } });

    const bad = await fetch(
      new Request('http://localhost/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ notName: 'alice' }),
      }),
    );
    expect(bad.status).toBe(400);
  });

  it('runs the auth stack on non-public routes only, in phase order', async () => {
    const calls: string[] = [];
    const tokenMw: HttpMiddleware = async (_req, next) => {
      calls.push('token');
      await next();
    };
    const sessionMw: HttpMiddleware = async (_req, next) => {
      calls.push('session');
      await next();
    };

    const { fetch } = buildServer({
      authMiddlewares: { tokenVerification: tokenMw, sessionLoad: sessionMw },
    });

    await fetch(new Request('http://localhost/users/42'));
    expect(calls).toEqual(['token', 'session']);

    calls.length = 0;
    await fetch(new Request('http://localhost/users/healthz'));
    expect(calls).toEqual([]);
  });

  it('serves routes without executionContext wired; getExecutionContext throws a clear error when called', async () => {
    let thrown: Error | undefined;

    @Controller('/public')
    class PublicOnlyController {
      @GetPublic('/')
      async root(_req: HttpRequest): Promise<HttpResponse> {
        return { httpCode: 200, payload: { ok: true } };
      }

      @GetPublic('/touches-ctx')
      async touchesCtx(req: HttpRequest): Promise<HttpResponse> {
        try {
          req.getExecutionContext();
        } catch (err) {
          thrown = err as Error;
        }
        return { httpCode: 200 };
      }
    }

    const router = new Router({ controllers: [new PublicOnlyController()] });
    let capturedFetch: ((req: Request) => Promise<Response>) | undefined;
    const server = new HonoServer({
      port: 0,
      router,
      serve: ((app: { fetch: (req: Request) => Promise<Response> }) => {
        capturedFetch = (req) => app.fetch(req);
        return { close: async () => {} };
      }) as never,
    });
    server.bootstrap();
    void server.listen();

    const ok = await capturedFetch?.(new Request('http://localhost/public'));
    expect(ok?.status).toBe(200);

    await capturedFetch?.(new Request('http://localhost/public/touches-ctx'));
    expect(thrown?.message).toMatch(/No ExecutionContext provider wired on Router/);
  });

  it('establishes an execution context for every route via the system middleware', async () => {
    const provider = new AsyncExecutionContextProvider();
    let capturedCorrelationId: string | undefined;

    @Controller('/probe')
    class ProbeController {
      @GetPublic('/')
      async probe(_req: HttpRequest): Promise<HttpResponse> {
        capturedCorrelationId = provider.getContext().correlationId;
        return { httpCode: 200 };
      }
    }

    const router = new Router({
      controllers: [new ProbeController()],
      executionContext: { provider },
    });

    let capturedFetch: ((req: Request) => Promise<Response>) | undefined;
    const server = new HonoServer({
      port: 0,
      router,
      serve: ((app: { fetch: (req: Request) => Promise<Response> }) => {
        capturedFetch = (req) => app.fetch(req);
        return { close: async () => {} };
      }) as never,
    });
    server.bootstrap();
    void server.listen();

    await capturedFetch?.(
      new Request('http://localhost/probe', { headers: { 'x-correlation-id': 'req-42' } }),
    );
    expect(capturedCorrelationId).toBe('req-42');
  });
});
