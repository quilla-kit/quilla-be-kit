import type { HttpJsonResponse } from './http-response.type.js';

export interface ResponseSerializer {
  // Returns the JSON wire body only; `httpCode`/`headers` are the adapter's job and are ignored.
  // Return `undefined` to emit a bodyless response (e.g. 204).
  serialize(response: HttpJsonResponse): unknown;
}
