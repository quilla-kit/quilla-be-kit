import type { HttpMethod } from '../decorator/route.metadata.js';
import type { HttpMiddleware } from '../request/http-middleware.type.js';
import type { HttpRequest } from '../request/http-request.interface.js';
import type { HttpResponse } from '../request/http-response.type.js';

export type NormalizedRoute = {
  readonly httpMethod: HttpMethod;
  readonly fullPath: string;
  readonly public: boolean;
  readonly middlewares: readonly HttpMiddleware[];
  readonly handler: (request: HttpRequest) => Promise<HttpResponse>;
  readonly handlerMethodName: string;
  readonly controllerName: string;
  readonly specificity: number;
};
