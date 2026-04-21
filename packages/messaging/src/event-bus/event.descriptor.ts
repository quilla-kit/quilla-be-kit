export interface EventDescriptor<TPayload = unknown> {
  readonly name: string;
  readonly schema?: string | undefined;
  readonly __payload?: TPayload;
}

export function defineEvent<TPayload = unknown>(
  name: string,
  schema?: string,
): EventDescriptor<TPayload> {
  const descriptor: EventDescriptor<TPayload> = schema !== undefined ? { name, schema } : { name };
  return Object.freeze(descriptor);
}
