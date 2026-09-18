---
description: cdkd layout notes for the state layer and the shared type definitions (S3 state backend, lock manager, rollback journal)
paths:
  - 'src/state/**'
  - 'src/types/**'
---

# Key Files and Directories - state, types

Split out of the former `layout-misc.md`, whose six globs made every
edit under any one of four src layers load all four.

`src/cli/commands/events.ts` and its `src/state` / `src/types` siblings are documented in [layout-cli.md](layout-cli.md).

Index of every area: [code-layout.md](code-layout.md).

## Important Files

- **src/state/** - S3 state backend, lock manager

- **src/state/state-prefix.ts** - `DEFAULT_STATE_PREFIX` (`'cdkd'`), the default S3 key prefix for cdkd state. Homed in the STATE layer and RE-EXPORTED by `src/cli/commands/state-file-keys.ts`, so its four pre-existing importers are unchanged. The move is the layering fix issue [#2170](https://github.com/go-to-k/cdkd/issues/2170)'s review forced: `lock-contention-message.ts` needs the constant to decide whether a recovery hint should spell `--state-prefix` at all, and a `src/state/**` module importing from `src/cli/commands/**` inverts the 7-layer architecture -- the CLI sits ABOVE the state layer, not below it. Note this is only the DEFAULT; commands accept `--state-prefix`, so whole-bucket listings deliberately do not scope to it. It also homes `CUSTOM_RESOURCE_RESPONSE_PREFIX` (issue [#2052](https://github.com/go-to-k/cdkd/issues/2052)); rationale and sync fence in [layout-cli.md](layout-cli.md)'s `gc.ts` entry.

- **src/state/s3-noncurrent-version-purge.ts** / **src/state/s3-replication-purge-gap.ts** - the state-bucket noncurrent-version purge and the S3-replication gap it cannot close (issue [#2447](https://github.com/go-to-k/cdkd/issues/2447)): [state-version-purge.md](state-version-purge.md).

- **src/state/lock-contention-message.ts** - the one lock-contention refusal, `buildForceUnlockCommand`, `shellQuote`, `formatLockExpiry` and `UNREPRODUCIBLE_LOCK_CLAUSE` (issues [#2161](https://github.com/go-to-k/cdkd/issues/2161) / [#2170](https://github.com/go-to-k/cdkd/issues/2170) / [#2610](https://github.com/go-to-k/cdkd/issues/2610) / [#3085](https://github.com/go-to-k/cdkd/issues/3085) / [#3377](https://github.com/go-to-k/cdkd/issues/3377)): [lock-contention-message.md](lock-contention-message.md)

- **src/state/malformed-resources-bag.ts** - [state-malformed-containers.md](state-malformed-containers.md)

- **src/types/assembly.ts** - Cloud Assembly types (AssemblyManifest, MissingContext, etc.)

- **src/types/rollback-journal.ts** - Rollback-journal types + parser (issue [#1183](https://github.com/go-to-k/cdkd/issues/1183)). Defines `RollbackJournal` / `RollbackJournalSegment` / `RollbackSegmentReason`, the `ROLLBACK_JOURNAL_VERSION` constant, `parseRollbackJournal` (JSON parse + validation -- since issues [#3140](https://github.com/go-to-k/cdkd/issues/3140) / [#3149](https://github.com/go-to-k/cdkd/issues/3149) that includes the per-operation shape the executor keys its lookups on and the nested records it dereferences, refused by index and TYPE with no value echoed -- TYPE-when-present, and `provisionedBy` deliberately not refused, because the journal forwards what `parseStateBody` tolerates and refusing it would lock `cdkd rollback` out of a journal cdkd wrote; the journal may refuse where `state.json` may not because it is DISCARDABLE and no recovery command reads it), and `UnknownRollbackJournalVersionError`. The journal is a **sibling** of `state.json` (`{prefix}/{stackName}/{region}/rollback-journal.json`), deliberately NOT part of the state schema — its own `journalVersion` (starting at 1), no `StackState.version` bump. Read/written via `S3StateBackend.{load,appendSegment,popSegment,delete}RollbackJournal`; `deleteState` sweeps the key so `cdkd destroy` cleans it up.

- **src/types/** - Type definitions (config, state, resources, assembly, etc.)
