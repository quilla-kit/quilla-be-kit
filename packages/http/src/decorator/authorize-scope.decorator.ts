import { ForbiddenError } from '@quilla-kit/errors';
import type { AuthenticatedToken } from '../request/authenticated-token.interface.js';
import { HttpAttributes } from '../request/http-attributes.js';
import type { HttpRequest } from '../request/http-request.interface.js';
import type { HttpResponse } from '../request/http-response.type.js';
import { updateLastRoute } from './route.metadata.js';

type ControllerMethod = (this: unknown, request: HttpRequest) => Promise<HttpResponse>;

export function AuthorizeScope(scope: string | readonly string[], mode: 'any' | 'all' = 'any') {
  return (
    originalMethod: ControllerMethod,
    context: ClassMethodDecoratorContext,
  ): ControllerMethod => {
    if (context.kind !== 'method') {
      throw new Error('@AuthorizeScope can only be applied to methods');
    }

    const required = Array.isArray(scope) ? scope : [scope as string];

    updateLastRoute(context.metadata as Record<string | symbol, unknown>, context.name as string, {
      scope: required,
      scopeMode: mode,
    });

    return function (this: unknown, request: HttpRequest): Promise<HttpResponse> {
      const token = request.getAttribute<AuthenticatedToken>(HttpAttributes.VERIFIED_TOKEN);
      if (!token) {
        throw new ForbiddenError({ message: 'Authentication is required for this action.' });
      }

      const granted = token.scope ?? [];
      const hasScope =
        mode === 'all'
          ? required.every((s) => granted.includes(s))
          : required.some((s) => granted.includes(s));

      if (!hasScope) {
        throw new ForbiddenError({ message: 'User is not authorized to perform this action.' });
      }

      return originalMethod.call(this, request);
    };
  };
}
