---
"@quilla-be-kit/execution-context": patch
---

Document `createSystemContext` `actorType` parameter: distinguish `'system'` (process-level ops) from `'job'` (background-job ticks). Previously the README listed the method without the parameter or any guidance on when to use each value.
