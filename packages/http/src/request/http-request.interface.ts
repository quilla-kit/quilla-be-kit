import type { ExecutionContext } from '@quilla-be-kit/execution-context';

export interface HttpRequest {
  getPath(): string;
  getMethod(): string;
  getQuery(): Record<string, string | readonly string[]>;
  getParams(): Record<string, string>;
  getHeaders(): Record<string, string>;
  getHeader(name: string): string | null;
  getBody(): unknown;
  getBinary(): Uint8Array | null;
  getFile(name: string): File | null;
  getFormFields(): Record<string, string | readonly string[]>;
  getExecutionContext(): ExecutionContext;
  setAttribute<T>(key: string, value: T): void;
  getAttribute<T>(key: string): T | undefined;
  getValidatedInput<T>(): T;
}
