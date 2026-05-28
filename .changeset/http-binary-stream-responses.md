---
'@quilla-be-kit/http': minor
---

feat(http): binary and stream responses

`HttpResponse` becomes a discriminated union: `HttpJsonResponse |
HttpBinaryResponse | HttpStreamResponse`. JSON handlers keep the existing
shape (`{ httpCode, payload, error?, metadata?, headers? }`) and continue
to be wrapped in the standard envelope. Binary handlers return
`{ httpCode, data: Uint8Array, headers? }`; stream handlers return
`{ httpCode, stream: ReadableStream<Uint8Array>, headers? }`. The adapter
discriminates by field presence (`'stream' in r` / `'data' in r`) and
writes the bytes/stream directly — no JSON envelope, no `kind` tag to set.

`content-type` lives in `headers` like every other header — the response
shape does not invent a separate field for it.

Tradeoff: binary responses lose the envelope convention. There's no
`payload` / `metadata` wrapper around the bytes, and middleware can't
introspect stream contents post-hoc. Errors thrown before the response
starts still go through `resolveHttpError` and emit a normal JSON error;
errors thrown mid-stream abort the connection.

Existing handlers returning `{ httpCode, payload }` still satisfy
`HttpJsonResponse` and therefore `HttpResponse` — no breaking change.
`ResolvedHttpError.body` is narrowed from `Omit<HttpResponse, 'httpCode'>`
to `Omit<HttpJsonResponse, 'httpCode'>`; error envelopes are always JSON.
