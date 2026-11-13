export type MarkFailedOptions = {
  // How long every instance waits before retrying the row; default 0.
  readonly retryAfterMs?: number;
};
