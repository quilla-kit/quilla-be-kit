export type { ErrorResolver, ResolvedHttpError } from './error-resolver.interface.js';
export { DefaultErrorResolver } from './default.resolver.js';
export { RouteNotFoundError } from './route-not-found.error.js';
export {
  HTTP_STATUS,
  getDeclaredHttpStatus,
  type HttpStatusAware,
} from './http-status-aware.interface.js';
