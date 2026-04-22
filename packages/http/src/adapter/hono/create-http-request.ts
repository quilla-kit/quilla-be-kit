import type { ExecutionContextProvider } from '@quilla-kit/execution-context';
import { HttpAttributes } from '../../request/http-attributes.js';
import type { HttpRequest } from '../../request/http-request.interface.js';

export type CreateHttpRequestInput = {
  readonly path: string;
  readonly method: string;
  readonly query: Record<string, string | readonly string[]>;
  readonly params: Record<string, string>;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  readonly binary: Uint8Array | null;
  readonly formData: FormData | null;
  readonly executionContextProvider: ExecutionContextProvider | undefined;
};

export function createHttpRequest(
  input: CreateHttpRequestInput,
  attributes: Map<string, unknown>,
): HttpRequest {
  return {
    getPath: () => input.path,
    getMethod: () => input.method,
    getQuery: () => input.query,
    getParams: () => input.params,
    getHeaders: () => input.headers,
    getHeader: (name) => input.headers[name.toLowerCase()] ?? null,
    getBody: () => input.body,
    getBinary: () => input.binary,
    getFile: (name) => {
      if (!input.formData) return null;
      const entry = input.formData.get(name);
      return entry instanceof File ? entry : null;
    },
    getFormFields: () => {
      if (!input.formData) return {};
      const fields: Record<string, string | string[]> = {};
      for (const [key, value] of input.formData.entries()) {
        if (typeof value !== 'string') continue;
        const existing = fields[key];
        if (existing === undefined) {
          fields[key] = value;
        } else if (Array.isArray(existing)) {
          existing.push(value);
        } else {
          fields[key] = [existing, value];
        }
      }
      return fields;
    },
    getExecutionContext: () => {
      if (!input.executionContextProvider) {
        throw new Error(
          'No ExecutionContext provider wired on Router. Pass `executionContext: { provider, factory }` to the Router options to use `request.getExecutionContext()`.',
        );
      }
      return input.executionContextProvider.getContext();
    },
    setAttribute: (key, value) => {
      attributes.set(key, value);
    },
    getAttribute: <T>(key: string) => attributes.get(key) as T | undefined,
    getValidatedInput: <T>(): T => {
      const value = attributes.get(HttpAttributes.VALIDATED_INPUT);
      if (value === undefined) {
        throw new Error('No validated input. Apply @ValidateRequest to the route handler.');
      }
      return value as T;
    },
  };
}
