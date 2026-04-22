import type { ExecutionContext } from '@quilla-kit/execution-context';
import type { HttpRequest } from '@quilla-kit/http';

export type FakeRequestInit = {
  readonly headers?: Record<string, string>;
  readonly executionContext?: ExecutionContext;
};

export function fakeHttpRequest(init: FakeRequestInit = {}): HttpRequest {
  const attributes = new Map<string, unknown>();
  const headers = Object.fromEntries(
    Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );

  return {
    getPath: () => '/',
    getMethod: () => 'GET',
    getQuery: () => ({}),
    getParams: () => ({}),
    getHeaders: () => headers,
    getHeader: (name: string) => headers[name.toLowerCase()] ?? null,
    getBody: () => null,
    getBinary: () => null,
    getFile: () => null,
    getFormFields: () => ({}),
    getExecutionContext: () => {
      if (!init.executionContext) {
        throw new Error('No ExecutionContext provided to fake request');
      }
      return init.executionContext;
    },
    setAttribute: <T>(key: string, value: T) => {
      attributes.set(key, value);
    },
    getAttribute: <T>(key: string) => attributes.get(key) as T | undefined,
    getValidatedInput: <T>() => {
      throw new Error('No validated input available on fake request');
    },
  };
}
