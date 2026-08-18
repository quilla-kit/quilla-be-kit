---
'@quilla-be-kit/errors': patch
---

Docs: retarget the Classification example away from HTTP status mapping

The README demonstrated category branching by hand-rolling an
`instanceof → 400/404/502` table, which is exactly what consumers should not
write — `@quilla-be-kit/http`'s `DefaultErrorResolver` already does it, and
`HttpStatusAware` covers statuses no category maps to. The example now shows a
transport-neutral retriability decision instead, keeping this package free of
transport vocabulary.
