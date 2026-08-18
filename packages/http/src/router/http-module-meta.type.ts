import type { HttpMiddleware } from '../request/http-middleware.type.js';
import type { ControllerRegistration } from './controller-registration.type.js';

export type HttpModuleMeta = {
  readonly controllers?: readonly (object | ControllerRegistration)[];
  readonly middlewares?: readonly HttpMiddleware[];
  readonly prefix?: string;
  readonly version?: string;
  /**
   * Module-level default auth stack, overridden by a controller- or route-level
   * `authStack`. Must name a stack declared in `RouterOptions.authStacks`.
   */
  readonly authStack?: string;
};
