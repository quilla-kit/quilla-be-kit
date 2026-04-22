import { NotFoundError } from '@quilla-kit/errors';
import {
  AsyncExecutionContextProvider,
  executionContextFactory,
} from '@quilla-kit/execution-context';
import { describe, expect, it } from 'vitest';
import { type HonoServeHandle, HonoServer } from '../../src/adapter/hono/hono.server.js';
import { Controller, Get, GetPublic, Post, ValidateRequest } from '../../src/decorator/index.js';
import { executionContextMiddleware } from '../../src/middleware/execution-context.middleware.js';
import type { HttpMiddleware } from '../../src/request/http-middleware.type.js';
import type { HttpRequest } from '../../src/request/http-request.interface.js';
import type { HttpResponse } from '../../src/request/http-response.type.js';
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
  authMiddlewares?: readonly HttpMiddleware[];
}): {
  server: HonoServer;
  fetch: (req: Request) => Promise<Response>;
} {
  const provider = new AsyncExecutionContextProvider();
  const router = new Router({
    controllers: [new UsersController()],
    globalMiddlewares: [executionContextMiddleware({ provider, factory: executionContextFactory })],
    authMiddlewares: options.authMiddlewares ?? [],
  });

  let capturedFetch: ((req: Request) => Promise<Response>) | undefined;
  const noopServe = (app: { fetch: (req: Request) => Promise<Response> }): HonoServeHandle => {
    capturedFetch = (req) => app.fetch(req);
    return { close: async () => {} };
  };

  const server = new HonoServer({
    port: 0,
    router,
    executionContextProvider: provider,
    ...(options.validator ? { requestValidator: options.validator } : {}),
    serve: noopServe as never,
  });
  server.bootstrap();
  // listen() invokes serve() which captures fetch
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

  it('applies auth middlewares to non-public routes only', async () => {
    const authCalls: string[] = [];
    const authMw: HttpMiddleware = async (req, next) => {
      authCalls.push(req.getPath());
      await next();
    };

    const { fetch } = buildServer({ authMiddlewares: [authMw] });

    await fetch(new Request('http://localhost/users/42'));
    expect(authCalls).toEqual(['/users/42']);

    // Public route — auth should NOT fire
    authCalls.length = 0;
    await fetch(new Request('http://localhost/users/healthz'));
    expect(authCalls).toEqual([]);
  });
});
