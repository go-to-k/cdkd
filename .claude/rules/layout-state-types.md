---
description: cdkd state layer and shared type definitions
paths:
  - 'src/state/**'
  - 'src/types/**'
---

# State and types

- **state-prefix.ts** — `DEFAULT_STATE_PREFIX` (`'cdkd'`) and
  `CUSTOM_RESOURCE_RESPONSE_PREFIX`, homed in the STATE layer and RE-EXPORTED by
  `src/cli/commands/state-file-keys.ts`, since a `src/state/**` module importing
  from `src/cli/**` inverts the layer order. It is only the DEFAULT — commands
  accept `--state-prefix`, so whole-bucket listings do NOT scope to it.
- **s3-noncurrent-version-purge.ts** / **s3-replication-purge-gap.ts**:
  [state-version-purge.md](state-version-purge.md).
  **lock-contention-message.ts**:
  [lock-contention-message.md](lock-contention-message.md).
  **malformed-resources-bag.ts**:
  [state-malformed-containers.md](state-malformed-containers.md).
- **types/assembly.ts** — Cloud Assembly types; **types/** also holds config,
  state and resource types.

- **types/rollback-journal.ts** — journal types, `parseRollbackJournal`,
  `UnknownRollbackJournalVersionError`
  ([#1183](https://github.com/go-to-k/cdkd/issues/1183)). The journal is a
  SIBLING of `state.json` at `{prefix}/{stack}/{region}/rollback-journal.json`,
  deliberately NOT part of the state schema: its own `journalVersion`, no
  `StackState.version` bump. It goes through `S3StateBackend.*RollbackJournal`,
  and `deleteState` sweeps the key.

  `parseRollbackJournal` validates the per-operation shape the executor keys on
  and the records it dereferences, refusing by INDEX and TYPE with no value
  echoed. `provisionedBy` is deliberately NOT refused: the
  journal forwards what `parseStateBody` tolerates, and refusing would lock
  `cdkd rollback` out of a journal cdkd wrote. It may refuse where `state.json`
  cannot, being discardable.
