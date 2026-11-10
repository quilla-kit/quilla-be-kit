import {
  type ExecutionContextProvider,
  toExecutionContextView,
} from '@quilla-be-kit/execution-context';
import type { ValidatedRequest } from '../validator/validated-request.type.js';
import { HttpAttributes } from './http-attributes.js';

export type CreateHttpRequestInput = {
  readonly path: string;
  readonly method: string;
  readonly query: Record<string, string | readonly string[]>;
  readonly params: Record<string, string>;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  readonly binary: Uint8Array | null;
  readonly formData: FormData | null;
  readonly executionContextProvider: Pick<ExecutionContextProvider, 'getContext'> | undefined;
};

export function createHttpRequest(
  input: CreateHttpRequestInput,
  attributes: Map<string, unknown>,
): ValidatedRequest<unknown> {
  const readContext = () => {
    if (!input.executionContextProvider) {
      throw new Error(
        'No ExecutionContext provider wired on Router. Pass `executionContext: { provider }` to the Router options to read the request context.',
      );
    }
    return input.executionContextProvider.getContext();
  };

  // Header names are case-insensitive; store them lower-cased so getHeader can match any casing.
  const headers = Object.fromEntries(
    Object.entries(input.headers).map(([name, value]) => [name.toLowerCase(), value]),
  );

  return {
    getPath: () => input.path,
    getMethod: () => input.method,
    getQuery: () => input.query,
    getParams: () => input.params,
    getHeaders: () => headers,
    getHeader: (name) => headers[name.toLowerCase()] ?? null,
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
    getContext: () => toExecutionContextView(readContext()),
    getExecutionContext: readContext,
    setAttribute: (key, value) => {
      attributes.set(key, value);
    },
    getAttribute: <T>(key: string) => attributes.get(key) as T | undefined,
    getValidatedInput: () => {
      const value = attributes.get(HttpAttributes.VALIDATED_INPUT);
      if (value === undefined) {
        throw new Error('No validated input. Apply @ValidateRequest to the route handler.');
      }
      return value;
    },
  };
}
