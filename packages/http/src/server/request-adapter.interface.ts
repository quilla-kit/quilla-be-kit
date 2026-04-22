import type { HttpRequest } from '../request/http-request.interface.js';
import type { HttpResponse } from '../request/http-response.type.js';

export interface RequestAdapter {
  controller(
    handler: (request: HttpRequest) => Promise<HttpResponse>,
  ): (frameworkContext: unknown) => Promise<unknown>;
  toHttpRequest(frameworkContext: unknown): Promise<HttpRequest>;
}
