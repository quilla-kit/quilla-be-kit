import type { ExecutionContext, ExecutionContextProvider } from '@quilla-be-kit/execution-context';
import { createHttpRequest } from './request/create-http-request.js';
import { HttpAttributes } from './request/http-attributes.js';
import type { ValidatedRequest } from './validator/validated-request.type.js';

export type TestHttpRequestOptions = {
  readonly method?: string;
  readonly path?: string;
  readonly params?: Record<string, string>;
  readonly query?: Record<string, string | readonly string[]>;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
  readonly binary?: Uint8Array;
  readonly formData?: FormData;
  /** Seeded as the input `@ValidateRequest` would have validated. */
  readonly validatedInput?: unknown;
  readonly attributes?: Readonly<Record<string, unknown>>;
  /** What `getContext()` reads: a fixed context, or a provider read live (for middleware tests). */
  readonly context?: ExecutionContext | Pick<ExecutionContextProvider, 'getContext'>;
};

/**
 * An `HttpRequest` for controller and middleware tests, built by the same
 * function the adapters use, so it implements every request method.
 */
export function createTestHttpRequest<S = unknown>(
  options: TestHttpRequestOptions = {},
): ValidatedRequest<S> {
  const attributes = new Map<string, unknown>(Object.entries(options.attributes ?? {}));
  if (options.validatedInput !== undefined) {
    attributes.set(HttpAttributes.VALIDATED_INPUT, options.validatedInput);
  }
  const { context } = options;
  const provider = context
    ? 'getContext' in context
      ? context
      : { getContext: () => context }
    : {
        getContext: (): never => {
          throw new Error(
            'No execution context on this test request; pass `context` to createTestHttpRequest',
          );
        },
      };
  return createHttpRequest(
    {
      path: options.path ?? '/',
      method: options.method ?? 'GET',
      query: options.query ?? {},
      params: options.params ?? {},
      headers: options.headers ?? {},
      body: options.body ?? null,
      binary: options.binary ?? null,
      formData: options.formData ?? null,
      executionContextProvider: provider,
    },
    attributes,
  ) as ValidatedRequest<S>;
}
