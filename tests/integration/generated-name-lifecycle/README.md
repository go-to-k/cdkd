# generated-name-lifecycle

Real-AWS net for issue [#5064](https://github.com/go-to-k/cdkd/issues/5064):
the physical names cdkd generates for resources a template does not name,
across a stack's whole lifetime.

- A stack the last v12 binary deployed stays **legacy**: the local binary keeps
  every `{stack}-{logicalId}` name, writes no stack instance id or name
  generation, and keeps today's replacement behavior (a same-name collision,
  `--replace` delete-first, a `cdkd rollback` of it).
- A stack the local binary deploys fresh gets a stack instance id and names
  `{stack}-{logicalId}-{12 hex}`. A replacement creates the new resource FIRST
  under the next name generation (no `--replace`); a crash re-run derives the
  same name (a name-adopting type is taken back, a non-adopting one refuses and
  names `cdkd import`); a rollback records the generation reached; a logical id
  that left the stack comes back under a new name; and what a rollback left in
  AWS under `Retain` is not taken back.

`names.mjs` recomputes every expected name from `state.json`'s id (a
transcription of `generateResourceName`), which it never prints. `verify.sh`
lists the phases.

Run with `/run-integ generated-name-lifecycle` (about 45 minutes: a load
balancer is created three times). It kills two deploys on purpose (`kill -9`)
and releases the stack lock they held.
