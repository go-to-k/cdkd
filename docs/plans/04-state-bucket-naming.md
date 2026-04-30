# PR 4: Default state bucket name (region-free)

**Status**: planned
**Branch**: `feat/state-bucket-naming`
**Depends on**: PR 3 (dynamic region resolution)
**Breaking change**: yes (auto-detected, gated by `bc-check` markgate)
**Parallel with**: PR 5 (after PR 3 lands)

## Goal

Make the default state bucket name independent of the user's profile region.
After this PR, two teammates with different profile regions look up the
same bucket and share state seamlessly.

```
Before: cdkd-state-{accountId}-{region}
After:  cdkd-state-{accountId}
```

## Background

Discussion scenario:

- One CDK app, stack with `env.region = us-west-2`.
- User A: profile region `us-east-1`. `cdkd bootstrap` →
  `cdkd-state-{acc}-us-east-1`. `cdkd deploy` works.
- User B: profile region `ap-northeast-1`. `cdkd deploy` looks up
  `cdkd-state-{acc}-ap-northeast-1` — does not exist — error.

Two teammates on the same project can't share state without out-of-band
communication. This is the fundamental defect that the region-free name
fixes: S3 bucket names are globally unique, so a single `cdkd-state-{acc}`
name resolves to the same bucket no matter who looks it up.

## Scope

### In scope

- Default bucket name change to `cdkd-state-{accountId}` in
  `src/cli/config-loader.ts`.
- Backwards-compat lookup: if the new name doesn't exist, try the legacy
  `cdkd-state-{accountId}-{profileRegion}` name and use that bucket. Log
  a warning suggesting the user run `cdkd state migrate-bucket` (PR 99).
- bootstrap creates the new name by default.
- Bucket region detection (the new name's region is unknown until
  `GetBucketLocation` runs — this is what PR 3 enables).

### Out of scope

- `--region` deprecation (PR 5).
- Removing legacy lookup permanently (PR 99).
- A `cdkd state migrate-bucket` command (deferred to PR 99).

## Design

### `getDefaultStateBucketName`

```typescript
// src/cli/config-loader.ts
export function getDefaultStateBucketName(accountId: string): string {
  return `cdkd-state-${accountId}`;
}

export function getLegacyStateBucketName(accountId: string, region: string): string {
  return `cdkd-state-${accountId}-${region}`;
}
```

### Lookup chain

In `resolveStateBucketWithDefault` (or whatever the equivalent helper is
named after this PR):

1. If `--state-bucket` is passed, use it as-is (and let PR 3's dynamic
   region resolution figure out the region).
2. If `CDKD_STATE_BUCKET` env var is set, same as #1.
3. If `cdk.json` has `context.cdkd.stateBucket`, same as #1.
4. Otherwise:
   - Get `accountId` from STS.
   - Try `cdkd-state-{accountId}` first (new name).
   - If not found (NoSuchBucket / 404 from `HeadBucket`), try
     `cdkd-state-{accountId}-{profileRegion}` (legacy).
   - If legacy is found, log a warning:
     ```
     Using legacy state bucket name 'cdkd-state-{acc}-us-east-1'.
     The default has changed to 'cdkd-state-{acc}'. Future cdkd
     versions will drop legacy support; consider migrating with
     cdkd state migrate-bucket (coming in a future release).
     ```
   - If neither is found, throw a "run cdkd bootstrap" error pointing at
     the new name.

### bootstrap

```typescript
// in bootstrap command
const bucketName = options.stateBucket ?? getDefaultStateBucketName(accountId);
```

The legacy name is no longer the default for newly bootstrapped buckets.
If a user explicitly passes the legacy name, that still works.

## Implementation steps

1. Update `getDefaultStateBucketName` signature and call sites
   (`src/cli/config-loader.ts`, `src/cli/commands/bootstrap.ts`).
2. Add `getLegacyStateBucketName` helper.
3. Update `resolveStateBucketWithDefault` (or its equivalent) to do the
   new → legacy lookup chain, calling `HeadBucket` (via the existing
   `S3StateBackend.verifyBucketExists`-style code, with the
   `normalizeAwsError` integration from PR 3) to decide whether to fall
   back.
4. Emit the legacy-warning log line via the standard logger.
5. Update bootstrap to use the new name.
6. Update unit tests covering lookup precedence.
7. Add integration test
   `tests/integration/legacy-bucket-name-fallback/` — pre-existing
   bucket with the legacy name; verify cdkd uses it and emits the
   warning.
8. Update docs: `docs/state-management.md`, `README.md`, `CLAUDE.md`.
9. Refresh `bc-check` markgate marker via `scripts/verify-bc.sh PR-4`.

## Tests

### Unit

- `tests/unit/cli/config-loader.test.ts` — extend with cases:
  - new name found → use it.
  - new not found, legacy found → use legacy with warning.
  - neither found → throw "run cdkd bootstrap" error.
  - explicit `--state-bucket` skips the lookup chain.
  - `CDKD_STATE_BUCKET` env var same.
  - `cdk.json` context same.

### Integration

- `tests/integration/legacy-bucket-name-fallback/` — fixture creates the
  legacy bucket via direct AWS calls, runs `cdkd state list`, verifies
  output and warning log.

## Compatibility verification (Pre-merge checklist)

Run `scripts/verify-bc.sh PR-4` or follow these steps manually:

- [ ] `pnpm run build`
- [ ] Fresh AWS account / no existing buckets:
      `cdkd bootstrap` → creates `cdkd-state-{acc}`.
      `cdkd state list` → reads `cdkd-state-{acc}`.
- [ ] Pre-existing legacy bucket only
      (`cdkd-state-{acc}-us-east-1`):
      `cdkd state list` → uses legacy bucket, emits warning.
- [ ] Both buckets exist (mid-migration):
      `cdkd state list` → uses NEW bucket; legacy untouched.
- [ ] `--state-bucket cdkd-state-{acc}-us-east-1` (explicit legacy):
      uses that bucket, no warning (user explicitly chose it).
- [ ] User A (us-east-1) bootstraps; User B (ap-northeast-1) deploys —
      both target the same `cdkd-state-{acc}` bucket. No more split
      state.

## Documentation updates

- `docs/state-management.md` — Default bucket name section: describe new
  name, legacy fallback, migration path.
- `README.md` — Update the section that mentions
  `cdkd-state-{accountId}-{region}` (Caveats / Configuration).
- `CLAUDE.md` — Important Implementation Details: bucket name no longer
  embeds region; legacy fallback is temporary.

## References

- Discussion scenario "User A (us-east-1) / User B (ap-northeast-1)"
  surfaced this defect.
- Default name is currently set in
  [`src/cli/config-loader.ts:99-100`](../../src/cli/config-loader.ts#L99-L100).

## Follow-ups discovered during implementation

(To be filled in as work progresses.)
