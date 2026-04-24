export interface ColumnResolver {
  resolve(domainKey: string): string;
}
