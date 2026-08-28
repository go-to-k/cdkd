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

State and lock keys are region-scoped (since PR 1, schema `version: 2`).
The same `stackName` deployed to two different regions has two independent
state files; changing `env.region` no longer silently overwrites the prior
region's record.

```
s3://{STATE_BUCKET}/{STATE_PREFIX}/
  └── {StackName}/
      └── {Region}/
          ├── lock.json               # Exclusive lock information (region-scoped)
          ├── state.json              # Resource state (region-scoped)
          └── rollback-journal.json   # Transient — present only between a failed
                                      #   deploy and its `cdkd rollback` (issue #1183)
s3://{STATE_BUCKET}/cdkd-bootstrap/
  └── {Region}.json          # Asset-storage bootstrap marker (issue #1002)
s3://{STATE_BUCKET}/custom-resource-responses/
  └── {RequestId}.json       # Transient — one placeholder per Custom Resource
                             #   invocation, collected by `cdkd gc` (issue #2052)
```

The `custom-resource-responses/{requestId}.json` placeholders are written by
`CustomResourceProvider` before each invocation, so the handler has a
pre-signed URL to PUT its `cfn-response` to. They are transient and the happy
paths delete them again, but three shapes strand one: an interrupted deploy
between the PUT and any cleanup, a throw on a path that reaches no cleanup
call, and a LATE handler PUT landing after cdkd stopped polling (the only one
that leaves real `Data` content rather than an empty body). Since issue
[#2052](https://github.com/go-to-k/cdkd/issues/2052) `cdkd gc` collects the
stranded ones — see
[`cdkd gc`](cli-reference.md#custom-resource-response-placeholders) for the
staleness rule and why an in-flight run's key is never taken.

**Deleting one is not the same as removing it, because this bucket is
VERSIONED.** `cdkd bootstrap` turns versioning on, so a plain `DeleteObject`
writes a DELETE MARKER and every earlier version of the key stays readable
through `GetObject` with a `VersionId`. That matters here more than anywhere
else under the state bucket: the object at this key is the handler's FULL
`cfn-response`, `Data` included, so a handler that mints a secret (a generated
password, an issued API key) put that value in the state bucket. Until issue
[#2340](https://github.com/go-to-k/cdkd/issues/2340) both delete paths — the
provider's own cleanup and `cdkd gc`'s collection — left it retrievable after
reporting the object gone. Both now purge the key's noncurrent versions as
well, scoped to that exact key so a concurrent deploy's live placeholder under
the same shared prefix is never touched.

**This is not the whole account of where that value lives.** A handler-minted
secret returned in `Data` is also persisted into the resource's `attributes` in
`state.json`, which is a separate object with a separate lifetime and is NOT
addressed here — see issue
[#2274](https://github.com/go-to-k/cdkd/issues/2274). Purging the response
sidecar closes the sidecar; treat the state file as still carrying the value.

That purge is conditional on `s3:ListBucketVersions` and
`s3:DeleteObjectVersion` on the state bucket — as is every other
noncurrent-version purge cdkd runs (the rollback journal and the bootstrap
marker below, and the transient CFn template upload) — see
[Bucket Policy with Least Privilege](#recommended-bucket-policy-with-least-privilege),
which did not grant either before #2340. It fails soft by design, because it
runs on a cleanup path that must never abort the operation it follows: without
those actions the deploy, destroy or `cdkd gc` run still succeeds, a warning
names the two grants, and the body stays retrievable by `VersionId`.

The `rollback-journal.json` sibling (issue
[#1183](https://github.com/go-to-k/cdkd/issues/1183)) is written whenever a
deploy ends **without a completed rollback** — a `--no-rollback` failure, a
Ctrl+C interruption, or before an automatic rollback (so a rollback that
dies partway is resumable). It records the exact operations the failed
deploy completed (one `segment` per failed attempt) so `cdkd rollback` can
revert them with no synth. Since issue
[#1198](https://github.com/go-to-k/cdkd/issues/1198) each segment also
carries the op(s) that **FAILED** mid-deploy (`failedOperations[]` — pre-op
state + attempted properties; an additive field, no `journalVersion` bump)
so `cdkd rollback --revert-failed` can optionally revert them too. It is deliberately **not** part of the state
schema (its own `journalVersion` field, no `StackState.version` bump) and
**not** under the `deployments/` prefix (that layer survives destroy by
design; the journal must not). Lifecycle: created on a failed / interrupted
deploy and before an auto-rollback; each replayed segment is popped; the
object is deleted on the next **successful deploy**, after a **clean
`cdkd rollback`**, and by `cdkd destroy` / `cdkd state destroy`. A **clean
automatic rollback** settles it to a failed-only segment instead of
deleting it (issue [#1208](https://github.com/go-to-k/cdkd/issues/1208):
`operations: []` plus the failed op records, `reason:
auto-rollback-clean`) so `cdkd rollback --revert-failed` works in the
default deploy flow too. It carries
resolved properties, the **same sensitivity class as `state.json`** (no new
secret-exposure class). Every writer holds the stack lock, so no optimistic
locking is needed.

**Deleting the journal purges its noncurrent versions too**, on every one of
those paths (issue
[#2346](https://github.com/go-to-k/cdkd/issues/2346)). The bucket is
versioned, so a plain `DeleteObject` would leave each earlier body readable
through `GetObject` with a `VersionId` — and `failedOperations[]` holds the
attempted properties of the FAILED write verbatim, which is where a literal
password lands when the resource that failed had one. Unlike `state.json`,
whose noncurrent versions ARE the recovery capability versioning exists for
and are deliberately left alone, the journal is transient by design, so
nothing weighs against removing them. Like the sidecar purge above it fails
soft: without the two version grants the deploy / rollback / destroy still
succeeds and a warning names them.

The `cdkd-bootstrap/{region}.json` marker is written by `cdkd bootstrap`
(unless `--no-assets`) and records that the region opted into cdkd-owned
asset storage — its body names the region's asset bucket
(default `cdkd-assets-{accountId}-{region}`) and container-asset ECR repo
(default `cdkd-container-assets-{accountId}-{region}`; custom names via
`cdkd bootstrap --asset-bucket <name>` / `--container-repo <name>`, issue
[#1011](https://github.com/go-to-k/cdkd/issues/1011) — every consumer reads
the names from the marker, never from the naming convention). Deploys read
the marker per
(account, region) to pick the asset mode: absent → legacy (publish to the
CDK bootstrap destinations verbatim, byte-identical to pre-#1002 behavior);
present → cdkd-assets mode (asset publishing redirects to the cdkd storage
and template references are rewritten to match — see the asset-destinations
section in [docs/cli-reference.md](cli-reference.md); no state schema
change, the deployed `properties` simply carry the cdkd names); present but
bucket/repo deleted → hard error
(never a silent fallback). `cdkd bootstrap --destroy` removes the marker and, since issue
[#2346](https://github.com/go-to-k/cdkd/issues/2346), purges its noncurrent
versions as well — the marker carries no secret (it names the region's asset
bucket and container repo), so that is class completeness rather than a
disclosure fix. The marker deliberately lives OUTSIDE the
`{STATE_PREFIX}/` prefix so stack listing never mistakes it for a stack, and
per-region keys mean concurrent bootstraps of two regions cannot race on a
shared object. `cdkd state info` lists the opted-in regions. Full design in
[docs/design/1002-cdkd-asset-storage.md](design/1002-cdkd-asset-storage.md).

To opt a region back out, `cdkd bootstrap --destroy --region <r>` tears
down the region's asset bucket + ECR repo and deletes the marker last
(the reverse of the create-side marker-written-last ordering); add
`--include-state-bucket` to also delete the state bucket once every stack
is destroyed. See the teardown section in
[docs/cli-reference.md](cli-reference.md#teardown-cdkd-bootstrap---destroy-issue-1010).

Because assets are content-addressed and never deleted on `cdkd destroy`,
the asset bucket / ECR repo grow over time; `cdkd gc` reclaims
unreferenced objects / images by scanning every state file in the state
bucket for asset references (with a 30d default age guard). See the gc
section in
[docs/cli-reference.md](cli-reference.md#cdkd-gc-garbage-collect-cdkd-owned-asset-storage).

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
migrate via `cdkd state migrate` (see below). The legacy-removal step is
tracked in [`docs/plans/99-future-bc-removal.md`](./plans/99-future-bc-removal.md).

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
  `cdkd force-unlock <stack>` first if a lock is stale.
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
(`state.json` reads/writes, since PR #60), the lock manager
(`lock.json` acquire/release, since issue #803 — before that fix, state
operations succeeded against a cross-region bucket but every lock
acquisition failed with S3's 301 PermanentRedirect), the exports
index store (`_index/{region}/exports.json` writes/removes for
`Fn::ImportValue` tracking, since issue #819 — before that fix the index
write/remove also hit the 301; non-fatal, so the cross-region index was
silently never maintained), and the custom-resource response path
(`custom-resource-responses/*.json` placeholder writes + the pre-signed
`ResponseURL` the Lambda handler PUTs its cfn-response to, since
issue #1195 — before that fix a cross-region deploy of any stack carrying a
Lambda-backed Custom Resource failed hard with the 301, because the
pre-signed URL was signed against the deploy region's endpoint). A
SUCCESSFUL bucket-region lookup is cached per bucket name for the process
lifetime, so all four consumers share a single `GetBucketLocation`
call. A FAILED probe is deliberately not cached (issue
[#1763](https://github.com/go-to-k/cdkd/issues/1763)): the resolver never
throws, so a failure degrades to a best guess, and caching that guess
pinned every later consumer in the process to one transient error's
answer with no way to heal.

The probe itself is aimed at the caller's own region — falling back to
the AWS SDK's region chain (`AWS_REGION`, the shared config profile) and
only then to `us-east-1`. `GetBucketLocation` is answered by any regional
S3 endpoint for a bucket in the same partition, so the probe never needs
to know the answer to ask the question; it does have to REACH the right
partition, and the hardcoded `us-east-1` endpoint it used before issue
#1763 is unreachable from `aws-cn` / `us-iso*` — so outside the
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

State files written by cdkd before PR 1 used a flat per-stack layout:

```
s3://{STATE_BUCKET}/{STATE_PREFIX}/
  └── {StackName}/
      ├── lock.json      # not region-scoped
      └── state.json     # version: 1, region recorded inside the body
```

cdkd still **reads** this layout (looking up the legacy key only when its
embedded `region` field matches the requested region), and the next write
auto-migrates: it writes the new region-scoped key, then deletes the legacy
key. The legacy read path is temporary and will be removed in a future PR
(see `docs/plans/99-future-bc-removal.md`).

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
`drift --revert` then destructively "fixed" (issue #1498). An
undeclared key captured with a real value is still compared.

**v2 → v3 upgrade is automatic on the next `cdkd deploy`.** When the
deploy engine loads state and finds resources without
`observedProperties` (typical the first time you deploy after upgrading
from cdkd <0.49), it kicks off `provider.readCurrentState` for each in
parallel with the rest of the deploy and drains the result into state at
the final save. The deploy critical path does NOT wait on these reads —
the cost is bounded by the longest single `readCurrentState` (~200-300ms
in practice) once at the end of the deploy. NO_CHANGE-only deploys (no
diff to apply) still drain and persist the refreshed baseline so the
next `cdkd drift` run sees a real AWS-current snapshot. Pass
`--no-capture-observed-state` to disable both regular capture and this
upgrade refresh; `cdkd state refresh-observed <stack>` remains the
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
cdkd state record is dropped). `cdkd destroy` (synth-driven) falls
back to the synth template's `DeletionPolicy` attribute when state has
no recorded value, preserving pre-v5 back-compat mid-flight. `cdkd
state destroy` is template-less by design and reads `state.deletionPolicy`
only — pre-v5 state therefore behaves as before (every resource is
deleted, since there is no signal to skip on; redeploy under v5 to
populate the field). `DeletionPolicy: Snapshot` is honored on the same
paths (issue #1352): cdkd creates the final snapshot CloudFormation
promises before deleting (see the "DeletionPolicy: Snapshot" section in
[cli-reference.md](cli-reference.md) for the per-type mechanics and the
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
`AWS::CloudFormation::Stack` adoption shipped in
[#459](https://github.com/go-to-k/cdkd/issues/459). Top-level stack state
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
[`tests/integration/schema-v5-to-v6-migration/`](../tests/integration/schema-v5-to-v6-migration/)
integ test proves the round-trip against real AWS.

The v6 prep PR added the type bump alone. The
[`NestedStackProvider`](../src/provisioning/providers/nested-stack-provider.ts)
that consumes the fields shipped in the [#459](https://github.com/go-to-k/cdkd/issues/459)
main PR: when a parent stack contains an `AWS::CloudFormation::Stack`
resource, the provider runs a recursive child deploy / destroy and the
child's state file lives at
`cdkd/{parentStackName}~{NestedStackLogicalId}/{region}/state.json`
with the three fields populated. Top-level deploys (the common case)
leave the three fields undefined on every write — the v6 reader treats
absence as "I am a top-level stack" and degrades cleanly.

`cdkd import --migrate-from-cloudformation` recursively adopts existing
CFn-managed nested-stack hierarchies as of [#464](https://github.com/go-to-k/cdkd/issues/464)
PR A — each nested child gets its own v6-keyed state file with all three
parent-link fields populated, and the source CFn stacks are retired via a
single parent-side `DeleteStack` cascade after recursive `DeletionPolicy: Retain`
injection. `cdkd export` of a cdkd-managed nested stack back into
CloudFormation is supported as of [#464](https://github.com/go-to-k/cdkd/issues/464)
PR B2 — the orchestrator submits one IMPORT changeset per cdkd-managed
stack in leaf-first order, non-leaf parents adopt their just-imported
children via the AWS-docs "Nest an existing stack" pattern, and cdkd
state for every stack in the tree is deleted leaf-first after the
CFn-side IMPORT loop completes. Fresh `cdkd deploy` of new nested
stacks has been supported since #459.

### `version: 7` adds `provisionedBy` (v7+ writers)

Schema `version: 7` adds an optional `provisionedBy` field to each
`ResourceState` ([#614](https://github.com/go-to-k/cdkd/issues/614)): `'sdk'`
(cdkd's preferred fast path — direct synchronous AWS SDK calls) or `'cc-api'`
(the Cloud Control API fallback), i.e. which provisioning layer owns the
resource. A Custom Resource is recorded `'sdk'` too, so the field is always
populated on a v7+ write; it has no SDK-vs-Cloud-Control dichotomy of its own,
so read the value there as "not Cloud Control" rather than as a literal claim
about synchronous SDK calls.

Pre-#614 every resource was implicitly SDK-managed, so a v7 reader treats the
absent field on a
v6-and-earlier record as the legacy SDK default. Precisely, an absent field
means the record is not PINNED: routing re-decides from scratch, so such a
resource can still be auto-routed to Cloud Control by the #614 silent-drop
check — the same decision it got before v7 existed. Only a recorded
`'cc-api'` pins. v7+ writers (`cdkd deploy` and `cdkd import` alike) emit the
field explicitly so the decision is durable across deploys.

The field is **sticky**: once a resource is `'cc-api'`, a later SDK-provider
backfill does NOT migrate it back, because that would mean physical-ID churn
(destroy + recreate) on every backfill release. **The stickiness has a narrow
exemption**, `STICKY_CC_MIGRATION_EXEMPT` in
[`src/provisioning/provider-registry.ts`](../src/provisioning/provider-registry.ts) —
consult the constant rather than a list here, since its membership changes.
A type is admitted only when its Cloud Control routing is **broken** (not merely
slower) AND the SDK provider addresses the resource by the SAME physicalId the
CC path stored, so the re-route costs no churn and the record flips to
`'sdk'` transparently on its next write. Without the exemption, pinning such a
record to `cc-api` would keep the bug alive for every pre-existing resource.
`AWS::Scheduler::Schedule` ([#961](https://github.com/go-to-k/cdkd/issues/961) —
a schedule in a custom `ScheduleGroup` is unaddressable via Cloud Control) is
the member today. So a `provisionedBy: 'cc-api'` record is NOT proof the
resource will keep being managed through Cloud Control.

`cdkd destroy` reads the field to pick the delete path, `cdkd drift` to pick
`readCurrentState`, and `cdkd state show` displays it
(`ProvisionedBy: sdk | cc-api | (sdk, legacy default)`).

**v6 → v7 upgrade is fully transparent** — a v6 state file read by a v7 binary
parses with the field undefined, and the next write persists `version: 7`
silently. No command, no flag, no manual JSON edit. The
[`tests/integration/schema-v6-to-v7-migration/`](../tests/integration/schema-v6-to-v7-migration/)
integ test proves the round-trip against real AWS.

### `version: 8` adds `outputReads`

Schema `version: 8` adds an optional stack-level `outputReads` array — one
`StateOutputReadEntry` per `Fn::GetStackOutput` resolution that was served from
a **cdkd state record** during the consumer stack's deploy
([#668](https://github.com/go-to-k/cdkd/issues/668)). Two resolutions are
deliberately NOT recorded, so the array is a subset of the references a
template carries rather than an inventory of them: a **cross-account**
(`RoleArn`) read (deferred to a future bump alongside a `sourceAccountId`
field), and one served by the **CloudFormation fallback**
([#1697](https://github.com/go-to-k/cdkd/issues/1697) — the producer is not
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
[`tests/integration/schema-v7-to-v8-migration/`](../tests/integration/schema-v7-to-v8-migration/)
integ test proves the round-trip against real AWS.

### `version: 9` adds `exportNames` (current writers)

Schema `version: 9` adds a stack-level `exportNames` array: the keys of
`outputs` that are `Export.Name` aliases, i.e. the ONLY names an
`Fn::ImportValue` may bind to
([#2193](https://github.com/go-to-k/cdkd/issues/2193)). The `outputs` bag has
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
[`tests/integration/schema-v8-to-v9-migration/`](../tests/integration/schema-v8-to-v9-migration/)
integ test proves the round-trip against real AWS — and first reproduces the
shadowing under the v8 binary (a consumer bound to a decoy stack's plain
output) before the v9 binary rebinds it to the real export.

## State Schema

### StackState (`state.json`)

```typescript
interface StackState {
  version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9   // 1 = legacy, 2 = region-prefixed, 3 = +observedProperties, 4 = +imports[], 5 = +deletionPolicy/updateReplacePolicy, 6 = +parentStack/parentLogicalId/parentRegion (nested-stack adoption), 7 = +provisionedBy on ResourceState, 8 = +outputReads[], 9 = +exportNames[]
  stackName: string                        // Stack name
  region?: string                          // Required on version >= 2
  resources: Record<string, ResourceState> // Logical ID → Resource state
  outputs: Record<string, unknown>         // Output name → Resolved value (NOT coerced to string)
  imports?: StateImportEntry[]             // v4+: Fn::ImportValue refs (strong reference — blocks the producer's destroy)
  outputReads?: StateOutputReadEntry[]     // v8+: Fn::GetStackOutput refs (informational — weak reference, never destroy-blocking)
  exportNames?: string[]                   // v9+: which `outputs` keys are Export.Name aliases — the ONLY names Fn::ImportValue may bind to (undefined = pre-v9 record, every key importable until its next deploy; [] = exports nothing)
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
`cdkd state show <stack>`, which renders any non-scalar through
`JSON.stringify` and so preserves the distinction.

#### Example

```json
{
  "version": 8,
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
}
```

`properties` records the user's intent (the resolved CloudFormation
template values cdkd asked AWS to apply). `observedProperties` records
what AWS actually has — captured by `provider.readCurrentState`
immediately after each create/update so it includes AWS-side defaults
the user did not template. The `cdkd drift` comparator prefers
`observedProperties` as its baseline for richer detection; resources
without it fall back to `properties` (the pre-`version: 3` behavior).

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

**Note**: cdkd supports **all resource types supported by Cloud Control API**. The table above shows only a few examples. For resources not supported by Cloud Control API, custom SDK Providers can be implemented (see [provider-development.md](./provider-development.md)).

**The physicalId is provider-defined, and it may differ from the value
CloudFormation records for the same resource.** cdkd stores whatever the
provider that created the resource returned — the value that provider needs
to address the resource again on update / delete / drift. For most types
that is the same scalar CloudFormation's `Ref` returns (a bucket name, a
function ARN), but it is not guaranteed to be: see the composite forms
below. Always read the id you must reuse from cdkd itself
(`cdkd state show <stack>` / `cdkd state resources <stack>`) rather than
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
`cdkd import --resource <logicalId>=<physicalId>` expects. A few types also
accept a looser form on import — see
[import.md](./import.md#auto-resolved-no---resource-flag-needed) for the
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
| `AWS::Glue::Table` | `<databaseName>\|<tableName>` |
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
| `AWS::Glue::Table` | the table name (the segment after the `\|`) |
| `AWS::Route53::RecordSet` | the record **name** — the MIDDLE segment |
| `AWS::S3Tables::Namespace` / `::Table` | the namespace / table name (the segment after the last `\|`) |

The three `AWS::AppSync::*` children are the case where the `Ref` value is not
a segment at all: cdkd recovers the ARN from the attribute the provider records.
`cdkd import` records the same attribute a fresh deploy does — it reconstructs
the ARN from the composite id you supply — so an adopted child's `Ref` and
`Fn::GetAtt` resolve immediately.

Some records can still lack the attribute, and they all degrade the same way —
`Ref` falls back to the raw composite id, and `Fn::GetAtt` on the ARN attribute
FAILS rather than serving a value CloudFormation would not return:

- one written by a cdkd older than the fix that started recording the real ARN;
- one whose import could not reach STS, so cdkd could not determine the account.
  It deliberately records NOTHING rather than an ARN built from a placeholder
  account id, which would look valid and be wrong;
- one whose import could not build the ARN for some other reason.

Each of the import cases names itself in a warning at import time.

Re-deploy the stack once in either case: the resource's next in-place update
records the corrected attribute.

### …and it is not what `cdkd export` sends CloudFormation either

`cdkd export` hands a stack to CloudFormation via an IMPORT changeset,
which addresses each resource by its CFn `primaryIdentifier`. For most
composite types that identifier is multi-field and cdkd splits the id
into it. Four types are different — their CFn identifier is a SINGLE
field holding a value that is not any segment of cdkd's composite:

| Resource Type | CloudFormation IMPORT identifies it by | cdkd resolves it from |
|---------------|----------------------------------------|-----------------------|
| `AWS::AppSync::DataSource` | `DataSourceArn` | the recorded `DataSourceArn` attribute |
| `AWS::AppSync::Resolver` | `ResolverArn` | the recorded `ResolverArn` attribute |
| `AWS::S3Tables::Table` | `TableARN` | the recorded `TableARN` attribute |
| `AWS::EC2::SecurityGroupIngress` | `Id` (the `sgr-…` rule id) | the recorded `Id` attribute |

You do not need to do anything for the first three on a stack deployed
by a current cdkd: a fresh deploy and `cdkd import` both record the
attribute. A record that lacks it — the degraded cases listed above —
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
- **The rule predates [#1761](https://github.com/go-to-k/cdkd/issues/1761),**
  which is when cdkd started recording the id at all. This is the one
  exception to "re-deploy once": AWS returns the `sgr-…` id only from
  `AuthorizeSecurityGroupIngress` itself, so a no-op deploy issues no
  call and records nothing. **You do not have to do anything about this
  one** — since [#1791](https://github.com/go-to-k/cdkd/issues/1791)
  `cdkd export` recovers the id itself, by looking the rule up in AWS
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
[cli-reference.md](cli-reference.md#cdkd-export-hand-a-stack-over-to-cloudformation).

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
> The separator is **not escaped**, so cdkd cannot manage a resource whose own
> name contains a `|` even where AWS and CloudFormation can. A Glue table named
> `a|b` in database `mydb` would be recorded as `mydb|a|b`, which decodes to
> database `mydb`, table `a` — both halves non-empty, so nothing downstream can
> tell it is wrong. Rather than record an id that names a different resource,
> `cdkd deploy` **refuses at pre-flight** with a message naming the offending
> segment. Rename the resource, or manage it with the CDK CLI. Tracked in
> [#1672](https://github.com/go-to-k/cdkd/issues/1672).

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
the CLI's base region (issue #803), so locking works against a
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

Before issue [#2168](https://github.com/go-to-k/cdkd/issues/2168) this was an
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
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // acquireLock reaps an EXPIRED foreign lock itself and retries once, so a
    // `false` here always means a LIVE lock held by someone else.
    if (await this.acquireLock(stackName, region, owner, operation)) return;

    const lockInfo = await this.getLockInfo(stackName, region);
    if (lockInfo && attempt < maxRetries) {
      // Reports the holder and how long until its deadline, then waits.
      await sleep(retryDelay);
    }
  }

  throw new LockError('Failed to acquire lock after retries');  // names owner + expiry
}
```

Expiry is decided by the lock's own `expiresAt` field, not by its age: a live
holder keeps pushing that field forward, so "old" and "abandoned" are different
questions and only the second one frees the lock.

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

Before issue [#2168](https://github.com/go-to-k/cdkd/issues/2168) there was no
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
  object version. A 30-minute deploy writes about fifteen. They go noncurrent
  the moment the next renewal lands, and **releasing the lock does not remove
  them**: the release is a `DeleteObject`, which on a versioned bucket writes a
  DELETE MARKER and leaves every earlier version readable through `GetObject`
  with a `VersionId`. Nothing in cdkd purges them today, so the count grows for
  the life of the bucket -- 452 versions on a single measured key. Nothing
  sensitive is in them (`lock.json` carries only `owner`, `timestamp`,
  `expiresAt` and an optional `operation`), so this is storage cost and listing
  noise rather than disclosure, and the remedy is a **bucket lifecycle rule on
  noncurrent versions** rather than a code change: purging on release would put
  a `ListObjectVersions` + `DeleteObjects` round trip on the hot path of every
  cdkd command and would make `s3:ListBucketVersions` / `s3:DeleteObjectVersion`
  required for ordinary use rather than only for the cleanup paths that need
  them. Tracked as a deliberately-open site of issue
  [#2346](https://github.com/go-to-k/cdkd/issues/2346), whose other sites --
  the rollback journal, the bootstrap marker, the transient template upload and
  the custom-resource response sidecar -- ARE purged.

If the holding process dies without releasing, the lock stops being renewed and
is reclaimed by the next `cdkd` invocation once `expiresAt` passes -- or
immediately with `cdkd force-unlock <stack>`.

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
cancellation) is forwarded to the same path (issue
[#1342](https://github.com/go-to-k/cdkd/issues/1342)): the first `SIGTERM`
behaves like the first Ctrl-C, a subsequent signal like the second.

### Destroy interruption (Ctrl-C)

`cdkd destroy` and `cdkd state destroy` handle the first `Ctrl-C` (SIGINT)
gracefully (issue [#816](https://github.com/go-to-k/cdkd/issues/816)),
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
(issue [#1342](https://github.com/go-to-k/cdkd/issues/1342)) — the first
`SIGTERM` drains like the first Ctrl-C, a second one force-quits.

### CI job cancellation

A cancelled CI job (e.g. GitHub Actions `cancel-in-progress: true`) can still
strand the lock: cdkd's `deploy` / `destroy` / `state destroy` / `rollback`
commands handle both `SIGINT` and `SIGTERM` gracefully (issue
[#1342](https://github.com/go-to-k/cdkd/issues/1342)), but CI runners
escalate to `SIGKILL` — which no process can handle — after a short grace
period (~10 s total on GitHub Actions), so a long in-flight AWS operation
can still die before the lock release runs. The lock is then reclaimed after
the TTL above, or cleared immediately with `cdkd force-unlock <stack>`. See
["Stale lock after a cancelled CI job" in the troubleshooting
guide](./troubleshooting.md#issue-stale-lock-after-a-cancelled-ci-job) for the
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
try {
  const newEtag = await s3StateBackend.saveState(
    'MyStack',
    updatedState,
    current.etag  // ← Expected ETag
  );
  console.log(`Updated with new ETag: ${newEtag}`);
} catch (error) {
  if (error.name === 'PreconditionFailed') {
    // Another process modified the state
    throw new Error('State was modified by another process');
  }
  throw error;
}
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

        // 4b. Incremental state persistence (issue #804): remove the
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

**Incremental state persistence during destroy** (issue
[#804](https://github.com/go-to-k/cdkd/issues/804)): the destroy path
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

cdkd ships three commands that touch state during cleanup. Choose based on
whether the CDK app is available, and whether you also want to delete the
underlying AWS resources:

| Command | Needs CDK app? | Deletes AWS resources? | Removes state record? |
| --- | --- | --- | --- |
| `cdkd destroy <stack>` | Yes (synth) | Yes | Yes |
| `cdkd state destroy <stack>` | No | Yes | Yes |
| `cdkd orphan <stack>` | Yes (synth) | **No** | Yes |
| `cdkd state orphan <stack>` | No | **No** | Yes |

`cdkd destroy` is the canonical path when you have the CDK source — it synths
the app, intersects against state, and deletes resources in reverse dependency
order. `cdkd state destroy` is the same per-stack pipeline (the logic is hoisted
into `src/cli/commands/destroy-runner.ts` and shared by both commands), but
sourced from the state record instead of synth output, so it works from any
working directory given access to the state bucket. Use it for cleanup from a
machine without the CDK source, CI cleanup jobs after the source repo is gone,
or a forgotten stack referenced only by name. `cdkd orphan` and `cdkd state
orphan` only forget the state record — the AWS resources stay alive — and are
the right tools when you intentionally want cdkd to stop tracking a stack
without touching its resources. The naming mirrors aws-cdk-cli's new `cdk
orphan` command. Choose the synth-driven `cdkd orphan` when you have the CDK
source and want the same stack-pattern routing as `deploy` / `destroy`; choose
`cdkd state orphan` when you don't have the CDK app or want to operate on the
bucket alone.

## Security and Best Practices

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
        "s3:DeleteObjectVersion"
      ],
      "Resource": [
        "arn:aws:s3:::cdkd-state-bucket",
        "arn:aws:s3:::cdkd-state-bucket/*"
      ]
    }
  ]
}
```

The last two are what let cdkd finish deleting an object on a VERSIONED
bucket, which the state bucket is: `cdkd bootstrap` turns versioning on, so
`DeleteObject` writes a DELETE MARKER and every earlier version of the key
stays readable through `GetObject` with a `VersionId`.

- **`s3:ListBucketVersions`** — bucket-level, like the `s3:ListBucket` above
  it, so the bare `arn:aws:s3:::cdkd-state-bucket` ARN already in `Resource`
  covers it. Lets cdkd find the leftover versions.
- **`s3:DeleteObjectVersion`** — object-level, like the `s3:DeleteObject`
  above it, so the `arn:aws:s3:::cdkd-state-bucket/*` ARN covers it. Lets cdkd
  remove them.

**Four kinds of object need these two actions, not one.** The set grew with
issue [#2346](https://github.com/go-to-k/cdkd/issues/2346), and the ordinary
commands are now in it:

| object | purged by | what its previous versions hold |
| --- | --- | --- |
| `rollback-journal.json` | every successful `cdkd deploy`, every clean `cdkd rollback`, `cdkd destroy` / `cdkd state destroy` | `failedOperations[].attemptedProperties` — the properties of the FAILED write, verbatim. Measured on a repo fixture as four versions each carrying a literal `"MasterUserPassword"` |
| custom-resource response object | `cdkd deploy` (the provider's own cleanup) and `cdkd gc` | the handler's FULL cfn-response, `Data` included — where a handler-minted password or API key lands |
| transient CFn template | `cdkd import --migrate-from-cloudformation`, `cdkd export`, and MACRO EXPANSION during `cdkd deploy` / `cdkd diff` (any template over the 51,200-byte inline ceiling) | the template body, which carries a secret only if the template does (an inline `Code.ZipFile`, a hand-written literal) |
| `cdkd-bootstrap/{region}.json` | `cdkd bootstrap --destroy` | the asset bucket and container-repo names. No secret; listed for completeness |

The journal is the one to note if you are deciding whether this matters to you:
it is written by an ORDINARY failed or interrupted deploy, not by an opt-in
feature, and it is swept by an ordinary `cdkd destroy`. `state.json` is
deliberately NOT in this table — its previous versions are the state-recovery
capability versioning is enabled for — and neither is `lock.json`, whose
history is bulk rather than exposure (see the lock section above).

**Without the two grants, nothing fails — and that is the point to
understand.** The purge runs on a cleanup path and must never abort the
operation it follows, so it logs a warning and the deploy, diff, rollback,
destroy, `cdkd import`, `cdkd export` or `cdkd gc` run still succeeds. What does not
happen is the removal: the value stays retrievable by anyone who can read the
state bucket with a `VersionId`. The warning counts KEYS, names them, names
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

If you are on the older four-action policy, adding these two lines is the whole
fix; the objects already stranded before the change have to be purged by hand
(`aws s3api list-object-versions` + `delete-object --version-id`).

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

#### List Stacks Stored in S3

```bash
# Display all stacks present in the state bucket (cdkd-native)
cdkd state list
cdkd state ls --long          # include resource count, last-modified, lock status
cdkd state list --tree        # parent → child stack tree for nested stacks
cdkd state list --tree --json # tree as nested JSON for tooling

# Or, low-level via the AWS CLI:
aws s3 ls s3://cdkd-state-bucket/cdkd/ --recursive \
  | grep state.json \
  | awk '{print $4}' \
  | sed 's|cdkd/||; s|/state.json||'
# Output: <stackName>/<region>, one row per (stackName, region) pair.
```

`--tree` walks each state record's v6 `parentStack` / `parentRegion` fields
(populated by `NestedStackProvider.create` and recursive
`cdkd import --migrate-from-cloudformation`) to render `tree(1)`-style
box-drawing of the parent → child hierarchy:

```text
NestedStackDeep (us-east-1)
└── NestedStackDeep~Child (us-east-1)
    └── NestedStackDeep~Child~Grandchild (us-east-1)
```

Flat output is preserved as the default so scripts that grep
`cdkd state list` still work. Children whose parent state record is missing
(parent destroyed out-of-band, or state hand-deleted) surface at the root
level — they stay visible rather than vanishing.

Note: `cdkd list` (alias `ls`) lists stacks from the local CDK app via
synthesis (CDK CLI parity — see README), which is a different question
from `cdkd state list` (what is registered in the S3 state bucket).

#### Show a Stack's Full State Record (with Nested Children)

```bash
# Single-stack output: metadata, lock, outputs, every resource
# (incl. properties — the deepest state subcommand).
cdkd state show MyStack
cdkd state show MyStack --json

# Recursively show every nested-stack child under the target stack.
# Each child's block is appended after the parent's, separated by a
# blank line and a `Nested stack: <name>` header.
cdkd state show MyParent --show-nested
cdkd state show MyParent --show-nested --json
```

`--show-nested` reuses the same recursive cdkd-state walker as `cdkd export`
(`buildCdkdStateStackTree`): for every `AWS::CloudFormation::Stack` row in
the target's `state.resources`, it derives the child key
(`<parent>~<childLogicalId>`) and loads the child's state file from
`cdkd/<parent>~<childLogicalId>/<region>/state.json`, recursing. The walk
fails fast on a torn tree (a parent that lists a nested-stack row but
whose child state file is missing) with a pointer to remediation
(`cdkd state orphan <parent>` + re-deploy, or finish whatever partial
operation tore the tree). The `--json` shape is recursive
`{state, lock, children: [...]}` so machine consumers see the full tree
in one document; `children` is always present (empty array on leaves) so
the key set is stable. Default (no `--show-nested`) preserves the
single-stack `{state, lock}` shape verbatim — tooling that already
consumes `cdkd state show --json` keeps working.

#### Inspect the State Bucket Itself

```bash
# Bucket name, region (auto-detected via GetBucketLocation), source
# (cli-flag / env / cdk.json / default), schema version, stack count.
cdkd state info
cdkd state info --json
```

Routine commands (`deploy`, `destroy`, `diff`, etc.) no longer print the
bucket banner by default — the bucket name includes the AWS account id,
which would leak via screenshots and public CI logs. Pass `--verbose` to
surface it in those commands' debug logs, or use `cdkd state info` for an
explicit on-demand answer.

## State Migration and Version Management

### Schema Version

Current writers emit **`version: 9`** on the region-prefixed key layout
(`cdkd/{stackName}/{region}/state.json`, introduced by `version: 2`). Older
`version: 1` blobs at the non-region key (`cdkd/{stackName}/state.json`) are
still readable; the next save migrates them to the region-prefixed key and
deletes the legacy key. Every v1..v8 blob is read and auto-upgraded in memory
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
# Force delete lock
aws s3 rm s3://cdkd-state-bucket/cdkd/MyStack/us-east-1/lock.json

# Or cdkd command (planned for future implementation)
# cdkd unlock --stack MyStack --force
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

## Future Extensions

### State Drift Detection

Feature to detect differences between actual AWS resources and state file:

```bash
cdkd detect-drift --stack MyStack
```

### State Import

Feature to import existing AWS resources into cdkd state:

```bash
cdkd import --stack MyStack \
  --resource MyBucket=s3://existing-bucket-name
```

### State Locking Backend Extensions

Support for other backends like DynamoDB or Consul:

```bash
cdkd deploy --state-backend dynamodb \
  --state-table cdkd-locks
```

## References

- [architecture.md](./architecture.md) - Overall architecture
- [S3 Conditional Requests](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-requests.html)
- [Optimistic Locking Pattern](https://en.wikipedia.org/wiki/Optimistic_concurrency_control)
- Terraform State Management (reference case)
