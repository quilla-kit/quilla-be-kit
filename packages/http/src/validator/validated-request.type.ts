import type { HttpRequest } from '../request/http-request.interface.js';

// Structural subset of the Standard Schema spec (Zod 4, Valibot, ArkType).
// Duplicated from messaging on purpose: http must not depend on messaging.
type StandardSchema<Output = unknown> = {
  readonly '~standard': {
    readonly types?: { readonly output: Output } | undefined;
  };
};

type InferOutput<S> = S extends StandardSchema<infer Output> ? Output : unknown;

export type ValidatedRequest<S> = HttpRequest & { getValidatedInput(): InferOutput<S> };
