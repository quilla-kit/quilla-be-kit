import { ValidationError } from '@quilla-be-kit/errors';
import { HttpAttributes } from '../request/http-attributes.js';
import type { HttpRequest } from '../request/http-request.interface.js';
import type { HttpResponse } from '../request/http-response.type.js';
import type { HeaderSourceMap } from '../validator/header-source.type.js';
import {
  BASE_SESSION_KEYS,
  SESSION_KEYS_ATTRIBUTE,
  effectiveHeaderMap,
} from '../validator/input-injection.metadata.js';
import type { RequestSource } from '../validator/request-source.type.js';
import type { RequestValidator } from '../validator/request-validator.interface.js';
import type { ValidatedRequest } from '../validator/validated-request.type.js';
import { addRoutePatch } from './route.metadata.js';

type ControllerMethod = (this: unknown, request: HttpRequest) => Promise<HttpResponse>;

const SOURCE_READERS: Record<RequestSource, (req: HttpRequest) => object> = {
  body: (req) => {
    const body = req.getBody();
    return body !== null && typeof body === 'object' ? body : {};
  },
  params: (req) => req.getParams(),
  query: (req) => req.getQuery(),
};

export function ValidateRequest<S>(
  schema: S,
  sources: readonly RequestSource[],
  headers?: HeaderSourceMap,
) {
  return (
    originalMethod: (this: unknown, request: ValidatedRequest<S>) => Promise<HttpResponse>,
    context: ClassMethodDecoratorContext,
  ): ControllerMethod => {
    if (context.kind !== 'method') {
      throw new Error('@ValidateRequest can only be applied to methods');
    }

    addRoutePatch(context.metadata as Record<string | symbol, unknown>, context.name as string, {
      validation: headers ? { schema, sources, headers } : { schema, sources },
    });
    const headerEntries = Object.entries(effectiveHeaderMap(headers));

    return function (this: unknown, request: HttpRequest): Promise<HttpResponse> {
      const validator = request.getAttribute<RequestValidator>(HttpAttributes.REQUEST_VALIDATOR);
      if (!validator) {
        throw new Error(
          '@ValidateRequest used but no RequestValidator was registered on the WebServer',
        );
      }

      const raw: Record<string, unknown> = {};
      for (const source of sources) {
        Object.assign(raw, SOURCE_READERS[source](request));
      }

      // A stack's extra session keys are authority: strip any client-sent
      // value up front, even when the schema can't be described, so a key the
      // decorator cannot inject is never supplied by the caller either.
      const stackKeys = request.getAttribute<readonly string[]>(SESSION_KEYS_ATTRIBUTE) ?? [];
      for (const key of stackKeys) delete raw[key];

      // Injection is limited to keys the schema declares, so strict schemas
      // never receive surprise fields. Validators without `describeSchema`
      // get no injection at all.
      const description = validator.describeSchema?.(schema);
      if (description) {
        // A merely-declared but unsent header must never blank out a value the
        // source merge already produced.
        for (const [key, headerName] of headerEntries) {
          if (!description.keys.includes(key)) continue;
          const value = request.getHeader(headerName);
          if (value !== null) raw[key] = value;
        }

        // Session injection runs last so the session always wins over client
        // input, headers included.
        const session = request.getExecutionContext().session as
          | Readonly<Record<string, unknown>>
          | undefined;
        const declared = (key: string) => description.keys.includes(key);
        if (!session) {
          const key = stackKeys.find(declared);
          if (key !== undefined) {
            throw new Error(
              `@ValidateRequest: session key "${key}" is declared by the auth stack but no session was loaded`,
            );
          }
        } else {
          for (const key of [...BASE_SESSION_KEYS, ...stackKeys]) {
            if (!declared(key)) continue;
            const value = Object.hasOwn(session, key) ? session[key] : undefined;
            if (value === undefined || value === null) {
              throw new Error(`@ValidateRequest: session has no value for declared key "${key}"`);
            }
            raw[key] = value;
          }
        }
      }

      const result = validator.validate(schema, raw);
      if (!result.success) {
        throw new ValidationError({
          message: 'Request validation failed',
          context: { issues: result.error },
        });
      }

      request.setAttribute(HttpAttributes.VALIDATED_INPUT, result.data);
      return originalMethod.call(this, request as ValidatedRequest<S>);
    };
  };
}
