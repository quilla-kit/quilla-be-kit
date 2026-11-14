---
'@quilla-be-kit/messaging': patch
---

README: explains that a poll loop never overlaps itself (a poll during a running batch is skipped, so the next claim comes on the first poll after the batch ends, even when the batch was full), and how claimed work spreads across replicas with `batchSize`.
