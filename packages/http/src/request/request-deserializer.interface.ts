export interface RequestDeserializer {
  // Rewrites the raw query dict before validation — the request-side mirror of
  // `ResponseSerializer.serialize`. Use it to translate a consumer's wire
  // dialect (e.g. `?p=2&per_page=50`) onto the canonical keys a schema parses
  // (`page` / `pageSize`). Return the dict unchanged to pass through.
  deserializeQuery(
    query: Record<string, string | readonly string[]>,
  ): Record<string, string | readonly string[]>;
}
