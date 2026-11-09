import type { ExecutionContext, ExecutionContextView } from '@quilla-be-kit/execution-context';

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
  /** The current execution context, with the scope resolved, read live. */
  getContext(): ExecutionContextView;
  /** @deprecated Use `getContext()`; for the raw context, use `provider.getContext()`. */
  getExecutionContext(): ExecutionContext;
  setAttribute<T>(key: string, value: T): void;
  getAttribute<T>(key: string): T | undefined;
}
