import type { HttpRequest } from './http-request.interface.js';

export type HttpMiddleware = (request: HttpRequest, next: () => Promise<void>) => Promise<void>;
