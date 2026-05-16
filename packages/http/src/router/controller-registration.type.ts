import type { HttpMiddleware } from '../request/http-middleware.type.js';

export type ControllerRegistration = {
  readonly controller: object;
  readonly prefix?: string;
  readonly middlewares?: readonly HttpMiddleware[];
};
