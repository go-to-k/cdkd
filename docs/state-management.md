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
```

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
   The default has changed to 'cdkd-state-123456789012'. Future cdkd
   versions will drop legacy support; consider migrating with cdkd state
   migrate-bucket (coming in a future release).
   ```

3. If neither exists, fail with a "run cdkd bootstrap" error pointing at
   the new name.

The legacy fallback is **temporary**. A future PR will drop it together
with shipping a `cdkd state migrate-bucket` command for users who never
touched their state in the interim. See
[`docs/plans/04-state-bucket-naming.md`](./plans/04-state-bucket-naming.md)
and [`docs/plans/99-future-bc-removal.md`](./plans/99-future-bc-removal.md).

#### Migration path

If you previously bootstrapped with the legacy name and want to silence
the warning:

1. `cdkd bootstrap` (creates `cdkd-state-{accountId}` with the new default).
2. Copy any existing state from the legacy bucket:

   ```bash
   aws s3 sync \
     s3://cdkd-state-{accountId}-{region}/ \
     s3://cdkd-state-{accountId}/
   ```

3. Delete the legacy bucket once you've verified the new one works:

   ```bash
   aws s3 rb s3://cdkd-state-{accountId}-{region} --force
   ```

A dedicated `cdkd state migrate-bucket` command will automate this in a
future release.

### State Bucket Region

The state bucket can live in any AWS region — it does not have to match
your CLI's profile region or the regions you deploy stacks into. cdkd
auto-detects the bucket's region via `GetBucketLocation` (a GET, not a
HEAD — has a body and avoids the AWS SDK v3 region-redirect parsing
glitch on empty-body 301 HEAD responses) and rebuilds its state-bucket
S3 client to that region before any state operation.

This is intentionally scoped to the state-bucket S3 client only.
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

An older cdkd binary that only knows `version: 1` will **fail with a clear
error** if it sees a `version: 2` blob (`Unsupported state schema version
2. Upgrade cdkd.`) instead of silently mishandling unknown fields.

## State Schema

### StackState (`state.json`)

```typescript
interface StackState {
  version: 1 | 2                           // 1 = legacy, 2 = region-prefixed
  stackName: string                        // Stack name
  region?: string                          // Required on version: 2
  resources: Record<string, ResourceState> // Logical ID → Resource state
  outputs: Record<string, string>          // Output name → Resolved value
  lastModified: number                     // Unix timestamp (milliseconds)
}
```

#### Example

```json
{
  "version": 2,
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
  physicalId: string                     // AWS physical ID (ARN, name, etc.)
  resourceType: string                   // CloudFormation resource type
  properties: Record<string, any>        // Resource properties
  attributes: Record<string, any>        // Attributes for Fn::GetAtt
  dependencies: string[]                 // List of dependent logical IDs
}
```

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

#### Lock Acquisition (Acquire)

```typescript
// Using If-None-Match: "*"
// → Succeeds only if object doesn't exist
await s3Client.send(
  new PutObjectCommand({
    Bucket: stateBucket,
    Key: `stacks/${stackName}/lock.json`,
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
    Key: `stacks/${stackName}/lock.json`,
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

    // 3. Determine deletion order from dependencies (reverse topological sort)
    const deletionOrder = computeDeletionOrder(state.resources);

    // 4. Delete resources (reverse of dependencies)
    for (const logicalId of deletionOrder) {
      const resource = state.resources[logicalId];

      try {
        await providerRegistry
          .getProvider(resource.resourceType)
          .delete(logicalId, resource.physicalId, resource.resourceType);

        logger.info(`Deleted resource: ${logicalId}`);
      } catch (error) {
        logger.error(`Failed to delete ${logicalId}:`, error);
        // Continue even on deletion failure (best effort)
      }
    }

    // 5. Delete state file
    await s3StateBackend.deleteState(stackName);

    // 6. Release lock
    await lockManager.releaseLock(stackName);

  } catch (error) {
    await lockManager.releaseLock(stackName);
    throw error;
  }
}
```

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
| `cdkd state rm <stack>` | No | **No** | Yes |

`cdkd destroy` is the canonical path when you have the CDK source — it synths
the app, intersects against state, and deletes resources in reverse dependency
order. `cdkd state destroy` is the same per-stack pipeline (the logic is hoisted
into `src/cli/commands/destroy-runner.ts` and shared by both commands), but
sourced from the state record instead of synth output, so it works from any
working directory given access to the state bucket. Use it for cleanup from a
machine without the CDK source, CI cleanup jobs after the source repo is gone,
or a forgotten stack referenced only by name. `cdkd state rm` only forgets the
state record — the AWS resources stay alive — and is the right tool when you
intentionally want cdkd to stop tracking a stack without touching its
resources.

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
aws s3 sync s3://cdkd-state-bucket/stacks/ \
  s3://cdkd-state-backup/$(date +%Y%m%d)/
```

### Team Environment Operations

#### Monitor Lock Status

```bash
# Check lock status
aws s3api get-object \
  --bucket cdkd-state-bucket \
  --key stacks/MyStack/lock.json \
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
# Display all stacks present in the state bucket
aws s3 ls s3://cdkd-state-bucket/stacks/ --recursive \
  | grep state.json \
  | awk '{print $4}' \
  | sed 's|stacks/||; s|/state.json||'
```

Note: `cdkd list` (alias `ls`) lists stacks from the local CDK app via
synthesis (CDK CLI parity — see README), not from the S3 state bucket.
Listing deployed stacks from the state bucket is currently only supported
via the AWS CLI snippet above.

## State Migration and Version Management

### Schema Version

Current version: **1**

If state schema changes in the future:

```typescript
// Future v2 example
interface StackStateV2 {
  version: 2,
  stackName: string,
  resources: Record<string, ResourceState>,
  outputs: Record<string, string>,
  metadata: {
    createdAt: number,
    lastModified: number,
    deployedBy: string,
  },
  // New field added
  parameters: Record<string, string>,
}
```

Migration tool (planned):

```bash
cdkd migrate-state --from-version 1 --to-version 2
```

## Troubleshooting

### If State is Corrupted

#### Restore from S3 Versioning

```bash
# List versions
aws s3api list-object-versions \
  --bucket cdkd-state-bucket \
  --prefix stacks/MyStack/state.json

# Restore specific version
aws s3api get-object \
  --bucket cdkd-state-bucket \
  --key stacks/MyStack/state.json \
  --version-id abc123 \
  /tmp/state-backup.json

# Restore
aws s3 cp /tmp/state-backup.json \
  s3://cdkd-state-bucket/stacks/MyStack/state.json
```

### If Lock Remains

```bash
# Force delete lock
aws s3 rm s3://cdkd-state-bucket/stacks/MyStack/lock.json

# Or cdkd command (planned for future implementation)
# cdkd unlock --stack MyStack --force
```

### If State and Resources Don't Match

If you manually changed AWS resources, state file and actual resources will diverge.

**Solutions**:

1. **Reset state** (delete only state, keep resources)

   ```bash
   aws s3 rm s3://cdkd-state-bucket/stacks/MyStack/state.json
   ```

   On next `cdkd deploy`, all resources will be treated as CREATE, so existing resources will cause errors.

2. **Manually fix state** (advanced)

   ```bash
   # Download state file
   aws s3 cp s3://cdkd-state-bucket/stacks/MyStack/state.json /tmp/state.json

   # Edit
   vim /tmp/state.json

   # Upload
   aws s3 cp /tmp/state.json s3://cdkd-state-bucket/stacks/MyStack/state.json
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
