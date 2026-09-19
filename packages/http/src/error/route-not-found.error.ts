import { NotFoundError } from '@quilla-be-kit/errors';

/**
 * No route matched the request. A subtype of `NotFoundError` so it still
 * resolves to 404 by default, but an `ErrorResolver` can tell an unmatched
 * path apart from a handler reporting a missing entity.
 */
export class RouteNotFoundError extends NotFoundError {
  override readonly code: string = 'ROUTE_NOT_FOUND';

  constructor(message = 'Route not found') {
    super({ message });
  }
}
