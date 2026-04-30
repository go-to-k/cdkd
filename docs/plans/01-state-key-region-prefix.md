# PR 1: State key region prefix (collection model extension)

**Status**: planned
**Branch**: `feat/state-region-key`
**Depends on**: none
**Breaking change**: yes (auto-migrated, gated by `bc-check` markgate)
**Parallel with**: PR 2, 3, 6, 7

## Goal

Make a stack's region part of the S3 state key so `env.region` changes do not
overwrite each other. After this PR, the same `stackName` deployed to two
different regions has two independent state files.

## Background

Current layout:

```
s3://{bucket}/cdkd/{stackName}/state.json
```

The region is stored *inside* `state.json` (`region: string`). When a user
changes `env.region` from `us-west-2` to `us-east-1` and re-runs `cdkd deploy`,
the state file at the same key is rewritten with `region: "us-east-1"`. The
original `us-west-2` resources still exist, but cdkd no longer knows about
them. A subsequent `cdkd destroy` runs against `us-east-1`, hits
`ResourceNotFoundException` for each resource, and treats those errors as
idempotent successes — silent failure.

This is the root cause of the bug surfaced in the discussion that produced
this rollout.

## Scope

### In scope

- New state key layout: `cdkd/{stackName}/{region}/state.json`.
- Lock key parallel: `cdkd/{stackName}/{region}/lock.json`.
- `state.json` schema bump: `version: 2` (was `version: 1`).
- Backwards-compat read path for `version: 1` (`cdkd/{stackName}/state.json`)
  with a deprecation warning.
- Auto-migration on next write: read legacy → write new key → delete legacy.
- `cdkd state list` default output gains a region column / paren suffix:
  `MyStack (us-west-2)`.
- `cdkd state show` and `cdkd state resources` accept an optional
  `--region` filter when a stack name resolves to multiple region keys.
- `cdkd state rm` deletes all region keys for the stack by default,
  with `--region` available to scope to one.
- DAG-builder, deploy-engine, destroy command pass `region` to the state
  backend so reads/writes hit the right key.

### Out of scope (handled by other PRs)

- Default bucket name change (PR 4).
- `--region` flag deprecation on most commands (PR 5).
- Dynamic bucket region resolution (PR 3).
- DELETE region verification (PR 2).

## Design

### Key resolution

`S3StateBackend` gains a constructor parameter or method to resolve keys
based on `(stackName, region)`. Reads use the following lookup order:

1. New key: `cdkd/{stackName}/{region}/state.json`
2. Legacy key: `cdkd/{stackName}/state.json` (only if region matches the
   `region` field of the legacy state body)

If a legacy key is found and the caller is a write path, the legacy state is
copied to the new key and the legacy key is deleted in the same write turn.

### Schema version

```typescript
interface StackState {
  version: 1 | 2;     // 1 = legacy, 2 = region-prefixed
  stackName: string;
  region: string;     // already exists, now load-bearing
  resources: Record<string, ResourceState>;
  outputs: Record<string, string>;
  lastModified: number;
}
```

A `version: 2` reader rejects `version: 3+` with a clear error
(`Unsupported state schema version 3. Upgrade cdkd.`). A `version: 1` reader
in older cdkd binaries already rejects `version: 2` because the legacy code
expects either no version or `version: 1` only.

### Multi-region same-name semantics

When `stackName` resolves to multiple region keys (transient state from an
in-flight `env.region` change), commands behave as follows:

| Command | Behavior |
|---|---|
| `cdkd state list` | One row per region key |
| `cdkd state show <stack>` | If multiple regions, list them and require `--region` |
| `cdkd state resources <stack>` | Same as `state show` |
| `cdkd state rm <stack>` | Removes all region keys (with confirmation) |
| `cdkd state rm <stack> --region X` | Removes only region X |
| `cdkd deploy <stack>` | Synth-driven; `env.region` selects the key |
| `cdkd destroy <stack>` | Synth-driven; `env.region` selects the key |
| `cdkd diff <stack>` | Synth-driven; `env.region` selects the key |

### Lock key

Locks are also region-scoped: `cdkd/{stackName}/{region}/lock.json`. This
means two regions of the same stack name can be operated on in parallel
without contention, which is consistent with the rest of cdkd's parallel
execution model.

## Implementation steps

1. Update `src/types/state.ts` to allow `version: 1 | 2`.
2. Add helper `getStateKey(stackName, region)` returning the new key, and
   `getLegacyStateKey(stackName)` for the old one.
3. Update `S3StateBackend.getState` / `saveState` / `stateExists` to:
   - Read new key first; if missing, try legacy; mark `migrationPending`
     when legacy is used.
   - On save, always write the new key. If `migrationPending`, also delete
     the legacy key after the new write succeeds.
4. Update `LockManager` similarly (region-scoped lock key).
5. Update `S3StateBackend.listStacks` to enumerate both new and legacy
   layouts and produce `{stackName, region}[]`.
6. Update each call site to pass `region` (deploy.ts, destroy.ts, diff.ts,
   state.ts subcommands, force-unlock.ts).
7. Update `cdkd state list` output to include region: `MyStack (us-west-2)`.
8. Update `cdkd state show` / `state resources` to require `--region` when
   ambiguous; emit a clear error listing the candidate regions.
9. Update `cdkd state rm` to remove all region keys by default; accept
   `--region` for scoping.
10. Add unit tests covering each lookup branch, the migration write path,
    and the multi-region listing.
11. Add integration tests:
    - `tests/integration/legacy-state-migration/` — legacy fixture in S3,
      run cdkd, verify auto-migration.
    - `tests/integration/multi-region-same-stack/` — deploy same stackName
      to two regions, verify both states coexist and `state list` shows
      both rows.
12. Update docs: `docs/state-management.md`, `CLAUDE.md`, `README.md`.
13. Add `scripts/verify-bc.sh` (shared with PR 4) — covers the legacy →
    new migration path.
14. Refresh `bc-check` markgate marker via the script.

## Tests

### Unit (Vitest)

- `tests/unit/state/s3-state-backend.test.ts` — extend with cases:
  - getState reads new key when present.
  - getState falls back to legacy and surfaces `migrationPending: true`.
  - saveState writes new key and deletes legacy when `migrationPending`.
  - listStacks merges new and legacy layouts; deduplicates `(stackName,
    region)` pairs.
- `tests/unit/state/lock-manager.test.ts` — region-scoped lock keys.
- `tests/unit/cli/state.test.ts` — output format, `--region` disambiguation.

### Integration (real AWS)

- `tests/integration/legacy-state-migration/` — minimal stack, seed a
  `version: 1` state file in the bucket, run deploy, verify post-state.
- `tests/integration/multi-region-same-stack/` — stack with `env.region`
  changed mid-flight, verify both state files end up coexisting.

## Compatibility verification (Pre-merge checklist)

Run `scripts/verify-bc.sh PR-1` (script lives alongside this PR), or perform
the following manually:

### A. Legacy → New (auto-migration)

- [ ] `pnpm run build`
- [ ] Seed a state bucket with a `version: 1` state at
      `s3://{bucket}/cdkd/MyStack/state.json` (region: us-west-2).
- [ ] `cdkd state list --state-bucket {bucket}`
      Expected: `MyStack (us-west-2)` plus a legacy-format warning in
      `--verbose` output.
- [ ] `cdkd deploy MyStack --state-bucket {bucket}` (no template change)
      Expected: writes `cdkd/MyStack/us-west-2/state.json`; deletes legacy
      `cdkd/MyStack/state.json`.
- [ ] `aws s3 ls s3://{bucket}/cdkd/MyStack/` — only `us-west-2/` is left.

### B. New format (regular operation)

- [ ] Fresh bucket, `cdkd deploy MyStack`.
- [ ] `aws s3 ls s3://{bucket}/cdkd/MyStack/` — `us-west-2/state.json` only.
- [ ] `cdkd state list` → `MyStack (us-west-2)`.
- [ ] `cdkd destroy MyStack` removes both AWS resources and the state key.

### C. Multi-region same stackName

- [ ] Deploy `MyStack` to `us-west-2`, then change `env.region` to
      `us-east-1` in code, deploy again.
- [ ] `aws s3 ls s3://{bucket}/cdkd/MyStack/` — `us-west-2/` and
      `us-east-1/` both present.
- [ ] `cdkd state list` → two rows.
- [ ] `cdkd state rm MyStack` (with confirmation) → both region keys gone.

### D. Cross-version coexistence (silent-failure prevention)

- [ ] An old cdkd binary trying to read a `version: 2` state file produces
      a clear error and exits non-zero (no silent fallback).

## Documentation updates

- `docs/state-management.md` — bucket structure section: new key layout,
  legacy migration, schema version, multi-region semantics.
- `CLAUDE.md` — Important Implementation Details: state key layout includes
  region; transient multi-region same-name allowed.
- `README.md` — Caveats: same `stackName` in multiple regions becomes
  visible after `env.region` changes; use `cdkd state rm --region X` to
  prune.

## References

- Original silent-failure incident:
  `s3://cdkd-state-{accountId}-us-east-1/cdkd/MyStage-CdkSampleStack/state.json`
  (now cleaned up).
- Related rule in `CLAUDE.md`: "DELETE idempotency (not-found / No policy
  found treated as success)" — this PR's protection complements PR 2's
  region check.
- Legacy `version: 1` schema: `src/types/state.ts:4-12`.

## Follow-ups discovered during implementation

(To be filled in as work progresses.)
