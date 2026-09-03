---
title: cdkd gc
description: "Garbage-collect cdkd-owned storage — unreferenced assets and abandoned custom-resource response placeholders — with cdkd gc."
---

## `cdkd gc` (garbage-collect cdkd-owned storage)

`cdkd gc [--region <r>] [--older-than <dur>] [--dry-run] [-y]` deletes
unreferenced objects / images from ONE region's cdkd-owned asset storage
(the asset bucket + container-asset ECR repo created by
[`cdkd bootstrap`](cli-bootstrap.md#cdkd-bootstrap)), **and abandoned custom-resource response placeholders from the
state bucket** (see
[Custom-resource response placeholders](#custom-resource-response-placeholders)
below). Assets are content-addressed and deliberately never deleted
on `cdkd destroy` (another stack or a future rollback may reference the
same hash), so the storage grows without bound — and `cdk gc` cannot reach
it by design. cdkd can gc it *precisely* because its state files record
exactly which assets are in use.

**Scope**: one region per invocation, resolved as `--region` → `AWS_REGION` →
`AWS_DEFAULT_REGION` → your AWS profile's region → `us-east-1`, with the
reconciliation described under
[`--region` / `AWS_REGION`](cli-reference.md#region-aws-region-every-command) — so a bare
`cdkd gc` collects in the region you actually work in, not in
`us-east-1`. The region gc
reports, the region its clients target and the region its marker key is built
from are **one value by construction** (they used to be resolved
separately and could disagree, so gc read one region's marker and deleted
against another region's endpoints), and the delete plan now names it
explicitly, because with a custom `--asset-bucket` name the plan would
otherwise mention no region at all.

`cdkd bootstrap` WRITES the marker through the same resolver and the same
reconciliation, so the read and write sides cannot drift apart — which is why
this could not be done for gc alone. The resolved region is
lower-cased before it reaches any AWS client or the marker key, and the marker
is looked up under the canonical spelling first and the spelling you passed
second, so `--region US-EAST-1` finds the marker either way; the second probe exists
because `cdkd bootstrap` still keys the marker off its region verbatim. The
asset bucket / repo names are read from the region's bootstrap marker, never
recomputed from the naming convention (custom-name compatible). A region with
no marker has no ASSET storage in scope, and gc says so — it then continues to the
state bucket's response-placeholder sweep rather than returning, because those
objects exist whether or not the region opted in to asset storage. With nothing
to collect on either side it is still a friendly no-op. **CDK bootstrap storage
(`cdk-hnb659fds-*`) is never touched** — that stays `cdk gc`'s job.

**Reference collection**: every state file in the state bucket is scanned
(the whole bucket, so stacks deployed under any `--state-prefix` are
covered — including nested-stack children). References are collected from
each resource's `properties` / `observedProperties` / `attributes` and the
stack `outputs`, matching `{S3Bucket, S3Key}` pairs (Lambda `Code` etc.),
`s3://` URIs, virtual-hosted and path-style `https://...<urlSuffix>`
URLs (query strings stripped), and ECR image URIs by `:tag` and/or
`@sha256:digest`. `<urlSuffix>` matches EVERY partition's suffix
(`amazonaws.com` / `amazonaws.com.cn` / `c2s.ic.gov` / `sc2s.sgov.gov` /
`cloud.adc-e.uk` / `csp.hci.ic.gov` / `amazonaws.eu`), not just the one
the gc region uses — the scan reads state written by any cdkd binary for
any region, and a suffix the matchers miss reads as UNREFERENCED and is
DELETED. ECR hosts
additionally match the FIPS (`<acct>.dkr.ecr-fips.<region>.<urlSuffix>`)
and dual-stack (`<acct>.dkr-ecr.<region>.on.aws`,
`<acct>.dkr-ecr-fips.<region>.on.aws`) endpoints — that list now comes from
the single ECR host FORM TABLE in `src/utils/ecr-uri.ts` rather than a second
copy here, which is what surfaced the dual-stack FIPS form gc had been
missing. ECR
hosts are matched case-INSENSITIVELY, since DNS is — and a matched
`@sha256:` DIGEST is normalized to lower case as it is collected, which the
case-insensitive match alone does NOT give you: a collected digest is compared
for EXACT equality against ECR's always-lower-case `imageDigest`, so an
upper-cased reference would be collected yet unmatchable and the live image
would still be deleted. The `:tag` is deliberately kept verbatim, because ECR
tags ARE case-sensitive.

The three S3 shapes are matched case-insensitively across the HOST too, for the
same DNS reason: the `s3://` / `https`
scheme, the `s3` label, the region and the `<urlSuffix>` all fold. The BUCKET
name folds only where it is a DNS label — the virtual-hosted
`https://<bucket>.s3.<region>.<urlSuffix>/<key>` shape, where an upper-cased
spelling reaches the same live object. It stays EXACT in path style (a PATH
segment) and in an `s3://` URI (the AUTHORITY), which S3 compares byte for byte
and where a case-variant therefore names a different bucket. The object KEY is
kept verbatim in every shape, since S3 keys ARE case-sensitive — the same
collected-yet-unmatchable trap the ECR digest note above describes, in reverse.

### Custom-resource response placeholders

`CustomResourceProvider` PUTs an empty object at
`custom-resource-responses/{requestId}.json` in the **state** bucket before each
invocation, so the handler has a pre-signed URL to write its response to. The
happy paths delete it again; three shapes leave it behind, and previously
nothing collected those:

- an interrupted deploy (Ctrl-C / SIGTERM / a cancelled CI job) between the PUT
  and any cleanup;
- any throw on a path that does not reach a cleanup call;
- a LATE handler PUT, landing after cdkd stopped polling. Of THESE THREE
  stranded shapes it is the only one with CONTENT — an empty body is just a
  storage leak, while a real CloudFormation `Data` payload sitting at a key
  nothing collects is a data-retention question too. Read that scope literally:
  on the HAPPY path the handler's real body is at the key as well, and cdkd
  deletes it there. The sentence is about which of the three LEAKS carries
  content, not about where content occurs.

Every `cdkd gc` run now lists that prefix and collects what is older than
`--older-than`. Two independent things keep an IN-FLIGHT run's key safe: the
**lock guard** below refuses the whole run while any stack holds a lock, and
every deploy that can write one of these keys holds one for its duration; and
the age guard is applied to the object's own `LastModified`, which for a
placeholder is the moment of the PUT that opened the invocation.

Collection is not the whole answer on a VERSIONED bucket, which the state
bucket is (`cdkd bootstrap` turns versioning on). A plain `DeleteObject` there
writes a DELETE MARKER and leaves the body readable through `GetObject` with a
`VersionId`, so previously a collected placeholder
was not gone — for the late-PUT shape above, the handler's full `Data` payload
stayed retrievable by anyone who could read the state bucket. `cdkd gc` now
purges each collected key's noncurrent versions after deleting it, and the
provider's own cleanup does the same for the keys it deletes on the happy path.

That purge needs `s3:ListBucketVersions` and `s3:DeleteObjectVersion` on the
state bucket, which the least-privilege policy in
[state-management.md](state-management.md#security-and-best-practices) did not
previously grant. It fails soft: without those actions the collection still
succeeds and `cdkd gc` still reports the reclaimed bytes, but a warning counts
and names the affected keys, names the two grants, and the bodies stay
retrievable by `VersionId`. Note the two fail differently — a missing
`s3:ListBucketVersions` denies the listing outright, while a missing
`s3:DeleteObjectVersion` comes back as per-key entries in `DeleteObjects`'
`Errors` array with the call itself reporting success, which cdkd reads rather
than treating as a clean run. The purge also runs when the collection PARTIALLY
failed, so keys that were deleted before the failure do not keep their history.

Placeholders appear in the reclaim plan and the byte totals alongside assets,
marked `[abandoned custom-resource response]`, and are covered by `--dry-run`
and the confirmation prompt exactly as assets are.

**This arm is ACCOUNT-scoped, not region-scoped** — the only part of `cdkd gc`
that is. Placeholder keys carry no region, so `cdkd gc --region us-east-1`
collects ones written by deploys into *any* region. It is also gc's only
DESTRUCTIVE call against the state bucket; every other arm only reads from it.
Both follow from what the objects are (cdkd's own transient scratch, not
per-region asset storage), and both are why the sweep matches the producer's own
key shape — `cdkd-{epoch}-{suffix}.json` — rather than deleting everything under
the prefix by age. A stack deployed with a colliding
`--state-prefix custom-resource-responses` therefore keeps its `state.json`.

**Scope**: only the DEFAULT prefix, and only keys matching the producer's shape.
`ProviderRegistry` can be configured with a different `responsePrefix`, and
nothing persists which one a past deploy used, so gc cannot discover a
non-default layout — it under-collects, which is the safe direction. A **corrupt**
bootstrap marker still ends the run before the sweep, unlike a missing one: gc
cannot trust what it knows about the region, and the parse error names the
remedy.

**Guards** (this command deletes data — every ambiguity is biased toward
NOT deleting):

- **Fail safe**: a state file that fails to JSON-parse aborts the whole
  run — deleting on partial knowledge is how a live asset gets deleted.
- **Lock guard**: any stack lock (`lock.json`) in the state bucket aborts
  with a listing of the locked stack(s) — a deploy in flight may have
  published assets whose state write has not landed yet, and may be about to
  write a custom-resource response placeholder. This runs BEFORE the
  bootstrap-marker check, so it also covers a region with no asset storage.
- **Age guard**: `--older-than <dur>` (default `30d`, accepts `<n>d` /
  `<n>h`) — an object (`LastModified`) / image (`imagePushedAt`) newer
  than the cutoff is never deleted, even when unreferenced. Protects
  in-flight publishes and recent rollback targets. Missing timestamps are
  treated as "new" (kept). It applies to custom-resource response
  placeholders on the same terms, and the boundary is inclusive-KEEP: an
  object exactly AT the cutoff survives.
- **Ownership**: every S3 call pins `ExpectedBucketOwner`; a 403 on the
  asset bucket is a foreign-bucket refusal (never deleted).

**Reporting + confirmation**: the reclaim plan (per-item key / tag+digest,
size, age) and byte totals are printed first. `--dry-run` prints the plan
and exits without prompting or deleting. Otherwise an interactive
`Continue? (y/N)` prompt (default No) gates the deletion; `--yes` / `-y`
skips it, and a non-TTY stdin without `--yes` is a hard error. Zero
candidates → info line, exit 0, no prompt. Deletion is chunked
(`DeleteObjects` 1,000 keys / `BatchDeleteImage` 100 images per call) and
any per-item failure is surfaced as a hard error.

**Upgrade note for CI**: "zero candidates" is a WIDER question than it used
to be. The
count also includes the state bucket's abandoned custom-resource response
placeholders, which accumulate account-wide and independently of whether any
region opted in to cdkd asset storage. A non-interactive run without `-y`
that used to exit `0` on an account with nothing to collect can therefore
now find a backlog of them and hard-error `NON_INTERACTIVE_CONFIRM` on its
first post-upgrade invocation. That is the intended consent posture — this
is the one arm of `gc` that deletes from the STATE bucket — but a cron that
calls `cdkd gc` bare and expects a quiet exit `0` needs `-y` (to collect) or
`--dry-run` (to keep reporting only).

Also accepts `--state-bucket`, `--profile`, `--role-arn`, `--verbose`.

**Reference shapes covered**: `{S3Bucket, S3Key}` / `{Bucket, Key}` (and any
other object shape carrying the asset bucket name as a value — every sibling
string is protected), `s3://` URIs, virtual-hosted and path-style `https`
URLs, ECR image URIs by tag and/or digest, content-addressed
`<sha256>.<ext>` tokens anywhere in a state string (protects keys embedded
in joined lists), and references inside base64-encoded values (one decode
level — covers `Fn::Base64`-resolved EC2 / ASG UserData fetching assets at
boot).

**Known limitation**: an UNTAGGED child manifest of a referenced multi-arch
/ attestation image index is not individually protected (references point at
the index). cdkd's own image publisher builds single-manifest images
(`BUILDX_NO_DEFAULT_ATTESTATIONS=1`), so this only affects images
hand-pushed into the cdkd repo — keep those out of gc'd repos or reference
them by digest in a deployed stack.
