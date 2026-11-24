import { NotFoundError } from '@quilla-be-kit/errors';
import { AsyncExecutionContextProvider } from '@quilla-be-kit/execution-context';
import { type Logger, NoopLogger } from '@quilla-be-kit/observability';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { type HonoServeHandle, HonoServer } from '../../src/adapter/hono/hono.server.js';
import { Controller, Get, GetPublic, Post, ValidateRequest } from '../../src/decorator/index.js';
import type { ErrorResolver, ResolvedHttpError } from '../../src/error/error-resolver.interface.js';
import { DefaultRequestDeserializer } from '../../src/request/default.deserializer.js';
import { HttpAttributes } from '../../src/request/http-attributes.js';
import type { HttpMiddleware } from '../../src/request/http-middleware.type.js';
import type { HttpRequest } from '../../src/request/http-request.interface.js';
import type {
  HttpBinaryResponse,
  HttpJsonResponse,
  HttpResponse,
  HttpStreamResponse,
} from '../../src/request/http-response.type.js';
import type { ResponseSerializer } from '../../src/request/response-serializer.interface.js';
import type { AuthMiddlewareStack } from '../../src/router/auth-middleware-stack.type.js';
import { Router } from '../../src/router/router.js';
import type { CorsOptions } from '../../src/server/cors.type.js';
import {
  type ErrorLogLevelPolicy,
  defaultErrorLogLevel,
} from '../../src/server/error-log-level.policy.js';
import type { HttpConventions } from '../../src/server/http-conventions.type.js';
import type { RequestValidator } from '../../src/validator/request-validator.interface.js';
import type { ValidatedRequest } from '../../src/validator/validated-request.type.js';
import { createZodRequestValidator } from '../../src/validator/zod.js';

@Controller('/users')
class UsersController {
  @GetPublic('/healthz')
  async health(_req: HttpRequest): Promise<HttpResponse> {
    return { httpCode: 200, payload: { ok: true } };
  }

  @GetPublic('/echo-query')
  async echoQuery(req: HttpRequest): Promise<HttpResponse> {
    return { httpCode: 200, payload: req.getQuery() };
  }

  @Get('/:id')
  async show(req: HttpRequest): Promise<HttpResponse> {
    const id = req.getParams().id;
    if (id === 'missing') throw new NotFoundError({ message: 'user not found' });
    return { httpCode: 200, payload: { id } };
  }

  @Post('/')
  @ValidateRequest({ name: 'string' }, ['body'])
  async create(req: ValidatedRequest<unknown>): Promise<HttpResponse> {
    const input = req.getValidatedInput() as { name: string };
    return { httpCode: 201, payload: { created: input.name } };
  }
}

function buildServer(options: {
  validator?: RequestValidator;
  authStacks?: Readonly<Record<string, AuthMiddlewareStack>>;
  defaultAuthStack?: string;
  controllers?: readonly object[];
  cors?: CorsOptions;
  conventions?: HttpConventions;
  provider?: AsyncExecutionContextProvider;
  logger?: Logger;
  errorLogLevel?: ErrorLogLevelPolicy;
}): {
  server: HonoServer;
  fetch: (req: Request) => Promise<Response>;
} {
  const provider = options.provider ?? new AsyncExecutionContextProvider();
  const router = new Router({
    controllers: options.controllers ?? [new UsersController()],
    executionContext: { provider },
    ...(options.authStacks
      ? { authStacks: options.authStacks, defaultAuthStack: options.defaultAuthStack }
      : {}),
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
    ...(options.conventions ? { conventions: options.conventions } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.errorLogLevel ? { errorLogLevel: options.errorLogLevel } : {}),
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
      authStacks: { bearer: { credentialVerification: tokenMw, sessionLoad: sessionMw } },
      defaultAuthStack: 'bearer',
    });

    await fetch(new Request('http://localhost/users/42'));
    expect(calls).toEqual(['token', 'session']);

    calls.length = 0;
    await fetch(new Request('http://localhost/users/healthz'));
    expect(calls).toEqual([]);
  });

  it('dispatches each route family through only its own auth stack', async () => {
    const calls: string[] = [];
    const record =
      (tag: string): HttpMiddleware =>
      async (_req, next) => {
        calls.push(tag);
        await next();
      };

    @Controller('/human')
    class HumanController {
      @Get('/me')
      async me(_req: HttpRequest): Promise<HttpResponse> {
        return { httpCode: 200, payload: { ok: true } };
      }
      @GetPublic('/healthz')
      async health(_req: HttpRequest): Promise<HttpResponse> {
        return { httpCode: 200, payload: { ok: true } };
      }
    }

    @Controller('/machine', { authStack: 'apiKey' })
    class MachineController {
      @Get('/tools')
      async tools(_req: HttpRequest): Promise<HttpResponse> {
        return { httpCode: 200, payload: { ok: true } };
      }
    }

    const { fetch } = buildServer({
      controllers: [new HumanController(), new MachineController()],
      authStacks: {
        bearer: { credentialVerification: record('bearer') },
        apiKey: { credentialVerification: record('apiKey') },
      },
      defaultAuthStack: 'bearer',
    });

    await fetch(new Request('http://localhost/human/me'));
    expect(calls).toEqual(['bearer']);

    calls.length = 0;
    await fetch(new Request('http://localhost/machine/tools'));
    expect(calls).toEqual(['apiKey']);

    calls.length = 0;
    await fetch(new Request('http://localhost/human/healthz'));
    expect(calls).toEqual([]);
  });

  it('exposes the resolved auth stack name on the request', async () => {
    let observed: string | undefined;

    @Controller('/machine', { authStack: 'apiKey' })
    class MachineController {
      @Get('/tools')
      async tools(req: HttpRequest): Promise<HttpResponse> {
        observed = req.getAttribute<string>(HttpAttributes.AUTH_STACK);
        return { httpCode: 200, payload: { ok: true } };
      }
    }

    const passthrough: HttpMiddleware = async (_req, next) => {
      await next();
    };
    const { fetch } = buildServer({
      controllers: [new MachineController()],
      authStacks: {
        bearer: { credentialVerification: passthrough },
        apiKey: { credentialVerification: passthrough },
      },
      defaultAuthStack: 'bearer',
    });

    await fetch(new Request('http://localhost/machine/tools'));
    expect(observed).toBe('apiKey');
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

  it('exposes ETag by default', async () => {
    const { fetch } = buildServer({ cors: { origins: ['https://app.example.com'] } });
    const res = await fetch(
      new Request('http://localhost/users/42', {
        headers: { origin: 'https://app.example.com' },
      }),
    );
    expect(res.headers.get('access-control-expose-headers')).toBe('ETag');
  });

  it('exposes consumer-supplied headers alongside the default ETag', async () => {
    const { fetch } = buildServer({
      cors: { origins: ['https://app.example.com'], exposeHeaders: ['X-Request-Id'] },
    });
    const res = await fetch(
      new Request('http://localhost/users/42', {
        headers: { origin: 'https://app.example.com' },
      }),
    );
    const exposed = res.headers.get('access-control-expose-headers');
    expect(exposed).toContain('ETag');
    expect(exposed).toContain('X-Request-Id');
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

const fixedErrorResolver = (httpCode: number, message: string): ErrorResolver => ({
  resolve: (): ResolvedHttpError => ({
    httpCode,
    body: { error: { name: 'about:blank', message } },
  }),
});

describe('HonoServer conventions', () => {
  it('reshapes the success envelope via a custom responseSerializer', async () => {
    const dataEnvelope: ResponseSerializer = {
      serialize(r: HttpJsonResponse): unknown {
        if (r.error) return { error: r.error };
        if (r.payload === undefined) return undefined;
        return { data: r.payload };
      },
    };

    const { fetch } = buildServer({ conventions: { responseSerializer: dataEnvelope } });
    const res = await fetch(new Request('http://localhost/users/42'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: '42' } });
  });

  it('reshapes the error body and status via a custom errorResolver', async () => {
    const { fetch } = buildServer({
      conventions: { errorResolver: fixedErrorResolver(422, 'overridden') },
    });
    const res = await fetch(new Request('http://localhost/users/missing'));

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { name: string; message: string } };
    expect(body.error.name).toBe('about:blank');
    expect(body.error.message).toBe('overridden');
  });

  it('answers an unknown route with the kit error shape', async () => {
    const { fetch } = buildServer({});
    const res = await fetch(new Request('http://localhost/nope'));

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({
      error: { name: 'RouteNotFoundError', message: 'Route not found' },
    });
  });

  it('answers a known path under an unregistered method the same way', async () => {
    const { fetch } = buildServer({});
    const res = await fetch(new Request('http://localhost/users/42', { method: 'DELETE' }));

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { name: string } };
    expect(body.error.name).toBe('RouteNotFoundError');
  });

  it('routes the unknown-route response through a custom errorResolver', async () => {
    const { fetch } = buildServer({
      conventions: { errorResolver: fixedErrorResolver(418, 'nope') },
    });
    const res = await fetch(new Request('http://localhost/nope'));

    expect(res.status).toBe(418);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe('nope');
  });

  it('routes error bodies through a custom responseSerializer', async () => {
    const wrapped: ResponseSerializer = {
      serialize: (r: HttpJsonResponse) => ({ failure: r.error }),
    };

    const { fetch } = buildServer({ conventions: { responseSerializer: wrapped } });

    const thrown = await fetch(new Request('http://localhost/users/missing'));
    expect(thrown.status).toBe(404);
    expect(await thrown.json()).toEqual({
      failure: { name: 'NotFoundError', message: 'user not found' },
    });

    const unmatched = await fetch(new Request('http://localhost/nope'));
    expect(await unmatched.json()).toEqual({
      failure: { name: 'RouteNotFoundError', message: 'Route not found' },
    });
  });

  it('emits a bodyless error response when the serializer returns undefined', async () => {
    const empty: ResponseSerializer = { serialize: () => undefined };

    const { fetch } = buildServer({ conventions: { responseSerializer: empty } });
    const res = await fetch(new Request('http://localhost/nope'));

    expect(res.status).toBe(404);
    expect(await res.text()).toBe('');
  });

  it('still applies CORS headers to an unknown route', async () => {
    const { fetch } = buildServer({ cors: { origins: ['https://app.test'] } });
    const res = await fetch(
      new Request('http://localhost/nope', { headers: { Origin: 'https://app.test' } }),
    );

    expect(res.status).toBe(404);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.test');
  });

  it('preserves the default wire shape when conventions are omitted', async () => {
    const { fetch } = buildServer({});
    const res = await fetch(new Request('http://localhost/users/42'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ payload: { id: '42' } });
  });

  it('remaps a consumer dialect onto canonical query keys via requestDeserializer', async () => {
    const { fetch } = buildServer({
      conventions: {
        requestDeserializer: new DefaultRequestDeserializer({
          paginationKeys: { page: 'p', pageSize: 'per_page' },
        }),
      },
    });
    const res = await fetch(
      new Request('http://localhost/users/echo-query?p=2&per_page=50&name=Ada'),
    );

    expect(res.status).toBe(200);
    // handlers (and @ValidateRequest) see canonical page / pageSize.
    expect(await res.json()).toEqual({ payload: { page: '2', pageSize: '50', name: 'Ada' } });
  });

  it('leaves query keys untouched when no requestDeserializer is configured', async () => {
    const { fetch } = buildServer({});
    const res = await fetch(new Request('http://localhost/users/echo-query?page=2&pageSize=50'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ payload: { page: '2', pageSize: '50' } });
  });
});

describe('HonoServer session keys', () => {
  const passthrough: HttpMiddleware = async (_req, next) => {
    await next();
  };
  const loadSession =
    (provider: AsyncExecutionContextProvider, session: Record<string, string>): HttpMiddleware =>
    async (_req, next) => {
      await provider.runWithContext(
        {
          ...provider.getContext(),
          actorType: 'user',
          session: session as { scopeId: string; userId: string },
        },
        next,
      );
    };

  const ListSchema = z.object({ projectId: z.string() });

  @Controller('/documents')
  class HumanDocuments {
    @Get('/')
    @ValidateRequest(ListSchema, ['query'])
    async list(req: ValidatedRequest<typeof ListSchema>): Promise<HttpResponse> {
      return { httpCode: 200, payload: req.getValidatedInput() };
    }
  }

  @Controller('/machine/documents', { authStack: 'apiKey' })
  class MachineDocuments {
    @Get('/')
    @ValidateRequest(ListSchema, ['query'])
    async list(req: ValidatedRequest<typeof ListSchema>): Promise<HttpResponse> {
      return { httpCode: 200, payload: req.getValidatedInput() };
    }
  }

  function build(machineSession: Record<string, string>) {
    const provider = new AsyncExecutionContextProvider();
    return buildServer({
      provider,
      validator: createZodRequestValidator(),
      controllers: [new HumanDocuments(), new MachineDocuments()],
      authStacks: {
        bearer: {
          credentialVerification: passthrough,
          sessionLoad: loadSession(provider, { scopeId: 's-1', userId: 'u-1' }),
        },
        apiKey: {
          credentialVerification: passthrough,
          sessionLoad: loadSession(provider, machineSession),
          sessionKeys: ['projectId'],
        },
      },
      defaultAuthStack: 'bearer',
    });
  }

  it('injects a stack session key on its routes and keeps it as client input on other stacks', async () => {
    const { fetch } = build({ scopeId: 's-1', userId: 'u-1', projectId: 'bound-project' });

    const machine = await fetch(
      new Request('http://localhost/machine/documents?projectId=other-project'),
    );
    expect(await machine.json()).toEqual({ payload: { projectId: 'bound-project' } });

    const human = await fetch(new Request('http://localhost/documents?projectId=chosen-project'));
    expect(await human.json()).toEqual({ payload: { projectId: 'chosen-project' } });
  });

  it('answers 500 with a generic body when the session lacks a declared key', async () => {
    const { fetch } = build({ scopeId: 's-1', userId: 'u-1' });

    const res = await fetch(new Request('http://localhost/machine/documents?projectId=p'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { name: 'InternalError', message: 'Internal server error' },
    });
  });
});

describe('HttpRequest.getContext', () => {
  it('returns the resolved context view inside a session-loaded route', async () => {
    const provider = new AsyncExecutionContextProvider();
    let view: unknown;

    @Controller('/me')
    class MeController {
      @Get('/')
      async me(req: HttpRequest): Promise<HttpResponse> {
        view = req.getContext();
        return { httpCode: 200 };
      }
    }

    const { fetch } = buildServer({
      provider,
      controllers: [new MeController()],
      authStacks: {
        bearer: {
          credentialVerification: async (_req, next) => {
            await next();
          },
          sessionLoad: async (_req, next) => {
            await provider.runWithContext(
              {
                ...provider.getContext(),
                actorType: 'user',
                session: { scopeId: 's-1', userId: 'u-1' },
              },
              next,
            );
          },
        },
      },
      defaultAuthStack: 'bearer',
    });

    await fetch(new Request('http://localhost/me'));
    expect(view).toMatchObject({
      actorType: 'user',
      scopeId: 's-1',
      userId: 'u-1',
      session: { scopeId: 's-1', userId: 'u-1' },
    });
  });
});

@Controller('/boom')
class FailingController {
  @GetPublic('/')
  async fail(_req: HttpRequest): Promise<HttpResponse> {
    throw new Error('database unreachable');
  }
}

function spyLogger() {
  const logger = new NoopLogger();
  const spies = {
    debug: vi.spyOn(logger, 'debug'),
    info: vi.spyOn(logger, 'info'),
    warn: vi.spyOn(logger, 'warn'),
    error: vi.spyOn(logger, 'error'),
  };
  const httpErrorCalls = (level: keyof typeof spies, message = 'HTTP error') =>
    spies[level].mock.calls.filter(([logged]) => logged === message);
  const allHttpErrorCalls = () =>
    (Object.keys(spies) as (keyof typeof spies)[]).flatMap((level) => httpErrorCalls(level));
  return { logger, httpErrorCalls, allHttpErrorCalls };
}

const getMissingUser = (fetch: (req: Request) => Promise<Response>) =>
  fetch(new Request('http://localhost/users/missing'));

describe('HonoServer error logging', () => {
  it('logs a 4xx at warn with name, message and code but no error object', async () => {
    const { logger, httpErrorCalls } = spyLogger();
    const { fetch } = buildServer({ logger });

    const res = await getMissingUser(fetch);

    expect(res.status).toBe(404);
    expect(httpErrorCalls('warn')).toEqual([
      [
        'HTTP error',
        {
          meta: {
            httpCode: 404,
            error: { name: 'NotFoundError', message: 'user not found', code: 'NOT_FOUND' },
          },
        },
      ],
    ]);
    expect(httpErrorCalls('error')).toEqual([]);
  });

  it('keeps validation details out of the 4xx entry', async () => {
    const { logger, httpErrorCalls } = spyLogger();
    const validator: RequestValidator = {
      validate: () => ({ success: false, error: [{ path: 'name', message: 'required' }] }),
    };
    const { fetch } = buildServer({ logger, validator });

    const res = await fetch(
      new Request('http://localhost/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'secret-input' }),
      }),
    );

    expect(res.status).toBe(400);
    const calls = httpErrorCalls('warn');
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0])).not.toContain('required');
    expect(JSON.stringify(calls[0])).not.toContain('issues');
  });

  it('logs a 5xx at error with the thrown error', async () => {
    const { logger, httpErrorCalls } = spyLogger();
    const { fetch } = buildServer({ logger, controllers: [new FailingController()] });

    const res = await fetch(new Request('http://localhost/boom'));

    expect(res.status).toBe(500);
    expect(httpErrorCalls('error')).toEqual([
      [
        'HTTP error',
        expect.objectContaining({ message: 'database unreachable' }),
        { meta: { httpCode: 500 } },
      ],
    ]);
    expect(httpErrorCalls('warn')).toEqual([]);
  });

  it('never logs an unknown route nor consults the policy', async () => {
    const { logger, allHttpErrorCalls } = spyLogger();
    const errorLogLevel = vi.fn(defaultErrorLogLevel);
    const { fetch } = buildServer({ logger, errorLogLevel });

    const res = await fetch(new Request('http://localhost/wp-admin'));

    expect(res.status).toBe(404);
    expect(allHttpErrorCalls()).toEqual([]);
    expect(errorLogLevel).not.toHaveBeenCalled();
  });

  it('skips logging when the policy returns off', async () => {
    const { logger, allHttpErrorCalls } = spyLogger();
    const { fetch } = buildServer({ logger, errorLogLevel: () => 'off' });

    await getMissingUser(fetch);

    expect(allHttpErrorCalls()).toEqual([]);
  });

  it('logs at the level the policy returns', async () => {
    const { logger, httpErrorCalls } = spyLogger();
    const { fetch } = buildServer({
      logger,
      errorLogLevel: (resolved, err) =>
        resolved.httpCode === 404 ? 'info' : defaultErrorLogLevel(resolved, err),
    });

    await getMissingUser(fetch);

    expect(httpErrorCalls('info')).toHaveLength(1);
    expect(httpErrorCalls('warn')).toEqual([]);
  });

  it('passes the full error when the policy raises a 4xx to error', async () => {
    const { logger, httpErrorCalls } = spyLogger();
    const { fetch } = buildServer({ logger, errorLogLevel: () => 'error' });

    await getMissingUser(fetch);

    expect(httpErrorCalls('error')).toEqual([
      ['HTTP error', expect.any(NotFoundError), { meta: { httpCode: 404 } }],
    ]);
  });

  it('hands the policy the status a custom errorResolver resolved', async () => {
    const { logger, httpErrorCalls } = spyLogger();
    const errorLogLevel = vi.fn(defaultErrorLogLevel);
    const { fetch } = buildServer({
      logger,
      errorLogLevel,
      conventions: { errorResolver: fixedErrorResolver(503, 'down') },
    });

    const res = await getMissingUser(fetch);

    expect(res.status).toBe(503);
    expect(errorLogLevel).toHaveBeenCalledTimes(1);
    expect(errorLogLevel.mock.calls[0]?.[0].httpCode).toBe(503);
    expect(errorLogLevel.mock.calls[0]?.[1]).toBeInstanceOf(NotFoundError);
    expect(httpErrorCalls('error')).toHaveLength(1);
  });

  it('falls back to the default level when the policy throws, keeping the response', async () => {
    const { logger, httpErrorCalls } = spyLogger();
    const policyFailure = new Error('policy bug');
    const errorLogLevel = vi.fn<ErrorLogLevelPolicy>(() => {
      throw policyFailure;
    });
    const { fetch } = buildServer({ logger, errorLogLevel });

    const res = await getMissingUser(fetch);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { name: 'NotFoundError', message: 'user not found' },
    });
    expect(errorLogLevel).toHaveBeenCalledTimes(1);
    expect(httpErrorCalls('error', 'HTTP error log policy failed')).toEqual([
      ['HTTP error log policy failed', policyFailure, { meta: { httpCode: 404 } }],
    ]);
    expect(httpErrorCalls('warn')).toHaveLength(1);
  });

  it('falls back to the default level when the policy returns an unknown level', async () => {
    const { logger, httpErrorCalls } = spyLogger();
    const { fetch } = buildServer({
      logger,
      errorLogLevel: () => 'fatal' as unknown as 'error',
    });

    const res = await getMissingUser(fetch);

    expect(res.status).toBe(404);
    expect(httpErrorCalls('warn')).toHaveLength(1);
  });

  it('answers a generic 500 once when the errorResolver throws', async () => {
    const { logger, httpErrorCalls } = spyLogger();
    const resolverFailure = new Error('resolver bug');
    const resolve = vi.fn((): ResolvedHttpError => {
      throw resolverFailure;
    });
    const { fetch } = buildServer({
      logger,
      cors: { origins: ['http://app.test'] },
      conventions: { errorResolver: { resolve } },
    });

    const res = await getMissingUser(fetch);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { name: 'InternalError', message: 'Internal server error' },
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(httpErrorCalls('error', 'HTTP error handling failed')).toEqual([
      ['HTTP error handling failed', resolverFailure, { meta: { httpCode: 500 } }],
    ]);
    expect(httpErrorCalls('error')).toEqual([
      ['HTTP error', expect.any(NotFoundError), { meta: { httpCode: 500 } }],
    ]);
  });

  it('answers a generic 500 once when the responseSerializer throws on an error body', async () => {
    const { logger, httpErrorCalls } = spyLogger();
    const serialize = vi.fn((r: HttpJsonResponse): unknown => {
      if (r.error) throw new Error('serializer bug');
      return r.payload;
    });
    const { fetch } = buildServer({ logger, conventions: { responseSerializer: { serialize } } });

    const res = await getMissingUser(fetch);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { name: 'InternalError', message: 'Internal server error' },
    });
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(httpErrorCalls('error', 'HTTP error handling failed')).toHaveLength(1);
    expect(httpErrorCalls('error')).toHaveLength(1);
  });
});
