import type { HttpMethod } from '../decorator/route.metadata.js';
import type { HttpMiddleware } from '../request/http-middleware.type.js';
import type { HttpRequest } from '../request/http-request.interface.js';
import type { HttpResponse } from '../request/http-response.type.js';

export type NormalizedRoute = {
  readonly httpMethod: HttpMethod;
  readonly fullPath: string;
  readonly public: boolean;
  /**
   * Complete ordered middleware chain for this route:
   * `[system? → globalMiddlewares → (public ? [] : authMiddlewares) → moduleMiddlewares → registrationMiddlewares]`.
   * Adapters iterate and wrap each entry; they do not re-compose the chain.
   */
  readonly middlewareChain: readonly HttpMiddleware[];
  readonly handler: (request: HttpRequest) => Promise<HttpResponse>;
  readonly handlerMethodName: string;
  readonly controllerName: string;
  readonly specificity: number;
};
