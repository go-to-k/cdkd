---
title: State Management
description: "How cdkd manages stack state client-side in S3 — bucket layout, state schema, optimistic locking, and troubleshooting."
---

# cdkd State Management Specification

## Overview

cdkd adopts a state management system with S3 as the backend. Unlike CloudFormation's server-side state management, state is explicitly managed on the client side.

The state bucket is **created by `cdkd bootstrap`** (once per account), not by
the user: bootstrap creates it with versioning, AES-256 encryption, and a
deny-external-access bucket policy. A `cdkd deploy` that finds no state bucket
fails with a "run cdkd bootstrap" error rather than creating one implicitly —
see [Default Bucket Name](#default-bucket-name) below.

## Design Principles

### 1. Use S3 as Single Source of Truth (SSOT)

- Does not depend on other services like DynamoDB
- Leverages S3's high availability and durability
- Simple JSON format that is human-readable

### 2. Optimistic Locking

- Uses S3 Conditional Writes (`If-None-Match`, `If-Match`)
- ETag-based conflict detection
- Lightweight and fast concurrency control

### 3. State Files are Immutable

- New ETag is always generated on update
- Audit trail via timestamps
- Can reference past state for rollback (optional implementation)

## S3 Storage Structure

### Directory Layout

State and lock keys are region-scoped (since schema `version: 2`).
The same `stackName` deployed to two different regions has two independent
state files; changing `env.region` no longer silently overwrites the prior
region's record.

**The key is what decides a record's region, not the `region` field inside
it.** cdkd writes the two to agree — every save stamps the key's region into
the body — so on a record cdkd wrote there is nothing to choose between. When
they *do* disagree, cdkd uses the key's region and prints a warning that the
record was not written by cdkd; the operation then acts on the region you
pointed it at. The warning names the kind of value the body held (`a string`,
`a number`) rather than the value itself, since a region a record supplies can
be chosen by anyone able to write that key; run with `--verbose` to see it. A
body with no `region` at all is read as belonging to its key's region, the
same way a legacy (`version: 1`) record with no region is readable from any
region.

**A destroy and a `cdkd rollback` are the operations that refuse on such a
record**, and only when it still lists resources. Reading a record is safe under either answer,
but DELETING is not: if the key is the dishonest half, every delete would be
issued where the resources are not, come back not-found — which a destroy
reads as "already deleted" — and the run would report success, remove the
record, and leave your resources standing with nothing naming them. cdkd
cannot tell which half is honest, so `cdkd destroy` / `cdkd state destroy`
stop and say so — as does a `cdkd deploy` that removes a nested stack, which
destroys the child's resources through the same path. `cdkd rollback` refuses
for the same reason before replaying anything: its replay deletes and reverts
in the key's region and reads a not-found delete as already rolled back. It
stops saving, keeps the journal and exits partially when the record is
rewritten with a disagreeing `region` while the rollback runs. A record with no
resources is not refused: there is nothing to strand, so cleaning one up still
works. To act on the refusal, destroy
against the region the resources are really in, or correct the record's
`region` field to match the key it is stored under; `cdkd state orphan` still
drops the record and leaves the live resources standing.

```
s3://{STATE_BUCKET}/{STATE_PREFIX}/
  └── {StackName}/
      └── {Region}/
          ├── lock.json               # Exclusive lock information (region-scoped)
          ├── state.json              # Resource state (region-scoped)
          ├── rollback-journal.json   # Transient — between a failed deploy and its
          │                           #   `cdkd rollback`; for a nested stack, also
          │                           #   until its top-level deploy succeeds
          └── create-tokens.json      # Create-token ledger (EFS / FSx / CloudFront
                                      #   OAI); deleted with state.json
s3://{STATE_BUCKET}/cdkd-bootstrap/
  └── {Region}.json          # Asset-storage bootstrap marker
s3://{STATE_BUCKET}/custom-resource-responses/
  └── {RequestId}.json       # Transient — one placeholder per Custom Resource
                             #   invocation, collected by `cdkd gc`
```

The `custom-resource-responses/{requestId}.json` placeholders are written by
`CustomResourceProvider` before each invocation, so the handler has a
pre-signed URL to PUT its `cfn-response` to. They are transient and the happy
paths delete them again, but three shapes strand one: an interrupted deploy
between the PUT and any cleanup, a throw on a path that reaches no cleanup
call, and a LATE handler PUT landing after cdkd stopped polling (the only one
that leaves real `Data` content rather than an empty body). `cdkd gc` collects
the stranded ones — see
[`cdkd gc`](cli-gc.md#custom-resource-response-placeholders) for the
staleness rule and why an in-flight run's key is never taken.

**Deleting one is not the same as removing it, because this bucket is
VERSIONED.** `cdkd bootstrap` turns versioning on, so a plain `DeleteObject`
writes a DELETE MARKER and every earlier version of the key stays readable
through `GetObject` with a `VersionId`. That matters here more than anywhere
else under the state bucket: the object at this key is the handler's FULL
`cfn-response`, `Data` included, so a handler that mints a secret (a generated
password, an issued API key) put that value in the state bucket. Previously
both delete paths — the
provider's own cleanup and `cdkd gc`'s collection — left it retrievable after
reporting the object gone. Both now purge the key's noncurrent versions as
well, scoped to that exact key so a concurrent deploy's live placeholder under
the same shared prefix is never touched.

**This is not the whole account of where that value lives.** A handler-minted
secret returned in `Data` also flows into `state.json` — into the custom
resource's own `attributes`, and into the resolved `properties` of every
resource that consumed it through `Fn::GetAtt`. That is a separate object with
a separate lifetime, and purging the response sidecar does nothing for it.
A handler can
opt those values out of the state file, by declaring the response sensitive —
see [`NoEcho` custom-resource responses](#noecho-custom-resource-responses)
below. Without that declaration the state file still carries the value.

That purge is conditional on `s3:ListBucketVersions` and
`s3:DeleteObjectVersion` on the state bucket — as is every other
noncurrent-version purge cdkd runs (the rollback journal and the bootstrap
marker below, the transient CFn template upload, and the `deployments/` event
store) — see
[Bucket Policy with Least Privilege](#recommended-bucket-policy-with-least-privilege)
— older recommended policies did not grant either. It fails soft by design, because it
runs on a cleanup path that must never abort the operation it follows: without
those actions the deploy, destroy or `cdkd gc` run still succeeds, a warning
names the two grants, and the body stays retrievable by `VersionId`. A purge
that SUCCEEDS still leaves the bodies behind if the state bucket is replicated
— see
[S3 replication defeats the purge](#s3-replication-defeats-the-purge-and-cdkd-cannot-fix-it-for-you).

The `create-tokens.json` sibling is the stack's create-token ledger. EFS file systems, FSx
file systems and CloudFront origin access identities are created with a token
the service binds to the resource for its whole life, so the token decides which
resource a create gets back. The ledger holds a random `nonce` folded into those
tokens, and a `sent` entry per logical id: the token its latest create sent and
when it was first sent, written BEFORE the create is sent. It holds no secret.

- The nonce is replaced whenever cdkd lets go of a resource it made while the
  resource still exists. The ledger is deleted, BEFORE `state.json`, with the
  state record (`cdkd destroy`, `cdkd state destroy`, `cdkd state orphan`, an
  export, a rolled-back first deploy); if it cannot be deleted, the record is
  left in place and the command fails. Its nonce is rotated, and the let-go
  logical id's `sent` entry dropped, by `cdkd orphan` (before it saves the
  record, failing if it cannot) and by a deploy or `cdkd rollback` that keeps a
  resource (`DeletionPolicy: Retain`, `UpdateReplacePolicy: Retain`,
  `cdkd rollback --orphan`). So a file system or identity left behind that way
  does not hold the token the stack's next create sends, and that create makes
  a new one, as the AWS CDK CLI does.
- A `sent` entry is kept until the deploy that wrote it SUCCEEDS and its state
  record names the resource. So a deploy interrupted anywhere -- during the
  create, or after it but before the state record named the resource -- is
  re-run with the same token, and takes the resource that interrupted run made.
- A deploy that finds no state record but a ledger that one was saved under
  (an earlier cdkd version deleted the record and left the ledger) starts a
  fresh ledger instead of resuming, so it does not take over resources that
  deployment kept. A first deploy interrupted before its first state save
  still resumes.
- A ledger cdkd cannot read or write (including one written by a newer cdkd)
  refuses each EFS, FSx and origin access identity create in that deploy,
  naming the stack and the logical id, and is never overwritten: a create sent
  without the ledger's token could not be found again by a re-run. Re-run once
  the ledger is reachable.
- The first time a stack's ledger is started, an EFS create looks up a file
  system holding the token cdkd versions without the ledger sent, and warns
  naming it: an earlier destroy or replacement kept it, or an interrupted
  create left it, and this create does not take it over. It may hold data, so
  inspect it before deleting it. FSx has no lookup by token, so an FSx file
  system left that way is not named.
- `s3:DeleteObject` on the ledger key is required wherever deleting the stack
  record is: a denied delete stops the command before the record is touched,
  even when no ledger exists, because S3 checks the permission first.

The `rollback-journal.json` sibling is written whenever a
deploy ends **without a completed rollback** — a `--no-rollback` failure, a
Ctrl+C interruption, or before an automatic rollback (so a rollback that
dies partway is resumable). It records the exact operations the failed
deploy completed (one `segment` per failed attempt) so `cdkd rollback` can
revert them with no synth. Each segment also
carries the op(s) that **FAILED** mid-deploy (`failedOperations[]` — pre-op
state + attempted properties; an additive field, no `journalVersion` bump)
so `cdkd rollback --revert-failed` can optionally revert them too. The one
place a deploy acts on the journal's contents while provisioning is an `AWS::EC2::SecurityGroupIngress` create that
AWS rejects as a duplicate: from the journal, it adopts the existing rule only
when a segment holds a FAILED attempt of the same logical id at the same rule that
no later completed op of the id superseded. (It also adopts a rule another record
of the same stack already holds, which is state rather than the journal.)
Otherwise it refuses. A completed op is never that
evidence: the failed deploy recorded its resource in state, so a later create of
the id means the resource was reverted, destroyed or replaced. Neither is a failed
CREATE that carries a physical id, nor a failed replacement UPDATE whose physical
id differs from its previous record's: both were recorded in state too. Removing a segment
(a clean rollback's settle, `cdkd rollback`, a nested child's settled or
orphaned segments, a successful deploy whose journal delete failed, or one that
keeps only the resources a failed CREATE made that it could not delete) leaves the
ids of its completed ops on the nearest older
segment (`supersededLogicalIds`, additive, no `journalVersion` bump), so the
attempt a reverted adoption consumed does not count again. `cdkd import` writes the
journal too: before its state write, it records each resource it adopts, as its
logical id, physical id and type, on every segment holding an op of that logical id
(`importedResources`, additive, no `journalVersion` bump), and supersedes each
marked id on the newest segment. `cdkd rollback` then runs none of a marked
segment's ops of that id. It warns about any op that recorded another resource ([`cdkd rollback`](cli-rollback.md#interaction-with-cdkd-import)). A failed op refused because the
resource it met belongs to someone else, or whose write AWS provably did not
apply (one send answered with a 4xx or a throttle), is recorded WITHOUT its
attempted properties, so it is never read back as an attempt; any other
failed write keeps them, since it may have landed. Every completed
UPDATE op additionally records whether the deploy left the OLD physical
resource alive (`oldResourceRetained` — also additive, also no bump; it is read
only for a replacement, but recording it unconditionally is what keeps an
ABSENT value meaning "written by an older binary"), so the
rollback acts on the verdict the deploy reached rather than re-deriving it from
the previous state record, which disagrees on the deploy that adds or removes
`UpdateReplacePolicy: Retain`. It also records the type the resource had BEFORE
the update (`previousResourceType` — additive, no bump): an op's own
`resourceType` is the template's, so after a `Type` change it names only the new
resource, and the rollback needs the old one to pick the provider that
re-creates it. A journal written before that field falls back to the previous
resource record the op already carries. It also records whether the deploy
deleted the old resource BEFORE creating the new one (`oldDeletedBeforeCreate`
— additive, no bump; `--recreate-via-cc-api` / `--recreate-via-sdk-provider`,
the update-unsupported fallback, `--replace`'s delete-first fallback, a child
lost with its re-created parent): the
rollback then deletes the new resource before re-creating the old one, so a
port or name only one of them can hold does not collide. An absent value (an
older binary's journal) keeps the create-first order. It is deliberately **not** part of the state
schema (its own `journalVersion` field, no `StackState.version` bump) and
**not** under the `deployments/` prefix (that layer survives destroy by
design; the journal must not). Lifecycle: created on a failed / interrupted
deploy and before an auto-rollback; each replayed segment is popped; the
object is deleted on the next **successful deploy**, after a **clean
`cdkd rollback`**, and by `cdkd destroy` / `cdkd state destroy`; the last
three first delete (per its `DeletionPolicy`) any resource a failed CREATE
made that only the journal records. A **clean
automatic rollback** deletes such a resource too, then settles the journal to a failed-only
segment instead of
deleting it (`operations: []` plus the remaining failed op records, `reason:
auto-rollback-clean`) so `cdkd rollback --revert-failed` works in the
default deploy flow too. An automatic rollback is clean only with no failed
AND no skipped op: one that left an op unreverted (a `ROLLBACK_RESOURCE_SKIPPED`
event) keeps the full segment, and an attempt that wrote no segment of its
own (nothing completed, and its only failures creates refused before
anything was applied, or a segment write that failed) settles nothing, leaving older segments as they are. A **nested stack** (`{Parent}~{Child}`) differs:
its successful deploy appends a `nested-pending-parent` segment instead of
deleting the journal, and the journal is deleted when its **top-level** stack's
deploy succeeds; the parent's rollback replays it to revert the child (see
[cdkd rollback](cli-rollback.md#known-limitations)). It carries
resolved properties, the **same sensitivity class as `state.json`** (no new
secret-exposure class). Every writer holds the lock of the stack whose journal
it writes — for a nested child's journal, the child's lock — so no optimistic
locking is needed.

**Deleting the journal purges its noncurrent versions too**, on every one of
those paths. The bucket is
versioned, so a plain `DeleteObject` would leave each earlier body readable
through `GetObject` with a `VersionId` — and `failedOperations[]` holds the
attempted properties of the FAILED write verbatim, which is where a literal
password lands when the resource that failed had one. Unlike `state.json`,
whose noncurrent versions ARE the recovery capability versioning exists for
and are left alone everywhere except an explicit
[`cdkd scrub`](cli-scrub.md#what-a-real-run-removes-and-what-it-cannot), the
journal is transient by design, so nothing weighs against removing them. Like the sidecar purge above it fails
soft: without the two version grants the deploy / rollback / destroy still
succeeds and a warning names them.

The `cdkd-bootstrap/{region}.json` marker is written by `cdkd bootstrap`
(unless `--no-assets`) and records that the region opted into cdkd-owned
asset storage — its body names the region's asset bucket
(default `cdkd-assets-{accountId}-{region}`) and container-asset ECR repo
(default `cdkd-container-assets-{accountId}-{region}`; custom names via
`cdkd bootstrap --asset-bucket '<name>'` / `--container-repo '<name>'` —
every consumer reads
the names from the marker, never from the naming convention). Deploys read
the marker per
(account, region) to pick the asset mode: absent → legacy (publish to the
CDK bootstrap destinations verbatim, byte-identical to the behavior before
cdkd-owned asset storage existed);
present → cdkd-assets mode (asset publishing redirects to the cdkd storage
and template references are rewritten to match — see the asset-destinations
section in [`cdkd bootstrap`](cli-bootstrap.md#asset-destinations-after-opt-in-cdkd-assets-mode); no state schema
change, the deployed `properties` simply carry the cdkd names); present but
bucket/repo deleted → hard error
(never a silent fallback). `cdkd bootstrap --destroy` removes the marker and
purges its noncurrent
versions as well — the marker carries no secret (it names the region's asset
bucket and container repo), so that is class completeness rather than a
disclosure fix. The marker deliberately lives OUTSIDE the
`{STATE_PREFIX}/` prefix so stack listing never mistakes it for a stack, and
per-region keys mean concurrent bootstraps of two regions cannot race on a
shared object. `cdkd state info` lists the opted-in regions. Full design in
the [asset-storage design note](design/1002-cdkd-asset-storage.md).

To opt a region back out, `cdkd bootstrap --destroy --region '<r>'` tears
down the region's asset bucket + ECR repo and deletes the marker last
(the reverse of the create-side marker-written-last ordering); add
`--include-state-bucket` to also delete the state bucket once every stack
is destroyed. See the teardown section in
[`cdkd bootstrap`](cli-bootstrap.md#teardown-cdkd-bootstrap-destroy).

Because assets are content-addressed and never deleted on `cdkd destroy`,
the asset bucket / ECR repo grow over time; `cdkd gc` reclaims
unreferenced objects / images by scanning every state file in the state
bucket for asset references (with a 30d default age guard). See the gc
section in
[`cdkd gc`](cli-gc.md).

### Configuration Example

```bash
export STATE_BUCKET="cdkd-state-myteam-1234567890"
export STATE_PREFIX="cdkd"  # Default
```

### Default Bucket Name

When `--state-bucket` / `CDKD_STATE_BUCKET` / `cdk.json
context.cdkd.stateBucket` are all unset, cdkd derives the bucket name from
the caller's STS account ID:

```
cdkd-state-{accountId}
```

The default name is intentionally **region-free**. S3 bucket names are
globally unique, so a single name resolves to the same bucket for every
teammate regardless of their profile region — two engineers with profile
regions `us-east-1` and `ap-northeast-1` see the same state instead of
silently forking into two regional buckets.

The bucket's actual region is not encoded in the name; cdkd resolves it at
runtime via `GetBucketLocation` (see "State Bucket Region" below).

#### Backwards-compat fallback

Pre-v0.8 cdkd used `cdkd-state-{accountId}-{region}` as the default name.
For users who already bootstrapped under that scheme, the lookup chain in
`resolveStateBucketWithDefault` is:

1. Probe `cdkd-state-{accountId}` (current default). If it exists, use it.
2. If not found (`HeadBucket` returns 404 / `NoSuchBucket`), probe
   `cdkd-state-{accountId}-{profileRegion}` (legacy default). If it exists,
   use it and emit a deprecation warning:

   ```text
   Using legacy state bucket name 'cdkd-state-123456789012-us-east-1'.
   The default has changed to 'cdkd-state-123456789012'. To migrate, run:

       cdkd state migrate --region us-east-1

   (add --remove-legacy to delete the legacy bucket after a successful
   copy; legacy support will be dropped in a future release.)
   ```

3. If neither exists, fail with a "run cdkd bootstrap" error pointing at
   the new name.

The legacy fallback is **temporary**. It will be dropped in a future
release together with the `cdkd-state-{accountId}-{region}` legacy
bucket name. Users who already bootstrapped under that name should
migrate via `cdkd state migrate` (see below).

#### Migration path: `cdkd state migrate`

To silence the legacy-bucket warning and move state onto the new
default name:

```bash
# Per-region: run once for each region you have a legacy bucket in.
cdkd state migrate --region us-east-1 --dry-run   # preview
cdkd state migrate --region us-east-1             # copy, keep source
cdkd state migrate --region us-east-1 --remove-legacy  # copy + delete source
```

Behavior:

- Copies every object from `cdkd-state-{accountId}-{region}` (source) to
  `cdkd-state-{accountId}` (destination). The destination is created on
  first run with the same hardening as `cdkd bootstrap` (versioning,
  AES-256, account-only access policy).
- Refuses to start if any `**/lock.json` exists in the source bucket
  (an in-flight `cdkd deploy` / `destroy` would race the copy).
  `cdkd force-unlock '<stack>'` first if a lock is stale.
- After copy, verifies the destination object count is at least the
  source count before any source-bucket cleanup.
- **Source bucket is kept by default**. Pass `--remove-legacy` to delete
  it after a successful copy. The deletion empties every prior version
  and delete-marker (the bucket has versioning enabled), so once
  removed, history is gone — verify the destination first.
- Re-running on the same region is idempotent: `CopyObject` on an
  existing destination key is a no-op for the user.
- Multi-region setups: invoke the command **once per region**. The
  destination bucket is reused across runs.

Manual fallback (equivalent shell):

```bash
aws s3 mb s3://cdkd-state-{accountId} --region us-east-1
aws s3 sync s3://cdkd-state-{accountId}-us-east-1 s3://cdkd-state-{accountId}
aws s3 rb s3://cdkd-state-{accountId}-us-east-1 --force   # only if you're sure
```

### State Bucket Region

The state bucket can live in any AWS region — it does not have to match
your CLI's profile region or the regions you deploy stacks into. cdkd
auto-detects the bucket's region via `GetBucketLocation` (a GET, not a
HEAD — has a body and avoids the AWS SDK v3 region-redirect parsing
glitch on empty-body 301 HEAD responses) and rebuilds its state-bucket
S3 client to that region before any state operation.

All four S3 consumers of the state bucket do this: the state backend
(`state.json` reads/writes), the lock manager
(`lock.json` acquire/release — previously state
operations succeeded against a cross-region bucket but every lock
acquisition failed with S3's 301 PermanentRedirect), the exports
index store (`_index/{region}/exports.json` writes/removes for
`Fn::ImportValue` tracking — previously the index
write/remove also hit the 301; non-fatal, so the cross-region index was
silently never maintained), and the custom-resource response path
(`custom-resource-responses/*.json` placeholder writes + the pre-signed
`ResponseURL` the Lambda handler PUTs its cfn-response to —
previously a cross-region deploy of any stack carrying a
Lambda-backed Custom Resource failed hard with the 301, because the
pre-signed URL was signed against the deploy region's endpoint). A
SUCCESSFUL bucket-region lookup is cached per bucket name for the process
lifetime, so all four consumers share a single `GetBucketLocation`
call. A FAILED probe is deliberately not cached: the resolver never
throws, so a failure degrades to a best guess, and caching that guess
pinned every later consumer in the process to one transient error's
answer with no way to heal.

The probe itself is aimed at the caller's own region — falling back to
the AWS SDK's region chain (`AWS_REGION`, the shared config profile) and
only then to `us-east-1`. `GetBucketLocation` is answered by any regional
S3 endpoint for a bucket in the same partition, so the probe never needs
to know the answer to ask the question; it does have to REACH the right
partition, and the hardcoded `us-east-1` endpoint it previously used
is unreachable from `aws-cn` / `us-iso*` — so outside the
commercial partition the probe could not run at all and every consumer
above silently proceeded against the commercial default.

This is intentionally scoped to the state-bucket S3 clients only.
Provisioning clients (Cloud Control API, Lambda, IAM, etc.) continue to
use the stack's `env.region` so resources are still created in the
region the CDK app declares.

Result:

```
s3://cdkd-state-myteam-1234567890/cdkd/
  ├── MyAppStack/
  │   └── us-east-1/
  │       ├── lock.json
  │       └── state.json
  └── DatabaseStack/
      ├── us-east-1/
      │   ├── lock.json
      │   └── state.json
      └── us-west-2/         # same stackName, different region — independent
          ├── lock.json
          └── state.json
```

### Legacy layout (`version: 1`) — read path only

State files written by early cdkd versions used a flat per-stack layout:

```
s3://{STATE_BUCKET}/{STATE_PREFIX}/
  └── {StackName}/
      ├── lock.json      # not region-scoped
      └── state.json     # version: 1, region recorded inside the body
```

cdkd still **reads** this layout (looking up the legacy key only when its
embedded `region` field matches the requested region), and the next write
auto-migrates: it writes the new region-scoped key, then deletes the legacy
key. The legacy read path is temporary and will be removed in a future
release.

An older cdkd binary that only knows an earlier version will **fail with
a clear error** if it sees a higher-versioned blob (e.g. `Unsupported
state schema version 3. Upgrade cdkd.`) instead of silently mishandling
unknown fields.

### `version: 3` adds `observedProperties` (v3+ writers)

Schema `version: 3` adds an optional `observedProperties` field to each
`ResourceState`. Writers emit `version: 3` or later. The on-disk key layout
(`cdkd/{stackName}/{region}/state.json`) is unchanged from `version: 2` —
only the per-resource shape grew. v2 readers see a `version: 3` blob and
fail clearly with the same "upgrade cdkd" error as above.

`observedProperties` is the AWS-current snapshot of a resource's
properties as captured by `provider.readCurrentState` immediately after
each successful create / update. The `cdkd drift` comparator prefers it
as the baseline so changes the user did not template (a manual tag added
in the AWS console, an inline policy attached out-of-band, etc.) surface
as drift instead of being silently ignored. Resources with
`observedProperties: undefined` (older state, or providers without
`readCurrentState`) fall back to comparing against `properties`.
One carve-out: a top-level key the template never declared whose
captured value was EMPTY (`[]` / `{}` / `null`) is skipped by the
comparator — such keys are typically populated AFTER the capture by a
sibling resource in the same stack (capacity-provider associations,
standalone lifecycle hooks / security-group rules) or by AWS itself,
and comparing them produced permanent phantom drift that
`drift --revert` then destructively "fixed". An
undeclared key captured with a real value is still compared.

Because it records what AWS returned, `observedProperties` can hold a value
the template never references — a password an operator set in the console
over a placeholder literal, for example. Secret redaction rewrites a value
only where the template spells a `{{resolve:...}}` reference, so such a value
is stored as AWS returned it, by design; see
[`cdkd import`'s note on it](import.md#a-value-your-template-never-references-is-recorded-as-aws-holds-it)
and [Security and Best Practices](#security-and-best-practices).

**v2 → v3 upgrade is automatic on the next `cdkd deploy`.** When the
deploy engine loads state and finds resources without
`observedProperties` (typical the first time you deploy after upgrading
from cdkd <0.47), it kicks off `provider.readCurrentState` for each in
parallel with the rest of the deploy and drains the result into state at
the final save. The deploy critical path does NOT wait on these reads —
the cost is bounded by the longest single `readCurrentState` (~200-300ms
in practice) once at the end of the deploy. NO_CHANGE-only deploys (no
diff to apply) still drain and persist the refreshed baseline so the
next `cdkd drift` run sees a real AWS-current snapshot. Pass
`--no-capture-observed-state` to disable both regular capture and this
upgrade refresh; `cdkd state refresh-observed '<stack>'` remains the
manual / non-deploy path for refreshing the baseline.

### `version: 5` adds `deletionPolicy` / `updateReplacePolicy` (pre-v6 writers)

Schema `version: 5` adds two optional template-attribute fields to each
`ResourceState`: `deletionPolicy` and `updateReplacePolicy`. They mirror the
CloudFormation `DeletionPolicy` / `UpdateReplacePolicy` attributes that the
synth template carried at the resource's last successful create / update.
Writers emit `version: 5` or later. The on-disk key layout is unchanged from
`version: 2`; only the per-resource shape grew. v4 readers see a `version: 5`
blob and fail clearly with the same "upgrade cdkd" error.

`DiffCalculator` (v5+) compares both attributes against the template on
every deploy / diff. A change there — typically a user removing
`removalPolicy: RemovalPolicy.DESTROY` from a CDK construct (CDK then emits
`DeletionPolicy: Retain` instead of `Delete`) — is now classified as
`UPDATE` rather than silently swallowed as `No changes detected`. The
attribute flip has no per-resource AWS API, so cdkd's deploy engine
refreshes the cdkd state record only — no provider call. **v4 → v5
upgrade is automatic on the next `cdkd deploy`**: state-update sites write
the current template attributes (or `undefined` when the template does not
carry the attribute) into the resource record, and the next deploy's
comparator has a real baseline to diff against. **`cdkd destroy` and
`cdkd state destroy`** honor `state.deletionPolicy` for the
`Retain` / `RetainExceptOnCreate` skip (the AWS resource is kept; the
cdkd state record is dropped). Both read `state.deletionPolicy` only,
never the template's attribute, so pre-v5 state has no signal to skip on
(redeploy under v5 to populate the field). A deploy's DELETE of a resource
removed from the template falls back to the template's `DeletionPolicy`
when state has no recorded value. With no recorded policy, an `AWS::RDS::DBCluster` or a
standalone `AWS::RDS::DBInstance` takes CloudFormation's default, `Snapshot`.
`DeletionPolicy: Snapshot` is honored on the same
paths: cdkd creates the final snapshot CloudFormation
promises before deleting (see the "DeletionPolicy: Snapshot" section in
[Destroy flags & guards](cli-destroy.md#deletionpolicy-snapshot-final-snapshots-on-delete-skip-final-snapshot) for the per-type mechanics and the
`--skip-final-snapshot` opt-out).

> **Upgrade note (v4 → v5)** — the **first** `cdkd deploy` after
> upgrading from a v0.99.x binary will classify every resource whose
> template carries a `DeletionPolicy` or `UpdateReplacePolicy` as
> `UPDATE` and print one `↻ <logicalId> attribute update: ...` line +
> a `Updated: N (metadata)` summary entry. **No AWS API call fires for
> any of these resources** — cdkd is just recording the attribute value
> into its own state file so the next diff has a baseline. The deploy
> finishes in seconds regardless of resource count. Subsequent deploys
> only surface `UPDATE` for resources whose template attribute actually
> changed.

### `version: 6` adds `parentStack` / `parentLogicalId` / `parentRegion` (v6+ writers)

Schema `version: 6` adds three optional stack-level fields to `StackState`:
`parentStack`, `parentLogicalId`, `parentRegion`. They are populated **only on
nested-stack child state records** — the
`AWS::CloudFormation::Stack` adoption. Top-level stack state
files leave all three undefined; a v6 reader treats absence as "I am a
top-level stack" (= the default semantics for every state file v1..v5
binaries wrote).

Child state files live at `cdkd/{parentStack}~{parentLogicalId}/{region}/state.json`
— the `~` separator avoids ambiguity with CDK Stage's `/`-separated
display paths. The on-disk shape is otherwise identical to v5.

Writers emit `version: 6` or later. v5 readers see a `version: 6` blob
and fail with the same "upgrade cdkd" error. **v5 → v6 upgrade is
fully transparent** — read a v5 state file with a v6 binary and the
parser tolerates the missing fields (degrades to "top-level stack");
the next write persists `version: 6` silently. No `cdkd state
migrate-schema` command, no env flag, no manual JSON edit. The
[`tests/integration/schema-v5-to-v6-migration/`](https://github.com/go-to-k/cdkd/tree/main/tests/integration/schema-v5-to-v6-migration/)
integ test proves the round-trip against real AWS.

The fields are consumed by
[`NestedStackProvider`](https://github.com/go-to-k/cdkd/blob/main/src/provisioning/providers/nested-stack-provider.ts):
when a parent stack contains an `AWS::CloudFormation::Stack`
resource, the provider runs a recursive child deploy / destroy and the
child's state file lives at
`cdkd/{parentStackName}~{NestedStackLogicalId}/{region}/state.json`
with the three fields populated. Top-level deploys (the common case)
leave the three fields undefined on every write — the v6 reader treats
absence as "I am a top-level stack" and degrades cleanly.

`cdkd import --migrate-from-cloudformation` recursively adopts existing
CFn-managed nested-stack hierarchies — each nested child gets its own v6-keyed state file with all three
parent-link fields populated, and the source CFn stacks are retired via a
single parent-side `DeleteStack` cascade after recursive `DeletionPolicy: Retain`
injection. `cdkd export` of a cdkd-managed nested stack back into
CloudFormation is supported as well — the orchestrator submits one IMPORT changeset per cdkd-managed
stack in leaf-first order, non-leaf parents adopt their just-imported
children via the AWS-docs "Nest an existing stack" pattern, and cdkd
state for every stack in the tree is deleted leaf-first after the
CFn-side IMPORT loop completes. Fresh `cdkd deploy` of new nested
stacks is supported too.

### `version: 7` adds `provisionedBy` (v7+ writers)

Schema `version: 7` adds an optional `provisionedBy` field to each
`ResourceState` — [Provisioning Layers](provisioning-layers.md) covers the same
routing from the user's side. The value is `'sdk'`
(cdkd's preferred fast path — direct synchronous AWS SDK calls) or `'cc-api'`
(the Cloud Control API fallback), i.e. which provisioning layer owns the
resource. A Custom Resource is recorded `'sdk'` too, so the field is always
populated on a v7+ write; it has no SDK-vs-Cloud-Control dichotomy of its own,
so read the value there as "not Cloud Control" rather than as a literal claim
about synchronous SDK calls.

Pre-v7 every resource was implicitly SDK-managed, so a v7 reader treats the
absent field on a
v6-and-earlier record as the legacy SDK default. Precisely, an absent field
means the record is not PINNED: routing re-decides from scratch, so such a
resource can still be auto-routed to Cloud Control by the silent-drop
check — the same decision it got before v7 existed. Only a recorded
`'cc-api'` pins. v7+ writers (`cdkd deploy` and `cdkd import` alike) emit the
field explicitly so the decision is durable across deploys.

The field is **sticky by default**: once a resource is `'cc-api'`, a later
SDK-provider backfill does not by itself migrate it back, because doing that
unconditionally would mean physical-ID churn (destroy + recreate) on every
backfill release. **The stickiness has narrow exemptions**, listed in
`STICKY_CC_MIGRATION_EXEMPT` in
[`src/provisioning/provider-registry.ts`](https://github.com/go-to-k/cdkd/blob/main/src/provisioning/provider-registry.ts) —
consult the constant rather than a list here, since its membership changes.

Every entry must satisfy the same hard requirement: **the SDK provider
addresses the resource by the SAME physicalId the Cloud Control path stored**,
so the re-route costs no churn and the record flips to `'sdk'` transparently on
its next write. That parity is a per-type empirical fact, not an argument, so
each entry names an integration fixture that OBSERVED it on a live resource;
a unit test refuses an entry whose fixture does not exist or has never run.

Entries then differ in WHY they were admitted, and the difference decides how
conditional the escape is:

- **`'cc-broken'`** — Cloud Control cannot correctly manage the type at all, so
  staying pinned keeps a live bug alive. The escape is unconditional.
  `AWS::Scheduler::Schedule` (a schedule in a custom `ScheduleGroup` is
  unaddressable via Cloud Control), `AWS::RDS::DBProxyTargetGroup` (the
  read and delete handlers cannot derive the proxy name from the
  TargetGroupArn), `AWS::Lambda::EventInvokeConfig` (every Cloud Control
  update fails validation) and `AWS::Pipes::Pipe` (a Cloud Control UPDATE
  cannot change a stream or broker source's write-only `SourceParameters`)
  are the members today.
- **`'sdk-coverage'`** — Cloud Control manages the type, apart from at most a
  defect that only an update reaches, and is slower; cdkd has since gained full
  property coverage. The escape is
  conditional on **this resource**: it happens only on a mutating deploy where
  neither the template's property bag nor the recorded one carries a property
  cdkd would silently drop. Reading the recorded bag too is what keeps a
  *removal* deploy correct — a property applied under Cloud Control and since
  deleted from the template still needs Cloud Control to unset it, so the flip
  waits one deploy. `AWS::SNS::Topic` and
  `AWS::ElasticLoadBalancingV2::Listener` are the members today. The listener
  has one more reason to leave: Cloud Control leaves a `ListenerAttributes`
  key removed from the template at its old value, and the SDK provider resets
  it, on the same deploy that flips the record.

When a `'sdk-coverage'` flip is about to happen, `cdkd diff` annotates the
resource `[returning to SDK provider]`, and `--pin-cc-api
<LogicalId>` declines it for that deploy. A `'cc-broken'` entry ignores the
pin — honoring it would re-pin the resource to a handler that cannot manage it.

So a `provisionedBy: 'cc-api'` record is NOT proof the resource will keep being
managed through Cloud Control.

`cdkd destroy` reads the field to pick the delete path, `cdkd drift` to pick
`readCurrentState`, and `cdkd state show` displays it
(`ProvisionedBy: sdk | cc-api | (sdk, legacy default)`).

**v6 → v7 upgrade is fully transparent** — a v6 state file read by a v7 binary
parses with the field undefined, and the next write persists `version: 7`
silently. No command, no flag, no manual JSON edit. The
[`tests/integration/schema-v6-to-v7-migration/`](https://github.com/go-to-k/cdkd/tree/main/tests/integration/schema-v6-to-v7-migration/)
integ test proves the round-trip against real AWS.

### `version: 8` adds `outputReads`

Schema `version: 8` adds an optional stack-level `outputReads` array — one
`StateOutputReadEntry` per `Fn::GetStackOutput` resolution that was served from
a **cdkd state record** during the consumer stack's deploy. Two resolutions are
deliberately NOT recorded, so the array is a subset of the references a
template carries rather than an inventory of them: a **cross-account**
(`RoleArn`) read (deferred to a future bump alongside a `sourceAccountId`
field), and one served by the **CloudFormation fallback**
(the producer is not
cdkd-managed, so cdkd never recreates it and there is no warning to attach the
consumer to). Same-account cross-REGION reads ARE recorded (`sourceRegion`
carries the producer's region). It is the sibling of v4's
`imports`, with one deliberate difference: `outputReads` is **informational
only**. There is no destroy-time refusal for `Fn::GetStackOutput`, because that
intrinsic is a weak reference by design — the producer stays deletable
independently of its consumers. The entries are consumed by
`findDownstreamConsumers` to name affected downstream stacks in the
`--recreate-via-cc-api` / `--recreate-via-sdk-provider` warn block.

The field is omitted from the JSON when the recorded set is empty, so the
on-the-wire shape is byte-identical to v7 for a stack whose references were all
of the two unrecorded kinds above — and for one that uses no
`Fn::GetStackOutput` at all.

**v7 → v8 upgrade is fully transparent** — `outputReads === undefined` on a
pre-v8 record reads as "no `Fn::GetStackOutput` consumers known" and the
enumeration degrades to imports-only (the v4-shipped behavior); the next deploy
under a v8 binary repopulates the field and persists `version: 8` silently. The
[`tests/integration/schema-v7-to-v8-migration/`](https://github.com/go-to-k/cdkd/tree/main/tests/integration/schema-v7-to-v8-migration/)
integ test proves the round-trip against real AWS.

### `version: 9` adds `exportNames`

Schema `version: 9` adds a stack-level `exportNames` array: the keys of
`outputs` that are `Export.Name` aliases, i.e. the ONLY names an
`Fn::ImportValue` may bind to. The `outputs` bag has
always held plain Output names and export aliases side by side, and nothing in
the record said which was which — so the exports index (on update and on
rebuild) and the resolver's `state.json` scan treated EVERY key as an export. A
plain `CfnOutput('VpcId')` in an unrelated stack was indexed as the producer of
export `VpcId`, last writer wins, and a consumer's `Fn::ImportValue: VpcId`
resolved to whichever stack deployed most recently — silently, and to a value
CloudFormation would never hand out (its export namespace is separate from its
output names, and it refuses a second producer of one name). All four readers
— those three plus the `cdkd local` commands' `--from-state` `Fn::ImportValue`
fallback scan — now go through one predicate (`importableOutputKeys` in
`src/types/state.ts`).

Two shapes of the field mean two different things, so unlike `imports` /
`outputReads` an EMPTY array is written, not omitted: `[]` means the stack is
known to export nothing (its plain outputs are not importable), while an
ABSENT field means the set is not known and the record keeps the legacy
"every key is importable" rule. Absent is what a pre-v9 record carries, and
also what a v9 failure-path save writes when it carries a pre-v9 bag forward
unchanged — the set travels with the bag it describes, and cdkd never invents
`[]` for a bag it did not re-resolve.

Two stacks that both EXPORT one name keep the index's latest-writer policy but
now produce a warning on the producer's deploy (and on an index rebuild);
CloudFormation refuses the second producer outright, so rename one of them.
During the upgrade window that warning can also name a stack that merely holds
a same-named PLAIN output under a pre-v9 record — that is its stale entry from
before the field existed, and the stack's next deploy clears it.

**v8 → v9 upgrade is fully transparent** — `exportNames === undefined` on a
pre-v9 record reads as "every output key is importable" (the v8-shipped
behavior), so no existing cross-stack reference breaks; the next deploy of the
producer under a v9 binary writes the set and persists `version: 9` silently.
That includes a deploy with NO template change: the no-change path persists the
set and re-feeds the exports index with the exports only whenever the effective
export set changed while the outputs values did not, so a producer whose
template never changes still stops publishing its plain output names after one
deploy. The same path also handles a **self-named export** toggled on a v9
record — adding or removing `Export.Name` equal to an output's own key rewrites
the same key with the same value (byte-equal bag), and the effective-set
comparison is what persists and re-indexes the flip so a newly-exported name
becomes importable (and a newly-unexported one stops being served). The
[`tests/integration/schema-v8-to-v9-migration/`](https://github.com/go-to-k/cdkd/tree/main/tests/integration/schema-v8-to-v9-migration/)
integ test proves the round-trip against real AWS — and first reproduces the
shadowing under the v8 binary (a consumer bound to a decoy stack's plain
output) before the v9 binary rebinds it to the real export.

**A hand-edited `exportNames` that is not an array reads as an empty set**, not
as an absent one. The distinction matters because absent means "not known" and
falls back to the legacy every-key rule — so reading a corrupt field that way
would republish every plain output name as an export, which is exactly the
shadowing v9 exists to close. A string, a number, an object or `null` there is
therefore read as "this stack exports nothing", and any element that is not a
string is dropped — key lookup coerces rather than throwing, so
`exportNames: [0]` against a bag holding a `"0"` key would otherwise publish
it. A healthy `string[]` is unaffected.

### `version: 10` adds `observedBaselineRefused`

Schema `version: 10` adds a per-resource `observedBaselineRefused` flag, set
by `cdkd import` when it DECLINES to capture an `observedProperties` baseline
for a resource.

`cdkd import` refuses that capture when it cannot vouch that the resource's
recorded `properties` still spell the dynamic reference the template had — a
resolve that threw, one that lost a `{{resolve:` opener, or one that discarded
a subtree it could not prove inert. The redaction protecting a captured
readback is POSITION-based, so an unvouched bag gives it no evidence and the
decrypted value would be written to `state.json` in the clear.

Before v10 the refusal left only `observedProperties: undefined` behind — the
same thing a pre-v3 record and a provider without `readCurrentState` leave —
so the commands whose job is to FILL a missing baseline could not tell a
refusal from a resource that simply never had one, and filled it anyway:

| command | what it did |
| --- | --- |
| `cdkd deploy` (the deploy-start baseline auto-refresh) | captured a readback positioned against the untrusted `properties` |
| `cdkd state refresh-observed` | the same, for every resource in the stack |
| `cdkd drift --accept` | wrote the readback INTO `properties` |
| `cdkd drift --revert` | pushed `properties` to AWS, which can overwrite a live secret with a placeholder the stack never deployed |
| `cdkd drift` (detection) | compared AWS against those properties and printed the live value — a decrypted secret among them — with nothing able to mask it |
| `cdkd import` (a later run) | re-captured a baseline for a resource a SELECTIVE import left in place — its recorded properties are still the ones an earlier run refused |

All six now decline a refused resource. `cdkd drift` reports it under
`notCompared` with the cause `baselineRefused` — it does not read the resource
back from AWS at all, so the live value never enters the report. The three you
invoke to act on that resource — `cdkd state refresh-observed`, `cdkd drift
--accept` and `--revert` — say so at normal verbosity; the deploy-start refresh
and the import skip report only under `--verbose`, since neither is a command
you ran to refresh that resource in the first place.
`cdkd state show` renders an `ObservedBaseline: REFUSED ...` line for one, `cdkd state refresh-observed`
reports them in their own tally rather than as unsupported, and `cdkd export`
lists them apart from the resources a refresh really can help.

**How to clear it** (every refusal but the one class below): deploy a change to the resource. A CREATE, UPDATE or
replacement rebuilds its state record from the template — the evidence the
import lacked — and captures a trustworthy baseline. A NO_CHANGE deploy does
NOT clear it, and neither does re-running `cdkd state refresh-observed`. Until
then `cdkd drift` compares that resource against its recorded properties, as
it did for any resource without a baseline before schema v3.

**One refusal class is NOT cleared by an in-place update**, and the record says
which: `observedBaselineRefusalReason: "unverifiable-parameter"` (an optional
field beside the marker, no version bump — for a record written before it
existed, see the next paragraph). `cdkd import`
writes it when the resource depends on a template parameter whose deployed value
it could not prove equal to the `Default` it bound. `cdkd deploy` binds that same
`Default`, so an update that does not rewrite the parameter-bound property
leaves the deployed value in AWS, and a baseline captured against the
placeholder would record it. For that reason an in-place UPDATE keeps both
fields and takes no readback; a replacement or a fresh CREATE clears them, and
so does a `cdkd import` that re-imports the resource while a CloudFormation
stack proves the parameter (a re-import with no such stack carries them forward
on an unchanged physical id). The reason is never present without the marker.
A cdkd binary that writes `version: 10` but predates the reason field ignores
it and clears the marker on any UPDATE, and 0.290.36 — which has the field —
still clears a marker recorded WITHOUT one (next paragraph). So do not deploy
such a stack with any cdkd older than the one that reads a reason-less marker
fail closed.

Every refusal cdkd writes now carries a reason: `"incomplete-resolution"` is the
other class (the import-time resolve threw, lost a `{{resolve:` reference, or
discarded part of the properties), which an UPDATE clears as described above.
A marker with NO reason was written by an older cdkd and does not say
which class it is — 0.290.35 wrote unverifiable-parameter refusals that way — so
it is read fail closed: when the resource's definition in the template at hand
reads a declared template parameter (or cdkd cannot tell: a template it cannot
read, or an intrinsic it does not know in a template where something reads a
declared parameter), `cdkd
deploy` stamps it `"unverifiable-parameter"` at the start of the deploy and
`cdkd import` carries it as one; otherwise an UPDATE clears it. See
[import.md](import.md) for the cost and the one known gap.

**Migration** is transparent in both directions a user can observe: a `version:
9` record has the field absent, absence means "not refused", and that is
exactly how those commands behaved before the field existed. The next write
persists `version: 10` silently.

As with every bump since v2, an OLDER cdkd binary refuses a `version: 10` blob
with an explicit "upgrade cdkd" error. That refusal is the point here rather
than a side effect — a binary that did not know the flag would ignore it and
refill the refused baseline — but it is a **trade, not a free win**, and it is
worth knowing before you upgrade one machine in a fleet: cdkd stamps the
current schema version on every state file it writes, so once a v10 binary has
deployed a stack, every older binary fails on that stack, whether or not it
holds a refused record. Upgrade the whole fleet together.

### `version: 11` stores `NoEcho` values as `***` (current writers)

Schema `version: 11` keeps the value of a `NoEcho: true` template parameter
out of everything cdkd writes down. Before it, cdkd masked such a value in its
log output only, and `state.json` held it in the clear wherever a resource or
an output used it.

Where a `NoEcho` parameter supplied a value, cdkd now stores `***`:

| surface | what is stored |
| --- | --- |
| `properties`, `observedProperties` | `***` at every position the parameter fills, whatever the value's type or length (a value embedded in a longer string from 4 characters) |
| `attributes` | `***` for an attribute DECLARED `NoEcho`, whatever its type or length, including one that echoes the value back (an `AWS::SSM::Parameter`'s `Value`); another attribute holding the value is masked from 4 characters |
| `outputs`, the exports index | `***` for an output whose value reads the parameter |
| `rollback-journal.json` | the same masks, for the records and outputs it saves |

A string that only CONTAINS the value is stored as `***` whole, as for a
`NoEcho` custom-resource response (see
[`NoEcho` custom-resource responses](#noecho-custom-resource-responses)).

Two optional per-resource fields record what was masked, and a third how AWS
reports it; none holds any part of a value:

| field | meaning |
| --- | --- |
| `noEchoLeaves` | the positions in `properties` (and so in `observedProperties`) stored as `***` because a `NoEcho` parameter, or an attribute declared `NoEcho`, supplied them; each position is a list of keys and array indexes |
| `noEchoAttributeNames` | the record's own `attributes` its provider declared `NoEcho`: every attribute of a custom resource that answered `NoEcho: true`, a nested stack's masked outputs, and an attribute that echoes a `NoEcho` value. Each is stored as `***` whatever its type or length |
| `noEchoExactEchoLeaves` | the `noEchoLeaves` positions, under a create-only property, at which AWS was seen to report exactly what cdkd sent (no version bump; see the table below) |

An ABSENT field means "not known", which is every record an older cdkd wrote.

#### How a deploy compares a masked value

AWS still receives the real value: cdkd resolves the parameter on every deploy
and sends it. What changes is how a deploy decides whether to send it, since
the record only says `***`. Every resource that reads a `NoEcho` parameter is
re-resolved on every deploy, and:

| the property | what the deploy does |
| --- | --- |
| can be updated, and AWS reports it back | reads the resource back; an unchanged value is skipped, a changed one updated |
| can be updated, but AWS does not report it (write-only, such as an RDS `MasterUserPassword`, or a type cdkd cannot read back) | sends it on every deploy, with one info line per resource saying why |
| cannot change without a replacement (create-only), and AWS was seen to report it exactly | reads the resource back; an unchanged value is skipped, a changed one REPLACES the resource, as before `version: 11` |
| create-only otherwise, including a write-only one or one whose type schema cdkd could not look up | never replaced: when the readback cannot confirm the value, every deploy warns, and `--recreate-via-cc-api` / `--recreate-via-sdk-provider` is how to apply a new value |
| create-only, and the readback FAILED | the resource fails with a message to re-run; it is never replaced on a failed read |

"Seen to report it exactly" is recorded per position in `noEchoExactEchoLeaves`:
a readback handed the
record, which holds `***` there, reported exactly the string cdkd sent. It
describes how the provider reports the property, never the value. The deploy
that creates the resource, or replaces it on a create-only change, reads it
back once to set it, and so does the migration deploy below; any later
readback that holds the value sets it too. A replacement a provider's update
falls back to takes no such readback: the new resource starts without it until
a later readback holds the value. A readback that differs never clears it, and one that fails or cannot
report the property leaves it unset. Only a whole string value under a
create-only property is eligible: a list, a number, or a value inside a list is
never trusted, since a provider may reorder or retype what it reports. Without
it, a provider that normalizes what it reports (lowercases a name, reorders a
list) would read `differs` on an unchanged value and replace the resource on
every deploy, so the warning says the provider is not known to report the
property exactly.

The replacement goes through the same create-first path, stateful-resource
guard (`--force-stateful-recreation`) and name-collision checks as any other.
The approval prompt before the deploy sees no replacement in a diff that
cannot read AWS, so under `--require-approval=destructive` or `any-change` the
deploy asks again when it reaches such a replacement (`--yes` approves it). A
"no", a terminal that cannot be asked, or a resource deadline that already
expired keeps the resource and warns, and
`--recreate-via-*` applies the value.

One case the flag cannot catch: a provider whose readback right after a create
reports exactly what was sent, while AWS normalizes the value later. Each
rotation-free deploy then reads a different value and replaces the resource.
cdkd stores nothing derived from the value, so it cannot tell this from a
change; the stateful-resource guard still stops a stateful type.

A stack whose resources read a `NoEcho` parameter, with nothing else changed,
is reported as `No changes`: those resources are compared as above and do not
count as changes, or as destructive changes for the approval prompt.

A provider can receive `***` as the PREVIOUS value of such a property on an
update whose readback could not confirm it, since the record holds nothing
else. A readback that confirms the value sends nothing.

#### Custom resources that read a `NoEcho` parameter

cdkd cannot read a custom resource back, so its handler is the "AWS does not
report it" row above:

| request | what the handler receives |
| --- | --- |
| `Update` | sent on every deploy: `ResourceProperties` holds the real value, `OldResourceProperties` holds `***` at that position. A `ServiceToken` fed this way is not compared with the record, so a changed value is not refused ([a changed custom-resource ServiceToken](cli-deploy.md#a-changed-custom-resource-servicetoken)) |
| `Delete` | `cdkd destroy` with the app: `ResourceProperties` holds the real value, re-resolved from today's template and parameters. `cdkd deploy --recreate-via-cc-api <logicalId>` re-resolves it the same way: it is the one deploy route that replaces a custom resource still in the template (deleting through its recorded handler and creating through the template's, on the custom-resource provider, so the record stays `provisionedBy: sdk`). No other deploy does (a changed `ServiceToken` is refused, and a `Type` change keeps the skip). Otherwise not sent: the delete is skipped, as for any resource whose DELETE needs a `NoEcho`-filled property (below) |

On a `Delete`, cdkd re-resolves a position only while today's template still
reads a `NoEcho` parameter there, for a resource of the same type, and, where
the record holds the hashes the last deploy took of that property's template
text and of its resolved non-secret inputs (`maskedPropertyFingerprints`,
`maskedPropertyInputFingerprints`), only while today's are the same: a changed
expression, condition, list element, or `Default` of a non-`NoEcho` input is
refused (a `NoEcho` parameter's own `Default` is not hashed, so a change to it
is accepted and the handler gets today's value). A hash the record holds but
cannot compare (a refused one, an input unknown today) refuses too; a property
the record never hashed (an older cdkd) is accepted. On `cdkd destroy` an input
that reads a resource is unknown, so a masked property that also reads one
elsewhere (`Config: {Token: {Ref: P}, Bucket: {Ref: MyBucket}}`) is refused
when the record hashed its inputs.
On `cdkd destroy` the expression must be built from parameters, the pseudo
parameters `AWS::Region`, `AWS::Partition`, `AWS::URLSuffix`, `AWS::AccountId`
and `AWS::StackName`, and literals; a nested stack's child gets the value its
parent's row hands it. The handler receives the value bound TODAY, as a deploy
of that template would send it: if the parameter's value changed since the
last deploy, it is the new one. The delete stays skipped when:

- the command holds no template: `cdkd state destroy`, a deploy that removed
  the resource, and a rollback;
- the position read an attribute a custom resource or nested stack declared
  `NoEcho`, and the template still does: there is no template value to
  re-resolve;
- the template no longer reads a `NoEcho` parameter there, that property's text
  or resolved inputs changed since the last deploy, the resource changed type, the
  template carries a `Transform` (destroy does not expand macros), or it was
  synthesized for another region;
- on `cdkd destroy`, the expression reads anything else (a resource, a
  condition, another stack, a dynamic reference), a parameter cannot be bound,
  or a nested child reads a row parameter its parent could not re-resolve;
- the record holds `***` at a position its `noEchoLeaves` does not name (one
  embedded through `Fn::Join`, or a record an earlier cdkd wrote): nothing
  names what it stood for. A `cdkd deploy` of the app (or, for a record with
  no `noEchoLeaves`, a `cdkd scrub` of the stack) first records the `NoEcho`
  positions, after which `cdkd destroy` sends the delete.

The value goes into the handler's request only; the record keeps `***`. The
warnings, errors and handler log lines cdkd prints are masked like a create's:
a value shorter than 4 characters embedded in a longer line, or one the
handler re-encodes (JSON-escaped quotes or backslashes), can still show.

A handler whose `Update` is not idempotent, or that compares the two bags to
decide what to do, should take a name or an ARN (for example of a Secrets
Manager secret) and read the value itself, rather than the value, which is the
same pattern cdkd already requires for a secure dynamic reference.

`cdkd diff` cannot read AWS, so it compares the masks and says once per stack
how many unchanged resources read a `NoEcho` parameter; that note does not
count as a change for `--fail`.

#### What else changes

- A nested stack's child treats each parameter its parent fills from a `NoEcho`
  source (a `NoEcho` parameter, or an attribute declared `NoEcho`) as a
  `NoEcho` parameter, whatever the child template declares: its records,
  outputs and `cdkd diff` mask and compare that value as above.
- A stack that reads another stack's output served by a `NoEcho` parameter gets
  the value only within ONE `cdkd deploy` run that also deploys the producer;
  a separate run reads `***` and is refused, as for a custom-resource `NoEcho`
  output. Deploy producer and consumer together (`cdkd deploy --all`).
- An `Export.Name` holding a `NoEcho` value is not published (the deploy warns),
  so no consumer can bind to it.
- A resource that reads an attribute a custom resource or a nested stack
  declared `NoEcho`, out of a record an EARLIER run wrote, is refused with the
  attribute named; cdkd does not re-run the producer to recover the value.
  Change the producer in the same deploy (for a custom resource, change one of
  its properties so its handler runs again).
- An attribute that echoes a `NoEcho` value (such as an SSM parameter's
  `Value`) is not refused: when the deploy gave the producer that value, its
  readers are served from an AWS readback of the producer, and the value is
  never written to state.
- `cdkd drift` reports a masked position in its own group, without printing
  either side and without affecting the exit code. `cdkd drift --accept` /
  `--revert` leave such a position alone: the baseline either one rebuilds
  holds `***` there, and `--revert` keeps AWS's value rather than sending the
  mask (see [Redacted (`NoEcho`) baselines](cli-drift.md#redacted-noecho-baselines)).
  A custom-resource mask is still refused by `--accept`; `--revert` refuses it only when it cannot
  tell which live value belongs there. `cdkd export` exports a record whose only masks sit at `NoEcho`
  positions: the exported template reads the parameter.
- A rollback revert reads a masked position back from AWS and sends the value
  AWS holds there, and refuses when it cannot read it (see
  [`cdkd rollback`](cli-rollback.md#known-limitations)).
- The observed baseline (captured at the start of a `cdkd deploy`, or by
  `cdkd state refresh-observed`) is masked at every position where the
  record holds `***`, named in `noEchoLeaves` or not. A leaf that is `***`
  for another reason (a custom resource's `NoEcho` value) is masked there
  too, so `cdkd drift` can report it as drift until a deploy updates or
  replaces that resource. This errs toward hiding a value, never toward
  storing one.
- `cdkd import` and `cdkd scrub` store `***` at every position today's
  template fills from a `NoEcho` parameter, whatever the value's type or
  length, and write `noEchoLeaves` for it, as a deploy does. `cdkd scrub` also
  masks a plaintext the record still holds there (an older `Default`)
  wherever else the same record holds it, and a declared output the parameter
  serves. A value a nested child received from its parent's row is masked by
  a deploy and by `cdkd scrub` (positioned by the row; see
  [`cdkd scrub`](cli-scrub.md)); `cdkd import` leaves it to a deploy.
- A resource's physical id is never masked, whether it embeds a `NoEcho` value
  or IS one (a name-identified resource, such as an RDS parameter group named
  by the parameter). A `NoEcho` value used as a NAME is published by AWS, and
  the deploy warns once per such resource.
- A resource whose DELETE needs a property a `NoEcho` parameter fills (a name,
  a policy target, or any property of a custom resource, whose handler would
  receive `***`) cannot be addressed from its record, which holds `***`
  (except a custom resource's, re-resolved as described in
  [Custom resources that read a `NoEcho` parameter](#custom-resources-that-read-a-noecho-parameter)).
  `cdkd destroy`, and a deploy that removes the resource, skip that delete,
  keep the record and exit non-zero (a deploy exits zero with
  `--allow-unaddressed`); delete the resource by hand (for a custom resource,
  whatever its handler manages), then drop the record with
  `cdkd state orphan`. When a REPLACEMENT creates the new resource first, the
  delete of the old one is skipped with a warning that it is no longer
  tracked, and it is left in AWS; the resource's row is reported as a partial
  update, and the deploy exits non-zero for it unless `--allow-unaddressed`.
- A `Number` parameter whose resource reports the value back as its STRING
  spelling (`"5432"` for `5432`) never reads as held: an updatable property is
  re-sent on every deploy, and a create-only one is warned about on every
  deploy, with no replacement.

#### What stays in plain text

- A value shorter than 4 characters, or a number, that reaches state other
  than at a position the template names: embedded in a longer string read
  through a declared attribute, or reaching a nested stack's child other than
  through a row parameter the parent fills from a `NoEcho` source (such a
  parameter is positioned like a `NoEcho` one, a list's elements included). A
  value of 4 or more characters is stored as `***` wherever it lands.
- A record the template no longer names (as the same logical id and type),
  such as a resource being deleted, an orphan record, or the previous copy of
  a resource whose type changed, which the rollback journal saves: the
  positions come from today's template.
- Outputs saved after a failed outputs pass, and an output the template
  changed since an older cdkd wrote it.
- An output of fewer than 4 characters, or a number, that a `NoEcho` parameter
  serves in another stack and that a consumer imports (`Fn::ImportValue` /
  `Fn::GetStackOutput`) in the same `cdkd deploy`: the consumer's record holds
  it in the clear.

#### Migration

Nothing to do. A `version: 10` record is read unchanged, and the first
`cdkd deploy` after the upgrade migrates the stack: each unchanged value is
compared with the plaintext the record still holds, which is exactly what cdkd
last sent, so the migration deploy neither updates nor replaces a resource for
it, and its save stores `***` and the new fields. A record that deploy did not
reach is masked by the template's positions too, while the template still
names it as the same logical id and type.

A value that DID change since the last deploy is applied by that first deploy
as before: a replacement where a change to the property replaces the resource,
an in-place update where cdkd updates that property in place. A replacement's
warning names the cause, never the value: "a NoEcho parameter's value changed
since the last deploy" where the property is the parameter itself, otherwise
"the value at its NoEcho position changed since the last deploy". The recorded
plaintext is exact evidence. The same deploy reads each create-only resource
it reaches back once, handed a copy of the record with the plaintext already
masked, to record whether AWS reports the value exactly (above). Later deploys
compare against `***`, and replace a create-only property on a readback only
where that was recorded.

**Rotate any `NoEcho` value a stack ever held in the clear.** Earlier object
versions of `state.json` written before the upgrade still contain it, and cdkd
does not purge them: they are the state's recovery path. Treat the value as
exposed to anyone who can read the state bucket's object versions, as
[`cdkd scrub`](cli-scrub.md) advises for a secret.

As with every bump, an OLDER cdkd binary refuses a `version: 11` blob with the
"Upgrade cdkd" error, so upgrade every machine that deploys the stack together.
A v11 binary stamps `version: 11` on every state file it writes, including by
commands that hold no template (`cdkd state refresh-observed`, `cdkd drift
--accept`, `cdkd orphan`). They do not position a record that has no
`noEchoLeaves`. `cdkd state refresh-observed` masks the baseline it captures
wherever the record names a position, and wherever the record's own property
is already `***`.
`version: 11` alone therefore does not mean a stack's values are masked, and
only a `cdkd deploy` migrates it.

### `skippedOutputs` (informational, no version bump)

An Output the deploy could NOT resolve is SKIPPED — warned about when the
resolver threw, silently when the resolver returned nothing (both under the
default arm; `--strict-getatt` aborts the deploy instead) — and `cdkd deploy`
stores nothing for it, so a bag the deploy re-resolved lacks the key (a
no-change deploy keeps a failed output's stored value, so a key that resolved
on an earlier deploy can keep that value beside a record — the diff then
ignores the record for it). When that
failure belongs to a secret reference — a `{{resolve:secretsmanager:...}}`
naming a JSON key the secret does not hold, or a reference assembled from
another secret's value, refused before its lookup — `cdkd diff` cannot
reproduce it: the diff resolves
outputs with secret references left as their tokens, so the value assembles
cleanly, and the diff used to preview an `ADD` the deploy would never perform
on every run of the unchanged stack, keeping `cdkd diff --fail` red.

`skippedOutputs` is the deploy telling the diff what it learned: each skipped
`Outputs` key mapped to a sha256 over the template inputs its resolution reads
— the output's own entry (`Value`, `Export`, `Condition`) and every top-level
section except `Resources` and the sibling `Outputs` (`Parameters`,
`Conditions`, `Mappings`, ...), digested from the template as handed in,
before any parameter binding or condition evaluation, on both sides. One value
is deliberately excluded: a `NoEcho: true` parameter's `Default` is hashed as a
constant, so this field cannot become a confirm oracle for a low-entropy one.
It is not a claim that the value is otherwise absent from state. Everything
else about such a parameter is still hashed, so only a change to that default
alone fails to un-bind. The diff
previews a recorded key as **absent** — no row, exactly what the next deploy
will leave in state, and the sibling outputs are previewed normally, so a
genuine change beside the broken output still renders and `--fail` still
exits 1 for it — only while the key is still absent from `outputs` AND today's
digest equals the recorded one. Any change to those inputs (the `Value`
repaired, an `Export.Name` added or removed, a parameter default, a condition,
a mapping) puts it back under the ordinary preview rules — usually an `ADD`
row; an intrinsic `Export.Name` the diff still cannot resolve keeps omitting
the section, as it did before this field — and the next deploy re-decides it:
it publishes the output if the repair took, or records it again under the new
digest.

Repairing the RESOURCE an output reads is handled separately, because
`Resources` is deliberately not digested (hashing it would discard the record
on every unrelated resource edit). `cdkd diff` declines to use the record for
an output whose `Value` or `Export.Name` references a logical id this run's
resource diff reports as changing: the deploy that follows re-resolves every
output, so the record cannot speak for it. The test is the reference, not
whether the edit could actually repair the output — undecidable from a
template — so an unrelated edit to a referenced resource also stops the record
binding. Bounded on purpose: that diff already reports the resource's own
change.

Lifecycle: written by every deploy that re-resolves outputs (the changed and
the no-change path alike; the no-change path saves on a record change alone,
and writes THIS pass's record beside the outputs that did resolve, while a
failed output keeps its earlier value — or beside the whole previous outputs
when they cannot be merged safely: a failed output with an earlier value whose
`Export.Name` is an intrinsic, or a save that would put the first secret
reference beside a kept value, checked on the outputs as they will be saved; a
kept value is not repositioned onto a reference from today's template, though
the ordinary secret scan still redacts it), omitted when nothing was skipped, cleared for a key that
resolves or leaves the template, and carried forward unchanged by the saves
that carry the `outputs` bag forward without re-resolving it (a failed
deploy's partial saves, and the snapshot a partial `cdkd destroy` leaves —
every resource it removed returns as a CREATE on the next diff, which un-binds
any record that references it). Every command that rebuilds state OUTSIDE a
deploy DROPS it instead — `cdkd import`, `cdkd drift --accept`,
`cdkd drift --revert`, `cdkd rollback`, `cdkd scrub`, `cdkd orphan` and
`cdkd state refresh-observed`. All but the last can change the values an
output's resolution reads while every resource still reports `NO_CHANGE`, so
the diff has nothing to un-bind on; `refresh-observed` writes only
`observedProperties`, which the resolver does not read, and drops anyway on
any run that refreshed at least one resource (a run that refreshed nothing
keeps the record). The rule is deliberately flat rather than per-command:
of three attempts to argue a particular command safe, two were shown wrong and
the third could not be settled either way. Those keys return to pre-record
behaviour until the next deploy.

**Upgrade is transparent** — the field is absent on a record written before
it existed, the diff then behaves as before, and the next no-change deploy of
the affected stack writes it. **Limitation**: five repairs are invisible to the
digest, so the record stays (and the diff stays silent about that output)
until the next deploy re-resolves it and clears the entry. Two are outside the
template and outside anything the diff looks up: the secret gained the key, or
the SSM parameter was created. One is a nested stack's input VALUE changing on
the parent's side, which the diff does resolve but the digest does not hash,
since hashing supplied values would tie the record to a caller's arguments
rather than to the template. One is cdkd itself being upgraded so that a
provider now builds an attribute an output reads. The fifth is deliberate: a
`NoEcho` parameter's default is masked out of the digest (above), so a change
to that default alone does not un-bind. Where the deploy warns, that
warn names the broken output and `cdkd diff` is not a second signal for it —
but the quiet arm, a resolver returning nothing for an attribute it cannot
construct, emits none, so for that one there is no signal at all until the next
deploy re-resolves the output.

### `conditionVerdicts` (no version bump)

A condition that reads a parameter fed a secret `{{resolve:...}}` reference
has no verdict at plan time: `cdkd diff` never resolves a secret. The deploy
evaluates it against the real value and records, for each such condition the
diff reads (by an `Fn::If`, or a resource's or output's `Condition`), its
`verdict` and a `fingerprint`: `sha256:` over the condition's definition,
every condition it names, and the inputs of the parameters they read. A
secret-fed parameter contributes its `{{resolve:...}}` reference, never its
value, and a value carrying a secret is never an input, except a value equal
to the parameter's `Default`, which is template text. `cdkd diff` reuses a
verdict only when the fingerprint it recomputes is equal; otherwise it takes
the condition's FALSE branch, as before
([`cdkd diff`](cli-diff.md#conditions-over-a-secret-fed-parameter)).

- **Written** by a deploy's final save and by its no-change save (the latter
  also when only the record changed). Only a nested child records anything,
  since only a child receives a secret-fed parameter. A parent skips an
  unchanged nested-stack row, so a child last deployed by an older cdkd gains
  its record on the next deploy that changes it.
- **Dropped** by every other save: the per-resource, rollback and
  output-failure saves rebuild state without it. So a failed or interrupted
  deploy leaves NO record, and the next diff falls back to the FALSE branch,
  never to a stale verdict.
- **No version bump.** An older binary ignores the field and drops it on its
  next save; this binary reads its absence, or any malformed shape, as no
  record. A writer that carries the loaded record forward (rollback, drift,
  scrub, orphan rewrite, `state refresh-observed`) may carry it, since none of
  them changes a definition or an input the fingerprint covers.

### `maskedPropertyFingerprints` / `maskedPropertyInputFingerprints` (no version bump)

A property whose resolved value carries a secret in a form state cannot
record as a reference is persisted as `***`. The common case is the EC2
`UserData` shape: `Fn::Base64` over a script that embeds a
`{{resolve:...}}` reference, whose encoding decodes straight back to the
secret. `***` identifies nothing, so for each such top-level property the
record also keeps two fingerprints of what the property was built from.
`cdkd diff` and `cdkd deploy` treat a property whose recorded fingerprint no
longer matches as changed, so the change is shown and sent. A secret rotated
behind an unchanged template leaves both equal and sends nothing, as
CloudFormation does.

- `maskedPropertyFingerprints` (`sha256:`) hashes the property's template
  TEXT, so an edit to the script around the reference, or a retarget of the
  reference, is sent.
- `maskedPropertyInputFingerprints` (`inputs-sha256:`, then the text hash it
  belongs to after a `+`) hashes the template value with each NON-SECRET input
  replaced by what it resolved to: a parameter's value, a `Ref` /
  `Fn::GetAtt` result (so a `Ref` to a resource the deploy replaced), a
  cross-stack read, and the branch an evaluated condition selects. So a new
  parameter value, a replaced resource's new name and a flipped condition
  are sent too.

Secrets stay in their template form and never reach the hash, decided by
where an input comes from, never by comparing its value with a secret it did
not read. A `{{resolve:...}}` reference is hashed as the reference, a `NoEcho`
parameter as its `Ref`, and these are kept as written:
- a condition that reads a `NoEcho` parameter, a reference, a cross-stack
  value or an attribute (as its whole `Fn::If`);
- a `Ref` / `Fn::GetAtt` to a resource whose own definition reads a secret, a
  `NoEcho` parameter, a cross-stack value, a name the template does not
  declare or an `Fn::FindInMap` over a mapping holding a reference anywhere
  (or one it cannot name), directly or through another resource; a condition
  reading such a mapping is kept whole the same way;
- an `Fn::GetAtt` on a custom resource, whose attributes may be `NoEcho` (its
  physical id is hashed), and one whose attribute NAME is built from any of
  these;
- a nested stack's output (`Fn::GetAtt [Child, Outputs.X]`, or
  `${Child.Outputs.X}` in an `Fn::Sub`) unless it is classified clean, below.
  A resource whose own definition reads a nested stack's output counts as
  reading a secret, as before;
- an input whose resolution read a secret (a `NoEcho` custom resource's
  `Data`, a redacted `***` read), and an attribute that the save redacts
  because the resource it belongs to read that secret in the same deploy;
- in a nested stack, a parameter value its parent passed that the PARENT
  built from any of the above, and every resource and condition that reads
  one. The parent classifies each expression in its stack row's `Parameters`
  by these same rules and hands the result to the child; a value built only
  from non-secret inputs (a `Ref` to a parent resource, say) enters the
  child's hash like any input. A passed value the parent did not classify (a
  rollback, which replays the child without the parent's template) is kept as
  written too, even when it equals the `Default`; the next deploy that
  classifies it sees the property's hash move and sends it once. One the
  parent could not read this time is neither compared nor hashed, nor is a
  property that reads it directly or through a resource or condition. A
  parameter the parent does not pass binds the child's `Default`, which is
  template text, and is hashed.

**Nested-stack outputs.** A masked property that reads a nested stack's
output directly is hashed with the output's value when the output is CLEAN.
The class is read from the templates in the cloud assembly, never from the
child's state, so the deploy (before and after the child runs) and
`cdkd diff` decide it alike. The parent follows the output's `Value` through
the child's template by the rules above, without resolving anything there:
- a parameter the parent passes takes the class the parent gives that value
  (the same class the child is handed); one it does not pass reads its
  `Default`; a `NoEcho` parameter is a secret whatever was passed;
- a `{{resolve:...}}` reference, a cross-stack read, a name the child does
  not declare, a resource whose definition reads any of these, an
  `Fn::FindInMap` over a mapping that holds a reference anywhere, and an
  attribute of a custom resource keep the output as written;
- an `Fn::If` is clean only when its condition reads only clean inputs and
  both branches are clean, since the child's verdict is not evaluated here;
  an output with a `Condition` over a secret is kept as written;
- an output read from a grandchild is classified the same way one level
  down, with the values the child passes classified over the child's
  template.

An output that cannot be classified (no assembly, a missing, unreadable or
cyclic template, an undeclared output) is kept as written, as before. One
that reads a value the parent could not read this time is neither compared
nor hashed. A clean output's value still takes the checks every input takes:
a `***`, a reference, or a value whose read recorded a secret is kept as
written. A child template edit that changes an output's class moves the hash
once and sends the property once; an unchanged tree sends nothing.

The same rule classifies a value a parent passes to one nested stack from
another's output: a clean sibling output is now a clean passed value, so a
masked property in the receiving child that reads it is sent when the
output's value changes (it used to be kept as written).

So these are NOT sent through the mask: a flip of a condition over a `NoEcho`
parameter, and a new value of anything above. (A new value of the `NoEcho`
parameter itself is found by reading the resource back from AWS; see
[`version: 11`](#version-11-stores-noecho-values-as-current-writers).) A hash
that moved with such a value would let anyone holding the state file test
guesses of it. CloudFormation would update the resource; change the
property's template text, or replace the resource, to push one.

A non-`NoEcho` parameter value and a cross-stack output value are treated as
public: they enter the hash, so a low-entropy one may be recoverable from the
state file by guessing. Declare a sensitive parameter `NoEcho`. A secret the
redaction itself does not mask (one shorter than 4 characters, embedded in a
longer value) is persisted in the clear already, and is not kept out of the
hash either.

A property whose template text holds, as a literal, the value
of one of the stack's `NoEcho` parameters, or a value the same resource
resolved as a secret, is the exception: it gets no hash in either field and
is compared as before the fields existed. A `NoEcho` parameter value is known
when the deploy starts, so this holds from the first deploy. A resolved secret
is known only to a deploy that resolves the resource, so a hash the first
deploy under this version filled in for a resource it did not change is
checked by the next deploy that resolves it.
The check is a plain text match, so a short secret that also occurs as
ordinary text in the property (a word in a script) costs that property its
hash too, and edits to it are not seen through the mask.

- **Written** by the save of a deploy that created, updated or replaced the
  resource, from the template it deployed. A failed update keeps the previous
  record and its previous fingerprints, so the retry still sends the edit.
- **No version bump.** A record without the fields (an older cdkd's) is
  compared exactly as before. The first deploy under a cdkd that knows the
  text field fills it in, per masked property, from the template it deploys,
  and saves even when nothing else changed; that deploy cannot tell an edit
  made since the last deploy, so such an edit is not sent until the property
  changes again. To push one anyway, change the property once more, or replace
  the resource with `--recreate-via-cc-api` / `--recreate-via-sdk-provider`.
- **An input fingerprint is bound to the text fingerprint** it was computed
  with. A property with a text fingerprint but no bound input fingerprint (a
  record written before the input fingerprint existed, or one an older cdkd
  rewrote since: it updates the text field and carries the other one as it
  was) is compared as text, so an edit is sent as before. While the text is
  unchanged, the deploy fills in the input fingerprint from today's inputs
  and sends nothing: it cannot tell whether an input moved since (a parameter
  changed under the older cdkd), so such a change is sent only once the input
  moves again. An older cdkd reads the text field only, exactly as it always
  did, so after a downgrade it still sends a template edit.
- **`cdkd diff`** compares the input fingerprint for the stack it was given,
  classifying its nested stacks' outputs from the same assembly the deploy
  reads. For a nested child, and wherever it cannot bind an input (a parameter it
  cannot resolve), it compares the text field only: a template edit shows,
  an input change shows only when the deploy sends it.
- **Nested stacks.** A nested child is deployed only when its parent row
  changed, which is usually because the child's own template changed. So the
  first deploy that reaches a child last deployed by an older cdkd is, most
  likely, one that carries an edit, and an edit to a masked property in that
  deploy is not sent. Check such a child after that deploy, and change the
  property once more if it did not take.
- A malformed field reads as absent. A record a rollback orphans gets them
  from the same save, and a writer that spreads an existing record (rollback,
  drift, scrub, orphan adoption) carries them.

## State Schema

### StackState (`state.json`)

```typescript
interface StackState {
  version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11  // 1 = legacy, 2 = region-prefixed, 3 = +observedProperties, 4 = +imports[], 5 = +deletionPolicy/updateReplacePolicy, 6 = +parentStack/parentLogicalId/parentRegion (nested-stack adoption), 7 = +provisionedBy on ResourceState, 8 = +outputReads[], 9 = +exportNames[], 10 = +observedBaselineRefused on ResourceState, 11 = +noEchoLeaves/noEchoAttributeNames on ResourceState
  stackName: string                        // Stack name
  region?: string                          // Required on version >= 2
  resources: Record<string, ResourceState> // Logical ID → Resource state
  outputs: Record<string, unknown>         // Output name → Resolved value (NOT coerced to string)
  imports?: StateImportEntry[]             // v4+: Fn::ImportValue refs (strong reference — blocks the producer's destroy)
  outputReads?: StateOutputReadEntry[]     // v8+: Fn::GetStackOutput refs (informational — weak reference, never destroy-blocking)
  exportNames?: string[]                   // v9+: which `outputs` keys are Export.Name aliases — the ONLY names Fn::ImportValue may bind to (undefined = pre-v9 record, every key importable until its next deploy; [] = exports nothing)
  skippedOutputs?: Record<string, string>  // informational, no version bump: Outputs keys the last deploy could not resolve and skipped → digest of their template inputs (issue #2740); absent = nothing skipped, or a record older than the field
  orphans?: StackOrphanRecord[]            // no version bump: resources a rollback retained under `Retain` and moved out of `resources`, kept so a later deploy can re-adopt one instead of colliding with the name it holds; absent = none
  conditionVerdicts?: Record<string, { verdict: boolean; fingerprint: string }> // no version bump: the deployed verdict of each condition `cdkd diff` reads that depends on a secret-fed parameter, with a fingerprint of its definitions and inputs (issue #4479); absent = no record
  parentStack?: string                     // v6+: populated on nested-stack child state records (undefined on top-level)
  parentLogicalId?: string                 // v6+: child's AWS::CloudFormation::Stack logical id in the parent's template
  parentRegion?: string                    // v6+: parent's region (always equals `region` until cross-region nested stacks ship)
  lastModified: number                     // Unix timestamp (milliseconds)
}
```

**`outputs` values are `unknown`, not `string`** — cdkd persists whatever the
intrinsic resolver produced for the Output's `Value`, with no stringification
step. Most Outputs do resolve to a string, but an `Fn::GetAtt` that
CloudFormation defines as a LIST persists a JSON **array** when it is used as
the Output value directly (rather than wrapped in `Fn::Join`) — e.g.
`AWS::Route53::HostedZone.NameServers`, whose list shape the Route 53 provider
preserves end to end. Do not write code (or docs) that assumes a
`state.outputs` value is a string; a consumer reading one back must handle the
non-string shapes too.

**The `Outputs:` block `cdkd deploy` prints is not evidence of the stored
shape.** That summary renders each value with JavaScript's `String(value)`, and
for an array that is a comma join with no brackets or spaces — a persisted
`["ns-1.awsdns-00.com", "ns-2.awsdns-01.net"]` prints as
`ns-1.awsdns-00.com,ns-2.awsdns-01.net`, indistinguishable from a genuine
comma-separated string. (An object prints as `[object Object]`, and an
unresolved output is dropped from the block entirely rather than printed as
`undefined`.) To see what was actually stored, read the state file —
`aws s3 cp s3://<bucket>/cdkd/{stackName}/{region}/state.json -` — or run
`cdkd state show '<stack>'`, which renders any non-scalar through
`JSON.stringify` and so preserves the distinction.

#### When `resources` is not an object

`resources` is the map of logical id to resource record, and it is unchecked in
the same way: a hand-edited or truncated record can hold a string, a list, a
number, a boolean or `null` there. `Object.keys` answers three different ways
over those, and the middle answer is the dangerous one — a `[]`, a number or a
boolean enumerates **no keys**, which is indistinguishable from a stack that
genuinely has none. A string enumerates one fabricated logical id per character.

| Command | Answer |
| --- | --- |
| `cdkd deploy` | **Refuses** at the load (`STATE_RESOURCES_MALFORMED`, exit `1`) — a map read as empty makes every resource the template declares plan as a `CREATE`, so the deploy re-provisions a stack that already exists, then saves a well-formed record over the evidence |
| `cdkd deploy --dry-run` | **Refuses**, identically — the plan a dry run prints comes from the same comparison |
| `cdkd destroy` / `cdkd state destroy` | **Refuses** before the prompt and before the lock (`STATE_RESOURCES_MALFORMED`, exit `1`) — the map is the list of what to delete, so an unreadable one counted as zero resources and the run removed `state.json` down the empty-stack fast path |
| `cdkd orphan`, `cdkd import`, `cdkd rollback` | **Refuse** (`STATE_RESOURCES_MALFORMED`, exit `1`) — each carries the bag into a save |
| `cdkd export` | **Refuses** the named stack at the load, before the lock, and every nested child record before any changeset (`STATE_RESOURCES_MALFORMED`, exit `1`), under `--dry-run` too — a child whose map cannot be read contributes no nested stacks of its own, so migrating past it would leave that subtree out |
| `cdkd scrub` | **Refuses** on a real run (exit `2`); audits and reports under `--dry-run` |
| `cdkd diff` | **Repairs** in memory and warns — it never writes state; on the stack you named it also reports the deploy's refusal under `Blocking` and exits `3`; see [`cdkd diff`](cli-diff.md#when-the-state-record-is-malformed) |
| `cdkd state show` | **Repairs** in memory and warns; `--json` still emits the stored value — see [`cdkd state`](cli-state.md#when-resources-is-not-an-object) |
| `cdkd state resources` | **Repairs** in memory and warns; `--json` emits `[]`, because that mode is the resource array cdkd derived rather than a view of the stored value |
| `cdkd local *` (`--from-state`) | **Repairs** in memory and warns — it writes no state record; every `Ref` / `Fn::GetAtt` in the run's environment that names a resource of this record resolves to nothing and is dropped, and a bare `--assume-role` falls back to the developer's credentials |

The destroy row is the one where *repairing* would be unsafe rather than
merely lossy. Read as empty, the count comes back zero, the empty-stack fast
path removes `state.json` with no confirmation, and the destroy reports
**success having deleted nothing** — every resource the record named left live
in AWS with nothing to say what they were. So reading the map as empty is not
the safe alternative here; it **is** that outcome. An empty `{}` and an unreadable `[]`
both count zero, so the two are separated by the container's shape, never by
its size, and a legitimately empty stack still takes the fast path exactly as
before.

Refusing a cleanup command does not leave you stuck, because proceeding would
not have torn anything down either — the list of what to delete is precisely
what is unreadable. If what you want is the record gone with the live resources
left standing, that is `cdkd state orphan '<stack>' --stack-region '<region>'`,
which the refusal names. To act on the resources instead, repair the record and
re-run.

An **absent** `resources` field is a defect, unlike an absent `outputs` — a
stack always has a resource map, even an empty one — and is refused the same
way. An empty `{}` is healthy.

#### When `outputs` is not an object

A state record is parsed as JSON and used as typed data without a
field-by-field shape check, so a hand-edited or truncated one can hold a
string, a list, a number, a boolean or `null` where the `outputs` map belongs.
`Object.entries` walks a string as readily as a map, so anything that rebuilds
the bag from one produces a well-formed map of fabricated keys — `"abcdef"`
becomes `{"0":"a", …, "5":"f"}`, and `null` becomes `{}`.

Which answer a command gives depends on what it would DO with the bag — write it
back, decide from it, or re-apply its value — and the answers are deliberately
opposite. Writing back is the plain case; the other two are why "can it write"
alone no longer predicts the table: `cdkd destroy` never rewrites the bag but
deletes the record on the strength of it, and the resolver hands a value to a
deploy that applies it to a live system:

| Command | Answer |
| --- | --- |
| `cdkd deploy` | **Refuses** at the load (`STATE_RESOURCES_MALFORMED`, exit `1`) — it rebuilds the bag, saves it, and republishes the result into the shared exports index |
| `cdkd destroy` / `cdkd state destroy` | **Refuses** before the prompt (`STATE_RESOURCES_MALFORMED`, exit `1`) — it reads the bag to decide whether the stack might export anything, and that decision gates the cross-stack check below |
| `cdkd orphan` | **Refuses** (`STATE_RESOURCES_MALFORMED`, exit `1`) — it rebuilds the bag and saves the result |
| `cdkd import` | **Refuses** (`STATE_RESOURCES_MALFORMED`, exit `1`) — it carries the bag into a save |
| A nested stack's child record | **Refuses** the parent's deploy AND its destroy (`STATE_RESOURCES_MALFORMED`, exit `1`) — the parent's `Outputs.<Key>` attributes are rebuilt from the child's bag and persisted into the parent's record, and the parent's destroy reaches the child through `runDestroyForStack`, which carries the same refusal |
| `cdkd scrub` | **Refuses** on a real run (exit `2`); audits and reports under `--dry-run` — see [`cdkd scrub`](cli-scrub.md#exit-codes) |
| `cdkd diff` | **Repairs** in memory and warns — it never writes state; on the stack you named it also reports the deploy's refusal under `Blocking` and exits `3`; see [`cdkd diff`](cli-diff.md#when-the-state-record-is-malformed) |
| `cdkd state show` / `state resources` | **Repairs** in memory and warns; `--json` still emits the stored value — see [`cdkd state`](cli-state.md#when-resources-is-not-an-object) |
| `cdkd local *` (`--from-state`) | **Repairs** in memory and warns — it writes no state record, so the run continues with no outputs from that record |
| An `Fn::GetStackOutput` read of that record | **Refuses the reference** — the deploy fails rather than resolving a fabricated value into the consumer's template |
| The exports index rebuild | Publishes **nothing** from that record, warns, and indexes every other producer — see [cross-stack internals](cross-stack-internals.md#an-unreadable-producer-record-contributes-nothing-and-says-so) |

The destroy row is the one whose *repair* answer would be unsafe rather than
merely lossy. `cdkd destroy` refuses to delete a stack another stack still
imports from, and it decides whether to run that check by asking whether the
`outputs` bag holds anything. A string or a list invents one export name per
character or element; a `null`, a number or a boolean reads as "exports
nothing" and **skips the check entirely**, deleting the record while consumers
still resolve against it. Reading the bag as empty is that second answer, so
there is no repair available — only a refusal.

The `Fn::GetStackOutput` row is the only one where the fabricated value would
be **applied** rather than displayed. `Object.hasOwn('abcdef', '0')` is true,
so an `OutputName: "0"` against a six-character producer bag used to resolve
the single character `a` and the deploy sent it to AWS as a live resource's
property. `Fn::ImportValue` was never affected: it binds through the export-set
predicate, which fails closed.

Refusing is what keeps the damaged record readable. Saving over it replaces the
only signal that anything is wrong with a legitimate-looking one, permanently —
and the next deploy would republish the fabricated keys into the shared exports
index that every other stack's `Fn::ImportValue` resolves against.

An **absent** `outputs` field is not a defect and is never refused: a record
with no outputs is one cdkd writes on purpose (a deploy's failure-path save
emits `outputs: currentState.outputs`, which `JSON.stringify` drops when it is
undefined), and `cdkd scrub` round-trips such a record rather than
materializing `{}` over it. An empty `{}` is healthy too — a stack can
legitimately publish no outputs.

Each container is judged on its own: a record whose `resources` map is fine and
whose `outputs` is damaged is refused with a message naming `outputs`, and vice
versa.

#### When one `resources` RECORD cannot be read

The map being an object says nothing about the records in it. A record is
readable only if it is an object carrying a string `resourceType` — the one
field every reader touches before any other. A `null`, a string, a list, or an
object with no type is a row nothing can route, and every command that reaches
it answers the way it answers a damaged map:

| Command | Answer |
| --- | --- |
| `cdkd deploy` | **Refuses** at the load (`STATE_RESOURCES_MALFORMED`, exit `1`), naming the rows — under `--dry-run` too. The same refusal runs on the pre-lock `--recreate-via-cc-api` / `--recreate-via-sdk-provider` check, which reads the record itself: without it a `null` named row was reported as *missing from state*, with advice to drop the flag for it |
| `cdkd destroy` / `cdkd state destroy` | **Refuses** before the prompt and before the lock, and again on the record the empty-stack path re-reads under the lock, naming the rows — a falsy row was skipped as "not found in state" and the record removed with its resource live; a row with no type was routed to a provider on no type with a physical id nothing checked; see [`cdkd destroy`](cli-destroy.md#an-unreadable-resource-record-refuses-the-destroy) |
| `cdkd import` | **Refuses** a SELECTIVE merge over an unreadable row it does NOT re-import (`STATE_RESOURCES_MALFORMED`, exit `1`) — it copies every such row into the record it saves. A row named by `--resource` / `--resource-mapping` is replaced from the provider's answer, so `cdkd import <stack> --resource <id>=<physicalId> --force` is the repair of that row and is not refused pre-flight — if that row's import then does not succeed, the import refuses before saving rather than writing the row back; a whole-stack `--force` import or `--migrate-from-cloudformation` REPLACES the map from the template and is not refused either |
| `cdkd orphan` | **Refuses** for a row on a record it would **keep**, under `--dry-run` too; a row you are orphaning is dropped as usual |
| `cdkd scrub` | **Refuses** on a real run (exit `2`) — the rewrite reads each row and saves the rebuilt map; under `--dry-run` it DROPS the rows, warns, and reports them in the audited-record refusal — see [`cdkd scrub`](cli-scrub.md#exit-codes) |
| `cdkd state refresh-observed`, `cdkd drift --accept` / `--revert` | **Refuse** before the lock, naming the rows — see [`cdkd drift`](cli-drift.md) |
| `cdkd diff`, plain `cdkd drift` | **Drop** the rows, warn, and report the rest; `cdkd diff` also reports the deploy's refusal under `Blocking` on the stack you named and exits `3` |
| `cdkd local *` (`--from-state`) | **Drops** the rows in memory and warns — it writes no state record. A `Ref` or `Fn::GetAtt` naming a dropped row resolves to nothing and is dropped like any other unresolvable reference, and a bare `--assume-role` read through one falls back to the developer's credentials. An unreadable **map** is read as empty the same way, with its own warning |
| The rollback-orphan claim scan (`cdkd deploy` / `cdkd diff`) | **Skips** the row and keeps reading the rest of that sibling's record, at debug level — a row with no readable physical id claims nothing. The scan exists to stop this stack adopting a resource another stack still owns, so it reads past a damaged row rather than stopping at it |

A row that names its type but no `physicalId` is readable here: it can be
routed, and what its missing id costs is reported by the command that reaches
it, in that command's own terms. Inspect the record with
`cdkd state show '<stack>' --stack-region '<region>' --json` and repair the row.

#### When a resource `properties` map is not an object

One level down from the two maps above, each resource record carries its own
`properties` map. It is unchecked for the same reason, and the consequence is
different again — this is the map the change calculation compares the template
against.

A non-object compares unequal to any declared property, so **every property the
template declares reads as missing from the deployed resource**. For an
ordinary property that is a spurious in-place update; for a **create-only** one
— an S3 `BucketName`, a DynamoDB `TableName`, anything CloudFormation lists
under `createOnlyProperties` — it is a **replacement**: `cdkd deploy` would
delete the live resource and create a new one, from a record nobody asked it to
act on. A string map adds one fabricated change per character on top.

| Command | Answer |
| --- | --- |
| `cdkd deploy` | **Refuses** at the state load, before any provider call — the observed-state refresh's reads included — (`STATE_RESOURCES_MALFORMED`, exit `1`), naming the resource records it could not read |
| `cdkd deploy --dry-run` | **Refuses**, identically — the plan a dry run prints comes from the same comparison, so it would show the replacement as though the template asked for it |
| `cdkd orphan` | **Refuses** (`STATE_RESOURCES_MALFORMED`, exit `1`) for a map on a record it would **keep**, under `--dry-run` and `--force` too — but never for one on a record you are orphaning, which it removes as usual |
| `cdkd export` | **Refuses** the named stack at the load, before any lock, and every nested child record before any child stack is planned or locked — after the root's plan (under `--dry-run` too), and on a real run under the root lock, which it releases (`STATE_RESOURCES_MALFORMED`, exit `1`), under `--dry-run` too — the export reads the map to build import identifiers and the phase-2 pre-deletes, then deletes the record |
| `cdkd destroy` / `cdkd state destroy` | **Refuses** before the prompt and before the lock (`STATE_RESOURCES_MALFORMED`, exit `1`), naming the records it could not read — a retained row included, since its `Ref` / `Fn::GetAtt` edges still order the deletes. The map is handed to each resource's delete, which reads keys off it (an RDS final snapshot, emptying an ECR repository first), and reading it as empty answers each of those keys as absent. A nested child record reached through its parent's destroy inherits it. See [cdkd destroy](cli-destroy.md#an-unreadable-properties-map-refuses-the-destroy) |
| `cdkd diff` | **Repairs** those maps to empty in memory and warns, naming the same records — it writes nothing, and a preview of the rest of the stack is worth more than an abort; on the stack you named it also reports the deploy's refusal under `Blocking` and exits `3` |

Reading the map as empty is **not** the safe answer here, which is why deploy
refuses rather than repairing: an empty map declares nothing either, so it
reaches the identical replacement verdict. The refusal is the only answer that
does not act on the damage. `cdkd diff` can take the lossy one precisely
because it never provisions, and its warning says the preview is wrong and that
`cdkd deploy` will refuse on the same record.

The `cdkd orphan` row is the one that is **scoped** rather than record-wide,
and the reason is that this command is itself a way out. It rewrites every
surviving resource's reference to the resources you are orphaning and saves the
result, so a map it could not read is carried into that save untouched — the
stored value is kept verbatim rather than fabricated into a well-formed one,
but the command reports success over a record the next `cdkd deploy` refuses.
What it cannot do is its own job: an unreadable map hides whichever references
to the orphan it holds, so the run's audit table is incomplete and the
`--force`-less failure on unresolvable references cannot fire for it. Because
the save cannot persist a record it is deleting, the refusal names only the
records that would **survive**. Three ways out, and the order matters:

1. **Repair the record by hand.**
   `cdkd state show '<stack>' --stack-region '<region>' --json` shows the stored
   value; fix the map and put the record back. This is the only option that
   keeps the resource under cdkd's management.
2. **Drop the whole record** with
   `cdkd state orphan '<stack>' --stack-region '<region>'`. It needs no CDK app and
   leaves every live AWS resource standing.
3. **Orphan just the damaged resource** — but only while your CDK app still
   declares it:

   ```bash
   cdkd orphan MyStack/TheDamagedResource
   ```

   That removes it and repairs the rest of the record in one step, leaving the
   live AWS resource standing like any other orphan. `cdkd orphan` addresses
   resources by **construct path**, and construct paths come from the
   synthesized template — so a resource your app no longer declares (a record
   left behind after the construct was deleted) has no path there. For that
   one, and without a CDK app at all, address it by logical id instead:

   ```bash
   cdkd state orphan MyStack --stack-region us-east-1 --resource TheDamagedResource
   ```

   It makes the same scoped refusals and the same rewrite as `cdkd orphan`
   ([`--resource`](cli-state.md#removing-one-resource-from-the-record)).

A **legacy** record (`<prefix>/<stack>/state.json`) that `cdkd state list`
shows with no region (its body names none, or could not be read) is the
exception to both commands above: `cdkd state orphan '<stack>'` without
`--stack-region` is the form that selects it, and `cdkd state show` cannot read
it at all, so read the object from the state bucket directly. The refusal
prints those forms for that record, and names the object's path only when the
stack name renders exactly. `cdkd orphan`'s refusals of an unreadable
`resources` or `outputs` map name the object the same way for such a record,
instead of a `cdkd state show` command that cannot read it.

The refusal prints its commands at the end, each on a line of its own after a
label; copy the command after the label. For the legacy record, the object's
key and bucket are printed the same way, on `Object key:` and `State bucket:`
lines; a stack name that would not be inert with its quotes stripped shows as
`'<stack>'` in the key, to be filled from `cdkd state list --json`. The `cdkd state orphan` and `cdkd state show`
commands carry the
`--profile`, `--state-bucket` and non-default `--state-prefix` the run was
given, so pasting them reaches the same bucket. If the stack name would not
survive display unchanged, or would not be inert with its quotes stripped
(whitespace, or a character a shell acts on, such as `'`, `;` or `$`), both
become templates with the name left as a hole; if the region would not, the
name and the region are both left as holes. The
account flags stay either way, and the message says where to take the exact
name from. A `--profile`, `--state-bucket` or `--state-prefix` value that would
not survive display unchanged, or would not be inert with its quotes stripped,
is itself printed as a hole (`'<profile>'`,
`'<bucket>'`, `'<prefix>'` — quoted, so a pasted hole is one literal argument
rather than a shell redirection), the message says so and tells you to fill it
from the value you passed, and the object path then names neither that bucket
nor that prefix. An empty `--state-bucket` counts as no bucket, so no
`State bucket:` line is printed; an empty `--state-prefix` is a real key space
and IS printed, both on the object key and as `--state-prefix ''`.

`cdkd deploy` refuses the same record until it is repaired or removed, so being
blocked in both commands is the intended state rather than an extra restriction
this row adds.

An **absent** `properties` map is a defect and is refused: every writer in cdkd
records an object there, and `JSON.stringify` never drops an empty one. An
empty `{}` is healthy — a resource can legitimately declare no properties.

A resource record that is not an object at all (a `null` entry, a string), or
carries no `resourceType`, is a different defect. `cdkd orphan` refuses it on a
record it would keep, scoped and with the same three ways out as above: its
save rebuilds each kept record by copying fields, so a string entry would be
saved as one key per character and a number as a record with no physical id. A
reference from another resource to such a record you are orphaning, or to one
with no physical id, is reported as unresolvable rather than substituted.
`cdkd deploy` **refuses** such a record before creating, updating or deleting
any resource (`STATE_RESOURCES_MALFORMED`, exit `1`), under `--dry-run` too,
naming the records it could not read. Otherwise the entry reads as absent and
deploy plans a `CREATE` for a resource it already manages. `cdkd diff` drops
those records, warns, and previews the rest; on the stack you named it also
reports the deploy's refusal under `Blocking` and exits `3`.

The same scoped refusal covers a kept record's `attributes` map — the cache
`Fn::GetAtt` of it is read from — when it is `null` or not an object; an absent
one is healthy. Under `--force`, `cdkd orphan` never reads a value out of an
orphaned record's unreadable `attributes` cache: the reference keeps its
original intrinsic, as it does when the cache lacks the attribute.

#### When `orphans` is not a list

`orphans` records resources an earlier failed deploy left live in AWS under a
`Retain` policy, so the next deploy can adopt them instead of re-creating them.
It is a list, it is unchecked in the same way as the maps above, and a
hand-edited or truncated record can hold a string, a number, an object or
`null` there. Every reader reached it through a `?? []` or a `?.length`, which
admits all four.

| Command | Answer |
| --- | --- |
| `cdkd deploy` | **Refuses** at the load, before any resource operation (`STATE_RESOURCES_MALFORMED`, exit `1`) — the adoption pass writes the container back, so an unreadable one would be rewritten |
| `cdkd destroy` / `cdkd state destroy` | **Refuses**, at its first read and again at the re-read it takes under the lock — otherwise the run deletes every resource and then the record, having never reported the orphans it could not read |
| `cdkd rollback` | **Refuses** before any replay — its own bookkeeping walks the container and saves the result |
| `cdkd import` | **Refuses** — it carries the container into the record it writes, so importing over a damaged one would leave a record every other command then refuses |
| `cdkd orphan` | **Refuses**, under `--dry-run` too — it carries the container into its save without reading it, so it would report success over a record the next deploy refuses |
| `cdkd scrub` | **Refuses** on a real run (exit `2`); audits and reports under `--dry-run` |
| `cdkd diff` | **Repairs** in memory and warns — it writes nothing, names `(orphans container)` in the preview and lists `orphans` in `--json`'s `unreadableContainers`, which `--fail` counts; on the stack you named it also reports the deploy's refusal under `Blocking` and exits `3` |

A string is the shape that makes this worse than a lost preview: walking it
character by character yields one garbage orphan record per character, and
`cdkd rollback` saved exactly that — a damaged container rewritten into a
differently damaged one, with nothing said. The other shapes read as **no
orphans at all**, so `cdkd diff` previewed no adoption and `cdkd destroy`
removed the record with its evidence unread.

An **absent** `orphans` container is the ordinary record, not a defect: a stack
that never had a failed deploy has no orphan list, and no command writes an
empty one over it. An empty `[]` is healthy too. Damage INSIDE a readable list is
a separate question, answered by the section below.

#### When one `orphans` RECORD cannot be read

The field being a list says nothing about the records in it. A record is usable
only if it is an object with a string `logicalId` whose `state` is a readable
resource entry carrying a NON-EMPTY string `physicalId` — including that entry's
`properties` and `attributes` maps — and no OTHER record in the list carries
that same `logicalId`. Each command answers a damaged one the same way it
answers a damaged container:

| Command | Answer |
| --- | --- |
| `cdkd deploy` | **Refuses** at the load. The adoption pass dereferences every record, so one whose `state` is absent or `null` aborts the run; one already in `resources` is dropped silently before `state` is read; and a primitive or type-less `state` is kept with a notice, since the provider lookup fails inside the pass's own `try` |
| `cdkd destroy` / `cdkd state destroy` | **Refuses**, at both reads. The listing that tells you which resources stop being tracked prints each record's own fields |
| `cdkd rollback` | **Refuses** before any replay. This is where the loss is worst: records MISSING a `logicalId` all key ONE entry of the merge map, so those collapse into one and the record saved keeps only that one (two distinct NUMERIC ids stay distinct keys) — and records SHARING one collapse the same way, the other rows' resources left live in AWS with nothing tracking them |
| `cdkd import` | **Refuses** — it carries the records into the record it writes, verbatim |
| `cdkd orphan` | **Refuses**, under `--dry-run` too |
| `cdkd scrub` | **Refuses** on a real run (exit `2`); under `--dry-run` it DROPS the record, warns, and reports it in the audited-record refusal |
| `cdkd diff` | **Drops** the record, names it in the preview, in `--json`'s `unreadableOrphans` and in the `--fail` count, and previews the rest; on the stack you named the deploy's refusal is also reported under `Blocking` and exits `3`. It drops only what the preview cannot read — an object, a string `logicalId`, and a readable `state` with a non-empty string `physicalId` (the preview resolves that id against AWS and against other stacks' records) — plus EVERY record whose `logicalId` another record also carries, since the preview keys its adoptions by that id and would show one adoption for two resources; a record whose `properties` or `attributes` map is torn is KEPT, and the preview then WARNS naming the row — at every node the run reaches with an adoption preview; a plain run visits only the top-level stack, and a state-only child being DELETED runs no preview at all — saying that `cdkd deploy` refuses the record over it; the TOP-LEVEL stack also exits `3`, so a clean run never precedes a deploy that will not start. A kept row that is ADOPTED additionally has its `properties` map repaired and named by the [`properties` repair](#when-a-resource-properties-map-is-not-an-object) |

Inspect the record with `cdkd state show '<stack>' --stack-region '<region>' --json`
and repair the row rather than deleting the record: no command removes a single
`orphans` row — the per-resource commands act on `resources` — and the record is
the only evidence that an earlier failed deploy left its resource live in AWS.

Two records sharing a `logicalId` are never written by cdkd — the rollback save
merges by that id and every other save carries the list unchanged — so they come
from a hand edit or a damaged file. Each of them is named, since nothing in the
record says which is the resource the stack should re-adopt; the repair is to
keep ONE record for that id, and the other resource is then no longer tracked by
cdkd.

#### Example

```json
{
  "version": 11,
  "stackName": "MyAppStack",
  "region": "us-east-1",
  "resources": {
    "MyBucket": {
      "physicalId": "myappstack-mybucket-abc123xyz",
      "resourceType": "AWS::S3::Bucket",
      "properties": {
        "BucketName": "myappstack-mybucket-abc123xyz",
        "VersioningConfiguration": {
          "Status": "Enabled"
        }
      },
      "attributes": {
        "Arn": "arn:aws:s3:::myappstack-mybucket-abc123xyz",
        "DomainName": "myappstack-mybucket-abc123xyz.s3.amazonaws.com",
        "RegionalDomainName": "myappstack-mybucket-abc123xyz.s3.us-east-1.amazonaws.com"
      },
      "dependencies": [],
      "provisionedBy": "sdk"
    },
    "MyFunction": {
      "physicalId": "arn:aws:lambda:us-east-1:123456789012:function:MyAppStack-MyFunction",
      "resourceType": "AWS::Lambda::Function",
      "properties": {
        "FunctionName": "MyAppStack-MyFunction",
        "Runtime": "nodejs20.x",
        "Handler": "index.handler",
        "Code": {
          "S3Bucket": "cdk-hnb659fds-assets-123456789012-us-east-1",
          "S3Key": "abc123.zip"
        },
        "Role": "arn:aws:iam::123456789012:role/MyAppStack-MyFunctionRole"
      },
      "attributes": {
        "Arn": "arn:aws:lambda:us-east-1:123456789012:function:MyAppStack-MyFunction"
      },
      "dependencies": ["MyFunctionRole", "MyBucket"],
      "provisionedBy": "sdk"
    }
  },
  "outputs": {
    "BucketName": "myappstack-mybucket-abc123xyz",
    "BucketArn": "arn:aws:s3:::myappstack-mybucket-abc123xyz",
    "FunctionArn": "arn:aws:lambda:us-east-1:123456789012:function:MyAppStack-MyFunction"
  },
  "exportNames": ["BucketArn"],
  "lastModified": 1710835200000
}
```

### ResourceState

```typescript
interface ResourceState {
  physicalId: string                           // AWS physical ID (ARN, name, etc.)
  resourceType: string                         // CloudFormation resource type
  properties: Record<string, unknown>          // Resolved template intent (what cdkd was asked to deploy)
  observedProperties?: Record<string, unknown> // AWS-current snapshot at deploy time (drift baseline)
  attributes?: Record<string, unknown>         // Attributes for Fn::GetAtt
  dependencies?: string[]                      // List of dependent logical IDs
  metadata?: Record<string, unknown>           // Additional metadata
  deletionPolicy?: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate'      // v5+: template attribute recorded at deploy time
  updateReplacePolicy?: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate' // v5+: template attribute recorded at deploy time
  provisionedBy?: 'sdk' | 'cc-api'             // v7+: provisioning layer (absent = SDK legacy default)
  observedBaselineRefused?: true               // v10+: `cdkd import` declined to capture a baseline
  observedBaselineRefusalReason?: 'unverifiable-parameter' | 'incomplete-resolution' // optional, no bump: only the first survives an in-place UPDATE
  noEchoLeaves?: (string | number)[][]         // v11+: positions in `properties` stored as `***` for a NoEcho value
  noEchoAttributeNames?: string[]              // v11+: `attributes` the provider declared NoEcho, each stored as `***`
  noEchoExactEchoLeaves?: string[][]           // optional, no bump: `noEchoLeaves` positions AWS reports exactly
  acceptedCreateOnlyDrops?: string[] // optional, no bump: create-only properties the SDK route was told to drop, so never sent
  maskedPropertyFingerprints?: Record<string, string> // optional, no bump: per property `properties` holds as `***`, a hash of its template text (issue #4451)
  maskedPropertyInputFingerprints?: Record<string, string> // optional, no bump: per such property, a hash of its template value with its non-secret inputs resolved, bound to the text hash (issue #4543)
}
```

`properties` records the resolved CloudFormation template values cdkd
**asked AWS to apply** — the values it actually sent, which is not always
everything the template declared. A provider that deliberately narrows what
it sends records the narrowed bag, and a top-level property the SDK provider
has no wiring for is likewise absent whenever
[`--prefer-sdk-route`](cli-deploy-safety.md#the-override) kept the
resource on the SDK route (that flag is the opt-in to the property not being
written at all) — unless the property is create-only, which cdkd keeps in the
record because removing it would classify the next deploy as a replacement,
and names in `acceptedCreateOnlyDrops`. That name is what lets a later deploy
without the flag refuse the replacement instead of reporting no change
([`CREATE_ONLY_DROP_NEEDS_REPLACEMENT`](cli-deploy-safety.md#create-only-drop-needs-replacement)).
One key is never sent: a nested stack's `AWS::CloudFormation::Stack` row
carries `cdkd:PendingChildDeletes` while its child stack (or one below it)
still holds a DELETE cdkd skipped, so the next `cdkd deploy` re-runs that
child and re-attempts the delete; it disappears once the delete lands. `observedProperties` records what AWS actually has — captured
by `provider.readCurrentState` immediately after each create/update so it
includes AWS-side defaults the user did not template. The `cdkd drift`
comparator prefers `observedProperties` as its baseline for richer detection;
resources without it fall back to `properties` (the pre-`version: 3` behavior).

One consequence worth knowing before you opt into a drop: `cdkd export`
reconstructs a CloudFormation template from `properties`, so a property
accepted via `--prefer-sdk-route` is absent from the exported
template too. That matches what AWS actually holds — which is what makes the
exported stack importable — but it means the export is not a round-trip of your
CDK source for that field.

#### `NoEcho` custom-resource responses

A Lambda-backed custom resource's handler can declare its response `Data`
sensitive by setting the documented `NoEcho: true` field on the cfn-response
envelope. cdkd honours it: every
string value in that `Data` is stored as `***` instead of the value itself —
in the custom resource's own `attributes`, in the resolved `properties` and
`observedProperties` of every resource that consumed it through `Fn::GetAtt`,
and in `state.outputs`.

A consumer value that builds a LONGER string around the value
(`postgres://user:${cr.getAttString('Password')}@db/app`) is stored as `***`
whole, not with the value masked in place: an inline `***` could not be told
from text you wrote, so nothing below could recognise and refuse it. The rest
of that string is therefore not in state either. A longer string is kept as it
is in two cases. The first is a value that occurs only inside the text of a
`{{resolve:...}}` reference to a service cdkd resolves: the reference is kept
so it can be resolved again, which means a reference NAME built from a
`NoEcho` value stores that value in the clear when the reference resolves to a
public value. One that resolves to a secret is refused instead: see
[the troubleshooting entry](troubleshooting.md#refusing-to-resolve-a-reference-whose-name-was-built-from-a-secret). The second is a value that IS
public text state already holds: the region, the stack name, one of the custom
resource's literal template properties, its `ServiceToken` or one of that
ARN's `:`-separated parts (its account id, for example). For a value read
from another stack's output, only the regions and the stack names count. A
string EQUAL to such a value is still stored as `***`. Any other string of the same consumer that happens to contain the value
is stored as `***` too.

```js
// in the handler
return {
  PhysicalResourceId: id,
  Data: { Token: mintedToken },
  NoEcho: true,          // <- this is the whole opt-in
};
```

**AWS still gets the real value.** CloudFormation delivers a `NoEcho` custom
resource's `Data` to a dependent resource in the clear, and cdkd matches that:
`Fn::GetAtt` resolves to the real value and the dependent is created with it.
Only what cdkd WRITES DOWN changes. (This is worth stating because the AWS
documentation's "masked with asterisks" sentence describes the display channel;
masking at resolution time would make a template feeding such a value into
`AWS::SecretsManager::Secret.SecretString` store the literal `***` as the
secret.)

**A new value reaches every consumer.** When the handler runs and returns a
value, each resource reading it is updated with it — including a resource in a
nested stack that receives the value as a stack parameter — although the stored value
and the new one both read `***` in state: two masks say nothing about the
values behind them. When the handler returns the same value again, cdkd cannot
tell, so:

- each consumer takes one redundant update;
- a consumer that is itself a custom resource has its OWN handler invoked
  again, with whatever side effects that handler has;
- a consumer holding the value in a property that cannot change in place is
  read back from AWS first, because cdkd keeps only the mask and cannot compare
  the new value with the old one. If AWS already holds exactly the new value
  there, the consumer is not replaced: it is updated in place when something
  else about it changed, and left alone when nothing did. The readback is
  compared in memory and never stored, so nothing derived from the value lands
  in state. The consumer is still REPLACED (or, for a stateful type, the deploy
  stops and asks for `--force-stateful-recreation`) whenever the readback cannot
  confirm the value: AWS holds a different one, the resource type has no
  readback, or the read fails. The deploy log says which, as a warning. A
  write-only property, which AWS never returns, is replaced only on the few
  resource types cdkd's own replacement rules name. On any other type, it is
  updated in place and never read back. So is any property of a type whose
  write-only list cdkd cannot look up, for example when
  `cloudformation:DescribeType` is denied.

**There is a cost, and it is not hidden from you.** cdkd has nothing to
re-derive the value from — a handler-generated value has no
`{{resolve:...}}` reference behind it — so once the mask is in state, cdkd will
not invent a value for it:

- A LATER deploy in which the custom resource is UNCHANGED does not re-invoke
  the handler (CloudFormation semantics), so the only thing `Fn::GetAtt` can
  read is the mask. If some resource actually has to be written in that deploy
  using that attribute, cdkd REFUSES it rather than sending `***` to AWS, and
  names the remedy: change one of the custom resource's properties (a nonce or
  version property is the usual way) so its handler runs again in the same
  deploy. A deploy that does not have to write the value is unaffected.
- `cdkd drift` reports the position but masks the live value, and `--accept`
  refuses to write that value into the baseline (accepting would undo the
  redaction). `cdkd drift --revert` leaves the position exactly as AWS has it
  rather than pushing the mask; when AWS reports nothing there, it refuses the
  resource.
- `cdkd rollback` refuses to replay a recorded baseline holding the mask, for
  the same reason. Force the custom resource to update and re-deploy to restore
  the property — a plain re-deploy leaves it unchanged, so the handler does not
  run and the mask stays.
- `cdkd export` blocks a resource whose recorded properties hold the mask: the
  exported CloudFormation template would declare the literal `***`. Forcing the
  custom resource to update does NOT clear this one, because the export reads
  STATE and state is exactly where the mask lives. Stop setting `NoEcho` on that
  response and re-deploy, or export the stack without that resource.

**ACROSS STACKS the value is available only within ONE run.** Every cross-stack
route reads the PRODUCER's persisted outputs — a nested stack's
`Fn::GetAtt [<Child>, 'Outputs.<Key>']`, `Fn::ImportValue`, and
`Fn::GetStackOutput` — so a masked output has no plaintext for a consumer to
read. cdkd bridges the case it can: while the producer was deployed by the SAME
`cdkd deploy` process (a nested-stack child, or another stack in the same
`cdkd deploy --all`), the plaintext is still in memory and is handed to the
consumer, which then masks it in its OWN state record. Outside that:

- a `cdkd deploy Consumer` run whose producer was deployed EARLIER reads the
  mask, and is refused rather than writing `***` to AWS;
- **re-deploying the producer by itself does not help** — it re-masks the value
  on the way into its own state, so the consumer's next run reads the mask
  again. Deploy the producer and the consumer in one run, with the producer's
  custom resource actually running (force it to update), or stop marking that
  response `NoEcho`.

**The `Fn::Base64` encoding of a secret is masked the same way, with
different remedies.** cdkd stores `***` where a value is the `Fn::Base64`
encoding of a `{{resolve:...}}` reference (an EC2 `UserData` script, for
example), because the encoding decodes straight back to the secret. No custom
resource is involved, so forcing one to update does nothing, and cdkd cannot
tell this mask from a `NoEcho` one: each refusal names both causes.

- `cdkd rollback` refuses to replay such a baseline. A `cdkd deploy` that
  changes the resource restores the value, because the deploy resolves the
  reference again and sends the encoding; a re-deploy that leaves the resource
  unchanged sends nothing. State still holds `***` afterwards, so a later
  rollback to it refuses again until the secret is no longer encoded into the
  property — have the resource read the secret at run time instead, not by
  writing its plaintext into the template.
- A deploy refuses a resource that reads such a value back out of state, for
  example through an `AWS::SSM::Parameter`'s `Value` attribute when the
  parameter is unchanged. Have the reading resource build the value itself
  from the secret's own reference (the `{{resolve:secretsmanager:...}}` or
  `{{resolve:ssm-secure:...}}` reference, or a `{{resolve:ssm:...}}` of a
  `SecureString` parameter, that the encoding was made from) under its own
  `Fn::Base64`. Do not read the parameter holding the encoding with a
  `{{resolve:ssm:...}}` reference instead: cdkd treats a `String` parameter as
  public and would record the encoding in state in the clear. A re-import does
  not clear this mask.
- `cdkd export` blocks the resource; see [cdkd export](cli-export.md).

Since `version: 11` the record names the attributes a custom resource declared
`NoEcho` (`noEchoAttributeNames`), so a refused read names that cause alone; a
mask with no such record still names every cause.

**Known bound: a value used as a NAME.** A resource's physical id is what
cdkd uses to find it again, so it is never masked. A `NoEcho` value passed as a
create-only name (`QueueName`, `TableName`, a parameter `Name`) is therefore
stored in the clear as that resource's physical id. The attributes AWS builds
around the name on that resource (a queue URL, an ARN) are stored as `***`,
because they contain the value (so a later deploy that has to write one of
them is refused, like any masked read), but any other resource's property or output
that reads one of those holds it in the clear, and so does any command output
that shows a physical id. CloudFormation behaves the same way: `DescribeStackResources`
returns the physical id in the clear, whatever `NoEcho` said. Use `NoEcho`
values as values, never as names.

#### physicalId Format

Varies by resource type. Examples:

| Resource Type | physicalId Example |
|---------------|-------------------|
| `AWS::S3::Bucket` | `my-bucket-name` |
| `AWS::Lambda::Function` | `arn:aws:lambda:us-east-1:123456789012:function:MyFunc` |
| `AWS::IAM::Role` | `MyRole` (role name) |
| `AWS::DynamoDB::Table` | `MyTable` (table name) |
| `AWS::SQS::Queue` | `https://sqs.us-east-1.amazonaws.com/123456789012/MyQueue` |
| `Custom::MyResource` | Any string returned by custom resource |

**Note**: cdkd supports **all resource types supported by Cloud Control API**. The table above shows only a few examples. For resources not supported by Cloud Control API, custom SDK Providers can be implemented (see [Provider Development](./provider-development.md)).

**The physicalId is provider-defined, and it may differ from the value
CloudFormation records for the same resource.** cdkd stores whatever the
provider that created the resource returned — the value that provider needs
to address the resource again on update / delete / drift. For most types
that is the same scalar CloudFormation's `Ref` returns (a bucket name, a
function ARN), but it is not guaranteed to be: see the composite forms
below. Always read the id you must reuse from cdkd itself
(`cdkd state show '<stack>'` / `cdkd state resources '<stack>'`) rather than
from the AWS console or CloudFormation's `DescribeStackResources`.

#### Composite (pipe-delimited) physicalIds

Some resources have no single AWS-side identifier — a Glue table is only
addressable as (database, table); an API Gateway method as (restApi,
resource, httpMethod). For those types cdkd stores a **composite physical
id: the identifying segments joined with a `|` pipe**. That is deliberately
the same convention Cloud Control API uses for a multi-part
`primaryIdentifier`, so a type that moves between an SDK Provider and the
Cloud Control fallback keeps a compatible id (`AWS::EC2::EIP` is the
explicit case — its SDK Provider reproduces the id shape the Cloud Control
path had produced).

The composite value is what state records, what `cdkd state show` /
`cdkd state resources` print, and what
`cdkd import --resource '<logicalId>=<physicalId>'` expects. A few types also
accept a looser form on import — see
[Importing Existing Resources](./import.md#auto-resolved-no-resource-flag-needed) for the
per-type notes.

| Resource Type | physicalId format |
|---------------|-------------------|
| `AWS::ApiGateway::Method` | `<restApiId>\|<resourceId>\|<httpMethod>` |
| `AWS::AppSync::ApiKey` | `<apiId>\|<apiKeyId>` |
| `AWS::AppSync::DataSource` | `<apiId>\|<name>` |
| `AWS::AppSync::Resolver` | `<apiId>\|<typeName>\|<fieldName>` |
| `AWS::EC2::EIP` | `<publicIp>\|<allocationId>` |
| `AWS::EC2::NetworkAclEntry` | `<networkAclId>\|<ruleNumber>\|<egress>` (`egress` is `true` / `false`) |
| `AWS::EC2::Route` | `<routeTableId>\|<destination>` (`destination` is the `DestinationCidrBlock`, `DestinationIpv6CidrBlock`, or `DestinationPrefixListId` the route declares) |
| `AWS::EC2::SecurityGroupIngress` | `<groupId>\|<ipProtocol>\|<fromPort>\|<toPort>` (an omitted port is recorded as `-1`) |
| `AWS::EC2::VPCGatewayAttachment` | `<internetGatewayId>\|<vpcId>` (note the order — CloudFormation's own identifier is `VpcId` first) |
| `AWS::Glue::Table` | `<databaseName>\|<tableName>` (either name may itself contain `\|`: cdkd reads the table name as everything after the recorded `DatabaseName`) |
| `AWS::Lambda::EventInvokeConfig` | `<functionName>\|<qualifier>` (a bare function name is read as qualifier `$LATEST`) |
| `AWS::Route53::RecordSet` | `<hostedZoneId>\|<name>\|<type>` |
| `AWS::S3Tables::Namespace` | `<tableBucketARN>\|<namespaceName>` |
| `AWS::S3Tables::Table` | `<tableBucketARN>\|<namespace>\|<name>` |

Examples as they appear in a real state file (`resources` map, abridged):

```json
{
  "MyGlueTable":  { "physicalId": "my_database|my_table" },
  "MyGetMethod":  { "physicalId": "a1b2c3d4e5|xy9z8w|GET" },
  "MyARecord":    { "physicalId": "Z1D633PJN98FT9|www.example.com.|A" },
  "MyEip":        { "physicalId": "52.1.2.3|eipalloc-0abc123def456789a" }
}
```

### The composite id is NOT what `Ref` returns

CloudFormation's `Ref` for these types returns a value of its own, which is
usually only a PART of cdkd's composite — and sometimes not a part of it at
all. cdkd translates the stored id back to CloudFormation's value before
handing it to any consumer (`Fn::Join` / `Fn::Sub` / a `CfnOutput`), so a
template gets the same value it would from `cdk deploy`. You do not need to do
anything; the table is here because the difference is visible when you compare
`cdkd state show` against a stack output.

| Resource Type | CloudFormation `Ref` returns |
|---------------|------------------------------|
| `AWS::ApiGateway::Method` | an AWS-generated id (no segment reconstructs it — cdkd passes the composite through) |
| `AWS::AppSync::ApiKey` | the API key **ARN** |
| `AWS::AppSync::DataSource` | the data source **ARN** |
| `AWS::AppSync::Resolver` | the resolver **ARN** |
| `AWS::EC2::EIP` | the public IP (the segment before the first `\|`) |
| `AWS::Glue::Table` | the table name — everything after the recorded `DatabaseName` and its `\|`, so a table named `a\|b` resolves to `a\|b` |
| `AWS::Route53::RecordSet` | the record **name**. A three-part id returns its middle segment without reading state. When the name itself contains `\|` (a longer id), it is everything between the first and the last `\|`, only when that matches the recorded `Name` and the last segment the recorded `Type`; an id that does not match passes through raw |
| `AWS::S3Tables::Namespace` / `::Table` | the namespace / table name (the segment after the last `\|`) |

The three `AWS::AppSync::*` children are the case where the `Ref` value is not
a segment at all: cdkd recovers the ARN from the attribute the provider records.
`cdkd import` records the same attribute a fresh deploy does — it reconstructs
the ARN from the composite id you supply — so an adopted child's `Ref` and
`Fn::GetAtt` resolve immediately.

Some records can still lack the attribute. `Ref` on such a record falls back to
the raw composite id. For `Fn::GetAtt` on the ARN attribute, `cdkd deploy`
re-reads the resource from AWS once and records the real ARN; when that read
cannot supply one it FAILS rather than serving a value CloudFormation would not
return. The records are:

- one written by a cdkd older than the fix that started recording the real ARN;
- one whose import could not reach STS, so cdkd could not determine the account.
  It deliberately records NOTHING rather than an ARN built from a placeholder
  account id, which would look valid and be wrong;
- one whose import could not build the ARN for some other reason.

Each of the import cases names itself in a warning at import time.

A deploy that resolves a `Fn::GetAtt` on the ARN heals the record, as does the
resource's next in-place update — see item 4 under
[Purpose of attributes](#purpose-of-attributes).

### …and it is not what `cdkd export` sends CloudFormation either

`cdkd export` hands a stack to CloudFormation via an IMPORT changeset,
which addresses each resource by its CFn `primaryIdentifier`. For most
composite types that identifier is multi-field and cdkd splits the id
into it. Five types are different — their CFn identifier is a SINGLE
field holding a value that is not cdkd's physical id (for four of them
not any segment of cdkd's composite; for the GraphQL API, whose physical
id is the bare `apiId`, the ARN CloudFormation has identified it by since
September 2026):

| Resource Type | CloudFormation IMPORT identifies it by | cdkd resolves it from |
|---------------|----------------------------------------|-----------------------|
| `AWS::AppSync::DataSource` | `DataSourceArn` | the recorded `DataSourceArn` attribute |
| `AWS::AppSync::Resolver` | `ResolverArn` | the recorded `ResolverArn` attribute |
| `AWS::AppSync::GraphQLApi` | `Arn` | the recorded `Arn` attribute |
| `AWS::S3Tables::Table` | `TableARN` | the recorded `TableARN` attribute |
| `AWS::EC2::SecurityGroupIngress` | `Id` (the `sgr-…` rule id) | the recorded `Id` attribute |

You do not need to do anything for the ARN-identified four on a stack
deployed by a current cdkd: a fresh deploy and `cdkd import` both record
the attribute. A record that lacks it — the degraded cases listed above —
makes `cdkd export` block that resource with a message naming the
attribute; re-deploy the stack once to heal the record, then re-run the
export.

`AWS::EC2::SecurityGroupIngress` has **two** ways to lack its `Id`, and
only one of them is healed by re-deploying:

- **The rule declares more than one source.** A single ingress resource
  setting both `CidrIp` and `CidrIpv6` makes AWS mint one rule per
  source, and cdkd deliberately records NEITHER id — neither one is
  "the" identifier for that resource, and picking one would name the
  wrong rule in the import changeset. **Re-deploying never heals this**;
  split the resource into one `AWS::EC2::SecurityGroupIngress` per
  source, which is also the shape CloudFormation manages after the
  export.
- **The rule predates id recording** — it was created by a cdkd older
  than the one that started recording the id at all. This is the one
  exception to "re-deploy once": AWS returns the `sgr-…` id only from
  `AuthorizeSecurityGroupIngress` itself, so a no-op deploy issues no
  call and records nothing. **You do not have to do anything about this
  one** — `cdkd export` recovers the id itself, by looking the rule up in AWS
  (see below). Only if that lookup cannot answer do you need the manual
  remedy: cdkd updates this type by revoking and re-authorizing, so
  changing ANY property of the rule mints a fresh id — as does
  destroying and re-deploying it. Either way the rule's traffic is
  interrupted for the moment between the revoke and the re-authorize,
  so pick the window.

**The live-read backfill.** For a row with no usable recorded `Id`,
`cdkd export` issues a paginated `DescribeSecurityGroupRules` on the
security group its physical id names and adopts the rule only when
EXACTLY ONE ingress rule on that group carries the composite's
`(protocol, port range)` tuple. Zero matches is refused with a message
naming the row and the tuple cdkd searched for, since nothing matched
and there is nothing to name; more than one is refused with a message
naming the row and EVERY candidate `sgr-…` id — cdkd's physical id
identifies a rule only by group, protocol and port range, so two rules
sharing that tuple are two rules cdkd cannot tell apart either, and
adopting one would import the wrong rule. Matching rules are counted
BEFORE any is set aside, so a rule AWS reports without a usable `sgr-…`
id refuses too rather than letting its sibling pass as "exactly one" —
and when more than one rule matched, that refusal carries the two-cause
remedy below as well, since such a row is ambiguous no matter how
readable the ids are. "More than one" has two causes with different
remedies: the multi-source rule above (split the resource), and two
DISTINCT ingress resources differing only by SOURCE — port 443 from a
CIDR and port 443 from a peer security group — which cdkd's composite
cannot tell apart because it carries no source. Those are already one
resource per source, so their remedy is to set the row's `attributes.Id`
to the `sgr-…` id that belongs to it, or to remove the row before
exporting. The lookup needs `ec2:DescribeSecurityGroupRules`; without
that permission the row is blocked with a message saying so, while a
THROTTLED lookup is retried with backoff and, if it still fails,
reported as a throttle rather than as a missing permission. A row that
already records the `Id` — everything a current cdkd deploys — issues no
live read at all.

In both cases you can instead remove the rule from the stack before
exporting: it stays in AWS and can be re-declared in CloudFormation
afterwards.

Some composite types cannot be exported at all, for an unrelated reason:
CloudFormation itself refuses `AWS::Glue::Table`,
`AWS::Route53::RecordSet`, `AWS::AppSync::ApiKey` and
`AWS::EC2::NetworkAclEntry` in IMPORT changesets. `cdkd export` detects
that up front and names every affected resource — see
[`cdkd export`](cli-export.md#resource-types-cloudformation-cannot-import).

Two more types **accept** a composite id without producing one:

- `AWS::ECS::Service` — cdkd stores the service ARN, but
  `<clusterArn>|<serviceName>` is also accepted on `--resource`.
- `AWS::Lambda::Permission` — cdkd stores the bare statement id; state
  written by the older Cloud Control path may instead hold
  `<functionArn>|<statementId>`, and both are read correctly.

> [!IMPORTANT]
> `|` is the shell pipe character. Always **quote** a composite id when you
> pass it on a command line:
>
> ```bash
> cdkd import MyStack --resource 'MyGlueTable=my_database|my_table'
> ```
>
> Unquoted, the shell splits the command at the `|` and the import runs
> against a truncated id. JSON mapping files
> (`--resource-mapping` / `--resource-mapping-inline`) need no escaping —
> `|` is an ordinary character in JSON.

> [!IMPORTANT]
> The separator is **not escaped**, so a segment that contains a `|` would
> make the id ambiguous. `cdkd deploy` **refuses at pre-flight**, naming the
> offending segment, rather than record such an id. There are two
> exceptions. One is `AWS::Glue::Table`, where both the table name and the database name may
> contain `|`: a table named `a|b` in database `x|y` is recorded as
> `x|y|a|b`, and cdkd reads the table name back as everything after the
> recorded `DatabaseName` — for update, destroy, drift and `Ref` alike. A
> record whose `DatabaseName` is not a plain string (`cdkd import` can leave
> it unresolved) cannot be placed that way: destroy then skips it and says to
> set `properties.DatabaseName` in the state file. The other is
> `AWS::Route53::RecordSet`, whose record name may contain `|`: a record named
> `a|b.example.com` of type `A` in zone `Z1` is recorded as
> `Z1|a|b.example.com|A`, and cdkd reads the name back as everything between
> the first and the last `|` only when it matches the recorded `Name` and the
> last segment matches the recorded `Type`. An id that does not match is read
> as CloudFormation's own physical id (the record name), and the zone comes
> from the recorded properties.
> For every other type, AWS's own naming rules and generated ids keep `|` out
> of the value.

#### Purpose of attributes

Stored to resolve attribute references via `Fn::GetAtt`.

Example:

```yaml
# CloudFormation template
!GetAtt MyBucket.Arn
```

↓ cdkd resolves

```typescript
const bucketState = state.resources['MyBucket'];
const arn = bucketState.attributes['Arn'];
// => "arn:aws:s3:::myappstack-mybucket-abc123xyz"
```

**How Attributes are Collected**:

1. **Cloud Control API**: Automatically collected from `GetResource` response
2. **SDK Provider**: Provider explicitly returns in `create()` / `update()`
3. **`cdkd import`**: Provider returns them from `import()`, so an adopted
   resource carries the same attribute snapshot a deployed one does. When a
   provider's `import()` returns no attributes — whether it omits the field
   or returns an empty `{}`, which is what most providers do — cdkd falls
   back to the map already in state, but only if the resource is being
   re-imported at the *same* physical id. A re-import that repoints a logical
   id at a different physical resource never inherits the old one's
   attributes. With neither source the map is empty (`{}`).

   Providers deliberately **omit** an attribute key rather than storing an
   empty string when a read-back cannot supply the value: the intrinsic
   resolver treats any non-`undefined` stored attribute as a hit, so a
   persisted `''` would shadow its computed fallback and make `Fn::GetAtt`
   resolve to the empty string.
4. **`cdkd deploy`, on a miss**: when a `Fn::GetAtt` is about to fall back to
   the physical ID for a resource this deploy does not update, cdkd re-reads the
   resource's attributes once through the provider's read-only `import()` and
   adds them to the record at the next state save. Only keys the record does
   not already hold are added (a wildcard placeholder ARN from an old release
   is the one value that is overwritten), an empty value is never added, and no
   other field of the record is touched. `--dry-run` reads but records nothing.
   `cdkd diff` issues the same read for its preview and records nothing; other
   read-only commands (`cdkd drift`) never re-read. See
   ["Cannot resolve" a GetAtt on a resource an older cdkd deployed](troubleshooting.md#cannot-resolve-a-getatt-on-a-resource-an-older-cdkd-deployed).

```typescript
// IAM Role Provider example
return {
  physicalId: roleName,
  attributes: {
    Arn: response.Role?.Arn,
    RoleId: response.Role?.RoleId,
  },
};
```

#### Purpose of dependencies

Used to determine proper deletion order in `destroy` command.

**Dependency Recording Timing**: Extracted from DAG during deployment

```typescript
// deploy-engine.ts
const resourceState: ResourceState = {
  // ...
  dependencies: dagNode.dependencies.map(dep => dep.logicalId),
};
```

**Determining Deletion Order**: Topological sort in reverse of dependencies

```
Creation order: Bucket → Role → Function
Deletion order: Function → Role → Bucket (reverse)
```

### LockInfo (`lock.json`)

```typescript
interface LockInfo {
  owner: string        // Process identifier (e.g., "user@hostname:12345")
  timestamp: number    // Lock acquisition time (Unix timestamp, milliseconds)
  expiresAt: number    // Lock expiry (Unix timestamp, milliseconds); RENEWED while the holder lives
  operation?: string   // Operation in progress (e.g., "deploy", "destroy")
}
```

`expiresAt` moves forward roughly every two minutes for as long as the holding
process is alive (see "Lock renewal" below), so it is not the time the
operation started plus the TTL -- it is the deadline by which the holder must
next check in.

#### Example

```json
{
  "owner": "goto@macbook:12345",
  "timestamp": 1710835200000,
  "expiresAt": 1710837000000,
  "operation": "deploy"
}
```

## Lock Mechanism

### Optimistic Lock Implementation

Lightweight lock system using S3 Conditional Writes.

Like the state backend, the lock manager resolves the state bucket's
actual region via `GetBucketLocation` before its first S3 operation and
rebuilds its S3 client when the bucket lives in a different region from
the CLI's base region, so locking works against a
cross-region state bucket too. The per-bucket region lookup is cached, so
this adds no extra API call when the state backend already resolved the
same bucket.

#### Lock Acquisition (Acquire)

```typescript
// Using If-None-Match: "*"
// → Succeeds only if object doesn't exist
await s3Client.send(
  new PutObjectCommand({
    Bucket: stateBucket,
    Key: `cdkd/${stackName}/${region}/lock.json`,
    Body: JSON.stringify(lockInfo),
    IfNoneMatch: '*',  // ← Important: only if object doesn't exist
  })
);
```

**Success**: Lock acquired → Continue processing
**Failure** (`PreconditionFailed`): Lock already exists → Another process is running

#### Lock Release (Release)

The DELETE is **conditional on the ETag this process last wrote**, so a process
can only ever delete the lock object it still owns:

```typescript
// IfMatch: the ETag returned when this process wrote (or last renewed) the lock
await s3Client.send(
  new DeleteObjectCommand({
    Bucket: stateBucket,
    Key: `cdkd/${stackName}/${region}/lock.json`,
    IfMatch: heldEtag,
  })
);
```

A `PreconditionFailed` here means the lock present is somebody else's; cdkd
leaves it in place and warns rather than raising, because the operation itself
has already finished and the caller has nothing to do about it.

The condition is dropped for exactly one class of failure: **the endpoint or
the policy will not evaluate it at all.** A conditional delete with a specific
ETag additionally requires `s3:GetObject`, so a policy granting only
`s3:DeleteObject` answers `403`, and an S3-compatible endpoint that has not
implemented the header answers `501`. Those fall back to an unconditional
delete so such a setup cannot end up with a stranded lock.

Even then the ownership is re-checked by hand before the condition is dropped,
because S3 authorizes a request *before* it evaluates a precondition: a policy
that scopes `s3:GetObject` away from `lock.json` turns a genuine `412` into a
`403`, and an unconditional retry there would delete the lock of whoever took
over. The re-read happens unconditionally -- **not** skipped when cdkd's own
deadline is still in the future, because `cdkd force-unlock` deletes regardless
of expiry, so a user running it mid-operation is a legitimate takeover no
deadline can rule out (cross-machine clock skew reaches the same state with
nobody running anything). A read that FAILS refuses: on the very policy this
fallback exists for, the read fails too, so answering "proceed" there would
leave the check inert in exactly the situation it was added to catch.

The expired-lock takeover has **no** such fallback, deliberately. Its `IfMatch`
is what makes concurrent reaping safe -- two processes that both judge a lock
expired race to delete it, the first wins and the second gets a `412` and
reports contention. Without the condition both would win, each would then
acquire against the key it just emptied, and the stack would have two holders.
An expired lock under a policy that cannot evaluate the condition is cleared
with `cdkd force-unlock`.

Every other failure raises, which is what release has always done. In
particular a `409` (S3's answer to a concurrent operation on the key) and a
`503` are **not** fallback-worthy: the first is the contended case by
definition, and the second may mean the conditional delete already succeeded
with the response lost, so an unconditional retry would delete whichever lock
exists by then. The heartbeat is already stopped at that point, so the worst
outcome is a lock that lapses at its TTL -- recoverable, unlike a lock deleted
out from under a live writer.

**A failed release never fails the command.** Every caller wraps it and logs a
warning, so a throttled or conflicted release is reported without replacing the
error the command was actually about -- and without aborting a `cdkd destroy
--all` run at the first stack over a lock that clears itself.

A second `releaseLock` for the same key is a no-op rather than an owner-blind
delete: the entry is tombstoned, not dropped. This matters because the
force-quit paths fire an un-awaited release while the main `finally` may still
be in one.

`cdkd force-unlock` is deliberately **not** conditional: it exists precisely to
remove a lock this process does not own.

In older cdkd versions this was an
owner-blind unconditional delete, which is what turned a single lapsed lock
into a cascade -- a process whose lock had been taken over deleted the *new*
owner's lock on its way out, freeing the stack for a third writer.

#### Retry Logic

```typescript
async acquireLockWithRetry(
  stackName: string,
  region: string,
  owner?: string,
  operation?: string,
  maxRetries = 3,
  retryDelay = 2000  // 2 seconds
): Promise<void> {
  let lockInfo = null;
  let releasedReacquires = 0;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // acquireLock reaps an EXPIRED foreign lock itself and retries once, so a
    // `false` here means someone else held the lock at the PUT.
    if (await this.acquireLock(stackName, region, owner, operation)) return;

    lockInfo = await this.getLockInfo(stackName, region);
    if (!lockInfo && releasedReacquires < RELEASED_LOCK_REACQUIRE_LIMIT) {
      // Released since the PUT: try again now, without spending a retry.
      releasedReacquires++;
      attempt--;
      continue;
    }
    if (attempt < maxRetries) {
      // Reports the holder (or that none could be read), then waits.
      await sleep(retryDelay);
    }
  }

  // Renders the read taken after the LAST failed acquire -- the holder, or
  // "No lock could be read" -- never a second read.
  throw new LockError('Failed to acquire lock after retries');
}
```

`RELEASED_LOCK_REACQUIRE_LIMIT` is 3. The bound matters because `getLockInfo`
also reads a `lock.json` whose body is not an object as "no lock", and that
object never lets the PUT through.

Expiry is decided by the lock's own `expiresAt` field, not by its age: a live
holder keeps pushing that field forward, so "old" and "abandoned" are different
questions and only the second one frees the lock.

### What the lock covers

A lock covers one stack in one region, and it is held for as long as the
command is working on that stack — in a multi-stack run each stack's lock is
released as that stack finishes, not at the end of the command. Either way it
is released when the work finishes, not when the resources it touched finish
provisioning, so a second `cdkd deploy` on the same stack can start while
resources the first one created are still coming up.
[`cdkd deploy`](cli-deploy.md#what-the-stack-lock-covers-and-when-a-second-deploy-can-start)
covers what that second deploy runs into.

### Lock TTL (Time To Live)

Default: **30 minutes**

### Lock renewal

The holding process **renews its lock in the background**, re-writing
`expiresAt` at most every **2 minutes** (or every quarter of the TTL, whichever
is shorter) for as long as the operation runs. Each renewal is a conditional
`PutObject` carrying `IfMatch` with the ETag of the object this process last
wrote, so a process that has already lost the lock cannot resurrect its own
expiry on top of the new owner's.

This is what makes the TTL mean **"the owner has been silent for 30 minutes"**
rather than **"the operation has been running for 30 minutes"**. The default TTL
tolerates fourteen consecutive missed renewals (a throttle, a network blip)
before it lapses; a renewal that fails for any reason other than "this lock is
no longer mine" is simply retried on the next tick. If they fail long enough
that the deadline actually passes, cdkd says so once at `warn` -- otherwise
half an hour of failing renewals would read exactly like a healthy run while
another process becomes free to take the lock.

A `412` on a renewal is not taken at face value. A conditional `PutObject` that
S3 applied but whose response was lost -- or an SDK-internal retry of it --
leaves the cached ETag one version behind, so the next attempt legitimately
conflicts with cdkd's own write. cdkd reads the object once to tell the two
apart and adopts the renewal when the stored body is byte-for-byte what it just
wrote (same owner, same acquisition timestamp, same millisecond deadline).
Without that check the process would declare a lock it still owns lost, warn
about a concurrent writer that does not exist, and then refuse to release its
own lock.

In older cdkd versions there was no
renewal at all, so any operation slower than the TTL silently stopped being
mutually exclusive while it was still running. That is reachable without
anything exotic: `AWS::FSx::FileSystem`, `AWS::EMR::Cluster` and Custom
Resources each wait up to an hour on their own, and a large enough stack
exceeds 30 minutes in aggregate regardless of resource type.

Two consequences worth knowing:

- **A lock whose `expiresAt` is not a finite number counts as EXPIRED.** That
  field arrives from the state bucket unvalidated, and `Infinity` / `NaN` /
  a string would otherwise pin the stack forever: no acquisition would ever
  succeed again and only `cdkd force-unlock` could clear it. Treating it as
  expired grants no new power -- anyone who can write that value could equally
  have deleted the object -- and it is the recoverable direction.
- **A lock that reaches its `expiresAt` now genuinely means an absent owner** --
  a crashed process, a `SIGKILL`, or a machine that slept. cdkd logs the
  takeover at `warn` level naming the previous owner, because on the remaining
  chance that the process IS alive, two writers are now operating on the stack.
- **The state bucket is versioned**, so each renewal adds one `lock.json`
  object version. A 30-minute deploy writes about fifteen, and they go
  noncurrent the moment the next renewal lands. A `DeleteObject` on a versioned
  bucket writes a DELETE MARKER and leaves every earlier version readable
  through `GetObject` with a `VersionId`, so previously the release left
  the whole chain behind and the count grew for the life of the bucket -- 452
  versions on a single measured key, invisible to `aws s3 ls`, still billed,
  and still paged through by every version listing the other purge sites issue.
  **cdkd now purges the lock key's noncurrent versions wherever it deletes the
  lock**: on release, on the expired-lock takeover, and on `cdkd force-unlock`.
  Nothing sensitive is in them (`lock.json` carries only `owner`, `timestamp`,
  `expiresAt` and an optional `operation`), so this is bucket cost rather than
  disclosure -- which is exactly why the reporting differs from the four
  secret-bearing sites: a purge failure on the RELEASE path is logged at
  `debug`, not `warn`, so a least-privilege principal without
  `s3:ListBucketVersions` / `s3:DeleteObjectVersion` does not get a warning at
  the tail of every mutating command about a heartbeat record. The two rare
  reap paths (takeover, `force-unlock`) do warn, matching the cost profile the
  [bucket-policy section](#recommended-bucket-policy-with-least-privilege)
  describes -- that section is also where the two grants and the never-throw
  contract are spelled out. Nothing fails either way.

  **The trade that split makes, stated rather than left implicit:** a principal
  who has `s3:ListBucketVersions` but lacks `s3:DeleteObjectVersion` now gets
  no routine signal that the chain is still growing, because the release path
  -- the one that runs on every mutating command -- reports at `debug`. (A
  principal missing `s3:ListBucketVersions` is already warned on every
  successful deploy by the rollback journal's own purge, so nothing changes for
  them.) That is deliberate (a warning per command
  about a heartbeat record is worse than the growth it reports), but it means
  the growth is silent for exactly the population that cannot stop it. The
  fallback is not a lifecycle rule -- see above for why one is not expressible
  against this key layout -- it is to grant the two actions, at which point the
  purge simply works. To check whether it is happening, run any mutating
  command with `--verbose` and look for the purge line, or count the versions
  directly:

  ```bash
  # Both halves matter: the purge removes noncurrent BODIES and noncurrent
  # DELETE MARKERS, and a released lock key accumulates one marker per cycle,
  # so counting bodies alone undercounts the growth. The `|| ` + "[]" default is
  # not decoration either -- on a fully purged key the response carries no
  # `Versions` array at all, and `length(null)` is a JMESPath ERROR, so the
  # naive query fails exactly when the answer should be 0.
  aws s3api list-object-versions --bucket <state-bucket> \
    --prefix "cdkd/<stack>/<region>/lock.json" \
    --query 'length(Versions[?IsLatest==`false`] || `[]`)'
  aws s3api list-object-versions --bucket <state-bucket> \
    --prefix "cdkd/<stack>/<region>/lock.json" \
    --query 'length(DeleteMarkers[?IsLatest==`false`] || `[]`)'
  ```

  Two things this does NOT do. The CURRENT version is never touched -- the
  purge filters on `IsLatest`, so it can neither delete the live lock nor
  remove the delete marker whose removal would resurrect a stale one. And it is
  scoped to the `lock.json` KEY, never to the stack prefix, so `state.json`'s
  history is untouched.

  **A bucket lifecycle rule is not an alternative here, contrary to what this
  document said before the site shipped.** The lock key is
  `cdkd/{stackName}/{region}/lock.json` -- `lock.json` is a key SUFFIX,
  interleaved under the same per-stack prefix as `state.json`,
  `rollback-journal.json` and `deployments/`. S3 lifecycle filters support
  `Prefix`, `Tag` and `ObjectSize` only, so no rule can select the lock keys and
  spare `state.json`; the one expressible prefix rule, `cdkd/`, would expire
  `state.json`'s noncurrent versions too -- the recovery capability the
  exempted keys are deliberately held open to protect, done in bucket
  configuration instead of in code. A tag-scoped rule would need `s3:PutObjectTagging` on the
  lock write, i.e. on the hot path.

  Still deliberately NOT purged: `state.json` itself and the v1 -> v2 migration
  delete, because those noncurrent versions ARE
  the state-recovery capability versioning is enabled for. The one exception
  is an explicit `cdkd scrub`, which purges the history of a `state.json` it
  rewrites (and, under `--purge-history`, of every record it examines and does
  not refuse), short of deleting the bucket itself (`cdkd bootstrap --destroy`,
  `cdkd state migrate --remove-legacy`) — see
  [`cdkd scrub`](cli-scrub.md#what-a-real-run-removes-and-what-it-cannot).

If the holding process dies without releasing, the lock stops being renewed and
is reclaimed by the next `cdkd` invocation once `expiresAt` passes -- or
immediately with `cdkd force-unlock '<stack>'`.

### Deploy interruption (Ctrl-C)

`cdkd deploy` handles the first `Ctrl-C` (SIGINT) gracefully:

- **First Ctrl-C** stops dispatching new resource operations. Any provider
  call already in flight is allowed to finish, partial state is saved (state
  is also saved incrementally after each completed resource), a rollback
  journal is recorded for `cdkd rollback`, and the stack lock is **released**
  before the command exits non-zero. A re-run resumes without waiting out the
  lock TTL.
- **Second Ctrl-C** force-quits immediately (`process.exit(130)`) without
  waiting for in-flight operations, printing the `cdkd force-unlock` recovery
  hint. The lock may be left behind and is reclaimed after the TTL above (or
  cleared with `cdkd force-unlock`).

`SIGTERM` (what CI runners, `docker stop`, and Kubernetes send on
cancellation) is forwarded to the same path: the first `SIGTERM`
behaves like the first Ctrl-C, a subsequent signal like the second.

### Destroy interruption (Ctrl-C)

`cdkd destroy` and `cdkd state destroy` handle the first `Ctrl-C` (SIGINT)
gracefully,
mirroring Terraform:

- **First Ctrl-C** stops scheduling new deletes. Any provider delete already
  in flight is allowed to finish (it is not cancelled). The runner then flushes
  the incremental destroy state (the same per-resource save-chain that powers
  the partial-failure path — see "Incremental destroy persistence" below), so
  the preserved `state.json` lists only the resources that still exist.
  Finally it **releases the stack lock** and the command exits non-zero. A
  re-run of `cdkd destroy` resumes cleanly with no replay and no wait for the
  lock TTL.
- **Second Ctrl-C** force-quits immediately (`process.exit(130)`) without
  waiting for the in-flight delete. In that case the lock may be left behind
  and is reclaimed after the TTL above (or cleared with `cdkd force-unlock`).

This is why an interrupted destroy no longer strands the lock for its full
TTL: only an ungraceful kill (`SIGKILL`, a second Ctrl-C, or a crash) leaves a
stale lock. As with deploy, `SIGTERM` is forwarded to the same graceful path
— the first
`SIGTERM` drains like the first Ctrl-C, a second one force-quits.

### CI job cancellation

A cancelled CI job (e.g. GitHub Actions `cancel-in-progress: true`) can still
strand the lock: cdkd's `deploy` / `destroy` / `state destroy` / `rollback`
commands handle both `SIGINT` and `SIGTERM` gracefully, but CI runners
escalate to `SIGKILL` — which no process can handle — after a short grace
period (~10 s total on GitHub Actions), so a long in-flight AWS operation
can still die before the lock release runs. The lock is then reclaimed after
the TTL above, or cleared immediately with `cdkd force-unlock '<stack>'`. See
["Stale lock after a cancelled CI job" in the troubleshooting
guide](troubleshooting.md#stale-lock-after-a-cancelled-ci-job) for the
full CI story and recommended workflow patterns.

## State Saving and Updating

### Initial Save (New Stack)

```typescript
const newState: StackState = {
  version: 1,
  stackName: 'MyStack',
  resources: { /* ... */ },
  outputs: { /* ... */ },
  lastModified: Date.now(),
};

// No ETag expected (new creation)
const etag = await s3StateBackend.saveState('MyStack', newState);
console.log(`Saved with ETag: ${etag}`);
```

### Update Save (Existing Stack)

```typescript
// 1. Get current state
const current = await s3StateBackend.getState('MyStack');
if (!current) {
  throw new Error('State not found');
}

// 2. Update state
const updatedState: StackState = {
  ...current.state,
  resources: { /* updated resources */ },
  lastModified: Date.now(),
};

// 3. Save with ETag (optimistic lock)
const newEtag = await s3StateBackend.saveState(
  'MyStack',
  'us-east-1',
  updatedState,
  { expectedEtag: current.etag }  // ← refuse the write if state moved
);
console.log(`Updated with new ETag: ${newEtag}`);
```

### ETag Handling

S3's ETag is returned **with double quotes**:

```typescript
// S3 response
{
  ETag: '"abc123def456"'  // ← With quotes
}

// When passing to If-Match, keep quotes
{
  IfMatch: '"abc123def456"'
}
```

cdkd stores and uses ETags as-is.

## Deployment Flow and State Management

### Full Deployment Flow

```typescript
async deploy(stackName: string) {
  // 1. Acquire lock
  await lockManager.acquireLockWithRetry(stackName, 'deploy');

  try {
    // 2. Get current state
    const currentStateData = await s3StateBackend.getState(stackName);
    const currentState = currentStateData?.state;
    const currentEtag = currentStateData?.etag;

    // 3. CDK synthesis
    const assembly = await synthesizer.synth();

    // 4. Publish assets
    await assetPublisher.publishAssets(assembly);

    // 5. Parse template
    const template = assembly.getStackByName(stackName).template;
    const resources = templateParser.parse(template);

    // 6. Build DAG
    const dag = dagBuilder.build(resources);

    // 7. Calculate diff
    const diffs = diffCalculator.calculate(currentState, template);

    // 8. Execute resources (event-driven DAG dispatch)
    const newResourceStates = {};
    const executor = new DagExecutor();
    for (const resource of resources) {
      executor.add({
        id: resource.logicalId,
        dependencies: new Set(resource.dependencies),
        state: 'pending',
        data: resource,
      });
    }
    await executor.execute(concurrency, async (node) => {
      const result = await provisionResource(node.data, diffs);
      newResourceStates[node.id] = {
        physicalId: result.physicalId,
        resourceType: node.data.resourceType,
        properties: node.data.properties,
        attributes: result.attributes,
        dependencies: node.data.dependencies,
      };
    });

    // 9. Resolve Outputs
    const outputs = resolveOutputs(template.Outputs, newResourceStates);

    // 10. Save state (with ETag check)
    const newState: StackState = {
      version: 1,
      stackName,
      resources: newResourceStates,
      outputs,
      lastModified: Date.now(),
    };

    await s3StateBackend.saveState(stackName, newState, currentEtag);

    // 11. Release lock
    await lockManager.releaseLock(stackName);

  } catch (error) {
    // Release lock even on error
    await lockManager.releaseLock(stackName);
    throw error;
  }
}
```

### Behavior on Partial Failure

cdkd catches errors per resource and saves **only successful resources** to state.

```typescript
// deploy-engine.ts (event-driven DAG dispatch)
const newResourceStates = {};
const executor = new DagExecutor();
// ... add nodes ...

try {
  await executor.execute(concurrency, async (node) => {
    const result = await provisionResource(node.data);
    // Record successful resource immediately (per-resource state save)
    newResourceStates[node.id] = result;
  });
} catch (error) {
  // First failure aborts dispatch — downstream nodes are auto-skipped.
  // Already-completed resources remain in newResourceStates for rollback.
  logger.error('Provisioning failed:', error);
  throw error;
}
// (placeholder — see actual code for the full rollback path)

// Save only successful state
await s3StateBackend.saveState(stackName, newState);
```

**On Next Execution**: Diff calculation will detect only failed resources as `CREATE` and retry them.

## Deletion (Destroy) and State Management

### Destroy Flow

```typescript
async destroy(stackName: string) {
  // 1. Acquire lock
  await lockManager.acquireLockWithRetry(stackName, 'destroy');

  try {
    // 2. Get current state
    const currentStateData = await s3StateBackend.getState(stackName);
    if (!currentStateData) {
      throw new Error(`No state found for stack: ${stackName}`);
    }

    const state = currentStateData.state;
    const remainingResources = { ...state.resources };

    // 3. Determine deletion order from dependencies (reverse topological sort)
    const deletionOrder = computeDeletionOrder(state.resources);

    // 4. Delete resources (reverse of dependencies)
    let errorCount = 0;
    for (const logicalId of deletionOrder) {
      const resource = state.resources[logicalId];

      try {
        await providerRegistry
          .getProvider(resource.resourceType)
          .delete(logicalId, resource.physicalId, resource.resourceType);

        logger.info(`Deleted resource: ${logicalId}`);

        // 4b. Incremental state persistence: remove the
        // deleted resource and write the trimmed state back to S3 so an
        // interrupted destroy leaves a state file that only lists
        // resources that still exist. The persisted snapshot also CLEARS
        // outputs and drops imports/outputReads (see note below). Persist
        // failures are logged and never fail the destroy — the final
        // write below is authoritative.
        delete remainingResources[logicalId];
        await s3StateBackend.saveState(stackName, region, {
          ...state,
          resources: remainingResources,
          outputs: {},      // never advertise a gone resource's export
          imports: undefined,
          outputReads: undefined,
        });
      } catch (error) {
        logger.error(`Failed to delete ${logicalId}:`, error);
        errorCount++;
        // Continue even on deletion failure (best effort)
      }
    }

    // 5. Full success: delete the state file. Partial failure: persist
    // the remaining state (failed + not-yet-deleted + retained resources,
    // with outputs cleared) so the user can re-run without replaying
    // completed deletes.
    if (errorCount === 0) {
      await s3StateBackend.deleteState(stackName);
    } else {
      await s3StateBackend.saveState(stackName, region, {
        ...state,
        resources: remainingResources,
        outputs: {},
        imports: undefined,
        outputReads: undefined,
      });
    }

    // 6. Release lock
    await lockManager.releaseLock(stackName);

  } catch (error) {
    await lockManager.releaseLock(stackName);
    throw error;
  }
}
```

**Incremental state persistence during destroy**: the destroy path
mirrors deploy's per-resource state saves. Each successfully deleted
resource (including resources found already deleted on a re-run) is removed
from the state object and the trimmed state is written back to S3
immediately, serialized under the stack lock the destroy already holds. An
interrupted (Ctrl-C) or partially-failed destroy therefore preserves a state
file that only lists resources that still exist — a re-run does not replay
deletes against already-deleted resources (which previously caused, for
example, a 10-minute stall per Custom Resource whose backing Lambda had
already been deleted). Resources retained via `DeletionPolicy: Retain` stay
in every intermediate snapshot; their record is only dropped by the
wholesale state-file delete at the end of a fully successful destroy. A
failed incremental write is logged and never fails the destroy — the final
write (state-file delete on success, preserve-write on failure) remains
authoritative.

Every persisted destroy snapshot (both the incremental writes and the final
partial-failure preserve-write) **clears `outputs` and drops `imports` /
`outputReads`**. `outputs` is keyed by output *name*, not logical id, so it
cannot be pruned precisely as the backing resources are deleted; a
partially- or fully-destroyed stack has no meaningful outputs, and leaving
them in the preserved state would advertise an export whose backing resource
is gone — a phantom export the
[exports index](cross-stack-references.md) or another producer's
strong-reference consumer scan (`scanActiveConsumers`) could pick up.
Clearing them removes that hazard. This does **not** affect the destroy's
own strong-reference check: that reads the *in-memory* `state.outputs`
*before* the delete loop, and the in-memory `state` object is never mutated
— only the persisted snapshot copies are cleared. On a clean destroy the
stack's entry is removed from the exports index outright
(`exportIndexStore.removeStack`); on a partial destroy the index may briefly
still list stale entries, but that index is a perf-only derived view that
self-heals on the next deploy / fallback scan, while the canonical
`state.json` no longer carries the phantom outputs.

### Computing Deletion Order

```typescript
function computeDeletionOrder(resources: Record<string, ResourceState>): string[] {
  // Build dependency graph
  const graph = new Map<string, string[]>();

  for (const [logicalId, resource] of Object.entries(resources)) {
    graph.set(logicalId, resource.dependencies);
  }

  // Topological sort (reverse)
  const sorted = topologicalSort(graph);
  return sorted.reverse();  // Deletion is reverse of creation
}
```

### Cleanup Options

cdkd ships four commands that touch state during cleanup. Choose based on
whether the CDK app is available, and whether you also want to delete the
underlying AWS resources:

| Command | Needs CDK app? | Deletes AWS resources? | Removes state record? |
| --- | --- | --- | --- |
| `cdkd destroy '<stack>'` | Yes (synth) | Yes | Yes |
| `cdkd state destroy '<stack>'` | No | Yes | Yes |
| `cdkd orphan '<constructPath>'...` | Yes (synth) | **No** | Only the named resources' entries |
| `cdkd state orphan '<stack>' --resource <logicalId>` | No | **No** | Only the named resources' entries |
| `cdkd state orphan '<stack>'` | No | **No** | Yes, the whole record |

`cdkd destroy` is the canonical path when you have the CDK source — it synths
the app, intersects against state, and deletes resources in reverse dependency
order. `cdkd state destroy` is the same per-stack pipeline (the logic is hoisted
into `src/cli/commands/destroy-runner.ts` and shared by both commands), but
sourced from the state record instead of synth output, so it works from any
working directory given access to the state bucket. Use it for cleanup from a
machine without the CDK source, CI cleanup jobs after the source repo is gone,
or a forgotten stack referenced only by name.

`cdkd orphan` and `cdkd state orphan` only forget state — the AWS resources
stay alive — and are the right tools when you want cdkd to stop tracking
something without touching it. The naming mirrors aws-cdk-cli's new `cdk
orphan` command. They differ in granularity, which is what decides between
them:

- `cdkd orphan '<constructPath>'...` takes CDK **construct paths**
  (`MyStack/MyTable`) and drops those resources from the record, leaving the
  rest of the stack tracked. It synthesizes, so it also rewrites the sibling
  references to each orphan and needs the CDK source.
- `cdkd state orphan '<stack>' --resource <logicalId>` drops those resources'
  entries by logical id and rewrites the same sibling references, with no CDK
  app — so it also reaches a resource whose construct is already gone.
- `cdkd state orphan '<stack>'` removes the entire record for a stack and
  operates on the bucket alone, with no CDK app.

[Orphan vs Destroy](orphan-vs-destroy.md) compares them side by side.

## Security and Best Practices

**Treat `state.json` as sensitive.** Secret redaction stores a
`{{resolve:...}}` reference in place of the value it resolves to where it can
line the two up ([how, and where it cannot](cli-scrub.md#how-secrets-stay-out-of-state)).
Several kinds of value are stored as they are, and `cdkd scrub` does not
detect any of them:

- what the drift baseline (`observedProperties`) records from AWS — and
  `attributes`, for a resource cdkd provisions through Cloud Control API —
  including values the template never names through a reference
  ([details](import.md#a-value-your-template-never-references-is-recorded-as-aws-holds-it));
- a credential a provider records in `attributes` so that `Fn::GetAtt` can
  read it, whether the provider is an SDK provider or Cloud Control — for
  example an `AWS::IAM::AccessKey`'s `SecretAccessKey`;
- a `NoEcho` parameter's value in a state record written before
  [`version: 11`](#version-11-stores-noecho-values-as-current-writers), until the
  next `cdkd deploy` migrates it, and in every earlier object version of it.

Limit who can read the state bucket, and its earlier object versions,
accordingly.

### S3 Bucket Configuration

#### Recommended: Bucket Policy with Least Privilege

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::123456789012:role/CdkdDeployRole"
      },
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket",
        "s3:ListBucketVersions",
        "s3:DeleteObjectVersion",
        "s3:GetReplicationConfiguration"
      ],
      "Resource": [
        "arn:aws:s3:::cdkd-state-bucket",
        "arn:aws:s3:::cdkd-state-bucket/*"
      ]
    }
  ]
}
```

`s3:ListBucketVersions` and `s3:DeleteObjectVersion` are what let cdkd finish
deleting an object on a VERSIONED bucket, which the state bucket is: `cdkd bootstrap` turns versioning on, so
`DeleteObject` writes a DELETE MARKER and every earlier version of the key
stays readable through `GetObject` with a `VersionId`.

- **`s3:ListBucketVersions`** — bucket-level, like the `s3:ListBucket` above
  it, so the bare `arn:aws:s3:::cdkd-state-bucket` ARN already in `Resource`
  covers it. Lets cdkd find the leftover versions.
- **`s3:DeleteObjectVersion`** — object-level, like the `s3:DeleteObject`
  above it, so the `arn:aws:s3:::cdkd-state-bucket/*` ARN covers it. Lets cdkd
  remove them.

The third addition is DIAGNOSTIC rather than required, and the only entry in
this policy that is:

- **`s3:GetReplicationConfiguration`** — bucket-level. Lets cdkd tell you when
  the purge above was defeated by replication (see
  [S3 replication defeats the purge](#s3-replication-defeats-the-purge-and-cdkd-cannot-fix-it-for-you)).
  Remove it and everything still works; you simply stop being told. Nothing
  fails without it.

**Six kinds of object need those two version actions, not one** — the five in
this table and the `deployments/**` event store below it, plus `state.json` and
the exports index for a principal that runs `cdkd scrub`. The set has grown
over time, and the ordinary
commands are now in it:

| object | purged by | what its previous versions hold |
| --- | --- | --- |
| `rollback-journal.json` | every successful `cdkd deploy`, every clean `cdkd rollback`, `cdkd destroy` / `cdkd state destroy` | `failedOperations[].attemptedProperties` — the properties of the FAILED write, verbatim. Measured on a repo fixture as four versions each carrying a literal `"MasterUserPassword"` |
| custom-resource response object | `cdkd deploy` (the provider's own cleanup) and `cdkd gc` | the handler's FULL cfn-response, `Data` included — where a handler-minted password or API key lands |
| transient CFn template | `cdkd import --migrate-from-cloudformation`, `cdkd export`, and MACRO EXPANSION during `cdkd deploy` / `cdkd diff` (any template over the 51,200-byte inline ceiling) | the template body, which carries a secret only if the template does (an inline `Code.ZipFile`, a hand-written literal) |
| `cdkd-bootstrap/{region}.json` | `cdkd bootstrap --destroy` | the asset bucket and container-repo names. No secret; listed for completeness |
| `lock.json` | every command that RELEASES a stack lock, plus the expired-lock takeover and `cdkd force-unlock` | the lock heartbeat: `owner`, `timestamp`, `expiresAt`, `operation`. No secret -- one row per two-minute renewal, which is why it was the fastest-growing key in the bucket. **Reported differently: see below** |

The journal is the one to note if you are deciding whether this matters to you:
it is written by an ORDINARY failed or interrupted deploy, not by an opt-in
feature, and it is swept by an ordinary `cdkd destroy`. `state.json` is
deliberately NOT in this table — its previous versions are the state-recovery
capability versioning is enabled for, and short of deleting the bucket only an
explicit `cdkd scrub` purges them (see
[`cdkd scrub`](cli-scrub.md#what-a-real-run-removes-and-what-it-cannot)).

**The `deployments/**` event store needs the two version actions as well.**
Every path that deletes from it — the writer's self-bounding prune,
`cdkd events prune`, and `cdkd destroy --purge-events` — also purges the
noncurrent versions of the keys it deletes, and `cdkd events prune --all` /
`cdkd destroy --purge-events` purge every noncurrent version under the stack's
`deployments/` prefix. Each run's stream is re-written in
full per flush, so one run leaves one version per flush, and the repo classes
this content as sensitive: see
[Deleting a run stream also purges its earlier versions](deployment-events.md#deleting-a-run-stream-also-purges-its-earlier-versions)
for what that purge does not reach.

**One other key family is not in the table either.** Short of deleting the
bucket, only `cdkd scrub` purges it, so the previous versions every other write leaves accumulate and
stay readable:

- `_index/{region}/exports.json` — the exports index, which holds resolved
  Output values. `cdkd deploy` rewrites it, and so does `cdkd scrub`, one entry
  at a time, for the stacks that run scrubbed. A deploy's write leaves the
  previous body as a noncurrent version of a key SHARED by every
  cdkd-managed stack in the region; `cdkd scrub` purges the key's noncurrent
  versions once per region whose entries it wrote. See
  [`cdkd scrub`](cli-scrub.md#the-exports-index).

**Without the two grants, nothing fails — and that is the point to
understand.** The purge runs on a cleanup path and must never abort the
operation it follows, so it logs a warning and the deploy, diff, rollback,
destroy, `cdkd import`, `cdkd export`, `cdkd gc`, `cdkd events prune` or `cdkd scrub` run still succeeds. What does not
happen is the removal: the value stays retrievable by anyone who can read the
state bucket with a `VersionId`. The warning counts KEYS, names them (a
prefix-wide sweep whose listing failed is counted as `every key under 1
prefix(es)` and named `<prefix>* (every key under this prefix)`), names
WHICH object it failed on, and spells the two actions exactly as above:

```
Could not purge noncurrent versions of 1 key(s) in s3://cdkd-state-bucket. Their
previous versions survive and remain readable via GetObject with a VersionId
(the rollback journal, whose `failedOperations[].attemptedProperties` records the
properties of the failed write verbatim). Grant s3:ListBucketVersions and
s3:DeleteObjectVersion on the state bucket, or purge the key(s) by hand.
Failures: cdkd/MyStack/us-east-1/rollback-journal.json (AccessDenied:
s3:ListBucketVersions)
```

The parenthetical is per-object — a custom-resource response object, the
transient template and the bootstrap marker each name themselves — so the
warning always says what to go and look at.

(Line-wrapped here; cdkd emits it as one line. It names up to five keys and
appends `(and N more)` beyond that, so the tail first appears at six.)

**The two grants fail in different ways, and only one of them fails loudly on
its own.** Missing `s3:ListBucketVersions` denies the listing, so the whole
purge stops. Missing `s3:DeleteObjectVersion` does NOT throw: `DeleteObjects`
reports per-key refusals in a `response.Errors` array and returns success
overall, so cdkd has to read that array to notice. It does — a partial failure
across a batch is counted key by key and named the same way — but it is why
granting one of the two and not the other is worth avoiding: everything looks
normal except the warning.

**`lock.json` is the one exception to the warning, deliberately.** A release
runs at the tail of EVERY mutating cdkd command, so inheriting the warning
would mean a principal on the older four-action policy -- who sees a silent
clean deploy today -- getting one after every single command, about a
heartbeat record with no secret in it. Release-path purge failures therefore go
to `debug` (visible under `--verbose`); the two rare reap paths, the
expired-lock takeover and `cdkd force-unlock`, still warn. Every other object
in the table warns as described above. Nothing fails on any of them.

A per-key `NoSuchVersion` counts as SUCCESS rather than as a failure, on every
object. The version named is already gone, which is the state the purge exists
to produce -- and on the lock key it is reachable in normal operation, because
a process reaping an abandoned lock and its original owner waking up to release
it can legitimately purge the same key at once. Reporting it would tell a
blameless user to grant permissions they already hold.

If you are on the older four-action policy, adding the two version actions is
the whole fix; the objects already stranded before the change have to be purged
by hand (`aws s3api list-object-versions` + `delete-object --version-id`). The
third addition, `s3:GetReplicationConfiguration`, is diagnostic — see the bullet
above.

#### S3 REPLICATION defeats the purge, and cdkd cannot fix it for you

**If the state bucket has Cross-Region (CRR) or Same-Region (SRR) Replication
enabled, the purge above removes the bodies from the SOURCE bucket only.** The
copies in the destination bucket survive, indefinitely, and stay readable there
with `GetObject` and a `VersionId`.

This is not a cdkd defect and no cdkd setting changes it. **S3 never replicates
a delete that names a version id.** Replication propagates PUTs, and — when
`DeleteMarkerReplication` is enabled — delete markers; a version-id delete is
deliberately excluded so that a delete on the source cannot destroy data on the
destination. cdkd's purge is exactly such a delete. Removing the replica's
copies would mean cdkd reading your replication configuration and issuing
deletes into a *different* bucket, which is a far larger and more dangerous
capability than cleaning up after itself, so cdkd does not do it.

It applies to **every** object in the table above, and to any future one. It is
worth stating plainly because it reproduces, one bucket over, exactly the
failure the purge exists to remove: an operation that reports success while the
value stays retrievable.

**cdkd tells you when it applies — if it can see your replication
configuration.** A purge that removed a BODY — or that could not establish
whether there was one — ends with one `GetBucketReplication` on the state
bucket, cached for the rest of the run. When
a rule covers the keys just purged, the warning names the destination:

```
S3 replication is enabled on s3://cdkd-state-bucket and covers the key(s) cdkd
just purged. S3 NEVER replicates a version-id delete, so the purge removed those
versions from THIS bucket only — the copies in the destination bucket survive and
remain readable there via GetObject with a VersionId (the rollback journal, whose
`failedOperations[].attemptedProperties` records the properties of the failed
write verbatim). cdkd cannot delete them. Remove them in the destination bucket
yourself (aws s3api list-object-versions, then delete-object --version-id), or
narrow the replication rule so it excludes the prefixes cdkd purges under.
Destination(s): cdkd-state-replica
```

Four things about that check, all deliberate:

- **It needs `s3:GetReplicationConfiguration`.** The action is in the
  least-privilege policy above, marked as the one DIAGNOSTIC entry: removing it
  costs you this check and nothing else. Without it the probe is denied, logs at
  `debug`, and never warns — most state buckets are not replicated, so warning
  there would demand a permission from everyone in order to inform almost
  nobody. The purge itself is unaffected either way.
- **It runs when a BODY was purged, or when cdkd could not tell.** A key with
  no noncurrent version — and a key whose only noncurrent entry was a delete
  MARKER, which carries no body — leaves nothing for the replica to be holding,
  so neither triggers it; a listing that failed or stopped early does, because
  what remains under that key is unknown and silence would be the wrong
  mistake. Both exclusions matter:
  `cdkd deploy` deletes the rollback journal on every success, marker and all,
  so without either exclusion an ordinary green deploy would have announced a
  surviving journal for a stack that has never had one.
- **It errs toward warning.** A rule that filters on object TAGS cannot be
  evaluated without reading each object, so cdkd treats it as covering
  everything; and a rule whose `Status` is `Disabled` is still reported, flagged
  as disabled, because disabling a rule stops FUTURE replication without
  removing what it already copied. A warning you look into and dismiss is the
  cheaper mistake.
- **It repeats once per (object kind, destination set), not once per object.**
  A stack with thirty custom resources gets one warning, not thirty; the
  repeats go to `debug`. The destinations are part of that identity on purpose
  — if a later purge under the same object kind matches a rule pointing
  somewhere NEW, you are told about the new replica rather than silenced by the
  first warning.

Your options, none of which cdkd can take for you:

- **Purge the destination bucket yourself**, with the same
  `list-object-versions` + `delete-object --version-id` pass.
- **Narrow the replication rule.** cdkd purges under four top-level prefixes,
  and a rule that covers any of them is in scope: `cdkd/` (the rollback journal,
  `lock.json` and the `deployments/` event store), `cdkd-bootstrap/` (the marker), `custom-resource-responses/`
  (the handler's full cfn-response, `Data` included — the most secret-dense of
  the four), and `cdkd-migrate-tmp/` (the transient CloudFormation template).
  **`cdkd/` is a DEFAULT, not a constant** — it is `--state-prefix`, so a
  bucket configured with one writes the journal and `lock.json` somewhere else
  entirely. The other three are fixed top-level prefixes today
  (`custom-resource-responses/` has a programmatic override that no CLI flag
  reaches). Read the prefixes off your own bucket rather than pasting these, or
  a narrowed rule will miss the objects it was meant to exclude.
  **Read that with the DR consequence attached**: `cdkd/` is also where
  `state.json`, its version history and the `deployments/` event streams live,
  so excluding it stops replicating the state records you presumably enabled
  replication FOR. Excluding the other three costs nothing you rely on.
- **Accept that the replica retains the history** and control access to it
  accordingly — `s3:GetObjectVersion` on the destination is what makes the
  surviving bodies readable.

**The same reasoning applies to any other copy of the bucket you keep** — most
directly the `aws s3 sync` backup suggested under
[State File Backup](#state-file-backup) below, which copies the state objects
into a bucket cdkd never touches. A purge on the state bucket says nothing
about what a backup, a replica, or a snapshot still holds.

#### Recommended: Enable Encryption

```bash
aws s3api put-bucket-encryption \
  --bucket cdkd-state-bucket \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": {
        "SSEAlgorithm": "AES256"
      }
    }]
  }'
```

Or use KMS:

```bash
aws s3api put-bucket-encryption \
  --bucket cdkd-state-bucket \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": {
        "SSEAlgorithm": "aws:kms",
        "KMSMasterKeyID": "arn:aws:kms:us-east-1:123456789012:key/abc-123"
      }
    }]
  }'
```

#### Recommended: Enable Versioning

Retains state file history and enables recovery from accidental deletion.

```bash
aws s3api put-bucket-versioning \
  --bucket cdkd-state-bucket \
  --versioning-configuration Status=Enabled
```

### State File Backup

In addition to S3 versioning, regular backups are recommended:

```bash
# Daily backup example
aws s3 sync s3://cdkd-state-bucket/cdkd/ \
  s3://cdkd-state-backup/$(date +%Y%m%d)/
```

### Team Environment Operations

#### Monitor Lock Status

```bash
# Check lock status
aws s3api get-object \
  --bucket cdkd-state-bucket \
  --key cdkd/MyStack/us-east-1/lock.json \
  /dev/stdout

# Example output:
# {
#   "owner": "goto@macbook:12345",
#   "timestamp": 1710835200000,
#   "operation": "deploy"
# }
```

#### Inspect and Operate on the Store with `cdkd state`

The `cdkd state` command family reads and writes this store directly, with no
CDK app: `cdkd state list` enumerates the records (`--tree` for the
nested-stack hierarchy), `cdkd state show` prints one record in full,
`cdkd state info` reports which bucket was resolved and how, and
`cdkd state destroy` acts on the stacks you name, and
`cdkd state refresh-observed` on one stack, several, or every stack in the
bucket with `--all`.

Every subcommand, its flags, and its exit codes are documented on
[`cdkd state`](cli-state.md); [State Store](state-store.md) is the shorter
first read.

## State Migration and Version Management

### Schema Version

Current writers emit **`version: 11`** on the region-prefixed key layout
(`cdkd/{stackName}/{region}/state.json`, introduced by `version: 2`). Older
`version: 1` blobs at the non-region key (`cdkd/{stackName}/state.json`) are
still readable; the next save migrates them to the region-prefixed key and
deletes the legacy key. Every v1..v10 blob is read and auto-upgraded in memory
by the current binary, and the next write persists the current version
silently — no user action, no migration command.

An older writer encountering a newer blob fails closed rather than silently
mishandling unknown fields.

## Troubleshooting

### If State is Corrupted

#### Restore from S3 Versioning

```bash
# List versions
aws s3api list-object-versions \
  --bucket cdkd-state-bucket \
  --prefix cdkd/MyStack/us-east-1/state.json

# Restore specific version
aws s3api get-object \
  --bucket cdkd-state-bucket \
  --key cdkd/MyStack/us-east-1/state.json \
  --version-id abc123 \
  /tmp/state-backup.json

# Restore
aws s3 cp /tmp/state-backup.json \
  s3://cdkd-state-bucket/cdkd/MyStack/us-east-1/state.json
```

### If Lock Remains

```bash
# Release the lock with cdkd (preferred)
cdkd force-unlock MyStack --stack-region us-east-1

# Or delete the lock object directly
aws s3 rm s3://cdkd-state-bucket/cdkd/MyStack/us-east-1/lock.json
```

### If State and Resources Don't Match

If you manually changed AWS resources, state file and actual resources will diverge.

**Solutions**:

1. **Reset state** (delete only state, keep resources)

   ```bash
   aws s3 rm s3://cdkd-state-bucket/cdkd/MyStack/us-east-1/state.json
   ```

   On next `cdkd deploy`, all resources will be treated as CREATE, so existing resources will cause errors.

2. **Manually fix state** (advanced)

   ```bash
   # Download state file
   aws s3 cp s3://cdkd-state-bucket/cdkd/MyStack/us-east-1/state.json /tmp/state.json

   # Edit
   vim /tmp/state.json

   # Upload
   aws s3 cp /tmp/state.json s3://cdkd-state-bucket/cdkd/MyStack/us-east-1/state.json
   ```

3. **Delete and recreate resources**

   ```bash
   cdkd destroy --stack MyStack --force
   cdkd deploy --app "..." --stack MyStack
   ```

## References

- [Architecture](./architecture.md) - Overall architecture
- [S3 Conditional Requests](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-requests.html)
- [Optimistic Locking Pattern](https://en.wikipedia.org/wiki/Optimistic_concurrency_control)
- Terraform State Management (reference case)
