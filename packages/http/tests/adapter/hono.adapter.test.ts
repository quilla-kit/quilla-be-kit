import { NotFoundError } from '@quilla-be-kit/errors';
import { AsyncExecutionContextProvider } from '@quilla-be-kit/execution-context';
import { describe, expect, it } from 'vitest';
import { type HonoServeHandle, HonoServer } from '../../src/adapter/hono/hono.server.js';
import { Controller, Get, GetPublic, Post, ValidateRequest } from '../../src/decorator/index.js';
import type { HttpMiddleware } from '../../src/request/http-middleware.type.js';
import type { HttpRequest } from '../../src/request/http-request.interface.js';
import type {
  HttpBinaryResponse,
  HttpResponse,
  HttpStreamResponse,
} from '../../src/request/http-response.type.js';
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
  controllers?: readonly object[];
  cors?: { origins: string[] };
}): {
  server: HonoServer;
  fetch: (req: Request) => Promise<Response>;
} {
  const provider = new AsyncExecutionContextProvider();
  const router = new Router({
    controllers: options.controllers ?? [new UsersController()],
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
    ...(options.cors ? { cors: options.cors } : {}),
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

describe('HonoServer CORS', () => {
  it('adds CORS headers to responses from allowed origins', async () => {
    const { fetch } = buildServer({ cors: { origins: ['https://app.example.com'] } });
    const res = await fetch(
      new Request('http://localhost/users/42', {
        headers: { origin: 'https://app.example.com' },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('does not add CORS headers for disallowed origins', async () => {
    const { fetch } = buildServer({ cors: { origins: ['https://app.example.com'] } });
    const res = await fetch(
      new Request('http://localhost/users/42', {
        headers: { origin: 'https://evil.example.com' },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('responds to preflight OPTIONS with 204 and CORS headers', async () => {
    const { fetch } = buildServer({ cors: { origins: ['https://app.example.com'] } });
    const res = await fetch(
      new Request('http://localhost/users/42', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://app.example.com',
          'access-control-request-method': 'POST',
        },
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
    expect(res.headers.get('access-control-allow-methods')).toBeTruthy();
  });

  it('does not add CORS headers when cors option is omitted', async () => {
    const { fetch } = buildServer({});
    const res = await fetch(
      new Request('http://localhost/users/42', {
        headers: { origin: 'https://app.example.com' },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('HonoServer binary and stream responses', () => {
  it('writes binary data with the headers caller provided and no JSON envelope', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

    @Controller('/files')
    class FilesController {
      @GetPublic('/avatar')
      async avatar(_req: HttpRequest): Promise<HttpBinaryResponse> {
        return {
          httpCode: 200,
          headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600' },
          data: bytes,
        };
      }
    }

    const { fetch } = buildServer({ controllers: [new FilesController()] });
    const res = await fetch(new Request('http://localhost/files/avatar'));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    const body = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(body)).toEqual(Array.from(bytes));
  });

  it('streams a ReadableStream body through to the response without buffering', async () => {
    const chunks = ['hello,', 'world\n'];

    @Controller('/files')
    class FilesController {
      @GetPublic('/export')
      async export(_req: HttpRequest): Promise<HttpStreamResponse> {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
          },
        });
        return {
          httpCode: 200,
          headers: {
            'content-type': 'text/csv',
            'content-disposition': 'attachment; filename="report.csv"',
          },
          stream,
        };
      }
    }

    const { fetch } = buildServer({ controllers: [new FilesController()] });
    const res = await fetch(new Request('http://localhost/files/export'));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="report.csv"');
    expect(await res.text()).toBe(chunks.join(''));
  });

  it('does not wrap binary responses in the JSON envelope', async () => {
    @Controller('/files')
    class FilesController {
      @GetPublic('/raw')
      async raw(_req: HttpRequest): Promise<HttpBinaryResponse> {
        return {
          httpCode: 200,
          headers: { 'content-type': 'application/octet-stream' },
          data: new Uint8Array([1, 2, 3]),
        };
      }
    }

    const { fetch } = buildServer({ controllers: [new FilesController()] });
    const res = await fetch(new Request('http://localhost/files/raw'));

    const text = await res.text();
    expect(text).not.toContain('payload');
    expect(text).not.toContain('"data"');
  });
});
