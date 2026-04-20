export type SqlStatement = {
  readonly text: string;
  readonly params: readonly unknown[];
};
