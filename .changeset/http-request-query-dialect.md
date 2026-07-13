---
'@quilla-be-kit/http': minor
---

Add a consumer-overridable inbound query dialect to `HttpConventions` — the
request-side mirror of `responseSerializer`.

`HttpConventions` gains an optional `requestDeserializer` (`RequestDeserializer`
interface) that rewrites the raw query dict before validation. The exported
`DefaultRequestDeserializer` renames a consumer's pagination keys onto the
canonical `page` / `pageSize` that handlers and `@ValidateRequest` already read:

```ts
new HonoServer({
  port,
  router,
  serve,
  conventions: {
    requestDeserializer: new DefaultRequestDeserializer({
      paginationKeys: { page: 'p', pageSize: 'per_page' },
    }),
  },
});
```

A pagination dialect is API-wide, so it's configured once at the server boundary
— `GET /roles?p=2&per_page=50` reaches every handler as `page` / `pageSize` with
no per-DTO changes. This aligns with `@quilla-fe-kit`'s `RepeatParamsSerializer`,
which renames the same slots once in its constructor on the emitting end.

Filter keys and all other query params pass through untouched; params and body
are never touched. `sort` is intentionally not remappable — the `sort` key
already agrees across request and response ends.

Non-breaking: omitting `requestDeserializer` (or its `paginationKeys`) is an
identity pass, so existing behavior is unchanged.
