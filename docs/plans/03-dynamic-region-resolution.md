# PR 3: Dynamic region resolution + UnknownError normalization

**Status**: planned
**Branch**: `feat/dynamic-region-resolution`
**Depends on**: none
**Breaking change**: no
**Parallel with**: PR 1, 2, 6, 7

## Goal

Two related fixes:

1. **Dynamic state-bucket region resolution** — When the cdkd CLI's profile
   region differs from the state bucket's actual region, resolve the
   bucket region via `GetBucketLocation` and use it for the state-bucket
   S3 client. Other AWS clients (resource provisioning) keep using the
   stack's `env.region`, unchanged.
2. **`UnknownError` normalization** — Convert AWS SDK v3 synthetic
   `Unknown` / `UnknownError` exceptions into messages keyed off
   `$metadata.httpStatusCode`, so users get actionable text instead of
   the literal string `UnknownError`.

## Background

### Bucket region mismatch

The current default state bucket name is `cdkd-state-{accountId}-{region}`
where `{region}` comes from the CLI's profile region. But a user's profile
region can differ from the bucket's actual region (e.g., they used
`--state-bucket cdkd-state-test` to point at a teammate's bucket; or
the default region was changed locally without re-bootstrapping). The S3
client created with the profile region then issues `HeadBucket` to a
bucket in another region. S3 returns `301 PermanentRedirect` with
`x-amz-bucket-region` set, but the AWS SDK v3 region-redirect middleware
does not handle the empty-body HEAD response cleanly; the protocol parser
falls through to `getErrorSchemaOrThrowBaseException` which produces a
synthetic `name: 'Unknown'`, `message: 'UnknownError'` exception.

### UnknownError surface

The same synthetic error appears in other places where a HEAD response
arrives without a parseable XML body. Today the user sees:

```
StateError: Failed to verify state bucket 'X': UnknownError
Caused by: UnknownError
```

…which is uninformative.

## Scope

### In scope

- New helper `src/utils/aws-region-resolver.ts` exposing
  `resolveBucketRegion(bucketName, opts): Promise<string>`.
  - Uses `GetBucketLocation` (GET, not HEAD — has a body, not subject to
    the same SDK glitch).
  - Caches per-bucket result.
- `S3StateBackend` rebuilds its S3Client using the resolved region before
  any state operation (idempotent).
- New helper `src/utils/error-handler.ts` ➜ `normalizeAwsError(err,
  context)`:
  - Detects `name === 'Unknown'` / `message === 'UnknownError'`.
  - Maps `$metadata.httpStatusCode` to a typed message:
    - 301 → `Bucket '<name>' is in a different region than the client.`
    - 403 → `Access denied to bucket '<name>'. Verify credentials and
      bucket policy.`
    - 404 → `Bucket '<name>' does not exist.`
    - other → `S3 error (HTTP <status>): see CloudTrail for details.`
- `verifyBucketExists` and other state-bucket operations route their
  errors through `normalizeAwsError`.
- bootstrap's pre-existence `HeadBucket` also routes errors through
  `normalizeAwsError`, so `cdkd bootstrap --state-bucket existing-bucket`
  produces a useful message instead of `Unknown: UnknownError`.

### Out of scope

- Default bucket name change (PR 4 — depends on this PR).
- `--region` deprecation (PR 5 — depends on this PR).
- Stack-region resolution (already handled by `env.region`).

## Design

### `resolveBucketRegion`

```typescript
// src/utils/aws-region-resolver.ts
import { GetBucketLocationCommand, S3Client } from '@aws-sdk/client-s3';

const cache = new Map<string, Promise<string>>();

export async function resolveBucketRegion(
  bucketName: string,
  opts: { profile?: string; fallbackRegion?: string } = {},
): Promise<string> {
  if (cache.has(bucketName)) return cache.get(bucketName)!;

  const promise = (async () => {
    // Use a region-agnostic client. us-east-1 works as the default global
    // endpoint for GetBucketLocation.
    const client = new S3Client({
      region: 'us-east-1',
      ...(opts.profile && { profile: opts.profile }),
    });
    try {
      const r = await client.send(new GetBucketLocationCommand({ Bucket: bucketName }));
      return r.LocationConstraint || 'us-east-1';   // empty/null = us-east-1
    } finally {
      client.destroy();
    }
  })();

  cache.set(bucketName, promise);
  return promise;
}
```

### `normalizeAwsError`

```typescript
// src/utils/error-handler.ts (new export)
export function normalizeAwsError(
  err: unknown,
  context: { bucket?: string; operation?: string } = {},
): Error {
  if (!(err instanceof Error)) return new Error(String(err));

  const isUnknown = err.name === 'Unknown' || err.message === 'UnknownError';
  if (!isUnknown) return err;

  const status = (err as any).$metadata?.httpStatusCode;
  const bucket = context.bucket ?? '<unknown bucket>';
  switch (status) {
    case 301: {
      const region = (err as any).$response?.headers?.['x-amz-bucket-region'];
      const where = region ? ` (in ${region})` : '';
      return new Error(
        `Bucket '${bucket}'${where} is in a different region than the client. ` +
        `cdkd resolves this automatically; if you see this message, please report it.`,
      );
    }
    case 403:
      return new Error(`Access denied to bucket '${bucket}'.`);
    case 404:
      return new Error(`Bucket '${bucket}' does not exist.`);
    default:
      return new Error(`S3 error during ${context.operation ?? 'operation'} on '${bucket}' (HTTP ${status}).`);
  }
}
```

### State backend integration

Before the first state operation, `S3StateBackend` resolves the bucket
region and rebuilds its client:

```typescript
async ensureClientForBucket(): Promise<void> {
  if (this.clientResolved) return;
  const region = await resolveBucketRegion(this.config.bucket, this.opts);
  if (region !== this.s3Client.config.region) {
    this.s3Client.destroy();
    this.s3Client = new S3Client({ region, ...this.opts });
  }
  this.clientResolved = true;
}
```

`getState`, `saveState`, `verifyBucketExists`, etc., all call
`ensureClientForBucket()` first.

This client is *only* used for state operations. The provisioning clients
(used by providers) are untouched and continue to use the stack's
`env.region`.

## Implementation steps

1. Add `src/utils/aws-region-resolver.ts` with cache.
2. Extend `src/utils/error-handler.ts` with `normalizeAwsError` and unit
   tests.
3. Modify `src/state/s3-state-backend.ts`:
   - `ensureClientForBucket()` private helper.
   - Call from every public method.
   - Wrap thrown errors via `normalizeAwsError`.
4. Modify `src/cli/commands/bootstrap.ts` to use `normalizeAwsError`
   around its `HeadBucket` pre-check.
5. Update `src/cli/commands/state.ts`'s `setupStateBackend` so the state
   backend is fully ready (including resolution) before any subcommand
   runs.
6. Unit tests:
   - region resolver: cache, fallback, IAM/network failure.
   - normalizeAwsError: each status code, non-Unknown errors are passed
     through.
   - S3StateBackend: client rebuild on region mismatch.
7. Integration: a small fixture bucket in a non-default region
   (`tests/integration/cross-region-state-bucket/`).
8. Docs: `docs/state-management.md`, `docs/troubleshooting.md`.

## Tests

### Unit

- `tests/unit/utils/aws-region-resolver.test.ts`
- `tests/unit/utils/error-handler.test.ts`
- `tests/unit/state/s3-state-backend.test.ts` — extended with mismatched-
  region scenario.

### Integration

- `tests/integration/cross-region-state-bucket/` — bucket in `us-west-2`,
  CLI run with `AWS_REGION=us-east-1`. Expected: `cdkd state list` works
  without manual region setting.

## Compatibility verification (Pre-merge checklist)

This PR does not change on-disk formats. It only fixes runtime behavior.

- [ ] `pnpm run build`
- [ ] `pnpm test` — full suite, no regressions.
- [ ] `pnpm run typecheck`
- [ ] `pnpm run lint`
- [ ] Manual: with profile `us-east-1`, run `cdkd state list
      --state-bucket {bucket-in-us-west-2}`. Expected: no
      `UnknownError`; output succeeds.
- [ ] Manual: with profile `us-east-1`, run `cdkd bootstrap
      --state-bucket {bucket-in-us-west-2}` (already exists).
      Expected: clear "bucket exists in us-west-2" or "access denied"
      message, no `UnknownError`.

## Documentation updates

- `docs/state-management.md` — note that the state bucket can live in any
  region; the CLI auto-detects.
- `docs/troubleshooting.md` — remove or update any guidance that
  recommended setting `--region` to match the bucket region (replaced by
  auto-resolution).
- `CLAUDE.md` — Important Implementation Details: state bucket region is
  resolved dynamically via `GetBucketLocation`; provisioning clients
  continue to use `env.region`.

## References

- Original `UnknownError` reproduction in the rollout discussion (with
  full stack trace from `@aws-sdk/core/.../protocols/index.js:1842:65`).
- AWS SDK v3 region-redirect middleware: known to misbehave on HEAD
  responses with empty bodies.

## Follow-ups discovered during implementation

(To be filled in as work progresses.)
