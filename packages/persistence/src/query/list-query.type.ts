export type SortDirection = 'asc' | 'desc';

export type SortOption = Readonly<Record<string, SortDirection>>;

export type PaginationOptions = {
  readonly page: number;
  readonly pageSize: number;
};

export type StandardListQuery<TFilters> = {
  readonly filters?: TFilters;
  readonly sort?: readonly SortOption[];
  readonly pagination?: PaginationOptions;
};
