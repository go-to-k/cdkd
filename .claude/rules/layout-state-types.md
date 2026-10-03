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
  and `deleteState` sweeps the key. `create-tokens.json` is the other such
  sibling (`src/state/create-token-ledger.ts`, [#4438](https://github.com/go-to-k/cdkd/issues/4438)):
  `deleteState` deletes it FIRST and fails closed: a ledger that outlives its
  record would hand a kept resource back to the next deploy. `saveState` tells
  the bound ledger (`notifyStateSaved`) so it carries `stateRecorded`; a deploy
  that finds no record replaces such a ledger instead of resuming it.

  `parseRollbackJournal` validates the per-operation shape the executor keys on
  and the records it dereferences, refusing by INDEX and TYPE with no value
  echoed. `provisionedBy` is deliberately NOT refused: the
  journal forwards what `parseStateBody` tolerates, and refusing would lock
  `cdkd rollback` out of a journal cdkd wrote. It may refuse where `state.json`
  cannot, being discardable.

  Each segment records the deploy's `skipPrefix`; every replay of a segment
  runs inside `withSkipPrefix(<it>)`, or a re-create derives a different name
  than the deploy sent ([#4018](https://github.com/go-to-k/cdkd/issues/4018)).
  Per op, a `SENT_NAME_REWRITTEN` type's re-create, holder proof and in-place
  revert then run under the flag that reproduces its OWN physical id
  (`replayPrefixChoice`, [#4024](https://github.com/go-to-k/cdkd/issues/4024)):
  an earlier deploy may have created it under the other one.
