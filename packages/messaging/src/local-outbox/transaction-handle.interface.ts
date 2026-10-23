/** The transaction an outbox write runs on. Statements are run; results are never read. */
export interface TransactionHandle {
  query(sql: string, params?: readonly unknown[]): Promise<unknown>;
}
