// Hints for an adapter's claim; an adapter that can't honor one may ignore it.
export type ClaimOptions = {
  // The instance that failed a row waits this much longer for its retry than other instances.
  readonly failoverWindowMs?: number;
};
