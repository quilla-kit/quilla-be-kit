import { AsyncExecutionContextProvider } from '@quilla-be-kit/execution-context';
import { describe, expect, it } from 'vitest';
import { Controller, Get, GetPublic, Post } from '../../src/decorator/index.js';
import type { HttpMiddleware } from '../../src/request/http-middleware.type.js';
import type { HttpRequest } from '../../src/request/http-request.interface.js';
import type { HttpResponse } from '../../src/request/http-response.type.js';
import type { AuthMiddlewareStack } from '../../src/router/auth-middleware-stack.type.js';
import { Router } from '../../src/router/router.js';

function makeExecutionContext(): { provider: AsyncExecutionContextProvider } {
  return { provider: new AsyncExecutionContextProvider() };
}

@Controller('/users')
class UsersController {
  @Get('/')
  async list(_req: HttpRequest): Promise<HttpResponse> {
    return { httpCode: 200 };
  }
  @Get('/:id')
  async show(_req: HttpRequest): Promise<HttpResponse> {
    return { httpCode: 200 };
  }
  @Post('/')
  async create(_req: HttpRequest): Promise<HttpResponse> {
    return { httpCode: 201 };
  }
  @GetPublic('/healthz')
  async health(_req: HttpRequest): Promise<HttpResponse> {
    return { httpCode: 200 };
  }
}

@Controller('/docs')
class DocsController {
  @Get('/:id/sections/:section')
  async show(_req: HttpRequest): Promise<HttpResponse> {
    return { httpCode: 200 };
  }
}

describe('Router', () => {
  describe('path composition', () => {
    it('combines controller prefix with route path', () => {
      const router = new Router({
        executionContext: makeExecutionContext(),
        controllers: [new UsersController()],
      });
      const paths = router.getRoutes().map((r) => r.fullPath);
      expect(paths).toContain('/users');
      expect(paths).toContain('/users/:id');
      expect(paths).toContain('/users/healthz');
    });

    it('combines registration prefix + controller prefix + route path', () => {
      const router = new Router({
        executionContext: makeExecutionContext(),
        controllers: [{ controller: new UsersController(), prefix: '/api/v1' }],
      });
      const paths = router.getRoutes().map((r) => r.fullPath);
      expect(paths).toContain('/api/v1/users');
      expect(paths).toContain('/api/v1/users/:id');
    });

    it('strips duplicate and trailing slashes', () => {
      @Controller('/thing/')
      class ThingController {
        @Get('/')
        async list(_req: HttpRequest): Promise<HttpResponse> {
          return { httpCode: 200 };
        }
      }

      const router = new Router({
        executionContext: makeExecutionContext(),
        controllers: [{ controller: new ThingController(), prefix: '/api/' }],
      });
      const paths = router.getRoutes().map((r) => r.fullPath);
      expect(paths).toEqual(['/api/thing']);
    });
  });

  describe('specificity ordering', () => {
    it('sorts more-specific routes before less-specific ones', () => {
      const router = new Router({
        executionContext: makeExecutionContext(),
        controllers: [new UsersController()],
      });
      const paths = router.getRoutes().map((r) => r.fullPath);
      expect(paths.indexOf('/users/healthz')).toBeLessThan(paths.indexOf('/users/:id'));
    });

    it('longer path wins when specificity ties', () => {
      const router = new Router({
        executionContext: makeExecutionContext(),
        controllers: [new DocsController()],
      });
      const paths = router.getRoutes().map((r) => r.fullPath);
      expect(paths).toEqual(['/docs/:id/sections/:section']);
    });
  });

  describe('middlewareChain composition', () => {
    it('composes [system, globals, auth, module, registration] for non-public routes', () => {
      const globalMw: HttpMiddleware = async (_req, next) => {
        await next();
      };
      const tokenMw: HttpMiddleware = async (_req, next) => {
        await next();
      };
      const sessionMw: HttpMiddleware = async (_req, next) => {
        await next();
      };
      const authStack: AuthMiddlewareStack = {
        tokenVerification: tokenMw,
        sessionLoad: sessionMw,
      };

      const router = new Router({
        executionContext: makeExecutionContext(),
        controllers: [new UsersController()],
        globalMiddlewares: [globalMw],
        authMiddlewares: authStack,
      });

      const showRoute = router.getRoutes().find((r) => r.fullPath === '/users/:id');
      expect(showRoute).toBeDefined();
      // chain: [system, global, token, session]
      expect(showRoute?.middlewareChain).toHaveLength(4);
      expect(showRoute?.middlewareChain[1]).toBe(globalMw);
      expect(showRoute?.middlewareChain[2]).toBe(tokenMw);
      expect(showRoute?.middlewareChain[3]).toBe(sessionMw);
    });

    it('omits the auth phase for public routes', () => {
      const tokenMw: HttpMiddleware = async (_req, next) => {
        await next();
      };
      const router = new Router({
        executionContext: makeExecutionContext(),
        controllers: [new UsersController()],
        authMiddlewares: { tokenVerification: tokenMw },
      });

      const publicRoute = router.getRoutes().find((r) => r.fullPath === '/users/healthz');
      expect(publicRoute?.public).toBe(true);
      expect(publicRoute?.middlewareChain).not.toContain(tokenMw);
    });

    it('orders auth phases: tokenVerification → sessionLoad, regardless of key declaration', () => {
      const tokenMw: HttpMiddleware = async (_req, next) => {
        await next();
      };
      const sessionMw: HttpMiddleware = async (_req, next) => {
        await next();
      };
      const router = new Router({
        executionContext: makeExecutionContext(),
        controllers: [new UsersController()],
        authMiddlewares: { sessionLoad: sessionMw, tokenVerification: tokenMw },
      });

      const showRoute = router.getRoutes().find((r) => r.fullPath === '/users/:id');
      const tokenIdx = showRoute?.middlewareChain.indexOf(tokenMw) ?? -1;
      const sessionIdx = showRoute?.middlewareChain.indexOf(sessionMw) ?? -1;
      expect(tokenIdx).toBeGreaterThanOrEqual(0);
      expect(sessionIdx).toBeGreaterThan(tokenIdx);
    });

    it('carries per-controller middlewares after the auth phase', () => {
      const localMw: HttpMiddleware = async (_req, next) => {
        await next();
      };
      const router = new Router({
        executionContext: makeExecutionContext(),
        controllers: [{ controller: new UsersController(), middlewares: [localMw] }],
      });

      const routes = router.getRoutes();
      expect(routes.every((r) => r.middlewareChain.includes(localMw))).toBe(true);
    });
  });

  describe('execution context bootstrap', () => {
    it('exposes the configured provider', () => {
      const ec = makeExecutionContext();
      const router = new Router({ executionContext: ec, controllers: [new UsersController()] });
      expect(router.getExecutionContextProvider()).toBe(ec.provider);
    });

    it('the system bootstrap reads the inbound correlation id and establishes context', async () => {
      const ec = makeExecutionContext();
      const router = new Router({ executionContext: ec, controllers: [new UsersController()] });
      const [chain] = router.getRoutes().map((r) => r.middlewareChain);
      const system = chain?.[0];
      if (!system) throw new Error('system middleware should head the chain');

      let observedCorrelationId: string | undefined;
      await system(
        {
          getHeader: (name: string) => (name === 'x-correlation-id' ? 'abc-123' : null),
        } as unknown as HttpRequest,
        async () => {
          observedCorrelationId = ec.provider.getContext().correlationId;
        },
      );
      expect(observedCorrelationId).toBe('abc-123');
    });

    it('the system bootstrap generates a correlation id when the header is absent', async () => {
      const ec = makeExecutionContext();
      const router = new Router({ executionContext: ec, controllers: [new UsersController()] });
      const [chain] = router.getRoutes().map((r) => r.middlewareChain);
      const system = chain?.[0];
      if (!system) throw new Error('system middleware should head the chain');

      let observedCorrelationId: string | undefined;
      await system({ getHeader: () => null } as unknown as HttpRequest, async () => {
        observedCorrelationId = ec.provider.getContext().correlationId;
      });
      expect(observedCorrelationId).toBeDefined();
      expect(observedCorrelationId).not.toBe('');
    });

    it('executionContext is optional — Router skips the system bootstrap when not configured', () => {
      const router = new Router({ controllers: [new UsersController()] });
      expect(router.getExecutionContextProvider()).toBeUndefined();
      for (const route of router.getRoutes()) {
        expect(route.middlewareChain).toHaveLength(0);
      }
    });

    it('throws at construction when authMiddlewares is set but executionContext is not', () => {
      const tokenMw: HttpMiddleware = async (_req, next) => {
        await next();
      };
      expect(
        () =>
          new Router({
            controllers: [new UsersController()],
            authMiddlewares: { tokenVerification: tokenMw },
          }),
      ).toThrow(/authMiddlewares.*requires.*executionContext/);
    });
  });

  describe('module bridge', () => {
    it('composes module prefix + module middlewares into routes', () => {
      const moduleMw: HttpMiddleware = async (_req, next) => {
        await next();
      };
      const router = new Router({
        executionContext: makeExecutionContext(),
        modules: [
          {
            name: 'iam',
            meta: {
              prefix: '/api/v1',
              middlewares: [moduleMw],
              controllers: [new UsersController()],
            },
          },
        ],
      });
      const routes = router.getRoutes();
      expect(routes.map((r) => r.fullPath)).toEqual(
        expect.arrayContaining(['/api/v1/users', '/api/v1/users/:id']),
      );
      expect(routes.every((r) => r.middlewareChain.includes(moduleMw))).toBe(true);
    });
  });

  describe('duplicate detection', () => {
    it('throws when two routes collide on method + path', () => {
      @Controller('/x')
      class A {
        @Get('/')
        async get(_req: HttpRequest): Promise<HttpResponse> {
          return { httpCode: 200 };
        }
      }
      @Controller('/x')
      class B {
        @Get('/')
        async getAgain(_req: HttpRequest): Promise<HttpResponse> {
          return { httpCode: 200 };
        }
      }
      expect(
        () =>
          new Router({
            executionContext: makeExecutionContext(),
            controllers: [new A(), new B()],
          }),
      ).toThrow(/Duplicate route/);
    });
  });

  describe('versioning', () => {
    it('inserts a module version resource-first: prefix + version + controller + path', () => {
      @Controller('/auth')
      class AuthController {
        @Get('/:id')
        async show(_req: HttpRequest): Promise<HttpResponse> {
          return { httpCode: 200 };
        }
      }
      const router = new Router({
        executionContext: makeExecutionContext(),
        modules: [
          {
            name: 'iam',
            meta: { prefix: '/iam', version: '/api/v1', controllers: [new AuthController()] },
          },
        ],
      });
      expect(router.getRoutes().map((r) => r.fullPath)).toEqual(['/iam/api/v1/auth/:id']);
    });

    it('applies a @Controller version as the default for every route on the class', () => {
      @Controller('/auth', { version: '/api/v1' })
      class AuthController {
        @Get('/:id')
        async show(_req: HttpRequest): Promise<HttpResponse> {
          return { httpCode: 200 };
        }
        @GetPublic('/healthz')
        async health(_req: HttpRequest): Promise<HttpResponse> {
          return { httpCode: 200 };
        }
      }
      const router = new Router({
        executionContext: makeExecutionContext(),
        controllers: [new AuthController()],
      });
      expect(
        router
          .getRoutes()
          .map((r) => r.fullPath)
          .sort(),
      ).toEqual(['/api/v1/auth/:id', '/api/v1/auth/healthz']);
    });

    it('lets a per-route version override the default for that route only', () => {
      @Controller('/auth', { version: '/api/v1' })
      class AuthController {
        @Get('/:id')
        async show(_req: HttpRequest): Promise<HttpResponse> {
          return { httpCode: 200 };
        }
        @Get('/:id', { version: '/api/v2' })
        async showV2(_req: HttpRequest): Promise<HttpResponse> {
          return { httpCode: 200 };
        }
      }
      const router = new Router({
        executionContext: makeExecutionContext(),
        controllers: [new AuthController()],
      });
      expect(
        router
          .getRoutes()
          .map((r) => r.fullPath)
          .sort(),
      ).toEqual(['/api/v1/auth/:id', '/api/v2/auth/:id']);
    });

    it('resolves precedence route > controller > module', () => {
      @Controller('/auth', { version: '/api/v2' })
      class AuthController {
        @Get('/a')
        async a(_req: HttpRequest): Promise<HttpResponse> {
          return { httpCode: 200 };
        }
        @Get('/b', { version: '/api/v3' })
        async b(_req: HttpRequest): Promise<HttpResponse> {
          return { httpCode: 200 };
        }
      }
      @Controller('/pub')
      class PubController {
        @Get('/c')
        async c(_req: HttpRequest): Promise<HttpResponse> {
          return { httpCode: 200 };
        }
      }
      const router = new Router({
        executionContext: makeExecutionContext(),
        modules: [
          {
            name: 'iam',
            meta: {
              prefix: '/iam',
              version: '/api/v1',
              controllers: [new AuthController(), new PubController()],
            },
          },
        ],
      });
      expect(
        router
          .getRoutes()
          .map((r) => r.fullPath)
          .sort(),
      ).toEqual(['/iam/api/v1/pub/c', '/iam/api/v2/auth/a', '/iam/api/v3/auth/b']);
    });

    it('normalizes a version segment with no leading slash (no double slash)', () => {
      @Controller('/auth', { version: 'api/v1' })
      class AuthController {
        @Get('/:id')
        async show(_req: HttpRequest): Promise<HttpResponse> {
          return { httpCode: 200 };
        }
      }
      const router = new Router({
        executionContext: makeExecutionContext(),
        modules: [{ name: 'iam', meta: { prefix: '/iam/', controllers: [new AuthController()] } }],
      });
      expect(router.getRoutes().map((r) => r.fullPath)).toEqual(['/iam/api/v1/auth/:id']);
    });

    it('produces byte-identical paths when no version is set anywhere', () => {
      @Controller('/auth')
      class AuthController {
        @Get('/:id')
        async show(_req: HttpRequest): Promise<HttpResponse> {
          return { httpCode: 200 };
        }
      }
      const router = new Router({
        executionContext: makeExecutionContext(),
        controllers: [{ controller: new AuthController(), prefix: '/api' }],
      });
      expect(router.getRoutes().map((r) => r.fullPath)).toEqual(['/api/auth/:id']);
    });

    it('keeps version orthogonal to *Public — a versioned public route stays public', () => {
      @Controller('/auth', { version: '/api/v1' })
      class AuthController {
        @GetPublic('/healthz')
        async health(_req: HttpRequest): Promise<HttpResponse> {
          return { httpCode: 200 };
        }
      }
      const router = new Router({
        executionContext: makeExecutionContext(),
        controllers: [new AuthController()],
      });
      const route = router.getRoutes().find((r) => r.fullPath === '/api/v1/auth/healthz');
      expect(route?.public).toBe(true);
    });

    it('treats version-differentiated routes as distinct (no false duplicate)', () => {
      @Controller('/auth', { version: '/api/v1' })
      class AuthController {
        @Get('/:id')
        async show(_req: HttpRequest): Promise<HttpResponse> {
          return { httpCode: 200 };
        }
        @Get('/:id', { version: '/api/v2' })
        async showV2(_req: HttpRequest): Promise<HttpResponse> {
          return { httpCode: 200 };
        }
      }
      expect(
        () =>
          new Router({
            executionContext: makeExecutionContext(),
            controllers: [new AuthController()],
          }),
      ).not.toThrow();
    });

    it('still detects a duplicate when two routes resolve to the same versioned path', () => {
      @Controller('/auth', { version: '/api/v1' })
      class AuthController {
        @Get('/:id')
        async show(_req: HttpRequest): Promise<HttpResponse> {
          return { httpCode: 200 };
        }
        @Get('/:id', { version: '/api/v1' })
        async showAgain(_req: HttpRequest): Promise<HttpResponse> {
          return { httpCode: 200 };
        }
      }
      expect(
        () =>
          new Router({
            executionContext: makeExecutionContext(),
            controllers: [new AuthController()],
          }),
      ).toThrow(/Duplicate route/);
    });
  });
});
