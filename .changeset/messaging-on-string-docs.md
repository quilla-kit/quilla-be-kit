---
"@quilla-be-kit/messaging": patch
---

Document `EventConsumer.on(string, handler)` bare-string overload. The descriptor form was the only documented usage; the string form (for untyped forwarding / bridging) was silently available but invisible to consumers.
