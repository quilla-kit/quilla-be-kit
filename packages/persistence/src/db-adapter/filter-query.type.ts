export type FilterQuery<T> = {
  readonly [K in keyof T]?: T[K] | readonly T[K][];
};
