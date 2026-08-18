import type { HttpMethod } from '../decorator/route.metadata.js';
import type { HttpMiddleware } from '../request/http-middleware.type.js';
import type { HttpRequest } from '../request/http-request.interface.js';
import type { HttpResponse } from '../request/http-response.type.js';

export type NormalizedRoute = {
  readonly httpMethod: HttpMethod;
  readonly fullPath: string;
  readonly public: boolean;
  /**
   * Resolved auth stack name. `undefined` on public routes, and on every route
   * when no `authStacks` are configured.
   */
  readonly authStack: string | undefined;
  /**
   * Complete ordered middleware chain for this route:
   * `[system? → globalMiddlewares → (public ? [] : resolved auth stack) → moduleMiddlewares → registrationMiddlewares]`.
   * Adapters iterate and wrap each entry; they do not re-compose the chain.
   */
  readonly middlewareChain: readonly HttpMiddleware[];
  readonly handler: (request: HttpRequest) => Promise<HttpResponse>;
  readonly handlerMethodName: string;
  readonly controllerName: string;
  readonly specificity: number;
};
