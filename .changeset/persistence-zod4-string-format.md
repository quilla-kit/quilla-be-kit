---
"@quilla-be-kit/persistence": patch
---

Fix `createQueryParametersSchema` dropping filter fields typed with Zod 4 top-level format helpers (`z.uuid()`, `z.email()`, `z.url()`, etc.). These return `ZodStringFormat` subclasses rather than `ZodString`, so `kindOf()` returned `null` and the field was silently omitted — causing strict-mode rejections. A single `instanceof ZodStringFormat` check restores correct `'string'` kind mapping for all format helpers.
