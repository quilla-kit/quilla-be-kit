import { describe, expect, it } from 'vitest';
import { Controller, Get, GetPublic, Post } from '../../src/decorator/index.js';
import type { HttpMiddleware } from '../../src/request/http-middleware.type.js';
import type { HttpRequest } from '../../src/request/http-request.interface.js';
import type { HttpResponse } from '../../src/request/http-response.type.js';
import { Router } from '../../src/router/router.js';

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
      const router = new Router({ controllers: [new UsersController()] });
      const paths = router.getRoutes().map((r) => r.fullPath);
      expect(paths).toContain('/users');
      expect(paths).toContain('/users/:id');
      expect(paths).toContain('/users/healthz');
    });

    it('combines registration prefix + controller prefix + route path', () => {
      const router = new Router({
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
        controllers: [{ controller: new ThingController(), prefix: '/api/' }],
      });
      const paths = router.getRoutes().map((r) => r.fullPath);
      expect(paths).toEqual(['/api/thing']);
    });
  });

  describe('specificity ordering', () => {
    it('sorts more-specific routes before less-specific ones', () => {
      const router = new Router({ controllers: [new UsersController()] });
      const paths = router.getRoutes().map((r) => r.fullPath);
      // '/users/healthz' is fully static → higher specificity than '/users/:id'
      expect(paths.indexOf('/users/healthz')).toBeLessThan(paths.indexOf('/users/:id'));
    });

    it('longer path wins when specificity ties', () => {
      const router = new Router({ controllers: [new DocsController()] });
      const paths = router.getRoutes().map((r) => r.fullPath);
      expect(paths).toEqual(['/docs/:id/sections/:section']);
    });
  });

  describe('middlewares', () => {
    it('carries global + auth middlewares through to the Router', () => {
      const globalMw: HttpMiddleware = async (_req, next) => {
        await next();
      };
      const authMw: HttpMiddleware = async (_req, next) => {
        await next();
      };
      const router = new Router({
        controllers: [new UsersController()],
        globalMiddlewares: [globalMw],
        authMiddlewares: [authMw],
      });
      expect(router.getGlobalMiddlewares()).toEqual([globalMw]);
      expect(router.getAuthMiddlewares()).toEqual([authMw]);
    });

    it('carries per-controller middlewares into each route', () => {
      const moduleLocalMw: HttpMiddleware = async (_req, next) => {
        await next();
      };
      const router = new Router({
        controllers: [{ controller: new UsersController(), middlewares: [moduleLocalMw] }],
      });
      const routes = router.getRoutes();
      expect(routes.every((r) => r.middlewares.includes(moduleLocalMw))).toBe(true);
    });
  });

  describe('module bridge', () => {
    it('composes module prefix + module middlewares into routes', () => {
      const moduleMw: HttpMiddleware = async (_req, next) => {
        await next();
      };
      const router = new Router({
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
      expect(routes.every((r) => r.middlewares.includes(moduleMw))).toBe(true);
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
      expect(() => new Router({ controllers: [new A(), new B()] })).toThrow(/Duplicate route/);
    });
  });
});
