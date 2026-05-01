# PR 99 (future): Backwards-compat removal + final migration command

**Status**: planned (not yet — schedule for 1–2 minor releases after PR 1
and PR 4 land)
**Branch**: `feat/drop-bc-and-migration-command`
**Depends on**: PR 1, PR 4 (must have shipped and been in real use for a
release window)
**Breaking change**: yes (no auto-migration this time)
**Parallel with**: none (this is the final step of the rollout)

## Goal

After users have had one or two releases to organically migrate by virtue
of normal `cdkd deploy` / `destroy` operations:

1. **Drop the legacy read paths**:
   - Legacy state key (`cdkd/{stackName}/state.json`) — added by PR 1.
   - Legacy bucket name (`cdkd-state-{accountId}-{region}`) — added by
     PR 4.
2. **Ship a one-shot migration command** for users whose state was
   never touched in the interim and therefore was not auto-migrated:
   - `cdkd state migrate-keys` (TBD) — bulk migrates legacy state files
     to the new key layout in the same bucket.
   - `cdkd state migrate` — already shipped in PR #66/#68 (v0.13.0 +
     v0.15.0 rename); copies every state file from the legacy-named
     bucket into the new-named bucket.

## Background

This PR is intentionally deferred. The point of the auto-migration paths
in PR 1 and PR 4 is precisely to eliminate the need for a manual migration
command for active users. Only stacks that haven't been touched at all
in the meantime require manual intervention. By the time PR 99 ships,
that population should be small.

## Scope

### In scope

- Remove the legacy lookup branches from
  `src/state/s3-state-backend.ts` (PR 1 territory) and
  `src/cli/config-loader.ts` (PR 4 territory).
- Remove related warning log lines.
- Add `cdkd state migrate-keys` subcommand (state-key layout
  migration; the bucket-name migration `cdkd state migrate` already
  shipped in PR #66/#68).
- Provide a clear pre-removal warning in the previous release ("This is
  the last release that reads legacy state files; run `cdkd state
  migrate-keys` before upgrading").
- Bump the major version (or document as a breaking change in semver-
  appropriate way).

### Out of scope

- Any new functionality.

## Design

### `cdkd state migrate-keys` (TBD, this PR)

```text
$ cdkd state migrate-keys
Scanning bucket cdkd-state-123456789012 for legacy state files...
Found 3 legacy state files:
  - cdkd/MyStack/state.json (region: us-west-2)
  - cdkd/OtherStack/state.json (region: us-east-1)
  - cdkd/Forgotten/state.json (region: us-west-2)
Migrate to new region-prefixed layout? (y/N) y
✓ MyStack       us-west-2   migrated
✓ OtherStack    us-east-1   migrated
✓ Forgotten     us-west-2   migrated
3 files migrated, 0 failed.
```

### `cdkd state migrate` (already shipped in PR #66/#68)

See `src/cli/commands/state-migrate.ts`. Behavior summary:

- Source: legacy `cdkd-state-{accountId}-{region}` (per --region).
- Destination: new region-free `cdkd-state-{accountId}` (created on
  first run with the same versioning / encryption / policy as `cdkd
  bootstrap`).
- Refuses to start if any `**/lock.json` exists in the source.
- Verifies destination object count >= source count before any cleanup.
- Source kept by default; `--remove-legacy` to delete after copy.

## Implementation steps

(Deferred — to be detailed when this PR is opened. Outline:)

1. Remove legacy read branches from S3StateBackend and config-loader.
2. Implement `cdkd state migrate-keys` (single-bucket, key-layout
   migration). The bucket-name migration `cdkd state migrate` already
   shipped in PR #66/#68 and does not need to be re-implemented here.
3. Add a release-notes entry calling out the pre-upgrade migration step.
4. Update docs to remove all mentions of legacy fallback.
5. Track in GitHub issue (created at PR 1 / 4 merge time).

## Tests

(Deferred — to be detailed when this PR is opened.)

## Compatibility verification (Pre-merge checklist)

(Deferred — to be detailed when this PR is opened.)

## Documentation updates

(Deferred.)

## References

- PR 1 introduces the legacy state-key fallback that this PR removes.
- PR 4 introduces the legacy bucket-name fallback that this PR removes.
- A GitHub issue tracks this PR; it is referenced from the
  `// TODO(remove-bc-after-1.x):` comments seeded by PR 1 and PR 4.

## Follow-ups discovered during implementation

(N/A until this PR is opened.)
