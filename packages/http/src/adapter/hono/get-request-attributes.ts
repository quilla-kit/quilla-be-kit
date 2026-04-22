const ATTRIBUTE_STORE = new WeakMap<object, Map<string, unknown>>();

export function getRequestAttributes(frameworkContextKey: object): Map<string, unknown> {
  let attrs = ATTRIBUTE_STORE.get(frameworkContextKey);
  if (!attrs) {
    attrs = new Map();
    ATTRIBUTE_STORE.set(frameworkContextKey, attrs);
  }
  return attrs;
}
