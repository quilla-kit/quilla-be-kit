import type { ExecutionContextProvider } from '@quilla-be-kit/execution-context';
import type { Component } from '@quilla-be-kit/runtime';
import type { HttpMiddleware } from '../request/http-middleware.type.js';
import type { AuthMiddlewareStack } from './auth-middleware-stack.type.js';
import type { ControllerRegistration } from './controller-registration.type.js';
import type { HttpModuleMeta } from './http-module-meta.type.js';

/**
 * Execution-context bootstrap options. Router installs the bootstrap
 * middleware internally so it runs before any consumer middleware on every
 * route (public and non-public). Provider carries its own factory, so this
 * option collapses to `{ provider, correlationIdHeader? }`.
 */
export type RouterExecutionContextOptions = {
  readonly provider: ExecutionContextProvider;
  /** Header name to read the inbound correlation id from. Default: `x-correlation-id`. */
  readonly correlationIdHeader?: string;
};

export type RouterOptions = {
  readonly controllers?: readonly (object | ControllerRegistration)[];
  readonly modules?: readonly Component<HttpModuleMeta>[];

  /**
   * Optional — when provided, Router installs a system-owned bootstrap that
   * runs on every route. Required iff `authMiddlewares` is set (Router
   * throws at construction otherwise). Handlers that never read
   * `ExecutionContext` can skip this.
   */
  readonly executionContext?: RouterExecutionContextOptions;

  /** Custom middlewares that run on every route after the system bootstrap. */
  readonly globalMiddlewares?: readonly HttpMiddleware[];

  /**
   * Typed, phase-ordered auth stack. Runs only on non-public routes, after
   * `globalMiddlewares`. `tokenVerification` always runs first, then
   * `sessionLoad` if present.
   */
  readonly authMiddlewares?: AuthMiddlewareStack;
};
