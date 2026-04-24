export type QueryProduct = {
  readonly sql: string;
  readonly countSql?: string;
  readonly params: readonly unknown[];
};
