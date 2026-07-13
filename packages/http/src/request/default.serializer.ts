import type { HttpJsonResponse } from './http-response.type.js';
import type { ResponseSerializer } from './response-serializer.interface.js';

export class DefaultResponseSerializer implements ResponseSerializer {
  serialize(response: HttpJsonResponse): unknown {
    const { httpCode: _httpCode, headers: _headers, ...body } = response;
    return Object.keys(body).length === 0 ? undefined : body;
  }
}
