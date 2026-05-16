import { camelToSnake } from './case.js';
import type { ColumnResolver } from './column-resolver.interface.js';

export type DefaultColumnResolverOptions = {
  readonly overrides?: Readonly<Record<string, string>>;
};

export class DefaultColumnResolver implements ColumnResolver {
  private readonly overrides: Readonly<Record<string, string>>;

  constructor(options: DefaultColumnResolverOptions = {}) {
    this.overrides = options.overrides ?? {};
  }

  resolve(domainKey: string): string {
    const override = this.overrides[domainKey];
    if (override !== undefined) return override;
    return camelToSnake(domainKey);
  }
}
