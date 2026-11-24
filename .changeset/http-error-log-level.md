---
'@quilla-be-kit/http': minor
---

`HonoServer` now picks the log level for a handled error from its resolved status. Below 500 it logs at `warn` with only `httpCode`, `name`, `message` and `code`: no stack, no error details. 500 and above logs at `error` with the full error. Alerts keyed on `error` level will fire less often after upgrading, which is intended. The new `errorLogLevel(resolved, err)` option (type `ErrorLogLevelPolicy`, default `defaultErrorLogLevel`) overrides the level per error, or returns `'off'` to skip logging. Unknown routes are still not logged and never reach `errorLogLevel`.

A custom `ErrorResolver` or `ResponseSerializer` that throws while handling an error no longer re-runs once per middleware layer and leaves the response to the runtime. The server now answers a generic `500` (`{ error: { name: 'InternalError', message: 'Internal server error' } }`, bypassing the configured conventions), and logs both the handling failure and the original error at `error`.
