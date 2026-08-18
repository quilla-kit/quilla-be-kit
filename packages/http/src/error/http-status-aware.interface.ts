export const HTTP_STATUS = Symbol.for('quilla-be-kit.http.status');

export interface HttpStatusAware {
  readonly [HTTP_STATUS]: number;
}

export function getDeclaredHttpStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const status = (err as Record<PropertyKey, unknown>)[HTTP_STATUS];
  if (typeof status !== 'number' || !Number.isInteger(status)) return undefined;
  return status >= 100 && status <= 599 ? status : undefined;
}
