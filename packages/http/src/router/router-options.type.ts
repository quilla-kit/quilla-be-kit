import type { Component } from '@quilla-kit/runtime';
import type { HttpMiddleware } from '../request/http-middleware.type.js';
import type { ControllerRegistration } from './controller-registration.type.js';
import type { HttpModuleMeta } from './http-module-meta.type.js';

export type RouterOptions = {
  readonly controllers?: readonly (object | ControllerRegistration)[];
  readonly modules?: readonly Component<HttpModuleMeta>[];
  readonly globalMiddlewares?: readonly HttpMiddleware[];
  readonly authMiddlewares?: readonly HttpMiddleware[];
};
