---
'@quilla-be-kit/http': minor
---

Add API versioning to route composition.

A version segment can now be declared at three levels and is inserted
**resource-first** into the composed path, so each module stays a clean future
service boundary:

```
[module prefix] + [effective version] + [registration prefix] + [@Controller prefix] + [@Route path]
```

The effective version resolves `route option ?? @Controller version ?? HttpModuleMeta.version ?? ''`:

- `HttpModuleMeta.version?` — module-wide default.
- `@Controller(prefix, { version })` — controller-level default.
- `@Get('/x', { version })` (and every other method + `*Public` decorator via the
  new optional `RouteOptions` argument) — per-route override.

Version lives on the method/controller decorators rather than a standalone
decorator because it is a pure path-composition fact (like `path` and the
`*Public` flag), with no runtime behavior — keeping it orthogonal to
`@AuthorizeScope` / `@ValidateRequest`.

Purely additive: when no version is set anywhere, composed paths are
byte-identical to before. Version segments go through the existing
leading-slash / no-trailing-slash normalization, and specificity sorting plus
duplicate-route detection run on the composed path unchanged.
