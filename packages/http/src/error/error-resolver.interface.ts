import type { HttpJsonResponse } from '../request/http-response.type.js';

export type ResolvedHttpError = {
  readonly httpCode: number;
  readonly body: Omit<HttpJsonResponse, 'httpCode'>;
};

export interface ErrorResolver {
  resolve(err: unknown): ResolvedHttpError;
}
