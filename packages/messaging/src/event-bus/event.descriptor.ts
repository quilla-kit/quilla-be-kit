import type { StandardSchemaV1 } from './standard-schema.type.js';

export interface EventDescriptor<TPayload = unknown> {
  readonly name: string;
  readonly schema?: StandardSchemaV1<unknown, TPayload> | undefined;
  readonly __payload?: TPayload;
}

export function defineEvent<TSchema extends StandardSchemaV1>(
  name: string,
  schema: TSchema,
): EventDescriptor<StandardSchemaV1.InferOutput<TSchema>>;
export function defineEvent<TPayload = unknown>(name: string): EventDescriptor<TPayload>;
export function defineEvent<TPayload = unknown>(
  name: string,
  schema?: StandardSchemaV1,
): EventDescriptor<TPayload> {
  const descriptor: EventDescriptor<TPayload> =
    schema !== undefined
      ? { name, schema: schema as StandardSchemaV1<unknown, TPayload> }
      : { name };
  return Object.freeze(descriptor);
}
