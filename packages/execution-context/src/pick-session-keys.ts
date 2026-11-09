export type ActorAttributeValue = string | number | boolean;

export function isActorAttributeValue(value: unknown): value is ActorAttributeValue {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/** Own `keys` of `session` whose value passes `accept`; `undefined` when none does. */
export function pickSessionKeys<V>(
  session: object,
  keys: readonly string[],
  accept: (value: unknown) => value is V,
): Record<string, V> | undefined {
  const source = session as Readonly<Record<string, unknown>>;
  let picked: Record<string, V> | undefined;
  for (const key of keys) {
    const value = Object.hasOwn(source, key) ? source[key] : undefined;
    if (accept(value)) {
      picked ??= {};
      picked[key] = value;
    }
  }
  return picked;
}
