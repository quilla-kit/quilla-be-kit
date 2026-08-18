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

/**
 * `S` is inferred from the keys of `authStacks`, which constrains
 * `defaultAuthStack` to a declared name. Route-, controller-, and module-level
 * `authStack` cannot be typed this way — decorators and module metadata are
 * evaluated independently of Router construction — so those are validated at
 * construction instead.
 *
 * Defaults to `string`, not `never`: inference from an inline `authStacks`
 * literal still narrows `S` to the declared keys, while a consumer who names
 * the type (`const options: RouterOptions = ...`) degrades to "any name"
 * rather than "no name is valid".
 */
export type RouterOptions<S extends string = string> = {
  readonly controllers?: readonly (object | ControllerRegistration)[];
  readonly modules?: readonly Component<HttpModuleMeta>[];

  /**
   * Optional — when provided, Router installs a system-owned bootstrap that
   * runs on every route. Required iff `authStacks` is set (Router throws at
   * construction otherwise). Handlers that never read `ExecutionContext` can
   * skip this.
   */
  readonly executionContext?: RouterExecutionContextOptions;

  /** Custom middlewares that run on every route after the system bootstrap. */
  readonly globalMiddlewares?: readonly HttpMiddleware[];

  /**
   * Named, phase-ordered auth stacks. A route resolves to exactly one stack,
   * which runs only when the route is non-public, after `globalMiddlewares`.
   *
   * Omit entirely for a service with no authentication. An empty record throws
   * at construction — it would leave every non-public route unauthenticated
   * while looking configured.
   */
  readonly authStacks?: Readonly<Record<S, AuthMiddlewareStack>>;

  /**
   * Stack applied to routes that declare none. Required whenever `authStacks`
   * is present, and constrained to its keys.
   */
  readonly defaultAuthStack?: NoInfer<S>;
};
