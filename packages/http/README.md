# @quilla-kit/http

Transport-agnostic HTTP abstractions: `IHttpRequest`, `IWebServer`, and the
`@Controller`, `@Route`, `@Authorize`, `@ValidateRequest` decorators.

Ships no adapter. Concrete transports (Hono, Express, Fastify, etc.) live in
consumer projects and implement `IWebServer`.

## Install

```sh
pnpm add @quilla-kit/http
```

## Status

Interface surface not yet implemented — scaffolded only.
