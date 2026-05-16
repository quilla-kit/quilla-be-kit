export type DatabaseResult = {
  readonly rows: readonly Record<string, unknown>[];
  readonly rowCount?: number;
};
