import type { ErrorResolver } from '../error/error-resolver.interface.js';
import type { RequestDeserializer } from '../request/request-deserializer.interface.js';
import type { ResponseSerializer } from '../request/response-serializer.interface.js';

export type HttpConventions = {
  readonly errorResolver?: ErrorResolver;
  readonly responseSerializer?: ResponseSerializer;
  readonly requestDeserializer?: RequestDeserializer;
};
