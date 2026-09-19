---
description: Cross-region owned bucket: REFUSED for assets, TOLERATED for state
paths:
  - 'src/assets/asset-storage.ts'
  - 'src/cli/commands/bootstrap.ts'
  - 'src/cli/commands/bootstrap-destroy.ts'
  - 'src/cli/commands/gc.ts'
---

# The owned-but-elsewhere bucket

`BucketAlreadyOwnedByYou` (409) and a cross-region `HeadBucket` redirect are
ACCOUNT-global signals while a bucket is REGIONAL
([#2240](https://github.com/go-to-k/cdkd/issues/2240)). Only the 409 proves
ownership: a redirect fires before `ExpectedBucketOwner` is evaluated, so the
refusal says "resolves to a bucket in X", not that cdkd owns it. Reachable
because `--asset-bucket` takes a region-free name.

**Do not converge the two polarities.** Cross-region is REFUSED for the ASSET
bucket, per-region by design, and TOLERATED for the STATE bucket, which serves
the account. `emptyAndDeleteBucket` serves both, so its check is an opt-in
`expectedRegion` only assets pass.

`assertAssetBucketRegion` reads `x-amz-bucket-region` off the error and falls
back to `GetBucketLocation`, which can itself answer a redirect — re-read the
region off THAT error before giving up. `isCrossRegionRedirect` is deliberately
WIDER than the SDK's `regionRedirectMiddleware` (a `301` alone, header or not,
and ANY header-carrying `400`): the SDK's extra conjunct only decides whether to
silently RETRY, while the action here is REFUSE. Keep the STATUS check: a stray
header on a `500` is not a redirect.

**A same-region re-create is NOT reliably a 200** — outside `us-east-1` a race
arrives as a 409, so the region EQUALITY check, not the error name, lets it
proceed. Never use `resolveBucketRegion`, which returns `fallbackRegion` on a
failed probe and turns a fail-CLOSED guard fail-OPEN, nor `HeadBucket` to learn
a region: the SDK turns its cross-region 301 into a synthetic `'Unknown'`.

The guard covers both HeadBucket probes and the `BucketAlreadyOwnedByYou`
swallow (the only ADOPTION path). `--force` never licenses one.
