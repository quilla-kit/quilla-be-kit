---
"@quilla-be-kit/messaging": minor
---

`EventConsumerOptions.executionContext` takes `{ provider }` only.
`EventConsumer` reads the factory from `provider.factory`, matching the
provider-carried-factory convention already used by http and security.
