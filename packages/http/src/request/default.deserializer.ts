import type { RequestDeserializer } from './request-deserializer.interface.js';

export type DefaultRequestDeserializerOptions = {
  /**
   * Rename the query keys a consumer's dialect uses onto the canonical
   * `page` / `pageSize` that a list schema parses. Configured once on the
   * server, so `?p=2&per_page=50` reaches every handler as `page` / `pageSize`
   * without touching any DTO. `sort` is intentionally not remappable — the
   * `sort` key already agrees across request and response ends.
   */
  readonly paginationKeys?: {
    readonly page?: string;
    readonly pageSize?: string;
  };
};

export class DefaultRequestDeserializer implements RequestDeserializer {
  private readonly renames: ReadonlyMap<string, string>;

  constructor(options: DefaultRequestDeserializerOptions = {}) {
    const renames = new Map<string, string>();
    const { page, pageSize } = options.paginationKeys ?? {};
    if (page && page !== 'page') renames.set(page, 'page');
    if (pageSize && pageSize !== 'pageSize') renames.set(pageSize, 'pageSize');
    this.renames = renames;
  }

  deserializeQuery(
    query: Record<string, string | readonly string[]>,
  ): Record<string, string | readonly string[]> {
    if (this.renames.size === 0) return query;
    const out: Record<string, string | readonly string[]> = {};
    for (const [key, value] of Object.entries(query)) {
      out[this.renames.get(key) ?? key] = value;
    }
    return out;
  }
}
