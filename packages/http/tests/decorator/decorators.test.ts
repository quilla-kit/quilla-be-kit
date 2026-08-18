import { describe, expect, it } from 'vitest';
import {
  AuthorizeScope,
  Controller,
  Delete,
  Get,
  GetPublic,
  Patch,
  Post,
  PostPublic,
  Put,
  ValidateRequest,
} from '../../src/decorator/index.js';
import {
  getControllerAuthStack,
  getControllerPrefix,
  getControllerRoutes,
  getControllerVersion,
} from '../../src/decorator/route.metadata.js';
import type { HttpRequest } from '../../src/request/http-request.interface.js';
import type { HttpResponse } from '../../src/request/http-response.type.js';

describe('decorators', () => {
  it('@Controller stores prefix in class metadata', () => {
    @Controller('/users')
    class UsersController {}

    const prefix = getControllerPrefix(new UsersController());
    expect(prefix).toBe('/users');
  });

  it('method decorators register routes with correct method + path', () => {
    @Controller('/users')
    class UsersController {
      @Get('/')
      async list(_req: HttpRequest): Promise<HttpResponse> {
        return { httpCode: 200 };
      }
      @Post('/')
      async create(_req: HttpRequest): Promise<HttpResponse> {
        return { httpCode: 201 };
      }
      @Get('/:id')
      async show(_req: HttpRequest): Promise<HttpResponse> {
        return { httpCode: 200 };
      }
      @Put('/:id')
      async update(_req: HttpRequest): Promise<HttpResponse> {
        return { httpCode: 200 };
      }
      @Patch('/:id')
      async patchOne(_req: HttpRequest): Promise<HttpResponse> {
        return { httpCode: 200 };
      }
      @Delete('/:id')
      async remove(_req: HttpRequest): Promise<HttpResponse> {
        return { httpCode: 204 };
      }
    }

    const routes = getControllerRoutes(new UsersController());
    expect(routes.map((r) => `${r.httpMethod} ${r.path}`)).toEqual([
      'GET /',
      'POST /',
      'GET /:id',
      'PUT /:id',
      'PATCH /:id',
      'DELETE /:id',
    ]);
    expect(routes.every((r) => r.public === false)).toBe(true);
  });

  it('@*Public variants flag routes as public', () => {
    @Controller('/auth')
    class AuthController {
      @GetPublic('/healthz')
      async health(_req: HttpRequest): Promise<HttpResponse> {
        return { httpCode: 200 };
      }
      @PostPublic('/login')
      async login(_req: HttpRequest): Promise<HttpResponse> {
        return { httpCode: 200 };
      }
    }

    const routes = getControllerRoutes(new AuthController());
    expect(routes.every((r) => r.public)).toBe(true);
  });

  it('inherits routes from parent controller', () => {
    @Controller('/base')
    class Base {
      @Get('/inherited')
      async inherited(_req: HttpRequest): Promise<HttpResponse> {
        return { httpCode: 200 };
      }
    }

    @Controller('/child')
    class Child extends Base {
      @Get('/own')
      async own(_req: HttpRequest): Promise<HttpResponse> {
        return { httpCode: 200 };
      }
    }

    const routes = getControllerRoutes(new Child());
    // Exact, not `toContain` — a prototype-linked metadata bag used to yield
    // every inherited route twice, which `toContain` cannot detect.
    expect(routes.map((r) => r.path)).toEqual(['/inherited', '/own']);
    // The child's route must not have leaked onto the parent.
    expect(getControllerRoutes(new Base()).map((r) => r.path)).toEqual(['/inherited']);
    // Child prefix wins
    expect(getControllerPrefix(new Child())).toBe('/child');
  });

  it('does not duplicate routes for a subclass with no decorators of its own', () => {
    @Controller('/base')
    class Base {
      @Get('/inherited')
      async inherited(_req: HttpRequest): Promise<HttpResponse> {
        return { httpCode: 200 };
      }
    }

    class Undecorated extends Base {}

    expect(getControllerRoutes(new Undecorated()).map((r) => r.path)).toEqual(['/inherited']);
    expect(getControllerPrefix(new Undecorated())).toBe('/base');
  });

  it('does not duplicate routes across a 3-level chain with an undecorated middle class', () => {
    @Controller('/a')
    class A {
      @Get('/a1')
      async a1(_req: HttpRequest): Promise<HttpResponse> {
        return { httpCode: 200 };
      }
    }

    class B extends A {}

    @Controller('/c')
    class C extends B {
      @Get('/c1')
      async c1(_req: HttpRequest): Promise<HttpResponse> {
        return { httpCode: 200 };
      }
    }

    expect(getControllerRoutes(new C()).map((r) => r.path)).toEqual(['/a1', '/c1']);
    expect(getControllerRoutes(new B()).map((r) => r.path)).toEqual(['/a1']);
  });

  it('does not duplicate a route when a subclass overrides the method without re-decorating', () => {
    @Controller('/base')
    class Base {
      @Get('/thing')
      async thing(_req: HttpRequest): Promise<HttpResponse> {
        return { httpCode: 200 };
      }
    }

    @Controller('/child')
    class Child extends Base {
      override async thing(_req: HttpRequest): Promise<HttpResponse> {
        return { httpCode: 204 };
      }
    }

    expect(getControllerRoutes(new Child()).map((r) => r.path)).toEqual(['/thing']);
  });

  it('stores a per-route version on the route, leaving siblings unversioned', () => {
    @Controller('/auth')
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

    const byName = new Map(
      getControllerRoutes(new AuthController()).map((r) => [r.handlerMethodName, r.version]),
    );
    expect(byName.get('show')).toBeUndefined();
    expect(byName.get('showV2')).toBe('/api/v2');
  });

  it('@Controller version is readable and unset returns undefined', () => {
    @Controller('/auth', { version: '/api/v1' })
    class Versioned {}
    @Controller('/auth')
    class Plain {}

    expect(getControllerVersion(new Versioned())).toBe('/api/v1');
    expect(getControllerVersion(new Plain())).toBeUndefined();
  });

  describe('patch decorators are order-independent', () => {
    it('attaches scope metadata whether @AuthorizeScope sits below or above the method decorator', () => {
      @Controller('/u')
      class C {
        @Get('/below')
        @AuthorizeScope('scope:below')
        async below(_req: HttpRequest): Promise<HttpResponse> {
          return { httpCode: 200 };
        }

        @AuthorizeScope('scope:above', 'all')
        @Get('/above')
        async above(_req: HttpRequest): Promise<HttpResponse> {
          return { httpCode: 200 };
        }
      }

      const byPath = (p: string) => getControllerRoutes(new C()).find((r) => r.path === p);
      expect(byPath('/below')?.scopes).toEqual(['scope:below']);
      expect(byPath('/below')?.scopeMode).toBe('any');
      expect(byPath('/above')?.scopes).toEqual(['scope:above']);
      expect(byPath('/above')?.scopeMode).toBe('all');
    });

    it('attaches validation metadata when @ValidateRequest sits below the method decorator', () => {
      const schema = { name: 'string' };

      @Controller('/u')
      class C {
        @Post('/')
        @ValidateRequest(schema, ['body'])
        async create(_req: HttpRequest): Promise<HttpResponse> {
          return { httpCode: 201 };
        }
      }

      const [route] = getControllerRoutes(new C());
      expect(route?.validation).toEqual({ schema, sources: ['body'] });
    });

    it('merges both patch decorators on one method without clobbering', () => {
      const schema = { name: 'string' };

      @Controller('/u')
      class C {
        @Post('/')
        @AuthorizeScope('user:write')
        @ValidateRequest(schema, ['body'])
        async create(_req: HttpRequest): Promise<HttpResponse> {
          return { httpCode: 201 };
        }
      }

      const [route] = getControllerRoutes(new C());
      expect(route?.scopes).toEqual(['user:write']);
      expect(route?.validation).toEqual({ schema, sources: ['body'] });
    });

    it('applies the patch to every route declared on the same handler', () => {
      @Controller('/u')
      class C {
        @Get('/a')
        @Post('/b')
        @AuthorizeScope('shared')
        async both(_req: HttpRequest): Promise<HttpResponse> {
          return { httpCode: 200 };
        }
      }

      const routes = getControllerRoutes(new C());
      expect(routes).toHaveLength(2);
      expect(routes.every((r) => r.scopes?.[0] === 'shared')).toBe(true);
    });

    it('a subclass patch does not appear on the parent route definitions', () => {
      @Controller('/base')
      class Base {
        @Get('/thing')
        async thing(_req: HttpRequest): Promise<HttpResponse> {
          return { httpCode: 200 };
        }
      }

      @Controller('/child')
      class Child extends Base {
        @AuthorizeScope('child-only')
        override async thing(_req: HttpRequest): Promise<HttpResponse> {
          return { httpCode: 200 };
        }
      }

      expect(getControllerRoutes(new Child())[0]?.scopes).toEqual(['child-only']);
      expect(getControllerRoutes(new Base())[0]?.scopes).toBeUndefined();
    });
  });

  describe('authStack metadata', () => {
    it('stores a per-route authStack, leaving siblings undefined', () => {
      @Controller('/u')
      class C {
        @Get('/scoped', { authStack: 'apiKey' })
        async scoped(_req: HttpRequest): Promise<HttpResponse> {
          return { httpCode: 200 };
        }
        @Get('/plain')
        async plain(_req: HttpRequest): Promise<HttpResponse> {
          return { httpCode: 200 };
        }
      }

      const byPath = (p: string) => getControllerRoutes(new C()).find((r) => r.path === p);
      expect(byPath('/scoped')?.authStack).toBe('apiKey');
      expect(byPath('/plain')?.authStack).toBeUndefined();
    });

    it('reads a controller-level authStack, and undefined when unset', () => {
      @Controller('/mcp', { authStack: 'apiKey' })
      class Scoped {}

      @Controller('/plain')
      class Plain {}

      expect(getControllerAuthStack(new Scoped())).toBe('apiKey');
      expect(getControllerAuthStack(new Plain())).toBeUndefined();
    });
  });
});
