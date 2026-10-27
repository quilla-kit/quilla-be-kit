---
'@quilla-be-kit/persistence': minor
---

Call stored procedures and functions through a routine DAO: `BaseRoutineDao`
over a `RoutineDbAdapter` port, with `PgRoutineDbAdapter` in `/postgres`.
Arguments are declared in order with a mode (`in`/`out`/`inout`); out-values
come back by name. See "Stored routines" in the README.
