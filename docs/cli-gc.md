---
title: cdkd gc
description: "Garbage-collect cdkd-owned storage — unreferenced assets and abandoned custom-resource response placeholders — with cdkd gc."
---

# cdkd gc

`cdkd gc` deletes unreferenced objects and images from ONE region's cdkd-owned
asset storage — the asset bucket and container-asset ECR repo created by
[`cdkd bootstrap`](cli-bootstrap.md#cdkd-bootstrap) — and abandoned
custom-resource response placeholders from the state bucket. Reach for it when
the asset bucket has grown: assets are content-addressed and deliberately never
deleted on `cdkd destroy`, because another stack or a future rollback may
reference the same hash.

```bash
cdkd gc --dry-run                  # print the reclaim plan, delete nothing
cdkd gc                            # collect, with a confirmation prompt
cdkd gc --yes                      # collect without prompting (CI)
cdkd gc --region us-west-2         # collect another region's asset storage
cdkd gc --older-than 7d            # shrink the protective age window
```

`cdk gc` cannot reach cdkd-owned storage by design. cdkd can collect it
*precisely*, because its state files record exactly which assets are in use.
**CDK bootstrap storage (`cdk-hnb659fds-*`) is never touched** — that stays
`cdk gc`'s job.

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `--region <region>` | see [Scope](#scope) | Region whose cdkd asset storage to collect. |
| `--older-than <duration>` | `30d` | Never delete an object or image newer than this, even when unreferenced. Accepts `<n>d` / `<n>h`. |
| `--dry-run` | off | Print the reclaim plan and exit, without prompting or deleting. |
| `-y`, `--yes` | off | Skip the confirmation prompt. |
| `--state-bucket <bucket>` | `cdkd-state-{accountId}` | S3 bucket holding cdkd state. |
| `--profile <profile>` | — | AWS profile. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | IAM role to assume for AWS API calls. |
| `--verbose` | off | Verbose logging. |

## Scope

One region per invocation, resolved as `--region` -> `AWS_REGION` ->
`AWS_DEFAULT_REGION` -> your AWS profile's region -> `us-east-1`, with the
reconciliation described under
[`--region` / `AWS_REGION`](cli-reference.md#region-aws-region-every-command) —
so a bare `cdkd gc` collects in the region you actually work in, not in
`us-east-1`.

The region gc reports, the region its clients target and the region its marker
key is built from are one value by construction, and the delete plan names it
explicitly (with a custom asset-bucket name the plan would otherwise mention no
region at all). `cdkd bootstrap` writes the marker through the same resolver and
the same reconciliation, so the read and write sides cannot drift apart.

The resolved region is lower-cased before it reaches any AWS client or the
marker key, and the marker is looked up under the canonical spelling first and
the spelling you passed second — so `--region US-EAST-1` finds a marker written
under either. The asset bucket and repo names are read from the region's
bootstrap marker, never recomputed from the naming convention, so custom names
work.

A region with **no** marker has no asset storage in scope, and gc says so. It
then continues to the state bucket's response-placeholder sweep rather than
returning, because those objects exist whether or not the region opted in to
asset storage. With nothing to collect on either side it is a friendly no-op. A
**corrupt** marker is different: it ends the run before the sweep, because gc
cannot trust what it knows about the region. The parse error names the remedy.

## Reference collection

Every state file in the state bucket is scanned — the whole bucket, so stacks
deployed under any `--state-prefix` are covered, nested-stack children included.
References are collected from each resource's `properties`,
`observedProperties` and `attributes`, and from the stack `outputs`.

### Reference shapes covered

- `{S3Bucket, S3Key}` / `{Bucket, Key}` pairs (Lambda `Code` and friends), and
  any other object shape carrying the asset bucket name as a value — every
  sibling string in that object is protected.
- `s3://` URIs.
- Virtual-hosted and path-style `https://…<urlSuffix>` URLs, with query strings
  stripped.
- ECR image URIs, by `:tag` and/or `@sha256:digest`.
- Content-addressed `<sha256>.<ext>` tokens anywhere in a state string, which
  protects keys embedded in joined lists.
- References inside base64-encoded values, one decode level deep — this covers
  `Fn::Base64`-resolved EC2 / Auto Scaling UserData that fetches assets at boot.

`<urlSuffix>` matches EVERY partition's suffix (`amazonaws.com`,
`amazonaws.com.cn`, `c2s.ic.gov`, `sc2s.sgov.gov`, `cloud.adc-e.uk`,
`csp.hci.ic.gov`, `amazonaws.eu`), not just the one the gc region uses: the scan
reads state written by any cdkd binary for any region, and a suffix the matchers
miss would read as unreferenced and be deleted.

ECR hosts additionally match the FIPS
(`<acct>.dkr.ecr-fips.<region>.<urlSuffix>`) and dual-stack
(`<acct>.dkr-ecr.<region>.on.aws`, `<acct>.dkr-ecr-fips.<region>.on.aws`)
endpoints.

### Case sensitivity

DNS is case-insensitive and object keys are not, so each shape folds exactly the
parts that name the same live thing and compares the rest byte for byte. Getting
this wrong in either direction deletes a live object: a reference collected in a
spelling the candidate never matches is collected yet unmatchable, and the live
object is deleted anyway.

| Reference shape | Folded to lower case | Compared exactly |
| --- | --- | --- |
| `s3://<bucket>/<key>` | scheme | bucket (the URI authority), object key |
| `https://<bucket>.s3.<region>.<suffix>/<key>` (virtual-hosted) | scheme, bucket label, `s3` label, region, URL suffix | object key |
| `https://s3.<region>.<suffix>/<bucket>/<key>` (path style) | scheme, `s3` label, region, URL suffix | bucket (a path segment), object key |
| `<acct>.dkr.ecr.<region>.<suffix>/<repo>:<tag>` | host | tag |
| `<acct>.dkr.ecr.<region>.<suffix>/<repo>@sha256:<digest>` | host, and the digest is normalized to lower case as it is collected | — |

Two consequences worth spelling out. The bucket name folds only where it is a
DNS label — the virtual-hosted shape, where an upper-cased spelling reaches the
same live object. It stays exact in path style and in an `s3://` URI, which S3
compares byte for byte and where a case-variant names a different bucket.
Conversely an ECR **tag** is kept verbatim, because ECR tags are case-sensitive,
while a **digest** is folded, because it is compared for exact equality against
ECR's always-lower-case `imageDigest`.

## Custom-resource response placeholders

Before each invocation, cdkd's custom-resource provider PUTs an empty object at
`custom-resource-responses/{requestId}.json` in the **state** bucket, so the
handler has a pre-signed URL to write its response to. The happy paths delete it
again. Three shapes leave it behind:

- an interrupted deploy (Ctrl-C, SIGTERM, a cancelled CI job) between the PUT
  and any cleanup;
- any throw on a path that does not reach a cleanup call;
- a **late** handler PUT, landing after cdkd stopped polling. This is the only
  one of the three that can carry content: an empty body is just a storage leak,
  while a real CloudFormation `Data` payload sitting at a key nothing collects is
  a data-retention question too. (On the happy path the handler's real body is at
  that key as well, and cdkd deletes it there.)

Every `cdkd gc` run lists that prefix and collects what is older than
`--older-than`. Two independent things keep an in-flight run's key safe: the
**lock guard** below refuses the whole run while any stack holds a lock, and
every deploy that can write one of these keys holds one for its duration; and the
age guard is applied to the object's own `LastModified`, which for a placeholder
is the moment of the PUT that opened the invocation.

Placeholders appear in the reclaim plan and the byte totals alongside assets,
marked `[abandoned custom-resource response]`, and are covered by `--dry-run` and
the confirmation prompt exactly as assets are.

### Versioned deletes

The state bucket is versioned (`cdkd bootstrap` turns versioning on), so a plain
`DeleteObject` there writes a delete marker and leaves the body readable through
`GetObject` with a `VersionId`. `cdkd gc` therefore purges each collected key's
noncurrent versions after deleting it, and the provider's own cleanup does the
same for the keys it deletes on the happy path. The purge also runs when the
collection PARTIALLY failed, so keys that were deleted before the failure do not
keep their history.

It removes them from the state bucket ONLY. If that bucket is replicated, the
destination keeps its own copies and no cdkd purge can reach them — `cdkd gc`
warns when it detects that; see
[S3 replication defeats the purge](state-management.md#s3-replication-defeats-the-purge-and-cdkd-cannot-fix-it-for-you).

That purge needs `s3:ListBucketVersions` and `s3:DeleteObjectVersion` on the
state bucket — see the least-privilege policy in
[State Management](state-management.md#security-and-best-practices). It fails
soft: without those actions the collection still succeeds and `cdkd gc` still
reports the reclaimed bytes, but a warning counts and names the affected keys and
the two grants, and the bodies stay retrievable by `VersionId`. The two fail
differently — a missing `s3:ListBucketVersions` denies the listing outright, while
a missing `s3:DeleteObjectVersion` comes back as per-key entries in
`DeleteObjects`' `Errors` array with the call itself reporting success, which cdkd
reads rather than treating as a clean run.

### Account scope

**This arm is ACCOUNT-scoped, not region-scoped** — the only part of `cdkd gc`
that is. Placeholder keys carry no region, so `cdkd gc --region us-east-1`
collects ones written by deploys into *any* region. It is also gc's only
destructive call against the state bucket; every other arm only reads from it.

Both follow from what the objects are — cdkd's own transient scratch, not
per-region asset storage — and both are why the sweep matches the producer's own
key shape, `cdkd-{epoch}-{suffix}.json`, rather than deleting everything under
the prefix by age. A stack deployed with a colliding
`--state-prefix custom-resource-responses` therefore keeps its `state.json`.

Only the DEFAULT prefix is swept. The provider registry can be configured with a
different response prefix, and nothing persists which one a past deploy used, so
gc cannot discover a non-default layout. It under-collects, which is the safe
direction.

## Guards

This command deletes data, so every ambiguity is biased toward NOT deleting.

- **Fail safe.** A state file that fails to JSON-parse aborts the whole run.
  Deleting on partial knowledge is how a live asset gets deleted.
- **Lock guard.** Any stack lock (`lock.json`) in the state bucket aborts the run
  with a listing of the locked stacks — a deploy in flight may have published
  assets whose state write has not landed yet, and may be about to write a
  custom-resource response placeholder. This runs BEFORE the bootstrap-marker
  check, so it also covers a region with no asset storage.
- **Age guard.** `--older-than <dur>` (default `30d`, accepts `<n>d` / `<n>h`) —
  an object (`LastModified`) or image (`imagePushedAt`) newer than the cutoff is
  never deleted, even when unreferenced. This protects in-flight publishes and
  recent rollback targets. Missing timestamps are treated as new and kept, and
  the boundary is inclusive-KEEP: an object exactly AT the cutoff survives. It
  applies to custom-resource response placeholders on the same terms.
- **Ownership.** Every S3 call pins `ExpectedBucketOwner`; a 403 on the asset
  bucket is a foreign-bucket refusal, never a deletion.

## Reporting and confirmation

The reclaim plan — per item, with key or tag plus digest, size and age — and the
byte totals are printed first.

- `--dry-run` prints the plan and exits without prompting or deleting.
- Otherwise an interactive `Continue? (y/N)` prompt (default No) gates the
  deletion. `--yes` / `-y` skips it.
- Zero candidates: an info line, exit `0`, no prompt.

Deletion is chunked (`DeleteObjects` at 1,000 keys per call,
`BatchDeleteImage` at 100 images per call) and any per-item failure is surfaced
as a hard error, so gc never reports success while objects remain.

**"Zero candidates" is a wider question than the asset storage alone.** The count
also includes the state bucket's abandoned custom-resource response placeholders,
which accumulate account-wide and independently of whether any region opted in to
cdkd asset storage. So a non-interactive run without `-y` on an account that
looks idle can still find a backlog of them and hard-error. That is the intended
consent posture — this is the one arm of `gc` that deletes from the STATE bucket
— but a cron that calls `cdkd gc` bare and expects a quiet exit `0` needs `-y`
(to collect) or `--dry-run` (to keep reporting only).

## Known limitation

An UNTAGGED child manifest of a referenced multi-arch or attestation image index
is not individually protected, because references point at the index. cdkd's own
image publisher builds single-manifest images, so this only affects images
hand-pushed into the cdkd repo — keep those out of gc'd repos, or reference them
by digest in a deployed stack.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The plan was printed (`--dry-run`), nothing was collectable, the prompt was declined, or every candidate was deleted. |
| `1` | Hard error — the refusals below, plus auth and AWS failures. |

| Refusal | When |
| --- | --- |
| `GC_LOCKED` | A stack in the state bucket holds an active lock. Wait for it, or clear a stale one with `cdkd force-unlock <stack>`. |
| `GC_STATE_UNREADABLE` | A state file is not valid JSON, so its references cannot be read. Repair or remove it, then re-run. |
| `ASSET_STORAGE_FOREIGN_BUCKET` | The asset bucket exists but is not owned by this account, or access is denied. Nothing is touched. |
| `GC_DELETE_FAILED` | One or more objects or images could not be deleted. |
| `NON_INTERACTIVE_CONFIRM` | The confirmation prompt was reached on a non-interactive stdin. Pass `-y` / `--yes`, or `--dry-run` to report only. |
| Corrupt bootstrap marker | The region's marker exists but does not parse. The error names the remedy. |

The full cross-command table is in the [CLI Reference](cli-reference.md#exit-codes).

## Related

- [`cdkd bootstrap`](cli-bootstrap.md) — creates the storage this command collects
- [State Management](state-management.md) — the state bucket, its layout, and the least-privilege policy
- [`cdkd rollback`](cli-rollback.md) — the replay whose asset references the age guard protects
- [CLI Reference](cli-reference.md) — every command and the full exit-code table
