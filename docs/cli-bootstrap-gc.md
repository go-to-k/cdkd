---
title: cdkd bootstrap & gc
description: "Provision the cdkd state bucket with cdkd bootstrap, and garbage-collect cdkd-owned storage with cdkd gc."
---

## `cdkd bootstrap`

One-time per-account setup (plus once per additional region for asset
storage). Creates:

1. The S3 **state bucket** (`cdkd-state-{accountId}`, or `--state-bucket
   <name>`) — versioned, AES-256 encrypted, account-only bucket policy.
2. cdkd-owned **asset storage** for `--region`: the asset bucket
   (default name `cdkd-assets-{accountId}-{region}`; AES-256, account-only
   policy, no versioning — assets are immutable content-addressed blobs) and
   the container-asset ECR repo (default name
   `cdkd-container-assets-{accountId}-{region}`; immutable tags), plus the
   per-region bootstrap **marker**
   `s3://{stateBucket}/cdkd-bootstrap/{region}.json` that opts the region
   into cdkd-assets mode. Why: `cdk gc` decides "in use" by scanning
   CloudFormation stack templates — cdkd-deployed stacks have no CFn stack,
   so assets published to the CDK bootstrap bucket/repo look isolated to gc
   and get deleted. cdkd-owned storage is structurally out of gc's reach.
   See [docs/design/1002-cdkd-asset-storage.md](design/1002-cdkd-asset-storage.md).

Flags:

- `--no-assets` — skip step 2 (no asset bucket / ECR repo / marker).
  Explicit opt-out for users who keep CDK bootstrap storage or use a custom
  synthesizer with their own asset destinations. Deploys in the region stay
  in legacy mode (publish to the `assets.json` destinations verbatim).
- `--asset-bucket <name>` / `--container-repo <name>` — custom names for
  the asset bucket / container-asset ECR repo instead of the defaults above.
  The escape hatch when the predictable default S3 name is squatted by
  another account (S3 names are global), and the compliance knob for
  org-wide naming policies (ECR repo names are account-scoped, so the ECR
  half is purely for naming policy). The names are validated before any AWS
  call (S3: 3-63 lowercase letters / digits / dots / hyphens, starting and
  ending with a letter or digit; ECR: 2-256 lowercase letters / digits with
  single `.` `_` `-` `/` separators), written into the bootstrap marker, and
  every consumer (deploy redirect / rewrite, publish, verification,
  `state info`, teardown) reads them from the marker from then on. A plain
  re-run of `cdkd bootstrap` keeps the marker's existing (custom) names.
  Re-bootstrapping a region with names that DIFFER from its marker is a hard
  error (`ASSET_STORAGE_NAME_CONFLICT`) — changing names would strand the
  existing storage and its published assets, so run
  `cdkd bootstrap --destroy --region <r>` first, then re-bootstrap with the
  new names. Rejected in combination with `--no-assets` (which skips the
  asset storage the flags name) and with `--destroy` (teardown reads the
  names from the marker). The deploy-time auto-create always
  uses the default names — custom names require the explicit
  `cdkd bootstrap`. Custom bucket names get the same squatting defense as
  the defaults (owned-elsewhere hard refusal, `ExpectedBucketOwner` on every
  call).
- `--force` — reconfigure existing buckets/repo (re-apply encryption /
  policy / tag-immutability). Without it, existing resources are left
  untouched (re-running bootstrap is idempotent and is the supported way to
  opt an existing account's region into asset storage). Under `--destroy`,
  `--force` instead skips the deployed-stack reference scan (see below).
- `--state-bucket <name>` / `--region <region>` — as documented above;
  `--region` on bootstrap is a real (non-deprecated) option.
- `--destroy` — tear down the region's asset storage instead of creating it
  (see "Teardown" below).
- `--include-state-bucket` — with `--destroy` only: also delete the S3 state
  bucket.

Re-running `cdkd bootstrap` on an already-bootstrapped account does NOT
require `--force` to add the asset storage — the state bucket is simply
left as-is and the asset bucket / repo / marker are created. Accounts
bootstrapped by cdkd versions before 0.232.0 need no manual step at all:
the first `cdkd deploy` into each region auto-creates the storage (see
"Auto-create on first deploy" below); the explicit re-run is the
pre-provisioning alternative. Deploys that opt out stay in **legacy mode**
(publish to the CDK bootstrap destinations, byte-identical to older
versions, plus a one-line `cdk gc` notice naming the region) — nothing
breaks by upgrading the binary alone, and downgrading is safe in either
mode (old binaries ignore the marker; both storages hold the same
content-addressed objects).

Relationship with `cdk bootstrap`: cdkd never uses CDK's bootstrap roles
(it deploys with the caller's credentials) and does not resolve the
template's `BootstrapVersion` parameter, so a region never touched by
`cdk bootstrap` works fine. `cdkd export` hands a stack back to the
CloudFormation / CDK CLI world, where `cdk bootstrap` is the CDK CLI's own
prerequisite again.

Bucket-squatting defense: bootstrap refuses to adopt an asset bucket owned
by another account (predictable-name defense), and cdkd's asset-bucket S3
calls pass `ExpectedBucketOwner`. It also refuses a bucket this account owns
that lives in **another region**
(`ASSET_STORAGE_FOREIGN_REGION_BUCKET`): S3 bucket names
are globally unique, so both `BucketAlreadyOwnedByYou` and a cross-region
`HeadBucket` redirect report ACCOUNT ownership rather than the bucket's
region. The default name embeds the region, but `--asset-bucket <name>` is
caller-chosen and region-free, so bootstrapping two regions under one custom
name reaches this. Unlike the STATE bucket — one per account, so bootstrap
re-points its client at the bucket's own region — asset storage is per-region
by design, and `--force` does not license adopting one from elsewhere.
Deleting the asset bucket/repo while the
marker exists makes deploys fail with a re-bootstrap hint — cdkd never
silently falls back to CDK bootstrap storage once a region is opted in.

`cdkd state info` shows which regions are opted in (`Asset storage:` line /
`assetStorage` JSON field).

### Asset destinations after opt-in (cdkd-assets mode)

Once a region's bootstrap marker exists, every asset-consuming command
redirects **default-bootstrap-shaped** destinations
(`cdk-<qualifier>-assets-…` / `cdk-<qualifier>-container-assets-…` for this
account+region — exactly the population `cdk gc` can delete) to the
cdkd-owned storage, and rewrites the matching template references
(`Code.S3Bucket`, `Code.ImageUri`, `s3.Asset` URLs in env vars, nested-stack
`TemplateURL`, …) to the cdkd names. `objectKey` / `imageTag` (content
hashes) are unchanged. User-chosen storage (custom `fileAssetsBucketName` /
`imageAssetsRepositoryName`, `AppStagingSynthesizer` staging buckets) and
cross-region destinations are never touched — `cdk gc` cannot reach those.

Per-command behavior:

| Command | cdkd-assets mode |
| --- | --- |
| `deploy` | redirect publishes + rewrite templates (incl. nested children); a post-resolution audit fails any resource whose resolved properties still name the CDK bootstrap storage |
| `diff` (incl. `--recursive`) | rewrite, so the shown plan matches what deploy will do (incl. the one-time migration diff) |
| `import` | rewrite the template, but record the **pre-rewrite** values in state so the first post-import `cdkd deploy` repoints the live resources |
| `publish-assets` | redirect via the same table (reads the marker from the state bucket; falls back to legacy with an info line when no state bucket resolves) |
| `synth` / `export` | **unrewritten** — synth prints the CDK app's template; export returns the stack to the CFn/cdk-assets world |
| `destroy` / `state *` / `drift` / `events` | state-driven, unchanged |

The first deploy after opting in shows a one-time "everything with assets
updates" diff — an ordinary in-place UPDATE repointing `Code` / `Image` at
cdkd storage (content identical, no replacement). The first deploy after a
`cdkd import` shows the same diff, for the same reason: state deliberately
records the pre-rewrite references, so that deploy is what actually repoints
the imported resources.

`--use-cdk-bootstrap-assets` (on `deploy` / `diff` / `import` /
`publish-assets`) pins legacy destinations for one invocation even after the
region is opted in; `cdk.json` `context.cdkd.useCdkBootstrapAssets: true`
pins it per app — for apps deployed via both CloudFormation and cdkd during
a migration window. The pin also suppresses the legacy-mode `cdk gc` notice.

### Auto-create on first deploy

`cdkd deploy` into a region that has **no** bootstrap marker auto-creates
the per-region asset storage (asset bucket + container-asset ECR repo +
marker — the same `ensureAssetStorage` path `cdkd bootstrap` uses, including
the squatting defense and marker-written-last ordering) instead of falling
back to legacy mode, so `cdkd bootstrap` stays a true once-per-account step.

- Interactive runs are prompted once per region (`[Y/n]`, default yes);
  `--yes` / non-TTY runs create immediately with an info line.
- A declined prompt or a failed creation (e.g. S3/ECR create denied) falls
  back to legacy mode with an actionable warning — a deploy that worked
  before never starts hard-failing.
- Opt out per invocation with `--no-auto-asset-storage`, or per app with
  `cdk.json` `context.cdkd.autoAssetStorage: false`. The
  `--use-cdk-bootstrap-assets` pin also disables it (the marker is never
  read), as does `--dry-run` (a dry run creates nothing). Only `deploy`
  auto-creates — `diff` / `import` / `publish-assets` never create
  resources.

### Teardown (`cdkd bootstrap --destroy`)

`cdkd bootstrap --destroy --region <r>` is the reverse of bootstrap for ONE
region's asset storage — the cdkd equivalent of deleting the CDK CLI's
`CDKToolkit` stack, replacing the manual `aws s3 rb` / `aws ecr
delete-repository` / marker-delete sequence. It:

1. Empties (all versions + delete markers) and deletes the region's **asset
   bucket**, then force-deletes the **container-asset ECR repo**, then
   deletes the region's bootstrap **marker LAST** — the mirror of the
   create side's marker-written-last ordering, so a crash mid-teardown
   leaves the region consistently opted in (deploys hard-error with a
   re-bootstrap hint rather than silently falling back to legacy mode).
2. Reads the asset bucket / repo **names from the marker**, never from the
   naming convention — compatible with custom asset-storage names. A region
   named by `--region` OR by `AWS_REGION` is lower-cased before it reaches any
   AWS client or the marker key, and both spellings of the key are probed, as
   in `cdkd gc` — with a sharper
   consequence here: an unmatched marker made this command report "nothing to
   delete" and exit 0 while the bucket and repo stayed alive. The marker
   deleted in step 1 is the key the marker was actually READ from, so the
   teardown cannot delete the wrong one. A region bootstrapped under MORE than
   one spelling of its name has more than one marker, and the teardown deletes
   exactly one of them: each survivor is reported with a warning naming its own
   key and the `--region` spelling that reaches it (only that spelling does —
   the canonical key is gone by then). Their asset storage is left standing on
   purpose, since two markers can name two different sets of custom names and
   the marker is the only record of them. The same listing runs when NO marker
   is found under either probed spelling, so a region whose only marker carries
   a third spelling is reported rather than dismissed with "nothing to delete";
   in that case the "re-run `cdkd bootstrap`" hint is withheld, because
   re-bootstrapping would write a second marker with DEFAULT names and the next
   teardown would destroy that storage while the existing marker's survives.
   The listing needs `s3:ListBucket` on the state bucket, which a plain
   `--destroy` did not previously require: without it the teardown still
   proceeds and warns that the check could not be made, while
   `--include-state-bucket` refuses outright
   (`STATE_BUCKET_MARKER_SCAN_FAILED`), since there the listing is the only
   thing preventing sibling markers from being deleted with the bucket.
3. Refuses while any deployed stack's state still references the region's
   asset bucket / repo (running Lambdas keep working after deletion, but a
   future re-deploy / rollback of those stacks would break). The scan
   covers every state file in the bucket regardless of the
   `--state-prefix` it was deployed under. `--force` overrides the scan.
4. Prompts for confirmation with the full deletion plan (`y/N`, default
   No); `--yes` / `-y` skips the prompt. A non-TTY stdin without `--yes` is
   a hard error.
5. Is idempotent: already-missing pieces are skipped with info lines
   (mirror of `ensureAssetStorage`), and every S3 call passes
   `ExpectedBucketOwner` (a foreign bucket squatting the name is refused,
   never deleted).

The **state bucket is kept by default** — it is the account's source of
truth. `--include-state-bucket` opts it into the teardown, and even then
the deletion is refused while ANY stack state exists — under any
`--state-prefix`, the guard lists the whole bucket — (destroy every stack
first; there is no `--force` override) or while any OTHER region still has
a bootstrap marker in the bucket (tear those regions down first — deleting
their markers with the bucket would silently flip them back to legacy
mode). "Other" is decided case-insensitively, so a region whose marker was
written under a different spelling of its own name is not mistaken for a
second region — but the refusal NAMES each one by the spelling its marker
key actually uses, because that is the spelling
`cdkd bootstrap --destroy --region <r>` needs in order to find
it. The same refusal covers
a marker for THIS region under another spelling: the teardown deletes one
marker key, so deleting the state bucket while a sibling is still in it would
remove that record while the asset storage it names survives, nameless.

A region with no bootstrap marker is a no-op (nothing to delete); note the
auto-create-on-first-deploy behavior above will re-create the storage on
the next `cdkd deploy` into the region unless you opt out
(`--no-auto-asset-storage` / `context.cdkd.autoAssetStorage: false`).

## `cdkd gc` (garbage-collect cdkd-owned storage)

`cdkd gc [--region <r>] [--older-than <dur>] [--dry-run] [-y]` deletes
unreferenced objects / images from ONE region's cdkd-owned asset storage
(the asset bucket + container-asset ECR repo created by
`cdkd bootstrap`), **and abandoned custom-resource response placeholders from the
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

