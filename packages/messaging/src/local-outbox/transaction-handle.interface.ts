export interface TransactionHandle {
  query<TRow = unknown>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: readonly TRow[] }>;
}
