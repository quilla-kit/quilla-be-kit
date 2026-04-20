/**
 * The kind of caller performing an operation. Consumers can widen to any
 * string via the `(string & {})` escape hatch without losing autocomplete
 * on the common values.
 */
export type ActorType = 'user' | 'system' | 'service' | 'anonymous' | 'job' | (string & {});
