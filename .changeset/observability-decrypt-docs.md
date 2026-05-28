---
"@quilla-be-kit/observability": patch
---

Export `importObfuscationKey` from the public package surface (previously unexported, leaving consumers with no way to obtain a `CryptoKey` for `decryptValue`). Add README section showing the full incident-response decryption flow: `importObfuscationKey` → `decryptValue`.
