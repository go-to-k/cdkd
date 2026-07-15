# cdkd State Management Specification

## Overview

cdkd adopts a state management system with S3 as the backend. Unlike CloudFormation's server-side state management, state is explicitly managed on the client side.

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
          ├── lock.json      # Exclusive lock information (region-scoped)
          └── state.json     # Resource state (region-scoped)
s3://{STATE_BUCKET}/cdkd-bootstrap/
  └── {Region}.json          # Asset-storage bootstrap marker (issue #1002)
```

The `cdkd-bootstrap/{region}.json` marker is written by `cdkd bootstrap`
(unless `--no-assets`) and records that the region opted into cdkd-owned
asset storage — its body names the region's asset bucket
(`cdkd-assets-{accountId}-{region}`) and container-asset ECR repo
(`cdkd-container-assets-{accountId}-{region}`). Deploys read the marker per
(account, region) to pick the asset mode: absent → legacy (publish to the
CDK bootstrap destinations verbatim, byte-identical to pre-#1002 behavior);
present → cdkd-assets mode (asset publishing redirects to the cdkd storage
and template references are rewritten to match — see the asset-destinations
section in [docs/cli-reference.md](cli-reference.md); no state schema
change, the deployed `properties` simply carry the cdkd names); present but
bucket/repo deleted → hard error
(never a silent fallback). The marker deliberately lives OUTSIDE the
`{STATE_PREFIX}/` prefix so stack listing never mistakes it for a stack, and
per-region keys mean concurrent bootstraps of two regions cannot race on a
shared object. `cdkd state info` lists the opted-in regions. Full design in
[docs/design/1002-cdkd-asset-storage.md](design/1002-cdkd-asset-storage.md).

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

All three S3 consumers of the state bucket do this: the state backend
(`state.json` reads/writes, since PR #60), the lock manager
(`lock.json` acquire/release, since issue #803 — before that fix, state
operations succeeded against a cross-region bucket but every lock
acquisition failed with S3's 301 PermanentRedirect), and the exports
index store (`_index/{region}/exports.json` writes/removes for
`Fn::ImportValue` tracking, since issue #819 — before that fix the index
write/remove also hit the 301; non-fatal, so the cross-region index was
silently never maintained). The bucket-region lookup is cached per bucket
name for the process lifetime, so all three consumers share a single
`GetBucketLocation` call.

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

### `version: 3` adds `observedProperties` (current writers)

Schema `version: 3` adds an optional `observedProperties` field to each
`ResourceState`. Writers always emit `version: 3`. The on-disk key layout
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
Writers always emit `version: 5`. The on-disk key layout is unchanged from
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
populate the field).

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

### `version: 6` adds `parentStack` / `parentLogicalId` / `parentRegion` (current writers)

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

Writers always emit `version: 6`. v5 readers see a `version: 6` blob
and fail with the same "upgrade cdkd" error. **v5 → v6 upgrade is
fully transparent** — read a v5 state file with a v6 binary and the
parser tolerates the missing fields (degrades to "top-level stack");
the next write persists `version: 6` silently. No `cdkd state
migrate-schema` command, no env flag, no manual JSON edit. The
[`tests/integration/schema-v5-to-v6-migration/`](../../tests/integration/schema-v5-to-v6-migration/)
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

## State Schema

### StackState (`state.json`)

```typescript
interface StackState {
  version: 1 | 2 | 3 | 4 | 5 | 6           // 1 = legacy, 2 = region-prefixed, 3 = +observedProperties, 4 = +imports[], 5 = +deletionPolicy/updateReplacePolicy, 6 = +parentStack/parentLogicalId/parentRegion (nested-stack adoption)
  stackName: string                        // Stack name
  region?: string                          // Required on version >= 2
  resources: Record<string, ResourceState> // Logical ID → Resource state
  outputs: Record<string, string>          // Output name → Resolved value
  parentStack?: string                     // v6+: populated on nested-stack child state records (undefined on top-level)
  parentLogicalId?: string                 // v6+: child's AWS::CloudFormation::Stack logical id in the parent's template
  parentRegion?: string                    // v6+: parent's region (always equals `region` until cross-region nested stacks ship)
  lastModified: number                     // Unix timestamp (milliseconds)
}
```

#### Example

```json
{
  "version": 3,
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
      "dependencies": []
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
      "dependencies": ["MyFunctionRole", "MyBucket"]
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
  physicalId: string                       // AWS physical ID (ARN, name, etc.)
  resourceType: string                     // CloudFormation resource type
  properties: Record<string, any>          // Resolved template intent (what cdkd was asked to deploy)
  observedProperties?: Record<string, any> // AWS-current snapshot at deploy time (drift baseline)
  attributes: Record<string, any>          // Attributes for Fn::GetAtt
  dependencies: string[]                   // List of dependent logical IDs
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
  operation?: string   // Operation in progress (e.g., "deploy", "destroy")
}
```

#### Example

```json
{
  "owner": "goto@macbook:12345",
  "timestamp": 1710835200000,
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

```typescript
// Simply DeleteObject
await s3Client.send(
  new DeleteObjectCommand({
    Bucket: stateBucket,
    Key: `cdkd/${stackName}/${region}/lock.json`,
  })
);
```

#### Retry Logic

```typescript
async acquireLockWithRetry(
  stackName: string,
  maxRetries = 3,
  retryDelay = 5000  // 5 seconds
): Promise<void> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const acquired = await this.acquireLock(stackName);

    if (acquired) {
      return;
    }

    // Get lock information
    const lockInfo = await this.getLockInfo(stackName);

    // Force release if lock is old
    const age = Date.now() - lockInfo.timestamp;
    if (age >= this.lockTTL) {  // Default 15 minutes
      await this.forceReleaseLock(stackName);
      continue;
    }

    // Wait if still fresh
    if (attempt < maxRetries - 1) {
      await sleep(retryDelay);
      continue;
    }
  }

  throw new LockError('Failed to acquire lock after retries');
}
```

### Lock TTL (Time To Live)

Default: **15 minutes**

Even if a process crashes, after 15 minutes the old lock is considered stale and can be force released.

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
stale lock.

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
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::cdkd-state-bucket",
        "arn:aws:s3:::cdkd-state-bucket/*"
      ]
    }
  ]
}
```

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

Current writers emit **`version: 2`** (region-prefixed key layout —
`cdkd/{stackName}/{region}/state.json`). Older `version: 1` blobs at the
non-region key (`cdkd/{stackName}/state.json`) are still readable; the
next save migrates them to v2 and deletes the legacy key.

A `version: 1` writer encountering a `version: 2` blob fails closed
rather than silently mishandling unknown fields.

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
