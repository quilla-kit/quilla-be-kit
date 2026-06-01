import { describe, expect, it } from 'vitest';
import {
  Controller,
  Delete,
  Get,
  GetPublic,
  Patch,
  Post,
  PostPublic,
  Put,
} from '../../src/decorator/index.js';
import {
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
    const paths = routes.map((r) => r.path).sort();
    expect(paths).toContain('/inherited');
    expect(paths).toContain('/own');
    // Child prefix wins
    expect(getControllerPrefix(new Child())).toBe('/child');
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
});
