---
"@quilla-be-kit/http": patch
---

Document `HttpRequest.getFile(name)` and `getFormFields()` for multipart/form-data handling. Both methods existed in the interface and Hono adapter but had no README coverage — consumers doing file uploads had no documented path.
