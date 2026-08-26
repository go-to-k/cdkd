---
description: Why an owned-but-cross-region S3 bucket is REFUSED for asset storage and TOLERATED for the state bucket
paths:
  - 'src/assets/asset-storage.ts'
  - 'src/cli/commands/bootstrap.ts'
  - 'src/cli/commands/bootstrap-destroy.ts'
  - 'src/cli/commands/gc.ts'
---

# Asset storage - the owned-but-elsewhere bucket

`BucketAlreadyOwnedByYou` (409) and a cross-region `HeadBucket` redirect are
both **ACCOUNT-global** signals, while a bucket is **regional**. Neither means
"the bucket is in this region". Issue
[#2240](https://github.com/go-to-k/cdkd/issues/2240) fixed that for asset
storage. The same conflation in `S3BucketProvider.create` is issue
[#2227](https://github.com/go-to-k/cdkd/issues/2227), tracked separately and
**not yet on `main`** (PR go-to-k/cdkd#2251 open as of 2026-08-26) -- so do not
read this rule as saying the provider side is already done, and do not import a
helper from it until it lands.

Only the **409** proves ownership. A redirect is emitted by the routing layer
BEFORE `ExpectedBucketOwner` is evaluated, so on the redirect path the bucket
may belong to someone else entirely -- which is why the refusal says "resolves
to a bucket in X" rather than claiming cdkd owns it.

## Why it is reachable at all

The default asset-bucket name embeds the region
(`getCdkdAssetBucketName` -> `cdkd-assets-{acct}-{region}`), which is why this
first read as structurally unreachable. That is only the DEFAULT:
`cdkd bootstrap --asset-bucket <name>` takes a caller-chosen, **region-free**
name, so bootstrapping two regions under one custom name reaches every site
below.

## The two polarities - do not converge them

| bucket | cross-region is | why |
| --- | --- | --- |
| **asset** bucket | **REFUSED** | per-region by design: the marker, the publish path and the template rewrite all assume the bucket sits in the deploy region |
| **state** bucket | **TOLERATED** | one bucket serves the whole account (v2+ region-prefixed keys). `bootstrap.ts` / `bootstrap-destroy.ts` re-point the client at the bucket's own region via `rebuildClientForBucketRegion` |

`emptyAndDeleteBucket` (`bootstrap-destroy.ts`) serves BOTH, so its region
check is an **opt-in `expectedRegion` parameter** the asset caller passes and
the state caller does not. Wiring it always-on would turn
`--include-state-bucket` into a false refusal whenever the pre-resolution
degrades to the ambient client. `tests/unit/cli/bootstrap-destroy.test.ts`
carries a POLARITY CONTROL case that goes red on exactly that mistake.

## Deriving the bucket's region

`assertAssetBucketRegion` (exported from `src/assets/asset-storage.ts`) reads
`x-amz-bucket-region` off the error itself - **measured present on both the
301 and the 409** (real S3, 2026-08-26), so no extra call and no extra IAM -
and falls back to `GetBucketLocation`, folding an empty constraint to
`us-east-1` and the legacy `EU` to `eu-west-1`. That probe runs on a
deploy-region client, so for the very bucket under test it can itself answer a
redirect -- the region is re-read off THAT error before giving up.

**Derive the redirect predicate from the SDK's, and know where it is WIDER.**
`@aws-sdk/middleware-sdk-s3`'s `regionRedirectMiddleware` fires when
`x-amz-bucket-region` is present AND the status is `301`, OR `400` with either
`IllegalLocationConstraintException` or a `HeadBucket` command.
`isCrossRegionRedirect` differs from it on purpose in two ways, and calling it a
"mirror" (as an earlier revision of this file did) is wrong:

- it accepts a `301` on its OWN, header or no header. A header-less `301` still
  needs resolving, and the `GetBucketLocation` fallback is exactly what resolves
  it -- requiring the header there was a regression that sent the caller back to
  the "please report it" wording;
- it accepts ANY header-carrying `400`, dropping the SDK's inner conjunct. That
  conjunct decides whether the SDK should silently RETRY against another region;
  the only thing done here is REFUSE, and a `400` carrying a bucket region is a
  cross-region answer whatever raised it. A same-region `400` folds to
  `actual === want` and falls through to a throw either way -- but note the
  three sites do not throw the SAME object: `ensureAssetStorage` and
  `emptyAndDeleteBucket` rethrow via `normalizeAwsError`, while
  `verifyAssetStorageExists`' non-redirect arm rethrows the raw error. Never an
  adoption, never a skipped teardown.

What must NOT be dropped is the status check itself: a bare "header present"
test would treat a `500` carrying a stray region header as a redirect.

**A same-region re-create is NOT reliably a 200.** Measured 2026-08-26: only
the `us-east-1` legacy endpoint answers `200` to a `CreateBucket` for a bucket
you already own; `ap-northeast-1` and `us-west-2` both answer
`BucketAlreadyOwnedByYou`. So in every region but one, an ordinary same-region
race arrives as a 409, and the guard's region EQUALITY check -- not the error
name -- is what lets it proceed. That check is load-bearing, not a safety net.

Two things it must NOT do:

- **Do not use `resolveBucketRegion`** (`utils/aws-region-resolver.ts`). It
  never throws and returns its `fallbackRegion` on a failed probe, which turns
  a fail-CLOSED guard into a fail-OPEN one. An undeterminable region refuses.
- **Do not use `HeadBucket` to learn the region.** It 301s cross-region and the
  SDK turns the empty-body HEAD into a synthetic `name: 'Unknown'` /
  `message: 'UnknownError'`. The AWS CLI follows the redirect and hides this,
  so a measurement taken with the CLI encodes a wire shape the SDK never
  produces.

## Sites, and the one deliberately left alone

Three sites route through the guard: `verifyAssetStorageExists`' HeadBucket,
`ensureAssetStorage`' HeadBucket `301`, and its `BucketAlreadyOwnedByYou`
create-race swallow (the swallow is the only one that would have ADOPTED the
foreign bucket and run this region's encryption / public-access-block /
deny-external-account PUTs against it). `emptyAndDeleteBucket` is the fourth,
opt-in.

`gc.ts` is **not** wired in, on measurement rather than reasoning: it probes
with `ListObjectsV2`, whose 301 carries a real XML body, so the SDK raises a
genuine `PermanentRedirect` with AWS's own actionable text - and
`normalizeAwsError` passes a non-synthetic error through untouched. There is
no misleading wording to replace there.

`--force` does not license adoption anywhere: it means "re-apply configuration
to the bucket you INTENDED", never "write to a bucket in another region".
