---
"@quilla-be-kit/http": minor
---

Add `cors` option to `HonoServer` for built-in CORS support. Pass `cors: { origins: string[] }` and `HonoServer` registers Hono's built-in `cors()` middleware before routes so both preflight `OPTIONS` requests and actual cross-origin requests are handled automatically. Requests from unlisted origins receive no CORS headers; requests without an `Origin` header are unaffected. No additional dependency — `hono/cors` ships with Hono.
