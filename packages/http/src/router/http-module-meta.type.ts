import type { HttpMiddleware } from '../request/http-middleware.type.js';
import type { ControllerRegistration } from './controller-registration.type.js';

export type HttpModuleMeta = {
  readonly controllers?: readonly (object | ControllerRegistration)[];
  readonly middlewares?: readonly HttpMiddleware[];
  readonly prefix?: string;
  readonly version?: string;
};
