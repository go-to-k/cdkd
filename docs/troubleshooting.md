---
title: Troubleshooting
description: "Common cdkd issues and their solutions — lock problems, state management, deploy failures, and debugging tips."
---

# cdkd Troubleshooting Guide

This document summarizes common issues when using cdkd and their solutions.

## Table of Contents

1. [Lock Issues](#lock-issues)
2. [State Management Issues](#state-management-issues)
3. [Deployment Errors](#deployment-errors)
4. [Asset Publishing Issues](#asset-publishing-issues)
5. [Intrinsic Function Issues](#intrinsic-function-issues)
6. [Permission Errors](#permission-errors)
7. [Proxy / Corporate Network](#proxy-corporate-network)
8. [Performance Issues](#performance-issues)
9. [Orphaned Resources](#orphaned-resources)

---

## Lock Issues

### Issue: "Failed to acquire lock" Error

#### Symptoms

```
Error: Failed to acquire lock for stack 'MyStack' after 3 attempts.
Locked by: user@hostname:12345, operation: deploy
```

#### Causes

- Another process is deploying the same stack
- Previous process crashed and lock remains

> **A lock is only reclaimed once its holder stops renewing it.** The holding
> process
> re-writes the lock's `expiresAt` every couple of minutes while it runs, so
> the 30-minute TTL measures **silence, not duration**. A long deploy no longer
> loses its lock partway through, and conversely a lock you find expired really
> does belong to a process that is gone. If you were waiting out a TTL to work
> around a slow operation, that is no longer a thing that happens -- and if a
> lock is not expiring, the process holding it is alive.

> **Note:** The message above is what `cdkd deploy` prints — it **retries** a
> held lock a few times before giving up. The commands that WRITE state
> without deploying — `cdkd destroy`, `cdkd state destroy`, `cdkd import`,
> `cdkd export`, `cdkd orphan`, `cdkd drift --accept`, `cdkd drift --revert`
> and `cdkd state refresh-observed` — instead **fail fast** on contention
> (except `cdkd export`'s nested-stack children, which retry briefly first)
> with a different message, and do **not** proceed while another process holds
> the lock:
>
> ```text
> Could not acquire lock for stack 'MyStack' (us-east-1) — held by alice@host:4242, operation: deploy, expires in ~12m. That process is still running — wait for it to finish. Only if you are certain it is gone, run: cdkd force-unlock MyStack --stack-region us-east-1
> ```
>
> **Read the holder before acting on the suggestion.** cdkd cleans up an
> EXPIRED lock automatically, so a lock that reaches this message is LIVE —
> in practice a `cdkd deploy` that is still running. Running `force-unlock`
> on it deletes that process's lock and lets a second writer into the same
> stack, which is the failure this refusal exists to prevent. Use it only
> when you know the named process is gone (a crashed CI job, a killed
> terminal). When the holder cannot be read (an S3 permission gap), the
> message falls back to `another cdkd process holds it`.
>
> The recovery command carries every flag that decides WHICH lock it resolves
> to — `--stack-region`, plus `--profile` / `--state-bucket` / `--state-prefix`
> when you passed them. Run it as printed: `force-unlock` re-resolves the state
> bucket from the ambient profile otherwise, so a shortened command can clear a
> same-named stack's lock in a different account.

> **Note:** A first `Ctrl-C` during `cdkd destroy` / `cdkd state destroy` no
> longer strands the lock — the graceful-SIGINT handler finishes any in-flight
> delete, flushes the incremental state, and **releases the lock** before
> exiting non-zero. A re-run resumes immediately without waiting out the lock
> TTL. `cdkd deploy` behaves the same way on a first `Ctrl-C`: in-flight
> operations finish, partial state is saved, a rollback journal is recorded,
> and the lock is released before the non-zero exit.
>
> A **second** `Ctrl-C` force-quits immediately (`exit 130`) without waiting
> for the in-flight delete. Because the force-quit path cannot run the normal
> lock-release cleanup, it fires a **best-effort** (un-awaited) lock release
> AND prints the exact recovery command to stderr:
>
> ```text
> Force-quit: stack lock may not be released. If the next run reports a lock, run: cdkd force-unlock MyStack
> ```
>
> The best-effort release usually lands before the process dies, so most
> force-quits leave no lock; if a subsequent run reports a lock, run the
> printed `cdkd force-unlock <stackName>` (or the steps below) to clear it. A
> leftover lock therefore means an ungraceful kill (`SIGKILL`, a force-quit
> whose best-effort release did not complete, or a crash).

#### Solutions

**1. Check if another process is running**

```bash
# Check lock information
aws s3api get-object \
  --bucket ${STATE_BUCKET} \
  --key cdkd/MyStack/us-east-1/lock.json \
  /dev/stdout

# Example output:
# {
#   "owner": "goto@macbook:12345",
#   "timestamp": 1710835200000,
#   "operation": "deploy"
# }
```

**2. Force release if lock is old**

```bash
# Delete lock file
aws s3 rm s3://${STATE_BUCKET}/cdkd/MyStack/us-east-1/lock.json

# Or use cdkd force-unlock command
cdkd force-unlock MyStack
```

**3. Increase retry count**

```typescript
// Adjust in deploy-engine.ts
await lockManager.acquireLockWithRetry(
  stackName,
  owner,
  operation,
  5,      // maxRetries (default: 3)
  10000   // retryDelay (default: 5000ms)
);
```

### Issue: Stale lock after a cancelled CI job

#### Symptoms

A CI job running `cdkd deploy` was cancelled (manually, or automatically by a
newer run), and the next run fails with `Failed to acquire lock` even though
no deploy is in progress.

A very common GitHub Actions setup for per-PR environments hits this:

```yaml
concurrency:
  group: pr-env-${{ github.event.pull_request.number }}
  cancel-in-progress: true
```

Consecutive pushes to the same PR target the **same stack**, so the cancelled
run's stale lock blocks the run that replaced it.

#### Causes

Cancellation is not a clean `Ctrl-C`. GitHub Actions escalates
`SIGINT` → `SIGTERM` (~7.5 s later) → `SIGKILL` (~2.5 s after that); other CI
systems (GitLab CI, `docker stop`, Kubernetes) typically send `SIGTERM`
directly. cdkd's `deploy` / `destroy` / `state destroy` / `rollback` commands
handle **both `SIGINT` and `SIGTERM`** gracefully: the first signal
finishes in-flight operations, saves state, and releases the lock; a second
signal force-quits with a best-effort lock release. But `SIGKILL` cannot be
handled by any process — under GitHub Actions the whole escalation completes
in ~10 seconds, so a job whose in-flight AWS operation takes longer than
that is still killed before the lock-release cleanup finishes, stranding the
lock. SIGTERM-only environments with a longer grace period (Kubernetes
defaults to 30 s; `docker stop` to 10 s) give the graceful path a better
chance to complete.

#### Solutions

**1. Wait out the TTL** — a stale lock is reclaimed automatically after the
lock TTL (**30 minutes** by default). The next run after that succeeds
without intervention.

**2. Clear it immediately** with:

```bash
cdkd force-unlock MyStack
```

**3. Recommended CI pattern** — when your workflow serializes runs per stack
(as the `concurrency` group above does), it is safe to clear any stale lock
at the start of the job, because no other run of the same group can be
holding it legitimately:

```yaml
- run: npm i -g @go-to-k/cdkd
- run: cdkd force-unlock MyStack || true  # only safe when runs are serialized per stack
- run: cdkd deploy MyStack --yes
```

Do **not** add an unconditional `force-unlock` to workflows where two jobs
can legitimately operate on the same stack concurrently — it would break the
lock that protects the running deploy.

#### Note on partially-applied deploys

A killed deploy is usually not a correctness problem beyond the lock: cdkd
saves state incrementally after each completed resource, so a re-run resumes
from the last saved state, and a rollback journal (when present) lets
`cdkd rollback` revert the interrupted deploy instead. The remaining exposure
is a resource whose create was in flight at the moment of the kill: it may
have been created on AWS without reaching state, in which case the next run
can surface an "already exists" conflict that needs manual reconciliation
(delete the resource, or adopt it with `cdkd import`).

---

## State Management Issues

### Issue: "State was modified by another process"

#### Symptoms

```
StateError: State was modified by another process. Expected ETag: "abc123", but state has changed.
```

#### Causes

- Two processes attempted to deploy simultaneously
- Lock was acquired but conflict occurred when saving state

#### Solutions

**1. Re-run deployment**

Protected automatically by optimistic locking, so simply re-running should succeed:

```bash
node dist/cli.js deploy --app "..." --state-bucket ${STATE_BUCKET}
```

**2. Adjust lock timeout**

```typescript
// lock-manager.ts
private readonly lockTTL = 30 * 60 * 1000;  // Extend to 30 minutes
```

### Issue: State File is Corrupted

#### Symptoms

```
SyntaxError: Unexpected token in JSON at position 123
```

#### Causes

- S3 upload was interrupted
- JSON error during manual editing

#### Solutions

**1. Restore from S3 versioning**

```bash
# Get version list
aws s3api list-object-versions \
  --bucket ${STATE_BUCKET} \
  --prefix cdkd/MyStack/us-east-1/state.json

# Example output:
# {
#   "Versions": [
#     {
#       "Key": "cdkd/MyStack/us-east-1/state.json",
#       "VersionId": "abc123",
#       "LastModified": "2024-03-19T10:30:00.000Z"
#     },
#     {
#       "Key": "cdkd/MyStack/us-east-1/state.json",
#       "VersionId": "def456",
#       "LastModified": "2024-03-19T09:00:00.000Z"
#     }
#   ]
# }

# Restore old version
aws s3api get-object \
  --bucket ${STATE_BUCKET} \
  --key cdkd/MyStack/us-east-1/state.json \
  --version-id def456 \
  /tmp/state-backup.json

# Restore
aws s3 cp /tmp/state-backup.json \
  s3://${STATE_BUCKET}/cdkd/MyStack/us-east-1/state.json
```

**2. Reset state and redeploy**

```bash
# Delete state (resources remain)
aws s3 rm s3://${STATE_BUCKET}/cdkd/MyStack/us-east-1/state.json

# Redeploy (will error if existing resources exist)
node dist/cli.js deploy --app "..." --state-bucket ${STATE_BUCKET}
```

### Issue: State and Resources Don't Match

#### Symptoms

- Manually deleted/modified resources in AWS Console
- cdkd tries to update non-existent resources

#### Causes

cdkd's state file and actual AWS resources have diverged.

#### Solutions

**1. Reset state**

```bash
# Delete state
aws s3 rm s3://${STATE_BUCKET}/cdkd/MyStack/us-east-1/state.json

# Redeploy (all resources treated as CREATE)
node dist/cli.js deploy --app "..." --state-bucket ${STATE_BUCKET}
```

**2. Manually fix state (advanced)**

```bash
# Download state
aws s3 cp s3://${STATE_BUCKET}/cdkd/MyStack/us-east-1/state.json /tmp/state.json

# Edit (remove entries for deleted resources)
vim /tmp/state.json

# Upload
aws s3 cp /tmp/state.json s3://${STATE_BUCKET}/cdkd/MyStack/us-east-1/state.json
```

**3. Delete and recreate entire stack**

```bash
# Delete all resources
node dist/cli.js destroy MyStack --force

# Redeploy
node dist/cli.js deploy --app "..." --state-bucket ${STATE_BUCKET}
```

---

### Issue: "UnknownError" / cross-region state bucket

#### Symptoms

```
StateError: Failed to verify state bucket 'my-bucket': UnknownError
Caused by: UnknownError
```

…or similar AWS SDK v3 surface-level `UnknownError` on any S3 operation
against the state bucket. The lock-path variant of the same root cause
surfaced as a 301 PermanentRedirect instead:

```
LockError: Failed to acquire lock for stack 'MyStack' (ap-northeast-1):
The bucket you are attempting to access must be addressed using the
specified endpoint. Please send all future requests to this endpoint.
```

#### Cause

The state bucket lives in a region different from the one the AWS SDK
client was constructed for. AWS SDK v3's region-redirect middleware does
not handle the empty-body 301 HEAD response S3 returns in this case
cleanly — the protocol parser falls through and produces a synthetic
`Unknown` exception with the literal message `UnknownError`.

#### Solution

cdkd resolves this automatically: the state backend (since
v0.10.0), the lock manager (previously
state operations succeeded against a cross-region bucket but lock
acquisition failed with the PermanentRedirect error above), and the
custom-resource response path (previously deploying
a stack with a Lambda-backed Custom Resource to a region different from
the state bucket's region failed with the same 301 on the pre-signed
`ResponseURL`) look up the bucket region via `GetBucketLocation` (a GET
request, not a HEAD — avoids the SDK glitch) and rebuild their S3
clients to that region before any state, lock, or custom-resource
response operation. If you still see either error, please file a bug
with the full stack trace.

You no longer need to set the region to match the bucket region (the
state-bucket client auto-detects it via `GetBucketLocation`). As of
v0.12.0, `--region` is a first-class option only on
`cdkd bootstrap` (where it picks the new bucket's region); on every
other command it is deprecated (prefer `AWS_REGION` / your AWS profile)
but still honored if passed. Use `AWS_REGION` or your AWS profile to
control the SDK's default region for provisioning.

---

## Deployment Errors

### Issue: "The following resources declare mutually exclusive properties"

#### Symptoms

```
The following resources declare mutually exclusive properties:
  - BadRoute (AWS::EC2::Route) declares DestinationCidrBlock and DestinationIpv6CidrBlock
      CloudFormation and the EC2 CreateRoute API accept exactly one destination per route.
      cdkd would send only DestinationCidrBlock; DestinationIpv6CidrBlock would be dropped.
      Deleting the dropped keys changes nothing cdkd sends — but if the LIVE resource was
      created from one of them, making DestinationCidrBlock the sole value is a create-only
      change that REPLACES it.
      Declare at most one of: DestinationCidrBlock / DestinationIpv6CidrBlock / DestinationPrefixListId
```

#### Causes

The template declares two or more properties AWS accepts only one of. cdkd
rejects this at pre-flight, before any AWS call. CloudFormation rejects the same
template, so this is a template defect rather than a cdkd limitation — which is
why there is no `--allow-*` escape hatch for it.

The check fires on EVERY deploy, not only when the resource is new. A stack that
already carries such a resource used to deploy silently (the diff classifies
`NO_CHANGE`, so the provider's own refusal was never reached) while AWS held only
one of the declared values.

`cdkd diff` reports no CHANGE for this shape (the narrowed sides are equal),
but it does warn that part of the declared properties cannot be sent as
declared — that warning and this error describe the same defect.

#### Solutions

**1. Remove the extra properties**

Delete every key except the one the message says cdkd would send. That edit
changes nothing cdkd sends. **Check what the resource is live on first**,
though: if it was created from one of the dropped keys, promoting a different
key to sole destination is a create-only change and REPLACES the resource:

```typescript
new ec2.CfnRoute(this, 'Route', {
  routeTableId: rt.ref,
  gatewayId: igw.ref,
  destinationCidrBlock: '0.0.0.0/0',
  // destinationIpv6CidrBlock: '::/0',  <- delete; only one destination is allowed
});
```

**2. Or make them conditional**

If the resource genuinely needs a different property per environment, put each
behind a condition whose other arm is `AWS::NoValue`. cdkd treats a key behind
an unresolved intrinsic as unknown and does NOT reject it, because exactly one
of the two survives resolution:

```json
{
  "DestinationCidrBlock":     { "Fn::If": ["IsV4", "0.0.0.0/0", { "Ref": "AWS::NoValue" }] },
  "DestinationIpv6CidrBlock": { "Fn::If": ["IsV4", { "Ref": "AWS::NoValue" }, "::/0"] }
}
```

### Issue: "Resource already exists" Error

#### Symptoms

```
ProvisioningError: Resource already exists: my-bucket-name
ResourceType: AWS::S3::Bucket
```

#### Causes

- Resource with same name already exists
- Previous deployment failed midway and state was not saved

#### Solutions

**1. Change resource name**

Make resource name unique in CDK code:

```typescript
new s3.Bucket(this, 'MyBucket', {
  bucketName: `my-app-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
});
```

**2. Delete existing resource**

```bash
# S3 bucket example
aws s3 rb s3://my-bucket-name --force
```

**3. Import existing resource to state (planned for future implementation)**

```bash
# cdkd import --stack MyStack --resource MyBucket=s3://my-bucket-name
```

### Issue: "Provider not found" Error

#### Symptoms

```
Error: No provider registered for resource type: AWS::CustomService::Resource
```

#### Causes

- Resource not supported by Cloud Control API
- SDK Provider not implemented

#### Solutions

**1. Check Cloud Control API support status**

```bash
# Check AWS documentation
# https://docs.aws.amazon.com/cloudcontrolapi/latest/userguide/supported-resources.html
```

**2. Implement SDK Provider**

Refer to [provider-development.md](./provider-development.md) to implement a custom provider.

**3. Temporarily use CloudFormation**

For resources not supported by cdkd, use regular `cdk deploy`.

### Issue: "Update requires replacement" Error

#### Symptoms

```
ProvisioningError: Cannot update property 'BucketName': Update requires replacement
```

#### Causes

- Attempting to change property marked "Update requires: Replacement" in CloudFormation
- Provider hasn't implemented replacement handling

#### Solutions

**1. Implement replacement handling in provider**

```typescript
async update(...): Promise<ResourceUpdateResult> {
  const requiresReplacement = this.checkReplacementRequired(
    properties,
    previousProperties
  );

  if (requiresReplacement) {
    // Create new resource
    const createResult = await this.create(logicalId, resourceType, properties);

    // Delete old resource
    await this.delete(logicalId, physicalId, resourceType);

    return {
      physicalId: createResult.physicalId,
      wasReplaced: true,
      attributes: createResult.attributes,
    };
  }

  // Normal update process
  // ...
}
```

**2. Manually delete and recreate resource**

```bash
# Manually delete
aws s3 rb s3://old-bucket-name --force

# Redeploy
node dist/cli.js deploy --app "..." --state-bucket ${STATE_BUCKET}
```

### Issue: "bucket is not empty" / "still contains images" on destroy

**Symptoms:**

```text
Failed to delete S3 bucket MyBucket: bucket my-bucket is not empty. Matching
CloudFormation, cdkd does not delete a non-empty bucket unless it opted into
automatic emptying ...
```

```text
Failed to delete ECR Repository MyRepo: repository my-repo still contains
images. Matching CloudFormation, cdkd does not force-delete an image-carrying
repository ...
```

**Cause:**

`cdkd destroy` matches CloudFormation's fail-and-protect behavior: an S3 bucket (standard
or S3 Express directory bucket) that still contains objects, or an ECR
repository that still contains images, is NOT force-cleaned unless the
resource opted in.

**Solutions:**

1. Opt in from the CDK app and redeploy, then destroy:
   - S3: `autoDeleteObjects: true` (with `removalPolicy: DESTROY`)
   - S3 Express directory bucket: CDK has no `autoDeleteObjects` sugar —
     declare the opt-in tag on the L1 (`Tags` is a handled property):
     `tags: [{ key: 'aws-cdk:auto-delete-objects', value: 'true' }]`
   - ECR: `emptyOnDelete: true` (or the legacy `autoDeleteImages: true`)
2. Or empty the data manually and re-run the destroy:

   ```bash
   # Unversioned bucket
   aws s3 rm s3://my-bucket --recursive
   # Versioned bucket: also delete all object versions + delete markers
   # ECR
   aws ecr batch-delete-image --repository-name my-repo \
     --image-ids "$(aws ecr list-images --repository-name my-repo --query 'imageIds' --output json)"
   ```

See the "Destroy data guards" section in
[cli-destroy.md](cli-destroy.md#destroy-data-guards-non-empty-s3-buckets-and-image-carrying-ecr-repositories) for the full semantics.

### Issue: "has DeletionPolicy: Snapshot, but ..." refusal on delete

**Symptoms:**

```text
MyDb (AWS::RDS::DBInstance) has DeletionPolicy: Snapshot, but the resource is
managed via the Cloud Control API route (provisionedBy: cc-api), which has no
final-snapshot delete parameter ...
```

**Cause:**

CloudFormation creates a final snapshot before deleting a
`DeletionPolicy: Snapshot` resource, and cdkd matches that for the FULL
CFn-documented Snapshot-capable type list. The delete is refused only when
cdkd cannot create the snapshot: the resource is an atomic-parameter type
routed via Cloud Control (`provisionedBy: cc-api`, the silent-drop
routing — Cloud Control's `DeleteResource` has no final-snapshot
parameter), or the template carries `Snapshot` on a type CloudFormation
itself would refuse the attribute on.

**Solutions:**

1. Snapshot the resource manually, then re-run with `--skip-final-snapshot`
   (the explicit data-loss opt-out), or
2. Change the policy to `Retain` and delete the resource manually after
   snapshotting.

See the "DeletionPolicy: Snapshot" section in
[cli-destroy.md](cli-destroy.md#deletionpolicy-snapshot-final-snapshots-on-delete-skip-final-snapshot) for the per-type mechanics.

---

### Issue: "OpenTableFormatInput.IcebergInput.IcebergTableInput cannot be deployed" on a Glue table

**Symptoms:**

```text
AWS::Glue::Table IcebergTable: OpenTableFormatInput.IcebergInput.IcebergTableInput
cannot be deployed by AWS in any shape, so cdkd refuses it before calling Glue
(issue #1454). ...
```

**Cause:**

cdkd refuses this property at pre-flight on a **template-driven create**,
before any AWS call. (A `cdkd rollback` only ever WARNS, on both of its paths —
the update replay and the reverse-replacement re-create — because a rollback
replays from cdkd state rather than from your template, so refusing there would
leave you no remedy but hand-editing `state.json`. That matters for tables
created by an older cdkd build, whose state records still
carry the key. See "Glue table Iceberg support" in
[supported-resources.md](supported-resources.md) for what the restored table
looks like.) It is a
deliberate parity divergence — CloudFormation forwards the property instead of
validating it, but a live probe showed the spec is
undeployable either way: the raw `glue:CreateTable` API cdkd calls rejects every
shape of it, and CloudFormation rolls the same template back. The handler asks
for `IcebergTableInputProperties`, a name that exists in neither the CFn
registry schema nor `@aws-sdk/client-glue` — an AWS-side contract bug. Failing
fast with the working shape spelled out beats a late, cryptic AWS error.

**Solutions:**

Move the table metadata into `TableInput` and leave `IcebergInput` carrying only
the create-time directive:

```yaml
TableInput:
  Name: events_iceberg
  TableType: EXTERNAL_TABLE          # required for Iceberg
  StorageDescriptor:
    Location: s3://your-bucket/iceberg/events/
    Columns:
      - Name: event_id
        Type: string
OpenTableFormatInput:
  IcebergInput:
    MetadataOperation: CREATE        # Version: '2' is also accepted
```

Glue writes the Iceberg metadata itself — the created table comes back with
`Parameters.table_type = ICEBERG` and a populated `Parameters.metadata_location`.
See [Glue table Iceberg support](supported-resources.md#glue-table-iceberg-support-icebergtableinput-is-refused)
for the full probe transcript and rationale.

---

### Issue: deleting a Cognito `Policies` sub-key changes nothing on the pool

**Symptoms:**

You remove `Policies.SignInPolicy` from a `AWS::Cognito::UserPool` template --
typically to revoke a passwordless first-auth factor such as `EMAIL_OTP` -- and
`cdkd deploy` succeeds, but the pool still allows it. `cdkd drift` and
`cdkd diff` both report nothing afterwards. The same happens for
`Policies.PasswordPolicy`, and for deleting the whole `Policies` container.

The one signal cdkd gives is a warning on the deploy that carries the removal:

```text
UserPool us-east-1_xxxxxxxxx: the desired configuration no longer declares
Policies.SignInPolicy, and no UpdateUserPool input can express that removal --
omitting the sub-key PRESERVES the live value ..., so the pool keeps its current
sign-in policy. ... To change the live value, declare Policies.SignInPolicy
explicitly with the intended configuration (the AWS default is
AllowedFirstAuthFactors: [PASSWORD]).
```

**Cause:**

`UpdateUserPool` treats an omitted `Policies` sub-key as "keep the live value",
not as "reset it" -- measured us-east-1 2026-08-19. There is no input that
expresses a removal, so a template that stops declaring the sub-key sends
nothing for it and AWS changes nothing. **CloudFormation behaves identically**
on the same template edit -- measured us-east-1 2026-09-02 on all three removal
shapes -- so this
is template-compatibility parity, not a cdkd defect, and cdkd deliberately does
not send a reset that CloudFormation would not.

`cdkd drift` is silent because the same deploy refreshes the drift baseline
(`observedProperties`) from a post-update read of the live pool, so the retained
sub-key sits on both sides of the comparison. That is why the deploy-time
warning is the ONLY place this surfaces.

**Solution:**

Declare the sub-key explicitly with the configuration you want, rather than
deleting it:

```yaml
Policies:
  SignInPolicy:
    AllowedFirstAuthFactors:
      - PASSWORD          # revokes EMAIL_OTP by stating the intended set
```

The AWS defaults, if that is what you are after, are
`AllowedFirstAuthFactors: [PASSWORD]` for `SignInPolicy` and `MinimumLength: 8`
with every character-class requirement enabled plus
`TemporaryPasswordValidityDays: 7` for `PasswordPolicy`.

---

## Asset Publishing Issues

### Issue: "Asset publishing failed"

#### Symptoms

```
AssetPublisherError: Failed to publish asset: Access Denied
```

#### Causes

- Asset storage doesn't exist for the target: in cdkd-assets mode the
  `cdkd-assets-*` bucket / `cdkd-container-assets-*` repo (someone deleted
  them after bootstrap), in legacy mode the CDK bootstrap bucket
  (`cdk-hnb659fds-assets-*`)
- Insufficient IAM permissions

#### Solutions

**1. Run `cdkd bootstrap` for the region**

`cdkd bootstrap` creates the state bucket AND cdkd-owned asset storage for
`--region` (asset bucket + container-asset ECR repo + opt-in marker), so no
`cdk bootstrap` is needed:

```bash
cdkd bootstrap --region us-east-1
```

Normally this is automatic — the first `cdkd deploy` into a region
auto-creates the storage, so this error usually means the
auto-create was declined / opted out (`--no-auto-asset-storage`), failed
(check the deploy output for the auto-create warning), or someone deleted
the bucket/repo after opt-in. Deploys that stay in **legacy mode** publish
to the CDK bootstrap bucket instead, which then must exist
(`npx cdk bootstrap aws://123456789012/us-east-1`). See
[cli-bootstrap.md](cli-bootstrap.md#cdkd-bootstrap).

> **Custom bootstrap**: If you use a custom qualifier (e.g., `--qualifier myqualifier`), CDK synthesis will embed the custom bucket name in the asset manifest. cdkd reads destinations from the manifest (and, in cdkd-assets mode, redirects default-bootstrap-shaped destinations to cdkd-owned storage), so custom qualifiers are fully supported.

**2. Skip asset publishing**

```bash
# Skip during deployment
node dist/cli.js deploy --app "..." --skip-assets
```

**3. Check IAM permissions**

cdkd publishes assets with the caller's credentials directly (it never
assumes CDK's `cdk-hnb659fds-file-publishing-role-*`). The caller needs
S3 read/write on the asset bucket — `cdkd-assets-*` in cdkd-assets mode
(adjust the ARN if the region was bootstrapped with a custom
`--asset-bucket` name), `cdk-hnb659fds-assets-*` in legacy mode:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject"
      ],
      "Resource": [
        "arn:aws:s3:::cdkd-assets-*/*",
        "arn:aws:s3:::cdk-hnb659fds-assets-*/*"
      ]
    }
  ]
}
```

(Docker image assets additionally need ECR push permissions on the
container-asset repo.)

### Issue: Lambda Deployment Fails

#### Symptoms

```
ProvisioningError: Failed to create Lambda function: InvalidParameterValueException
The provided execution role does not have permissions to call CreateFunction.
```

#### Causes

- Lambda asset (zip file) not published
- IAM Role not created

#### Solutions

**1. Verify asset publishing**

```bash
# Check asset manifest
cat cdk.out/MyStack.assets.json

# Check asset bucket (cdkd-assets mode; use cdk-hnb659fds-assets-... in legacy mode)
aws s3 ls s3://cdkd-assets-${AWS_ACCOUNT_ID}-${AWS_REGION}/
```

**2. Check IAM Role dependencies**

Lambda functions depend on IAM Role, so verify proper ordering in DAG:

```typescript
// Define Role first in CDK code
const role = new iam.Role(this, 'LambdaRole', { ... });

const func = new lambda.Function(this, 'MyFunction', {
  role: role,  // ← Dependency set
  // ...
});
```

---

## Intrinsic Function Issues

### Issue: "Unresolved intrinsic function" Error

#### Symptoms

```
Error: Cannot resolve intrinsic function: Fn::Select
```

#### Causes

CloudFormation intrinsic function not supported by cdkd is being used.

#### Support Status

| Function | Supported |
|----------|-----------|
| `Ref` | ✅ |
| `Fn::GetAtt` | ✅ |
| `Fn::Join` | ✅ |
| `Fn::Sub` | ✅ |
| `Fn::Select` | ✅ |
| `Fn::Split` | ✅ |
| `Fn::If` | ✅ |
| `Fn::Equals` | ✅ |
| `Fn::And` | ✅ |
| `Fn::Or` | ✅ |
| `Fn::Not` | ✅ |
| `Fn::ImportValue` | ✅ |
| `Fn::GetStackOutput` | ✅ (same-account; cross-account `RoleArn` not yet implemented) |
| `Fn::FindInMap` | ✅ |
| `Fn::GetAZs` | ✅ |
| `Fn::Base64` | ✅ |

#### Solutions

**1. All intrinsic functions are now supported**

All CloudFormation intrinsic functions are supported as of 2026-03-26, including `Fn::GetAZs`. If you encounter this error, ensure you are using the latest version of cdkd.

**2. Extend intrinsic function implementation**

If a new function needs support, add implementation to `src/deployment/intrinsic-function-resolver.ts`.

Example for Fn::Base64:

```typescript
if ('Fn::Base64' in obj) {
  const value = await this.resolveValue(obj['Fn::Base64'], context);
  return Buffer.from(String(value)).toString('base64');
}
```

### Issue: "AWS::AccountId not resolved"

#### Symptoms

```
Output value contains unresolved reference: ${AWS::AccountId}
```

#### Causes

Pseudo parameter not resolved.

#### Solutions

cdkd retrieves actual Account ID via STS GetCallerIdentity. Verify AWS credentials are properly configured:

```bash
# Check credentials
aws sts get-caller-identity

# Example output:
# {
#   "UserId": "AIDAI...",
#   "Account": "123456789012",
#   "Arn": "arn:aws:iam::123456789012:user/myuser"
# }
```

---

## Permission Errors

### Issue: "Access Denied" Error

#### Symptoms

```
ProvisioningError: Access Denied
User: arn:aws:iam::123456789012:user/myuser is not authorized to perform: s3:CreateBucket
```

#### Causes

IAM user/role lacks required permissions.

#### Solutions

**1. Grant required permissions**

Main permissions required by cdkd:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:*",
        "iam:*",
        "lambda:*",
        "dynamodb:*",
        "sqs:*",
        "cloudcontrol:*",
        "cloudformation:DescribeType",
        "sts:GetCallerIdentity"
      ],
      "Resource": "*"
    }
  ]
}
```

**Note**: In production, follow the principle of least privilege and grant only necessary permissions.

**Note on `cloudformation:DescribeType`**: cdkd uses it to resolve each
resource type's `writeOnlyProperties` from the CloudFormation registry so
that Cloud Control API updates re-include write-only properties in every
patch document (Cloud Control's read-modify-write update would otherwise
drop them — e.g. `AWS::ECS::Service.VolumeConfigurations`). If the
permission is missing, cdkd logs a warning and gracefully falls back to a
minimal patch (the pre-existing behavior), so deploys still work — but
write-only properties may be dropped on update for affected resource
types. `cdkd export` also uses `cloudformation:DescribeType` to resolve
primary identifiers (with a hardcoded fallback table) and, from the same
response, to pre-flight resource types CloudFormation cannot IMPORT at
all. Without the permission the export still runs off the fallback
table, but the pre-flight cannot fire — a non-importable type then
surfaces later as `ResourceTypes [<T>] are not supported for Import`
from `CreateChangeSet`, naming only some of the offenders.

**2. CloudFormation PassRole permission**

When using IAM Role with Lambda, etc.:

```json
{
  "Effect": "Allow",
  "Action": "iam:PassRole",
  "Resource": "arn:aws:iam::123456789012:role/MyLambdaRole"
}
```

### Issue: "You are not authorized to perform sts:AssumeRole"

#### Symptoms

```
Error: You are not authorized to perform sts:AssumeRole on arn:aws:iam::...:role/cdk-*
```

#### Causes

Lack of AssumeRole permission for roles created by CDK Bootstrap.

#### Solutions

**1. Check Bootstrap role trust policy**

```bash
aws iam get-role --role-name cdk-hnb659fds-deploy-role-123456789012-us-east-1
```

**2. Add your user/role to trust policy**

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::123456789012:user/myuser"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

---

## Proxy / Corporate Network

### Issue: "self-signed certificate in certificate chain" on the very first command

```
$ cdkd bootstrap --profile my-sso-profile
Starting cdkd bootstrap...
No --state-bucket specified, resolving default bucket name...
CredentialsProviderError: Error: self-signed certificate in certificate chain
```

**The certificate wording is usually a red herring.** On a network whose only
egress is a corporate proxy, it is the DIRECT route that gets intercepted, so
the certificate cdkd sees is the interceptor's rather than Amazon's. Routed
through the proxy, cdkd sees Amazon's own certificate.

cdkd honours the proxy environment variables. If the AWS CLI, `git` and `npm`
work in the same shell but cdkd does not, check that the variables are exported
to the process running cdkd — the AWS CLI can also be
configured through `~/.aws/config`, and `npm` through `~/.npmrc`, so those two
working is not by itself evidence that the environment carries a proxy.

**Why this needed a change in cdkd at all.** The AWS SDK for JavaScript v3 does
not read the proxy variables the way botocore (the AWS CLI) and Go's
`net/http` do; its
[guide](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/node-configuring-proxies.html)
states that a proxy is supplied "through a third-party HTTP agent" by whoever
constructs the client. Node's own `NODE_USE_ENV_PROXY=1` is not a substitute:
it rewires the GLOBAL agent, while every SDK client builds its own.

### Variables cdkd honours

| Variable | Effect |
| --- | --- |
| `HTTPS_PROXY` / `https_proxy` | Proxy for `https://` requests, which is all AWS traffic in practice |
| `HTTP_PROXY` / `http_proxy` | Proxy for plain `http://` requests |
| `ALL_PROXY` / `all_proxy` | Fallback for either scheme |
| `NO_PROXY` / `no_proxy` | Hosts to reach directly, bypassing the proxy |

Both spellings work; the lower-case ones win where a tool sets both, matching
the resolution order of every other tool that reads them. The proxy is chosen
per REQUEST, so `HTTPS_PROXY` and `HTTP_PROXY` may name different proxies and
each scheme goes to its own.

### `NO_PROXY` matching is EXACT, unlike curl

An entry that does not start with `.` or `*` is compared for **exact equality**
against the hostname. This surprises most people, because curl treats a bare
entry as a suffix.

| `NO_PROXY` | `example.com` | `api.example.com` |
| --- | --- | --- |
| `example.com` | direct | **proxied** |
| `.example.com` | **proxied** | direct |
| `*.example.com` | **proxied** | direct |
| `example.com,.example.com` | direct | direct |

So covering a domain and its subdomains takes **two entries**.

**CIDR ranges are not supported and are silently ignored.** A hostname never
contains `/`, so a `10.0.0.0/8` entry falls into the exact-match branch and can
never match anything. IP addresses must be listed literally
(`NO_PROXY=10.1.2.3`). A trailing wildcard such as `172.16.*` does not work
either — only a LEADING `*` is a wildcard.

This matters for VPC-endpoint setups, where the intent is usually to send
`*.amazonaws.com` direct and everything else through the proxy: write
`NO_PROXY=.amazonaws.com,amazonaws.com`, not `NO_PROXY=amazonaws.com`.

### A TLS-terminating proxy still needs `NODE_EXTRA_CA_CERTS`

Routing through the proxy removes the need for an extra CA only when the proxy
opens a **CONNECT tunnel**, because the origin's own certificate is what gets
validated end to end. A proxy that **terminates TLS** presents its own
certificate on purpose, and cdkd must be told to trust it:

```bash
export NODE_EXTRA_CA_CERTS=/path/to/corporate-root-ca.pem
```

If a certificate error survives correct proxy variables, this is almost always
what is missing. `NODE_EXTRA_CA_CERTS` must point at a PEM file readable by the
cdkd process; it is a Node.js variable, so it does not help the AWS CLI (which
uses `AWS_CA_BUNDLE`).

### The Docker daemon has its own egress

`cdkd deploy` builds and pushes container image assets through the **Docker
daemon**, and `cdkd local` runs containers through it. The daemon is a separate
process with its own network configuration — cdkd cannot configure it, and the
variables above do not reach it. If image pulls or pushes fail behind a proxy
while everything else works, configure the daemon itself (on Linux, a systemd
drop-in with `Environment="HTTPS_PROXY=..."`; on Docker Desktop, Settings →
Resources → Proxies) and restart it.

### Verifying that traffic is routed

Point cdkd at a proxy that cannot work. If the variable is being honoured, the
command fails; if it succeeds anyway, the variable is not reaching the process:

```bash
HTTPS_PROXY=http://127.0.0.1:1 cdkd state list --profile <a working profile>
```

---

## Performance Issues

### Issue: Deployment is Slow

#### Symptoms

- Takes 30+ seconds even for small stacks (5-10 resources)
- Expected speedup not achieved

#### Causes

- Long dependency chains in the DAG (the critical path caps how fast a deploy can finish, even with event-driven dispatch)
- Cloud Control API rate limits
- Asset publishing takes time

#### Solutions

**1. Check dependencies**

```bash
# Check execution plan with diff command
node dist/cli.js diff --app "..." --state-bucket ${STATE_BUCKET} --verbose

# Example output:
# Execution levels:
#   Level 0: [Bucket, Table] (2 resources, parallel)
#   Level 1: [Role] (1 resource)
#   Level 2: [Function] (1 resource)
```

**2. Remove unnecessary dependencies**

Reduce explicit dependencies in CDK code:

```typescript
// Bad example
const bucket = new s3.Bucket(this, 'Bucket');
const role = new iam.Role(this, 'Role', { ... });
role.node.addDependency(bucket);  // ← Unnecessary dependency

// Good example
const bucket = new s3.Bucket(this, 'Bucket');
const role = new iam.Role(this, 'Role', { ... });
// Dependencies auto-detected from Ref/GetAtt
```

**3. Parallelize asset publishing (planned for future implementation)**

```typescript
// Parallel execution in asset-publisher.ts
await Promise.all(
  assets.map(asset => publishAsset(asset))
);
```

### Issue: Cloud Control API Rate Limit

#### Symptoms

```
Error: TooManyRequestsException: Rate exceeded
```

#### Causes

Cloud Control API has the following rate limits:

- CreateResource: 5 TPS
- UpdateResource: 5 TPS
- DeleteResource: 5 TPS

#### Solutions

**1. Retry logic with exponential backoff (built-in)**

cdkd includes built-in retry logic for CREATE operations, with the backoff shape chosen per error class:

- **Throttling and other transient errors** (rate limits, a resource still leaving `Pending`, an async delete releasing a dependency, and a transient server error — HTTP 500 / 502 / 503 / 504, the same four the AWS SDK's own retry strategy treats as transient): exponential backoff `1s->2s->4s->8s->8s->8s->8s->8s`, capped at 8s, up to 8 retries (47s of sleep). Hammering a throttled API is counter-productive, so this class deliberately backs off hard.
- **IAM propagation** (`Invalid IAM Instance Profile`, `cannot be assumed`, `not authorized to perform`, `Policy Error: PrincipalNotFound`, ...): a denser `0.25s->0.5s->1s->2s->2s...` schedule over 26 retries (47.75s of sleep). This class resolves in single-digit seconds — cdkd creates an IAM entity and consumes it ~1-3s later, faster than IAM propagates — so cdkd re-probes roughly every 2s instead of idling through a 4s or 8s step. The total window is at least as long as the generic one, so nothing that used to recover still recovers.

  If the window is not enough, cdkd says so rather than silently re-raising the AWS error. A propagation retry that gives up prints one line at the DEFAULT log level (`--verbose` additionally prefixes a timestamp and `WARN`):

  ```text
  MyFunction: gave up after 26 IAM-propagation retries over 47.75s of propagation backoff (the full propagation budget) - The role defined for the function cannot be assumed by Lambda.
  ```

  When cdkd can see what the AWS SDK made of the failing response, the line ends with a bracketed summary of it:

  ```text
  MyQueuePolicy: gave up after 5 IAM-propagation retries over 5.75s of propagation backoff - Failed to create SQS queue policy MyQueuePolicy: UnknownError [name=InternalFailure http=500 requestId=ebf581cc-6072-5ffc-943a-e33312488615]
  ```

  A sequence that spent its budget on transient server errors rather than on propagation says so instead, and a mixed one reports both:

  ```text
  MyQueuePolicy: gave up after 8 transient server-error retries (HTTP 5xx) - ... [name=InternalFailure http=503 requestId=...]
  ```

  `UnknownError` in the message position is not something AWS said — it is the placeholder the AWS SDK substitutes when a response carries no message text at all. When you see it, the message is empty by definition and the bracket is the whole diagnosis: `name` and `http` are the two fields cdkd's classifier decides on, and `requestId` is what AWS support needs. A `no-$metadata` token instead of `http=` means the failure never reached the SDK's error parsing (a network or protocol failure), which is a different problem from a status cdkd chose not to retry.

  That line is how you tell the cases apart without reading cdkd's source:

  - **`(the full propagation budget)` present** — the retry ran to exhaustion and IAM genuinely took longer than 47.75s in that account. Re-running usually succeeds; if it recurs, please [open an issue](https://github.com/go-to-k/cdkd/issues) with the line, since the budget's shape is then the thing that needs changing. Note the retry COUNT on such a line can be below 26: a throttle mid-race consumes an attempt without counting as a propagation retry, so the budget can run out at 25 or fewer.
  - **No budget note, and a low count** — something terminal ended the race early: a non-retryable error such as an explicit deny, or an error cdkd's classifier could not read. The seconds figure tells you how much of the 47.75s was actually spent, which is what distinguishes "IAM was too slow" from "the retry was cut short", and the bracketed `[name=... http=...]` names what ended it. This shape is worth reporting when the status is a 5xx other than 500 / 502 / 503 / 504, or when the bracket shows `no-$metadata`: those are the cases cdkd does not currently treat as transient, and one of them (a plain HTTP 500 answered mid-propagation with an empty body) was a real, since-fixed defect, where a single 500 ended an otherwise healthy sequence at 12% of its budget.
  - **No such line at all** — the retry never engaged, and there are two reasons, which need different responses. Either the failure was never classified as propagation (a missing pattern in `retryable-errors.ts`, worth reporting), OR the failing resource is served by a provider that opts out of the outer retry by design — `Custom::*` / `AWS::CloudFormation::CustomResource` and `AWS::CloudFormation::Stack` set `disableOuterRetry`, so the dense outer schedule never wraps them and no give-up line is produced for them. A custom resource's Lambda HANDLER is an ordinary `AWS::Lambda::Function` and does retry on the outer schedule. Check which of the two the failing logical id is before filing.

    There used to be a THIRD reason, and it is worth knowing it is gone. A rollback's reverse-replacement re-create — the arm that revives the OLD resource after a replacement failed — could never produce this line at all, whatever the error: it wrapped the create in a retry carrying an explicit schedule and a name-collision classifier, and either of those alone makes the propagation counters inert. So a rollback that hit `The role defined for the function cannot be assumed by Lambda.` printed the bare AWS sentence, retried zero times, and was indistinguishable from a build with no propagation retry at all. That path now retries on the same dense schedule and prints the same give-up line, so **you can now see this line during `cdkd rollback` and during an automatic rollback**, not only during `cdkd deploy`. The two reasons above are once again the complete set.

    Opting out of the OUTER retry is not the same as having no retry, which is what this bullet used to say. `CustomResourceProvider` retries internally instead, and that now covers both error shapes rather than one: a handler that RETURNS `FAILED` with an authz-shaped reason, and — new — an authz-shaped error THROWN by an SDK call the provider itself makes before the request reaches the handler. The two draw on SEPARATE budgets, because they cost different things. A re-invoke after a FAILED response re-runs your handler, so it stays small (`CDKD_CR_AUTHZ_MAX_RETRIES`, default 2, clamped to 10). A pre-delivery THROW reached no handler at all, so it gets the same 26 retries over 47.75s the outer schedule gives every other resource type — which is the whole point, since the propagation window this covers is measured in seconds and 0.75s of coverage would not have closed the reported failure. `CDKD_CR_AUTHZ_MAX_RETRIES=0` therefore disables re-invocations of your handler only; it does not disable the pre-delivery retry or the response-placeholder `PutObject` retry, neither of which can reach a handler. A throw that lands AFTER the invoke was accepted is never replayed regardless of its wording — the handler is running and will write to that attempt's response URL — so a `Custom::*` failure can still be genuinely single-shot; the readiness waiters are likewise never replayed — they have already polled `lambda:GetFunction` for their own 600s — so a permanent denial there surfaces after one waiter timeout rather than three. `AWS::CloudFormation::Stack` is unchanged and has no internal retry.

  The seconds count PROPAGATION backoff only, so an interleaved throttle's own wait is excluded — the figure is meant to be compared against the 47.75s budget, not read as total elapsed time.

  Add `--verbose` to see each attempt with its running total (`attempt 15/26, 25.75s backoff through this attempt`), which is what turns "it failed" into a measurement.

CC API polling uses its own `1s->2s->4s->8s->10s cap` schedule. If rate limit errors persist, consider reducing parallelism or staggering deployments.

**2. Use SDK Provider**

Implement provider that uses SDK directly instead of Cloud Control API.

---

## Orphaned Resources

### Overview

Orphaned resources are AWS resources that exist in your account but are not tracked in cdkd's state file. This can happen when a deployment fails partway through — some resources may have been successfully created while others failed in flight.

### How cdkd Prevents Orphans

cdkd uses a multi-layered approach to prevent orphaned resources:

1. **Per-resource in-memory state update**: Each resource updates the in-memory state (`newResources`) immediately upon successful provisioning.

2. **Per-resource partial state save**: After each successful resource provision, state is persisted to S3 (serialized via a save chain to avoid ETag conflicts). This prevents orphans if the process crashes mid-deploy.

3. **Pre-rollback state save**: If any resource fails, cdkd saves the current in-memory state (including all successfully provisioned resources up to that point) to S3 **before** attempting rollback. This ensures that resources completed concurrently with the failed one are still tracked.

4. **Post-rollback state save**: After rollback completes (or is skipped with `--no-rollback`), state is saved again to reflect the rolled-back resource state.

5. **Rollback journal**: On a `--no-rollback` failure, a Ctrl+C interruption, or before an automatic rollback, cdkd writes a `rollback-journal.json` sibling of `state.json` recording exactly which operations completed. This is what lets the standalone `cdkd rollback` command revert the deploy later (see below). The journal is deleted on the next successful deploy and by `cdkd destroy`. After a **clean automatic rollback** it is settled to a failed-only segment instead of deleted: the completed ops are already reverted, but the failed resource's pre-op record is kept so `cdkd rollback --revert-failed` can still revert a possibly-half-applied resource; the next successful deploy clears it.

### Issue: `DistributionAlreadyExists` on a CloudFront deploy, and a distribution you did not ask for

cdkd retries a `CreateDistribution` that answered HTTP 500 / 502 / 504, because
those are usually transient. Some of them are not: the request can SUCCEED
server-side and lose only the response. `CallerReference` is CloudFront's
idempotency key, so cdkd sends a value that is stable across every attempt of
one logical create —
the replay is then REFUSED by CloudFront rather than quietly creating a second
distribution that no state file knows about and that `cdkd destroy` can never
reach.

The deploy therefore fails, and **the first attempt's distribution is still
live**. That is deliberate: a loud failure with an orphan you can find beats a
green deploy with an orphan you cannot. CloudFront gives no way to adopt it —
`ListDistributions` returns `Comment` but not `CallerReference`, and
`GetDistribution` needs the `Id` the lost response was carrying — so the cleanup
is manual:

```bash
# List every distribution with its origins, and find yours by origin domain or
# Comment. Do NOT filter with `contains(Origins.Items[0].DomainName, ...)` --
# JMESPath raises a TypeError on any distribution that has no origins, so one
# unrelated distribution in the account breaks the whole query.
aws cloudfront list-distributions \
  --query "DistributionList.Items[].{Id:Id,Status:Status,Enabled:Enabled,Domain:DomainName,Origins:Origins.Items[].DomainName,Comment:Comment}"

# Deleting one requires disabling it first, then waiting for the disable to
# propagate (typically ~15 min) before the delete is accepted.
aws cloudfront get-distribution-config --id <ID>    # note the ETag
# ... set Enabled=false in the config, then:
aws cloudfront update-distribution --id <ID> --if-match <ETag> --distribution-config file://disabled.json
aws cloudfront wait distribution-deployed --id <ID>
aws cloudfront delete-distribution --id <ID> --if-match <NewETag>
```

Then re-run `cdkd deploy`. The next run derives a fresh caller reference, so it
will not collide with the deleted one.

### Issue: an ACM certificate deploy fails with "did not reach ISSUED status"

```
ACM certificate SiteCert (arn:aws:acm:us-east-1:123456789012:certificate/...) did not reach
ISSUED status within 600s.
```

A DNS-validated certificate only reaches `ISSUED` once its validation records
are live in your DNS zone. On a first deploy those records usually do not exist
yet — cdkd prints them on its first `PENDING_VALIDATION` poll — so the wait runs
out. This is a real failure, not a cosmetic one: anything downstream
(CloudFront, an ALB listener) cannot use a certificate that has not issued.

**The certificate is not orphaned.** cdkd deletes the certificate it requested
before the error is reported, so a failed deploy leaves
nothing behind and repeated attempts do not accumulate certificates in your
account. Before this, each failed attempt left one that nothing tracked.

Add the printed CNAME records to your DNS zone, then re-run the deploy:

```bash
cdkd deploy <stack>
```

**Adding those records is not wasted work**, even though the certificate they
were printed for is gone: ACM derives a domain's validation CNAME from the
domain and the account rather than from the certificate, and documents that you
can [replace a deleted certificate](https://docs.aws.amazon.com/acm/latest/userguide/dns-validation.html)
without repeating validation. The records you added validate the next attempt's
certificate.

Two ways to change what the deploy does about the wait:

```bash
# Wait LONGER. This is the provider's OWN cap -- 60 polls x 10s = 10 minutes --
# and it is what fires, so raising it is what makes cdkd wait longer.
CDKD_ACM_POLL_ATTEMPTS=180 cdkd deploy <stack>          # 30 minutes

# Do not wait at all. The certificate is created, RECORDED IN STATE, and the
# deploy returns immediately -- downstream consumers will fail until it issues,
# but the certificate survives for you to validate out of band. This is the
# supported way to keep a PENDING_VALIDATION certificate across runs.
CDKD_NO_WAIT=true cdkd deploy <stack>
```

**`--resource-timeout` cannot make this wait longer**, which is the opposite of
the intuition. It is the engine's per-resource deadline (30 minutes by default)
wrapped AROUND the provider, so it can only cut the 10-minute poll cap short —
`--resource-timeout AWS::CertificateManager::Certificate=45m` changes nothing.
Setting it BELOW the cap is worth avoiding for a second reason: the deadline
abandons the create from outside rather than cancelling it, so the cleanup that
retires the certificate may run after the deploy has already reported failure,
or not at all if the process exits first.

If the message also says the certificate **could NOT be deleted**, the cleanup
itself failed (a throttle, a permissions gap). The message names the ARN and
the exact command; cdkd is not tracking that certificate, so `cdkd destroy`
will not remove it:

```bash
aws acm delete-certificate --certificate-arn <arn> --region <region>
```

### Reverting a failed `--no-rollback` / interrupted deploy: `cdkd rollback`

After a deploy fails with `--no-rollback`, is interrupted with Ctrl+C, or its
automatic rollback dies partway, you have three options: fix forward
(`cdkd deploy` again), revert (`cdkd rollback`), or clean up (`cdkd destroy`).

```bash
cdkd rollback MyStack        # revert to the pre-deploy state
cdkd rollback MyStack --force # skip the confirmation prompt
```

- **Exit `2`** means the rollback was partial — one or more ops failed
  best-effort or were skipped with a warning (e.g. a resource whose physical
  id changed after a later fix-forward attempt, or an unrecoverable DELETE).
  The rollback journal is **kept** so you can re-run `cdkd rollback` — replay
  is idempotent (already-reverted resources are skipped).
- Use `--orphan <logicalId>` (repeatable) to leave a specific resource alone
  during the revert (mirrors `cdk rollback --orphan`).
- **Secret dynamic references need live access at rollback time.** A resource
  whose properties use `{{resolve:secretsmanager:...}}` — or
  `{{resolve:ssm:...}}` pointing at a `SecureString` parameter — stores the
  unresolved expression (never the plaintext) in state and the journal, so
  reverting it re-resolves the reference against Secrets Manager / SSM during
  the rollback. If that secret has since been deleted or your credentials can no
  longer read it, that resource's revert fails (exit `2`, journal kept) —
  restore access to the secret and re-run `cdkd rollback`, or `--orphan` the
  resource to skip it.
- If `cdkd rollback` reports "nothing to roll back", the journal is already
  gone — the deploy either succeeded on a later attempt (journal deleted on
  success) or the process was killed before the journal was written (a
  SIGKILL before the PUT). In the latter case use `cdkd deploy` to resume or
  `cdkd destroy` to clean up.
- See [docs/cli-rollback.md](cli-rollback.md#cdkd-rollback-revert-a-failed-deploy) for the full flag
  reference and known limitations.

### Issue: destroy reports `N skipped` and exits 2

```text
⚠ MyGlueTable (AWS::Glue::Table) skipped (malformed physicalId in state — no delete issued)
⚠ Stack MyStack partially destroyed (4 deleted, 1 skipped, 0 errors). cdkd could not address the skipped resource(s) ...
```

**Cause**: the state record's `physicalId` does not decode. A handful of
resource types need more than one value to address the resource, so cdkd packs
them into one string joined by `|` (`<databaseName>|<tableName>` for
`AWS::Glue::Table`, `<apiId>|<typeName>|<fieldName>` for
`AWS::AppSync::Resolver`, ...). If the recorded value has the wrong number of
segments — a hand-edited `state.json`, or a record written by an older binary —
cdkd cannot build the delete call. The per-resource warning names the exact
shape it expected.

**What cdkd did**: nothing. No AWS call was issued for that resource, so it may
still exist and still be billing. cdkd deliberately does NOT count it as
deleted and does NOT drop its state record — without the record you would have
neither the resource deleted nor an id to go and delete it with. `state.json` is
preserved and the command exits `2`.

**Fix**, either way round:

```bash
# 1. Inspect the bad record
cdkd state show MyStack

# 2a. Repair the physicalId to the shape the warning named, then re-run
aws s3 cp s3://cdkd-state-{account}/cdkd/MyStack/{region}/state.json .
#    ...edit "physicalId": "mydb|mytable"...
aws s3 cp state.json s3://cdkd-state-{account}/cdkd/MyStack/{region}/state.json
cdkd destroy MyStack

# 2b. OR delete the AWS resource by hand and drop the state record
aws glue delete-table --database-name mydb --name mytable
cdkd state orphan MyStack   # removes state only, never AWS resources
```

Do not "fix" this by re-running with the record deleted — that is the orphan
this behavior exists to prevent.

### Detecting Orphaned Resources

If you suspect orphaned resources exist (e.g., due to a process crash before state could be saved), you can manually compare the state file against actual AWS resources:

```bash
# Download state file
aws s3 cp s3://${STATE_BUCKET}/cdkd/MyStack/us-east-1/state.json /tmp/state.json

# List resources tracked in state
cat /tmp/state.json | jq '.resources | keys[]'

# Compare against actual AWS resources using Cloud Control API
aws cloudcontrol list-resources --type-name AWS::S3::Bucket
aws cloudcontrol list-resources --type-name AWS::Lambda::Function
```

### Future: `cdkd orphans` Command

A dedicated `cdkd orphans` (or `cdkd check`) command is planned to automate orphan detection. The approach:

1. **Read the state file** for the target stack to get all tracked resources and their physical IDs.
2. **Read the synthesized template** to get all expected resource types and logical IDs.
3. **Query AWS** for each resource type in the template using Cloud Control API `GetResource` with the expected physical ID pattern, or by listing resources and matching tags/naming conventions.
4. **Compare**: Resources that exist in AWS but are not in the state file are potential orphans. Resources in the state file but not in AWS indicate state drift.
5. **Report**: Display a table of orphaned/drifted resources with recommended actions (import to state, delete from AWS, or remove from state).

Example planned interface:

```bash
# Check for orphaned resources
cdkd orphans MyStack

# Example output:
# Orphaned Resources (exist in AWS but not in state):
#   AWS::IAM::Role    my-stack-role-abc123    (likely from failed deploy on 2026-03-25)
#   AWS::S3::Bucket   my-stack-bucket-xyz     (likely from failed deploy on 2026-03-25)
#
# Recommended: Run 'cdkd deploy MyStack' to reconcile, or delete manually.
```

### Recovering from Orphaned Resources

**If state was saved (most cases)**:

Running `cdkd deploy` again will reconcile the state — existing resources will be detected as already created and handled as updates or no-ops.

**If state was NOT saved (rare — process crash)**:

```bash
# Option 1: Delete state and redeploy (resources will error on CREATE if they exist)
aws s3 rm s3://${STATE_BUCKET}/cdkd/MyStack/us-east-1/state.json
cdkd deploy MyStack  # May need manual cleanup of duplicates

# Option 2: Manually reconstruct state
aws s3 cp s3://${STATE_BUCKET}/cdkd/MyStack/us-east-1/state.json /tmp/state.json
# Add entries for orphaned resources with their physical IDs
vim /tmp/state.json
aws s3 cp /tmp/state.json s3://${STATE_BUCKET}/cdkd/MyStack/us-east-1/state.json

# Option 3: Destroy everything and start fresh
# Manually delete orphaned resources first, then:
cdkd destroy MyStack --force
cdkd deploy MyStack
```

### Known Leftover: FSx Final Backups

A successful `cdkd destroy` of an `AWS::FSx::FileSystem` can leave a
chargeable final backup behind: cdkd keeps CloudFormation parity and calls
`DeleteFileSystem` with API defaults, which take a final backup for
Windows/ONTAP (observed on OpenZFS too). The backup is typically untagged, so
find it via the backup's persisted `FileSystem.FileSystemId` rather than tags.
See [supported-resources.md, "FSx final backup on destroy"](supported-resources.md#fsx-final-backup-on-destroy)
for the details and the `aws fsx describe-backups` / `aws fsx delete-backup`
commands.

---

## Debugging Methods

### Adjust Log Level

```bash
# Enable verbose logging
node dist/cli.js deploy --app "..." --verbose

# Set log level with environment variable
export LOG_LEVEL=debug
node dist/cli.js deploy --app "..."
```

### Check State File

```bash
# Download state file
aws s3 cp s3://${STATE_BUCKET}/cdkd/MyStack/us-east-1/state.json /tmp/state.json

# Format and display
cat /tmp/state.json | jq .

# Check specific resource
cat /tmp/state.json | jq '.resources.MyBucket'
```

### Check API Calls with AWS CloudTrail

```bash
# Check recent events in CloudTrail
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=CreateBucket \
  --max-results 10
```

### Check Execution Plan with Dry Run

```bash
# Show plan only without actual execution
node dist/cli.js deploy --app "..." --state-bucket ${STATE_BUCKET} --dry-run
```

---

## Previously Known Destroy Issues (All Resolved)

### CloudFront OAI DELETE

Resolved via dedicated SDK Provider (`cloudfront-oai-provider.ts`).

### Bedrock AgentCore Runtime IAM Propagation

Resolved via dedicated SDK Provider (`agentcore-runtime-provider.ts`).

### Lambda Permission "No policy found"

Handled automatically by cdkd's idempotent delete logic (not-found errors treated as success).

---

## Frequently Asked Questions (FAQ)

### Q: Is a CloudFormation stack created?

A: No, cdkd does not use CloudFormation. Resources are provisioned directly via Cloud Control API and AWS SDK.

### Q: Can I use CloudFormation and cdkd for the same stack?

A: No. Stacks deployed with CloudFormation should be managed with `cdk deploy` or `aws cloudformation`, and stacks deployed with cdkd should be managed with `cdkd`.

### Q: What happens if I delete the state file?

A: On next deployment, all resources will be treated as CREATE. If existing resources exist, errors will occur, so manual deletion is required beforehand.

### Q: Is there a rollback feature?

A: Yes. By default, cdkd rolls back on failure. Use `--no-rollback` to skip rollback and keep partial state (Terraform-style). On next execution, remaining changes are applied as diff. To revert a `--no-rollback` (or interrupted) deploy back to its pre-deploy state instead of fixing forward, run the standalone `cdkd rollback <stack>` command — it replays a rollback journal cdkd persisted at failure time, with no synth needed.

### Q: Are custom resources supported?

A: Yes, Lambda-backed custom resources (`Custom::*`) are supported.

---

## Support

### Issue Reporting

Report on GitHub Issues:
https://github.com/YOUR_REPO/cdkd/issues

### Questions

Ask questions on GitHub Discussions:
https://github.com/YOUR_REPO/cdkd/discussions

### Documentation

- [architecture.md](./architecture.md) - Overall architecture
- [state-management.md](./state-management.md) - State management details
- [provider-development.md](./provider-development.md) - Provider implementation methods
