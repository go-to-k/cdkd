---
title: Troubleshooting
description: "Common cdkd issues and their solutions — lock problems, state management, deploy failures, and debugging tips."
---

# cdkd Troubleshooting Guide

This document summarizes common issues when using cdkd and their solutions.

## Contents

- [Lock Issues](#lock-issues)
  - ["Failed to acquire lock" Error](#failed-to-acquire-lock-error)
  - [Stale lock after a cancelled CI job](#stale-lock-after-a-cancelled-ci-job)
- [State Management Issues](#state-management-issues)
  - ["State has been modified by another process"](#state-has-been-modified-by-another-process)
  - [State File is Corrupted](#state-file-is-corrupted)
  - [State and Resources Don't Match](#state-and-resources-don-t-match)
  - [Cross-region state bucket ("is in a different region", `PermanentRedirect`)](#cross-region-state-bucket-is-in-a-different-region-permanentredirect)
- [Deployment Errors](#deployment-errors)
  - ["The following resources declare mutually exclusive properties"](#the-following-resources-declare-mutually-exclusive-properties)
  - ["Resource already exists" Error](#resource-already-exists-error)
  - [An unsupported resource type](#an-unsupported-resource-type)
  - [Replacing a resource, and the refusal that guards it](#replacing-a-resource-and-the-refusal-that-guards-it)
  - ["bucket is not empty" / "still contains images" on destroy](#bucket-is-not-empty-still-contains-images-on-destroy)
  - ["has DeletionPolicy: Snapshot, but ..." refusal on delete](#has-deletionpolicy-snapshot-but-refusal-on-delete)
  - ["OpenTableFormatInput.IcebergInput.IcebergTableInput cannot be deployed" on a Glue table](#opentableformatinput-iceberginput-icebergtableinput-cannot-be-deployed-on-a-glue-table)
  - [deleting a Cognito `Policies` sub-key changes nothing on the pool](#deleting-a-cognito-policies-sub-key-changes-nothing-on-the-pool)
- [Asset Publishing Issues](#asset-publishing-issues)
  - ["Asset publishing failed"](#asset-publishing-failed)
  - [Lambda Deployment Fails](#lambda-deployment-fails)
- [Intrinsic Function Issues](#intrinsic-function-issues)
  - ["Unresolved intrinsic function" Error](#unresolved-intrinsic-function-error)
  - [STS cannot report the account, and pseudo parameters fall back](#sts-cannot-report-the-account-and-pseudo-parameters-fall-back)
- [Permission Errors](#permission-errors)
  - ["Access Denied" Error](#access-denied-error)
  - ["not authorized to perform: sts:AssumeRole"](#not-authorized-to-perform-sts-assumerole)
  - ["The state machine IAM Role is not authorized to access the Log Destination"](#the-state-machine-iam-role-is-not-authorized-to-access-the-log-destination)
- [Proxy / Corporate Network](#proxy-corporate-network)
  - ["self-signed certificate in certificate chain" on the very first command](#self-signed-certificate-in-certificate-chain-on-the-very-first-command)
  - [Variables cdkd honours](#variables-cdkd-honours)
  - [`NO_PROXY` matching is EXACT, unlike curl](#no-proxy-matching-is-exact-unlike-curl)
  - [A TLS-terminating proxy still needs `NODE_EXTRA_CA_CERTS`](#a-tls-terminating-proxy-still-needs-node-extra-ca-certs)
  - [The Docker daemon has its own egress](#the-docker-daemon-has-its-own-egress)
  - [Verifying that traffic is routed](#verifying-that-traffic-is-routed)
- [Performance Issues](#performance-issues)
  - [Deployment is Slow](#deployment-is-slow)
  - [A property you set in the template never reaches AWS](#a-property-you-set-in-the-template-never-reaches-aws)
  - [`cdkd diff` shows `[returning to SDK provider]`](#cdkd-diff-shows-returning-to-sdk-provider)
  - [Cloud Control API Rate Limit](#cloud-control-api-rate-limit)
  - [A name is still held by the resource you just deleted](#a-name-is-still-held-by-the-resource-you-just-deleted)
- [Orphaned Resources](#orphaned-resources)
  - [Overview](#overview)
  - [How cdkd Prevents Orphans](#how-cdkd-prevents-orphans)
  - [`DistributionAlreadyExists` on a CloudFront deploy, and a distribution you did not ask for](#distributionalreadyexists-on-a-cloudfront-deploy-and-a-distribution-you-did-not-ask-for)
  - [an ACM certificate deploy fails with "did not reach ISSUED status"](#an-acm-certificate-deploy-fails-with-did-not-reach-issued-status)
  - [Reverting a failed `--no-rollback` / interrupted deploy: `cdkd rollback`](#reverting-a-failed-no-rollback-interrupted-deploy-cdkd-rollback)
  - [destroy reports `N skipped` and exits 2](#destroy-reports-n-skipped-and-exits-2)
  - [Detecting Orphaned Resources](#detecting-orphaned-resources)
  - [Recovering from Orphaned Resources](#recovering-from-orphaned-resources)
  - [Known Leftover: EFS Automatic Backups](#known-leftover-efs-automatic-backups)
  - [Known Leftover: FSx Final Backups](#known-leftover-fsx-final-backups)
- [Debugging Methods](#debugging-methods)
  - [Adjust Log Level](#adjust-log-level)
  - [Check State File](#check-state-file)
  - [Check API Calls with AWS CloudTrail](#check-api-calls-with-aws-cloudtrail)
  - [Check Execution Plan with Dry Run](#check-execution-plan-with-dry-run)
- [Frequently Asked Questions (FAQ)](#frequently-asked-questions-faq)
  - [Q: Is a CloudFormation stack created?](#q-is-a-cloudformation-stack-created)
  - [Q: Can I use CloudFormation and cdkd for the same stack?](#q-can-i-use-cloudformation-and-cdkd-for-the-same-stack)
  - [Q: What happens if I delete the state file?](#q-what-happens-if-i-delete-the-state-file)
  - [Q: Is there a rollback feature?](#q-is-there-a-rollback-feature)
  - [Q: Are custom resources supported?](#q-are-custom-resources-supported)
- [Getting help](#getting-help)
- [Related](#related)
## Lock Issues

### "Failed to acquire lock" Error

**Symptoms:**

```
LockError: Failed to acquire lock for stack 'MyStack' (us-east-1) after 4 attempts. Locked by: alice@host-1:12345, operation: deploy, expires in: 4m12s. If you are certain no other process is active, run: cdkd force-unlock MyStack --stack-region us-east-1
```

**Causes:**

- Another process is deploying the same stack
- Previous process crashed and lock remains

> **A lock is only reclaimed once its holder stops renewing it.** The holding
> process re-writes the lock's `expiresAt` **every 2 minutes** while it runs, so
> the 30-minute TTL measures **silence, not duration** — it tolerates fourteen
> consecutive missed renewals before it lapses. A long deploy does not lose its
> lock partway through, and conversely a lock you find expired really does
> belong to a process that is gone. If a lock is not expiring, the process
> holding it is alive.

> **Note:** The message above is what `cdkd deploy` prints — it **retries** a
> held lock 3 times at 2-second intervals (4 attempts, about 6 seconds) before
> giving up. `cdkd rollback` and `cdkd scrub` retry on the same schedule. The
> commands that WRITE state without deploying — `cdkd destroy`,
> `cdkd state destroy`, `cdkd import`, `cdkd export`, `cdkd orphan`,
> `cdkd drift --accept`, `cdkd drift --revert` and
> `cdkd state refresh-observed` — instead **fail fast** on contention (except
> `cdkd export`'s nested-stack children, which retry 6 times at 5-second
> intervals, a ceiling of about 30 seconds) with a different message, and do
> **not** proceed while another process holds the lock:
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

> **Note:** Nested-stack children are locked separately. A child teardown
> reached from `cdkd deploy` (because the template no longer declares the
> child) or from `cdkd rollback` fails fast on the **child's** lock, even
> though the parent's lock was acquired with retry.
>
> `cdkd orphan` and `cdkd state orphan` are different commands, not two
> spellings of one: `cdkd orphan <paths...>` drops individual resources by
> construct path and fails fast on the lock, while
> `cdkd state orphan <stacks...>` drops whole stack records and takes no lock
> of its own — it refuses while one is held, and `--force` makes it delete
> that lock, including a live one.

> **Note:** A first `Ctrl-C` during `cdkd destroy` / `cdkd state destroy` no
> longer strands the lock — the graceful-SIGINT handler finishes any in-flight
> delete, flushes the incremental state, and **releases the lock** before
> exiting non-zero. A re-run resumes immediately without waiting out the lock
> TTL. `cdkd deploy` behaves the same way on a first `Ctrl-C`: in-flight
> operations finish, partial state is saved, a rollback journal is recorded,
> and the lock is released before the non-zero exit.
>
> A **second** `Ctrl-C` force-quits immediately (`exit 130`) without waiting
> for the in-flight operation, and what it does about the lock differs by
> command.
>
> `cdkd destroy` / `cdkd state destroy` fire a **best-effort** (un-awaited)
> lock release and print the recovery command to stderr:
>
> ```text
> Force-quit: stack lock may not be released. If the next run reports a lock, run: cdkd force-unlock MyStack --stack-region us-east-1
> ```
>
> `cdkd deploy` prints its own plural form and does **not** attempt a release,
> because a deploy may hold locks on several stacks:
>
> ```text
> Force-quit: stack locks may not be released. If the next run reports a lock, run this for EACH stack it names (the region-qualified form — see the message that run prints): cdkd force-unlock <stackName> --stack-region <region>
> ```
>
> **`cdkd rollback` has no second-signal path**: further `Ctrl-C`s are absorbed
> by its graceful handler, so it cannot be force-quit this way. Stop it with
> `SIGKILL` if you must, and expect to clear the lock afterwards.
>
> Run the command as printed — the `--stack-region` it carries is what decides
> which lock is cleared. After a destroy force-quit the best-effort release
> usually lands, so most leave no lock; after a deploy force-quit, expect one.
> A leftover lock therefore means an ungraceful kill (`SIGKILL`, a force-quit
> whose best-effort release did not complete, or a crash).

**Solutions:**

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
#   "expiresAt": 1710837000000,
#   "operation": "deploy"
# }
```

`expiresAt` is the field everything keys on — the expiry check, the `expires
in:` clause of the error above, and the renewal loop. It is `timestamp` plus
the 30-minute TTL, rewritten every 2 minutes while the holder runs.
`operation` is the only optional field. A truncated `lock.json` with no
`expiresAt` is treated as **expired**.

**2. Force release if lock is old**

```bash
cdkd force-unlock MyStack --stack-region us-east-1
```

Prefer this to deleting `lock.json` by hand: it resolves the same state
bucket the deploy would, and it purges the key's noncurrent versions rather
than leaving a delete marker over them.

> **The retry count, the retry delay and the lock TTL are not configurable** —
> there is no flag, environment variable or `cdk.json` setting for any of them.
> If a lock is genuinely stale, clear it with `cdkd force-unlock`; if it is
> not, the holder is alive and waiting is the correct behaviour.

### Stale lock after a cancelled CI job

**Symptoms:**

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

**Causes:**

Cancellation is not a clean `Ctrl-C`. GitHub Actions escalates
`SIGINT` → `SIGTERM` (~7.5 s later) → `SIGKILL` (~2.5 s after that); other CI
systems (GitLab CI, `docker stop`, Kubernetes) typically send `SIGTERM`
directly. cdkd's `deploy` / `destroy` / `state destroy` / `rollback` commands
handle **both `SIGINT` and `SIGTERM`** gracefully: the first signal
finishes in-flight operations, saves state, and releases the lock. What a
second signal does varies by command (see the note above). But `SIGKILL` cannot be
handled by any process — under GitHub Actions the whole escalation completes
in ~10 seconds, so a job whose in-flight AWS operation takes longer than
that is still killed before the lock-release cleanup finishes, stranding the
lock. SIGTERM-only environments with a longer grace period (Kubernetes
defaults to 30 s; `docker stop` to 10 s) give the graceful path a better
chance to complete.

**Solutions:**

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

### "State has been modified by another process"

**Symptoms:**

```
StateError: State has been modified by another process. Expected ETag: "abc123", but state has changed.
```

**Causes:**

- Two processes attempted to deploy simultaneously
- Lock was acquired but conflict occurred when saving state

**Solutions:**

**1. Re-run the command**

The write is guarded by an S3 precondition on the ETag cdkd read, so a
conflicting write is refused rather than silently overwriting. **cdkd does not
retry the save itself** — the conflict always surfaces as a failed command, and
the re-run is deliberately yours to make, because it re-reads state and plans
against whatever the other writer left:

```bash
cdkd deploy --app "..." --state-bucket ${STATE_BUCKET}
```

**2. If it recurs, find the other writer**

A second conflict means a second process really is writing this stack. Read
the lock rather than re-running in a loop — it names the owner and the
operation:

```bash
aws s3api get-object \
  --bucket ${STATE_BUCKET} \
  --key cdkd/MyStack/us-east-1/lock.json \
  /dev/stdout
```

Note this is not the lock TTL's doing: the lock excludes other cdkd
*processes*, while this error is the ETag precondition on `state.json`. Waiting
for a lock to expire does not affect it.

### State File is Corrupted

**Symptoms:**

```
StateError: State file for stack 'MyStack' is not valid JSON: Unexpected token } in JSON at position 123
Caused by: Unexpected token } in JSON at position 123
```

A sibling refusal names a schema version this binary cannot read, which is a
different problem with a different fix — upgrade cdkd rather than restoring a
backup:

```
StateError: Unsupported state schema version 12 for stack 'MyStack'. This cdkd binary supports versions 1, 2, 3, 4, 5, 6, 7, 8, 9. Upgrade cdkd to a version that supports schema 12.
```

**Causes:**

- S3 upload was interrupted
- JSON error during manual editing

**Solutions:**

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

**2. Rebuild state from the live resources**

If no usable version survives, adopt the resources back rather than deleting
the state and redeploying — the resources still exist, and `cdkd import`
records them without touching AWS:

```bash
aws s3 rm s3://${STATE_BUCKET}/cdkd/MyStack/us-east-1/state.json
cdkd import MyStack --dry-run
cdkd import MyStack
```

### State and Resources Don't Match

**Symptoms:**

- Manually deleted/modified resources in AWS Console
- cdkd tries to update non-existent resources

**Causes:**

cdkd's state file and actual AWS resources have diverged.

**Solutions:**

**1. See what cdkd thinks it has**

```bash
cdkd state resources MyStack          # LogicalID, Type, PhysicalID
cdkd state resources MyStack --long   # plus dependencies and attributes
```

**2. Drop the records for resources that no longer exist**

`cdkd state orphan` removes state only and never touches AWS, so it is the
right tool when the resource is already gone:

```bash
cdkd state orphan MyStack --stack-region us-east-1   # whole stack record
cdkd orphan MyStack/MyTable                          # one resource, by construct path
```

`cdkd orphan` is synth-driven and takes construct paths (repeatable, all
referencing the same stack); `cdkd state orphan` needs no CDK app and takes
stack names. Both accept `--dry-run`.

The next `cdkd deploy` then plans those resources as CREATE.

**3. Re-adopt resources that exist but are missing from state**

```bash
cdkd import MyStack --dry-run   # preview; writes no state
cdkd import MyStack
```

See [Importing Existing Resources](import.md) for the full flag set.

**4. Start over, through cdkd rather than by hand**

```bash
cdkd state destroy MyStack --yes   # deletes the AWS resources AND the state
cdkd deploy --app "..." --state-bucket ${STATE_BUCKET}
```

> **Do not delete `state.json` and redeploy.** It is not a reset — what happens
> next depends on the resource type and none of the outcomes are what you
> wanted. See
> [Recovering from Orphaned Resources](#recovering-from-orphaned-resources).

---

### Cross-region state bucket ("is in a different region", `PermanentRedirect`)

**Symptoms:**

```
StateError: Failed to verify state bucket 'my-bucket': Bucket 'my-bucket' (in ap-northeast-1) is in a different region than the client. cdkd resolves this automatically; if you see this message, please report it.
```

cdkd rewrites the AWS SDK's synthetic `UnknownError` into a sentence keyed on
the HTTP status, so the state-bucket path names the region rather than the
placeholder. The lock path does not rewrite, and surfaces the raw 301 instead:

```
LockError: Failed to acquire lock for stack 'MyStack' (ap-northeast-1):
The bucket you are attempting to access must be addressed using the
specified endpoint. Please send all future requests to this endpoint.
```

**Cause:**

The state bucket lives in a region different from the one the AWS SDK
client was constructed for. AWS SDK v3's region-redirect middleware does
not handle the empty-body 301 HEAD response S3 returns in this case
cleanly — the protocol parser falls through and produces a synthetic
`Unknown` exception with the literal message `UnknownError`.

**Solution:**

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

### "The following resources declare mutually exclusive properties"

**Symptoms:**

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

**Causes:**

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

**Solutions:**

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

### "Resource already exists" Error

**Symptoms:**

A name-collision failure surfaces as the AWS error, wrapped twice — once by
the provider and once by the deploy engine:

```
ProvisioningError: Failed to create resource MyBucket
Caused by: The requested bucket name is not available. The bucket namespace is shared by all users of the system. Please select a different name and try again.
```

The wording of the `Caused by:` line is the service's, so it differs per type:
IAM raises `EntityAlreadyExists`, DynamoDB `ResourceInUseException`, and so on.

**Not every type fails here.** Three behave differently, and knowing which
matters before you reach for a fix:

| Behaviour | Types | What you see |
| --- | --- | --- |
| Fails the create | IAM roles/users/groups, DynamoDB tables, Lambda functions, SQS queues, ELBv2 load balancers | the error above |
| Adopts the existing resource | `AWS::S3::Bucket`, `AWS::Logs::LogGroup`, `AWS::SNS::Topic` | a successful deploy that re-applies your configuration to the resource that was already there |
| Creates a second resource | types AWS assigns an opaque id to — VPC, EC2 instance, ACM certificate, CloudFront distribution | a successful deploy, and an orphan nothing tracks |

An S3 bucket you own in a **different region** is refused rather than adopted,
because owning a globally-unique name never implies the bucket is in this
stack's region.

**Causes:**

- Resource with same name already exists
- Previous deployment failed midway and state was not saved

**Solutions:**

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

**3. Adopt the existing resource into state**

```bash
cdkd import MyStack --resource MyBucket=my-bucket-name
```

See [Importing Existing Resources](import.md) for the full flag set.

### An unsupported resource type

**Symptoms:**

Usually at pre-flight, before anything is touched — and the message already
carries a pre-filled link for requesting the type:

```
The following resource types are not supported by cdkd:
  - AWS::AppMesh::Mesh
      AWS reports this type as NON_PROVISIONABLE (Cloud Control API cannot
      manage it) and cdkd has no SDK provider for it.
      Request support: https://github.com/go-to-k/cdkd/issues/new?title=...

To attempt deployment anyway (Cloud Control will likely fail for
NON_PROVISIONABLE types), re-run with: --allow-unsupported-types AWS::AppMesh::Mesh
```

Or, if the type slipped past pre-flight, at provisioning time:

```
No provider available for resource type: AWS::CustomService::Resource. This
resource type is not supported by Cloud Control API and no SDK provider is
registered.
```

**Causes:**

cdkd provisions a resource through a hand-written SDK provider or, failing
that, the Cloud Control API ([Provisioning Layers](provisioning-layers.md)).
This error means neither is available: AWS reports the type as
`NON_PROVISIONABLE`, or it is on cdkd's Cloud Control blocklist pending a
dedicated provider, or it is not an `AWS::` type at all.

**Solutions:**

**1. Ask for the type**

The pre-flight message includes a link that opens a pre-filled issue for
exactly this type. Use it — that request is what schedules the work.

**2. Unblock the deploy now, if the type is only blocklisted**

```bash
cdkd deploy MyStack --allow-unsupported-types AWS::AppMesh::Mesh
```

This routes the named type through Cloud Control optimistically. It is
per-type, not a blanket flag, so each one is an explicit choice. For a type AWS
reports as `NON_PROVISIONABLE`, Cloud Control cannot manage it either and the
deploy will still fail — the flag does not conjure support. See
[`--allow-unsupported-types`](cli-deploy-safety.md#allow-unsupported-types-deploy-destroy).

**3. Confirm what Cloud Control actually supports**

[Supported resources for Cloud Control API](https://docs.aws.amazon.com/cloudcontrolapi/latest/userguide/supported-resources.html),
and [Supported Resources](supported-resources.md) for cdkd's own per-type
coverage table.

### Replacing a resource, and the refusal that guards it

**cdkd performs replacement itself.** Changing a property AWS cannot update in
place makes cdkd delete the old resource and create the new one, and it says so
as it goes:

```
Replacing MyBucket (AWS::S3::Bucket) - immutable properties changed: BucketName
```

You do not have to do anything to enable that, and there is nothing to
implement.

**Symptoms:**

Two different refusals interrupt it, and they call for opposite responses.

**1. The resource holds data.** cdkd refuses to replace a stateful resource
without an explicit confirmation, because replacement means deleting it:

```
ProvisioningError: Failed to update resource MyBucket
Caused by: MyBucket (AWS::S3::Bucket) requires replacement (immutable property changed: BucketName) but it is a stateful resource — S3 bucket is not provably empty. Re-run with --force-stateful-recreation to confirm the data loss, or change the resource definition to avoid the immutable-property change.
```

Either revert the immutable-property change, or accept the data loss:

```bash
cdkd deploy MyStack --force-stateful-recreation
```

The guard is skipped for a resource carrying `UpdateReplacePolicy: Retain`.

**2. The type has no in-place update path at all**, so any change to it is a
replacement:

```
ResourceUpdateNotSupportedError: AWS::EC2::NatGateway (MyNat) cannot be updated in place: use cdkd deploy with --replace, or change the resource definition to create a new version.
```

The message names the remedy for that specific type; the tail varies per
provider. This exits `2` rather than `1`.

### "bucket is not empty" / "still contains images" on destroy

**Symptoms:**

```text
Failed to delete S3 bucket MyBucket: bucket my-bucket is not empty. Matching
CloudFormation, cdkd does not delete a non-empty bucket unless it opted into
automatic emptying ...
```

An S3 Express directory bucket carries its own prefix and wording:

```text
Failed to delete S3 Express Directory Bucket my-bucket--use1-az4--x-s3: bucket
my-bucket--use1-az4--x-s3 is not empty. Matching CloudFormation, cdkd does not
delete a non-empty directory bucket without an explicit opt-in ...
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
[Destroy flags & guards](cli-destroy.md#destroy-data-guards-non-empty-s3-buckets-and-image-carrying-ecr-repositories) for the full semantics.

### "has DeletionPolicy: Snapshot, but ..." refusal on delete

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
[Destroy flags & guards](cli-destroy.md#deletionpolicy-snapshot-final-snapshots-on-delete-skip-final-snapshot) for the per-type mechanics.

---

### "OpenTableFormatInput.IcebergInput.IcebergTableInput cannot be deployed" on a Glue table

**Symptoms:**

```text
AWS::Glue::Table IcebergTable: OpenTableFormatInput.IcebergInput.IcebergTableInput
cannot be deployed by AWS in any shape, so cdkd refuses it before calling Glue
(issue #1454). ...
```

**Cause:**

cdkd refuses this property on a **template-driven create**, before any AWS
call. Two other paths only WARN, and the difference matters:

- **An UPDATE never refuses.** Adding `IcebergTableInput` to an
  already-deployed table produces a warning and a green deploy — cdkd forwards
  nothing for it, because Glue's update-only shape for this is not wired. The
  property is silently ignored rather than applied.
- **A `cdkd rollback` warns** on both of its paths (the update replay and the
  reverse-replacement re-create), because a rollback replays from cdkd state
  rather than from your template, so refusing there would leave you no remedy
  but hand-editing `state.json`. That matters for tables created by an older
  cdkd build, whose state records still carry the key. See "Glue table Iceberg
  support" in [Supported Resources](supported-resources.md) for what the
  restored table looks like.

The refusal is a
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

### deleting a Cognito `Policies` sub-key changes nothing on the pool

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

### "Asset publishing failed"

**Symptoms:**

A permissions failure on the S3 upload surfaces as the AWS SDK's own error,
because cdkd does not wrap it:

```
AccessDenied: User: arn:aws:iam::123456789012:user/myuser is not authorized to perform: s3:PutObject on resource: "arn:aws:s3:::cdkd-assets-123456789012-us-east-1/abc123.zip"
```

The existence probe that runs before the upload fails with a wrapped message
instead, naming the bucket and key:

```
Error: Failed to check S3 object s3://cdkd-assets-123456789012-us-east-1/abc123.zip: AccessDenied: Access Denied
```

Docker image assets are the ones that raise `AssetError`:

```
AssetError: ECR login failed: <docker output>
AssetError: Docker push failed: <docker output>
```

**Causes:**

- Asset storage doesn't exist for the target: in cdkd-assets mode the
  `cdkd-assets-*` bucket / `cdkd-container-assets-*` repo (someone deleted
  them after bootstrap), in legacy mode the CDK bootstrap bucket
  (`cdk-hnb659fds-assets-*`)
- Insufficient IAM permissions

**Solutions:**

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
the bucket/repo after opt-in.

A deploy stays in **legacy mode** only when the region carries no cdkd
bootstrap marker and the auto-create did not run, or when legacy mode is
pinned with `--use-cdk-bootstrap-assets` / `cdk.json`
`context.cdkd.useCdkBootstrapAssets`. Legacy mode publishes to the
destinations named in the asset manifest — the CDK bootstrap bucket — and
cdkd does not create that bucket. So either opt the region in, or create the
CDK bootstrap stack with the CDK CLI:

```bash
cdkd bootstrap --region us-east-1                     # recommended
npx cdk bootstrap aws://123456789012/us-east-1        # legacy mode only
```

See [`cdkd bootstrap`](cli-bootstrap.md#cdkd-bootstrap).

> **Custom bootstrap**: If you use a custom qualifier (e.g., `--qualifier myqualifier`), CDK synthesis will embed the custom bucket name in the asset manifest. cdkd reads destinations from the manifest (and, in cdkd-assets mode, redirects default-bootstrap-shaped destinations to cdkd-owned storage), so custom qualifiers are fully supported.

**2. Skip asset publishing**

```bash
# Skip during deployment
cdkd deploy --app "..." --skip-assets
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
      "Sid": "FileAssetObjects",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": [
        "arn:aws:s3:::cdkd-assets-123456789012-*/*",
        "arn:aws:s3:::cdk-hnb659fds-assets-123456789012-*/*"
      ]
    },
    {
      "Sid": "FileAssetBucket",
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:GetBucketLocation"],
      "Resource": [
        "arn:aws:s3:::cdkd-assets-123456789012-*",
        "arn:aws:s3:::cdk-hnb659fds-assets-123456789012-*"
      ]
    },
    {
      "Sid": "EcrAuthTokenMustBeStar",
      "Effect": "Allow",
      "Action": "ecr:GetAuthorizationToken",
      "Resource": "*"
    },
    {
      "Sid": "DockerAssetRepo",
      "Effect": "Allow",
      "Action": [
        "ecr:DescribeRepositories",
        "ecr:DescribeImages",
        "ecr:BatchCheckLayerAvailability",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:PutImage"
      ],
      "Resource": [
        "arn:aws:ecr:*:123456789012:repository/cdkd-container-assets-*",
        "arn:aws:ecr:*:123456789012:repository/cdk-hnb659fds-container-assets-*"
      ]
    }
  ]
}
```

Three things about that policy are easy to get wrong:

- **`ecr:GetAuthorizationToken` only works on `Resource: "*"`.** It is
  registry-scoped and cannot be narrowed to a repository ARN.
- **The layer-upload actions are needed even though cdkd makes no SDK call for
  them.** The push is a `docker push` subprocess authenticated with a token
  minted from your credentials, so a policy derived from cdkd's API calls alone
  looks complete and then fails at push time.
- **`s3:ListBucket` on the bucket ARN** (not the `/*` object ARN) is what the
  pre-flight storage probe needs. Omitting it fails the deploy before any
  upload is attempted.

**Creating the storage needs more**, and not only when you run
`cdkd bootstrap`: the first `cdkd deploy` into a region with no cdkd bootstrap
marker **auto-creates** the asset storage, from the deploy identity. So unless
you pass `--no-auto-asset-storage`, the same identity also needs:

```json
{
  "Sid": "CreateAssetStorage",
  "Effect": "Allow",
  "Action": [
    "s3:CreateBucket",
    "s3:PutEncryptionConfiguration",
    "s3:PutBucketPublicAccessBlock",
    "s3:PutBucketPolicy",
    "ecr:CreateRepository",
    "ecr:PutImageTagMutability"
  ],
  "Resource": [
    "arn:aws:s3:::cdkd-assets-123456789012-*",
    "arn:aws:ecr:*:123456789012:repository/cdkd-container-assets-*"
  ]
}
```

Without it the auto-create fails, the deploy falls back to legacy mode with a
warning, and the push then targets a CDK bootstrap bucket that may not exist —
a confusing failure two steps removed from the missing permission. (Asset
buckets are deliberately NOT versioned, so `s3:PutBucketVersioning` is not in
this set; it belongs to the state bucket, which `cdkd bootstrap` creates.)

### Lambda Deployment Fails

**Symptoms:**

```
ProvisioningError: Failed to create resource MyFunction
Caused by: Failed to create Lambda function MyFunction: <the AWS error>
```

**Causes:**

The AWS error on the `Caused by:` line is the diagnosis; the two common ones
are:

- **The asset was never published** — `Error occurred while GetObject. S3 Error
  Code: NoSuchKey.` Reachable when the deploy ran with `--skip-assets`, or the
  asset bucket was emptied.
- **The execution role is not usable yet** — `The role defined for the function
  cannot be assumed by Lambda.` This is IAM propagation, and cdkd **already
  retries it** for about 48 seconds, so seeing it means the retry budget was
  spent. Re-running usually succeeds.

A missing `Code` or `Role` in the template is caught before any AWS call:
`Code is required for Lambda function MyFunction`.

**Solutions:**

**1. Verify asset publishing**

```bash
# Check asset manifest
cat cdk.out/MyStack.assets.json

# Check asset bucket (cdkd-assets mode; use cdk-hnb659fds-assets-... in legacy mode)
aws s3 ls s3://cdkd-assets-${AWS_ACCOUNT_ID}-${AWS_REGION}/
```

**2. Check IAM Role dependencies**

A Lambda function depends on its IAM role, and the edge comes from the
reference — not from the order the constructs appear in:

```typescript
const role = new iam.Role(this, 'LambdaRole', { ... });

const func = new lambda.Function(this, 'MyFunction', {
  role: role,  // ← synthesises to Fn::GetAtt, which is what creates the DAG edge
});
```

---

## Intrinsic Function Issues

### "Unresolved intrinsic function" Error

**Symptoms:**

```
ProvisioningError: Failed to create resource MyResource
Caused by: Unsupported CloudFormation intrinsic function "Fn::ToJsonString": cdkd does not support resolving it yet. Deploying this template would produce a broken value. Please request support by opening an issue: https://github.com/go-to-k/cdkd/issues/new?title=Support%20intrinsic%20Fn%3A%3AToJsonString&labels=intrinsic-support
```

The message names the intrinsic and carries a pre-filled issue link. It
surfaces at provision time rather than at diff time, because `cdkd diff`
resolves best-effort and leaves anything it cannot resolve as-is.

**Causes:**

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
| `Fn::GetStackOutput` | ✅ (cdkd-specific; cross-account via its `RoleArn` argument) |
| `Fn::FindInMap` | ✅ |
| `Fn::GetAZs` | ✅ |
| `Fn::Base64` | ✅ |
| `Fn::Cidr` | ✅ |
| `Fn::Transform` | ✅ |

**Solution:**

If the intrinsic in the error is **not** in the table, cdkd does not implement
it — `Fn::ToJsonString` and `Fn::ForEach` are the two you are most likely to
meet. [Open an issue](https://github.com/go-to-k/cdkd/issues) naming it and the
template shape you used; there is no flag that works around it.

If it **is** in the table, the installed cdkd predates its support. Upgrade:

```bash
npm i -g @go-to-k/cdkd
```

### STS cannot report the account, and pseudo parameters fall back

**Symptoms:**

cdkd resolves `AWS::AccountId` from `sts:GetCallerIdentity`. When that call
fails it warns and continues on a placeholder account id:

```
Failed to get AWS account info from STS: <the AWS error>, using defaults
```

A value CONSTRUCTED from that placeholder — an ARN built by `Fn::GetAtt` —
is refused rather than deployed, because it would be structurally valid while
naming a different account:

```
IntrinsicResolutionRefusalError: Cannot resolve Fn::GetAtt [MyTable, Arn] for AWS::DynamoDB::Table: STS did not report this deploy's account id, so cdkd would build the value from the placeholder account 123456789012 — structurally valid, naming a different account, and indistinguishable downstream from a real one. Fix the AWS credentials (or set AWS_ACCOUNT_ID to this deploy's account) and deploy again.
```

**A bare `Ref: AWS::AccountId` is NOT refused** — it resolves to the
placeholder silently. So a warn with no refusal does not mean the deploy is
fine; it means nothing happened to embed the placeholder in a constructed ARN.
`AWS::StackName` degrades the same way, to `UnknownStack`.

**Causes:**

The credentials are missing, expired, or cannot call `sts:GetCallerIdentity`.

**Solutions:**

Verify AWS credentials are properly configured:

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

### "Access Denied" Error

**Symptoms:**

```
ProvisioningError: Failed to create resource MyBucket
Caused by: User: arn:aws:iam::123456789012:user/myuser is not authorized to perform: s3:CreateBucket on resource: "arn:aws:s3:::my-bucket-name"
```

**Causes:**

IAM user/role lacks required permissions.

**Solutions:**

**1. Grant the two sets of permissions cdkd needs**

They are genuinely two sets, and conflating them is why hand-written policies
for cdkd tend not to work.

**Set A — cdkd's own bookkeeping.** Needed by every deploy, whatever the stack
contains:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CloudControlApi",
      "Effect": "Allow",
      "Action": [
        "cloudformation:CreateResource",
        "cloudformation:UpdateResource",
        "cloudformation:DeleteResource",
        "cloudformation:GetResource",
        "cloudformation:GetResourceRequestStatus",
        "cloudformation:ListResources"
      ],
      "Resource": "*"
    },
    {
      "Sid": "RegistryAndCrossStackReads",
      "Effect": "Allow",
      "Action": [
        "cloudformation:DescribeType",
        "cloudformation:ListExports",
        "cloudformation:DescribeStacks"
      ],
      "Resource": "*"
    },
    {
      "Sid": "Identity",
      "Effect": "Allow",
      "Action": "sts:GetCallerIdentity",
      "Resource": "*"
    },
    {
      "Sid": "StateBucketObjects",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:DeleteObjectVersion"
      ],
      "Resource": "arn:aws:s3:::cdkd-state-123456789012/*"
    },
    {
      "Sid": "StateBucketMetadata",
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket",
        "s3:ListBucketVersions",
        "s3:GetBucketLocation",
        "s3:GetReplicationConfiguration"
      ],
      "Resource": "arn:aws:s3:::cdkd-state-123456789012"
    }
  ]
}
```

> **The Cloud Control API's IAM actions carry the `cloudformation:` prefix**,
> not a `cloudcontrol:` one — there is no such service prefix, so an action
> spelled `cloudcontrol:*` matches nothing and grants nothing. Cloud Control
> supports neither resource-level permissions nor service-specific condition
> keys, so these six must stay on `"Resource": "*"`.

**Set B — the services your template provisions.** This one cannot be listed
here, because it is whatever your stack contains. cdkd calls each service's
API directly — through its own SDK providers, and through the Cloud Control
API, which executes as **you** rather than as a service role. So a template
with a bucket and a queue needs the `s3:` and `sqs:` actions for those
operations on top of Set A. See
[Supported Resources](supported-resources.md) for which layer handles a type.

**Set C — two conditional sets that are easy to miss**, because neither is
implied by the resources in your template:

- **A CDK context lookup** (`Vpc.fromLookup`, `Machineimage.lookup`, a hosted
  zone or AMI lookup) is resolved at SYNTH time and needs its own read
  permissions — typically `ec2:DescribeVpcs` / `DescribeSubnets` /
  `DescribeAvailabilityZones` / `DescribeImages`, `ssm:GetParameter`,
  `route53:ListHostedZonesByName`, `kms:ListAliases`. A denial here fails
  before any provisioning starts.
- **A template declaring a macro** (`Transform` / `Fn::Transform`, e.g. SAM) is
  expanded by CloudFormation through a transient stack, so that deploy also
  needs `cloudformation:CreateChangeSet`, `DescribeChangeSet`, `GetTemplate`
  and `DeleteStack` on `cdkd-macro-expand-*`, plus `lambda:InvokeFunction` on
  your own macro function if it is not an AWS-managed transform.

**Note**: In production, follow the principle of least privilege and grant only necessary permissions.

**Note on `cloudformation:DescribeType`**: cdkd reads the CloudFormation
registry schema for a resource type in three places, so this permission
matters on an ordinary deploy and not only on the Cloud Control path.

It resolves each type's **`createOnlyProperties`**, which is how `cdkd deploy`
and `cdkd diff` decide that a property change forces a replacement. Without
the permission that determination falls back and a replacement can be
misclassified.

It also resolves each type's `writeOnlyProperties` so
that Cloud Control API updates re-include write-only properties in every
patch document (Cloud Control's read-modify-write update would otherwise
drop them — e.g. `AWS::ECS::Service.VolumeConfigurations`). If the
permission is missing, cdkd logs a warning and gracefully falls back to a
minimal patch, so deploys still work — but
write-only properties may be dropped on update for affected resource
types. `cdkd export` also uses `cloudformation:DescribeType` to resolve
primary identifiers (with a hardcoded fallback table) and, from the same
response, to pre-flight resource types CloudFormation cannot IMPORT at
all. Without the permission the export still runs off the fallback
table, but the pre-flight cannot fire — a non-importable type then
surfaces later as `ResourceTypes [<T>] are not supported for Import`
from `CreateChangeSet`, naming only some of the offenders.

**2. `iam:PassRole` for roles your template hands to a service**

Because cdkd calls service APIs directly instead of delegating to a
CloudFormation execution role, the identity running `cdkd deploy` (or the role
given to `--role-arn`) needs `iam:PassRole` for every role the template hands
to a service — Lambda's `Role`, ECS task execution and task roles, CodeBuild
and EMR service roles, Step Functions, Glue, Firehose, EventBridge targets,
RDS monitoring roles, EC2 instance profiles. The Cloud Control fallback needs
it on the same identity, since cdkd never passes Cloud Control a service role
of its own:

```json
{
  "Effect": "Allow",
  "Action": "iam:PassRole",
  "Resource": "arn:aws:iam::123456789012:role/MyLambdaRole"
}
```

### "not authorized to perform: sts:AssumeRole"

**Symptoms:**

```
AccessDenied: User: arn:aws:iam::123456789012:user/myuser is not authorized to perform: sts:AssumeRole on resource: arn:aws:iam::210987654321:role/CdkdDeploy
```

**Causes:**

cdkd assumes a role only when something asked it to, and none of those involve
a CDK bootstrap role:

- **You passed `--role-arn` / set `CDKD_ROLE_ARN`.** cdkd assumes that role for
  every AWS call.
- **A cross-account `Fn::GetStackOutput` supplied a `RoleArn`.** cdkd assumes
  it to read the producer stack's state. That path wraps the AWS error with a
  trust-policy hint rather than surfacing it bare.
- **You passed `--assume-role` to a `cdkd local` command**, which assumes the
  role to give the locally-run function or task its credentials. Pulling a
  container image from ECR for `cdkd local` can assume a role too.

**`cdk-hnb659fds-deploy-role-*` and the other CDK bootstrap roles are not
usable here.** cdkd issues raw service API calls instead of routing through
CloudFormation, so a CDK CLI deploy role does not carry what cdkd needs.
Adding yourself to a bootstrap role's trust policy will not make this error go
away.

The role you name needs the permissions the Set A / Set B / Set C policy above
describes, granted on the assumed role rather than on your own principal —
**not `AdministratorAccess`**. cdkd's own help text calls this
"admin-equivalent" because the union of Set B across an arbitrary template is
unbounded; that is an argument for scoping the role to the services your stacks
actually use, not for attaching a blanket policy.

**Solutions:**

**1. Confirm which role is actually being assumed**

```bash
aws sts get-caller-identity          # who you are before the hop
echo "${CDKD_ROLE_ARN:-<unset>}"     # what cdkd will try to assume
```

**2. Add your principal to that role's trust policy**

On the role named in the error — not on a CDK bootstrap role:

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

For the cross-account `Fn::GetStackOutput` case, the trust policy belongs on
the **producer** account's role and must allow the consumer's principal — see
[Cross-Stack References](cross-stack-references.md).

### "The state machine IAM Role is not authorized to access the Log Destination"

A Step Functions state machine with `LoggingConfiguration` fails to create or
update with:

```text
The state machine IAM Role is not authorized to access the Log Destination
```

AWS emits this same sentence whether the problem is transient or permanent, so
cdkd cannot tell them apart from the message:

| Cause | Fix |
| --- | --- |
| The role's log-delivery grants have not propagated yet | Nothing — cdkd retries this for you |
| The execution role lacks the grants | Add the delivery policy below |
| The account's CloudWatch Logs resource policies are at a quota | See below |

**Missing grants.** The role the state machine runs as needs the vended-logs
delivery actions on `"Resource": "*"` — these actions do not support resource
types, so scoping them to the log group's ARN produces this same error:

```json
{
  "Effect": "Allow",
  "Action": [
    "logs:CreateLogDelivery",
    "logs:GetLogDelivery",
    "logs:UpdateLogDelivery",
    "logs:DeleteLogDelivery",
    "logs:ListLogDeliveries",
    "logs:PutResourcePolicy",
    "logs:DescribeResourcePolicies",
    "logs:DescribeLogGroups"
  ],
  "Resource": "*"
}
```

That is what the CDK Step Functions L2 attaches to the role it CREATES for the
state machine. If you passed your own `role:`, check that it carries them —
a role imported with `mutable: false` has the grant silently dropped, and the
state machine still synthesizes with logging enabled.

AWS's reference policy for this error additionally lists `logs:CreateLogStream`
and `logs:PutLogEvents`, which are for writing log events rather than for the
destination check the eight above satisfy.

**Resource-policy quotas.** Step Functions records log delivery in CloudWatch
Logs resource policies, and two separate quotas apply — a policy document is
limited to 5120 characters, and an account is limited to ten policies per
Region. Either one produces this error. Inspect both dimensions with:

```bash
aws logs describe-resource-policies --region <region>
```

For the size limit, give the log group a name starting with `/aws/vendedlogs/`,
which is covered by one wildcard entry instead of consuming the budget per
group. The name is immutable, so this REPLACES the log group — see the
[stateful-resource guard](cli-deploy-safety.md#stateful-resource-guard) for what
cdkd does with the old one and when it refuses the replacement outright. The
ten-policy quota is account-wide across every service that writes one, so it can
be reached with no Step Functions history at all; AWS documents consolidating
the existing policies for that case.

Editing those documents by hand is not safe by default: there is no per-entry
API, so pruning means rewriting a whole document with
`aws logs put-resource-policy`, and `aws logs delete-resource-policy` removes
one outright — revoking log delivery for every identity in it, not just Step
Functions.

Because the first cause is transient, cdkd retries this message rather than
failing immediately — so on the two permanent causes the deploy appears to hang
for up to ~47.75s before the error surfaces, and the give-up line still carries
AWS's own sentence. The schedule and how to read that line are under
[Cloud Control API Rate Limit](#cloud-control-api-rate-limit), which is where
this page documents the retry behaviour.

---

## Proxy / Corporate Network

### "self-signed certificate in certificate chain" on the very first command

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

Both spellings work, and the lower-case one wins where both are set. Tools
differ here — the AWS CLI prefers the lower-case spelling too, while Go's
`net/http` prefers the upper-case one — so do not rely on the two agreeing. The
proxy is chosen per REQUEST, so `HTTPS_PROXY` and `HTTP_PROXY` may name
different proxies and each scheme goes to its own.

**Always include the scheme.** A scheme-less value inherits the request's, so
`HTTPS_PROXY=proxy.corp:8080` is read as `https://proxy.corp:8080` and cdkd
then speaks TLS *to the proxy* — an error that names neither the variable nor
the missing scheme. Write `HTTPS_PROXY=http://proxy.corp:8080` unless the proxy
genuinely terminates TLS on its own listener; the scheme describes how to reach
the PROXY, not the traffic being proxied.

A proxy variable set to **whitespace only** is treated as a typo rather than as
configuration: cdkd refuses to start and names the variable. Unset it, or give
it a URL.

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

Three more behaviours worth knowing: a lone `*` — as the whole value or as one
entry among others — bypasses the proxy for every host; entries may be
separated by whitespace as well as commas, and matching is case-insensitive;
and an entry may carry a port (`example.com:443`), in which case it applies to
that port only, so `example.com:8443` exempts nothing from ordinary HTTPS.

Instance-metadata (IMDS) and ECS container credentials are fetched over the
link-local address and deliberately bypass the proxy, so a `NO_PROXY` entry for
`169.254.169.254` is unnecessary.

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

### Deployment is Slow

**Symptoms:**

- A handful of independent resources take well over a minute, where the
  measured figure for five parallel SDK-provider resources is ~17s (see
  [Benchmarks](benchmarks.md))
- Adding resources that do not depend on each other still lengthens the deploy
  roughly linearly

**Causes:**

- Long dependency chains in the DAG (the critical path caps how fast a deploy can finish, even with event-driven dispatch)
- Cloud Control API rate limits
- Asset publishing takes time
- A resource pinned to the Cloud Control route (`ProvisionedBy: cc-api`), which is slower than cdkd's hand-written SDK provider

**Solutions:**

**1. Inspect the dependency graph**

`cdkd diff` reports *what* changes, not in what order. To see the shape of the
graph, run a dry-run deploy at debug level — it builds the DAG and then stops
before touching AWS:

```bash
cdkd deploy --app "..." --state-bucket ${STATE_BUCKET} --dry-run --verbose
```

```text
... DEBUG [DagBuilder] Dependency graph built: 4 nodes, 3 edges
... DEBUG [DagBuilder] Level 0: 2 resources - Bucket, Table
... DEBUG [DagBuilder] Level 1: 1 resources - Role
... DEBUG [DagBuilder] Level 2: 1 resources - Function
... DEBUG [DagBuilder] Execution levels computed: 3 levels
✓ Dry run completed - no actual changes made
```

A deep, narrow graph is what caps a deploy: the depth bounds how much can
overlap. A real deploy prints the same figure in one line —
`Deploying 4 resource(s) (DAG: 3 levels, max parallel: 10)`.

Deploy does not actually wait for a whole level to finish: each resource starts
the moment its own dependencies complete, so the levels describe the graph's
depth rather than a set of barriers. Destroy is the exception — it deletes
level by level, in reverse.

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

**3. Check whether a resource is pinned to the Cloud Control route**

```bash
cdkd state show MyStack

# Example output:
# MyTopic
#   Type: AWS::SNS::Topic
#   PhysicalID: arn:aws:sns:us-east-1:123456789012:MyTopic
#   ProvisionedBy: cc-api
```

`ProvisionedBy: cc-api` means the resource is provisioned through the Cloud
Control API — cdkd's fallback layer, and slower than a hand-written SDK
provider. A resource lands there when its template carries a top-level property
the SDK provider would silently drop, and the record is then **sticky**: a later
cdkd release that adds SDK coverage for that property does not by itself move
the resource back, because doing that unconditionally would mean
destroy-and-recreate churn on every release. [Provisioning Layers](provisioning-layers.md) explains
the two layers and how cdkd picks between them.

Whether you need to do anything depends on the resource type:

- **The type is exempt from the sticky rule**, because cdkd now covers it.
  Nothing to do. The next deploy that changes the resource returns it to the SDK
  provider automatically and **in place** — no flag, no physical-id churn. See
  [`cdkd diff` shows `[returning to SDK provider]`](#cdkd-diff-shows-returning-to-sdk-provider)
  below.
- **The type has no exemption.** The migration is user-initiated, and it
  destroys and recreates the resource:
  [`--recreate-via-sdk-provider <LogicalId>`](cli-deploy-safety.md#recreate-via-sdk-provider-deploy).
  The flag refuses while the template still carries the silent-drop property
  that sent the resource to Cloud Control in the first place, so first either
  remove that property or accept the drop with
  `--allow-unsupported-properties <Type>:<Prop>`.

### A property you set in the template never reaches AWS

**Symptoms:**

The deploy succeeds, `cdkd diff` reports the change, but the field is absent
from the live resource when you read it back with the AWS CLI or the console.

**Cause:**

cdkd's SDK providers write only the properties they were written to handle. A
top-level CloudFormation property outside that set is a **silent drop** — the
provider does not send it and does not complain. This is a real bug class, so
cdkd defends against it by default rather than dropping the field: a resource
whose template carries such a property is routed through the Cloud Control API
instead, which forwards the whole property map. The deploy says so:

```
MyAlarm (AWS::CloudWatch::Alarm): routing via Cloud Control API (cdkd's SDK Provider does not yet wire EvaluationWindow — CC API will forward the full property map. Override via --allow-unsupported-properties AWS::CloudWatch::Alarm:EvaluationWindow.)
```

So if the field is genuinely missing from AWS, the auto-route did not fire.
Three reasons:

1. **You passed `--allow-unsupported-properties <Type>:<Prop>`.** That flag
   means "keep this resource on the SDK provider and accept the drop" — it is
   the opt-in to exactly this outcome.
2. **The property is not in cdkd's committed CloudFormation schema snapshot.**
   Each cdkd release carries a snapshot of AWS's published resource schemas,
   and the routing decision is made against that snapshot alone — cdkd does not
   call AWS to look a property up at deploy time. A property AWS published
   after your release's snapshot is therefore indistinguishable from a typo, so
   it cannot drive a routing decision; cdkd warns rather than routing.
   Upgrading cdkd picks up a newer snapshot.
3. **The property is nested, not top-level.** The silent-drop check works on
   top-level properties; a missing key inside a nested object is a different
   problem.
**Solutions:**

Confirm which layer handled the resource:

```bash
cdkd state show MyStack    # ProvisionedBy: sdk | cc-api
```

`sdk` means one of the three causes applies. For case 1, dropping the flag is
enough: cdkd records only what the SDK provider actually sent, so the property
is a genuine addition on the next deploy and the auto-route delivers it — unless
the property is create-only, which cdkd keeps in the record because applying one
to a live resource needs a replacement. See
[Deploy: safety & compatibility flags](cli-deploy-safety.md#the-override) for how
to recreate it deliberately and what that costs. For
case 2, the property is genuinely unsupported today: open an issue, or use
`--recreate-via-cc-api <LogicalId>` to put the resource on Cloud Control
deliberately.

`cc-api` means the resource is on the layer that forwards the whole property
map, so the absence is not cdkd dropping the field.

You do **not** need `--recreate-via-cc-api` merely because a deployed
SDK-managed resource has just gained a silent-drop property — the next deploy
re-routes it and normally applies the property in place. A create-only property
and a physical id Cloud Control cannot address are the exceptions. See
[Provisioning Layers](provisioning-layers.md#choosing-a-flag).

### `cdkd diff` shows `[returning to SDK provider]`

**Symptoms:**

```
  [~] MyTopic (AWS::SNS::Topic) [returning to SDK provider]
```

**Cause:**

The resource is recorded `provisionedBy: cc-api`, and its type carries an
`'sdk-coverage'` exemption from the sticky rule described above — Cloud Control
manages the type correctly and is merely slower, and cdkd now covers every
property this particular resource uses. The next mutating deploy moves it back
to the faster SDK provider — see
[Coming back from Cloud Control](provisioning-layers.md#coming-back-from-cloud-control).

The annotation deliberately does not wear the `via CC API:` prefix its sibling
tokens (`[via CC API: <property>]`, `[via CC API: sticky]`) share — the resource
is *leaving* Cloud Control, not routing through it.

**This is an update in place, not a replacement.** The physical id is preserved,
so references to the resource and any out-of-band configuration attached to it
survive. `cdkd deploy` names the move as it happens:

```
MyTopic (AWS::SNS::Topic): returning to the SDK provider — cdkd now covers every property this resource uses. The physical id is preserved; pass --pin-cc-api MyTopic to decline this for a deploy.
```

**Solutions:**

Usually none — this is the routing improving itself. To decline it for a single
deploy, for example to keep one deploy on the same layer as the last while
investigating something, pass
[`--pin-cc-api <LogicalId>`](cli-deploy-safety.md#pin-cc-api-deploy). It is
per-deploy rather than a stored preference: pass it again next time, or stop
passing it and let the move happen.

A resource whose type is exempt for the opposite reason — Cloud Control
*cannot* manage it correctly — moves for correctness rather than speed, logs a
different line, and **ignores `--pin-cc-api`**, since honouring the pin would
hold the resource on the handler that cannot address it.

### Cloud Control API Rate Limit

**Symptoms:**

```
ProvisioningError: Failed to create resource MyTopic
Caused by: CREATE failed for MyTopic: Rate exceeded
```

Cloud Control returns this as `ThrottlingException`. cdkd retries it
automatically, so you normally see it only under `--verbose`, or in the
give-up line after the retry budget is spent.

**Causes:**

AWS publishes **no rate quota** for the Cloud Control API — its Service Quotas
entry states the service has no quotas — but it does throttle when the request
rate is too high. A wide stack whose resources are all independent issues many
Cloud Control calls at once, which is when you are most likely to see it.

**Solutions:**

**1. Retry with exponential backoff (built-in)**

cdkd retries CREATE, UPDATE and DELETE operations during `cdkd deploy` (and the
replays performed by `cdkd rollback` and `cdkd drift --revert`), with the
backoff shape chosen per error class:

- **Throttling and other transient errors** (rate limits, a resource still leaving `Pending`, an async delete releasing a dependency, and a transient server error — HTTP 500 / 502 / 503 / 504, the same four the AWS SDK's own retry strategy treats as transient): exponential backoff `1s->2s->4s->8s->8s->8s->8s->8s`, capped at 8s, up to 8 retries (47s of sleep). Hammering a throttled API is counter-productive, so this class deliberately backs off hard.
- **IAM propagation** (`Invalid IAM Instance Profile`, `cannot be assumed`, `not authorized to perform`, `Policy Error: PrincipalNotFound`, `not authorized to access the Log Destination`, `does not have a trust relationship allowing`, ...): a denser `0.25s->0.5s->1s->2s->2s...` schedule over 26 retries (47.75s of sleep). This class usually resolves in single-digit seconds — cdkd creates an IAM entity and consumes it ~1-3s later, faster than IAM propagates — so cdkd re-probes roughly every 2s instead of idling through a 4s or 8s step. A few of these patterns are also emitted for PERMANENT problems (see the note under the give-up line below), and those spend the budget rather than resolving. The dense window (47.75s) is slightly longer than the generic one (47s), so nothing that used to recover stops recovering — and from 3.75s onwards the dense grid is strictly ahead, never lagging the generic one by more than 0.75s in the early band.

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

  - **`(the full propagation budget)` present** — the retry ran to exhaustion. Usually that means IAM genuinely took longer than 47.75s in that account, and re-running succeeds; if it recurs, please [open an issue](https://github.com/go-to-k/cdkd/issues) with the line, since the budget's shape is then the thing that needs changing. Note the retry COUNT on such a line can be below 26: a throttle mid-race consumes an attempt without counting as a propagation retry, so the budget can run out at 25 or fewer.

    **Read the AWS message on the line before concluding that, though**: a few patterns are matched because the same sentence is AMBIGUOUS between a propagation race and a permanent misconfiguration, so exhausting the budget is how a PERMANENT failure surfaces on those. Re-running will never succeed there and the budget is not the problem — fix what the message names. The Step Functions log-destination rejection is the one to know: `The state machine IAM Role is not authorized to access the Log Destination` is emitted both while the role's log-delivery grants are still propagating AND when they are genuinely absent or when the account's CloudWatch Logs resource policies have hit a quota. See ["The state machine IAM Role is not authorized to access the Log Destination"](#the-state-machine-iam-role-is-not-authorized-to-access-the-log-destination) for both remedies.
  - **No budget note, and a low count** — something terminal ended the race early: a non-retryable error such as an explicit deny, or an error cdkd's classifier could not read. The seconds figure tells you how much of the 47.75s was actually spent, which is what distinguishes "IAM was too slow" from "the retry was cut short", and the bracketed `[name=... http=...]` names what ended it. This shape is worth reporting when the status is a 5xx other than 500 / 502 / 503 / 504, or when the bracket shows `no-$metadata`: those are the cases cdkd does not currently treat as transient, and one of them (a plain HTTP 500 answered mid-propagation with an empty body) was a real, since-fixed defect, where a single 500 ended an otherwise healthy sequence at 12% of its budget.
  - **No such line at all** — the retry never engaged, and there are two reasons, which need different responses. Either cdkd's error classifier did not recognise the failure as IAM propagation — worth reporting, since the wording it failed to recognise is the useful half of the report — OR the failing resource is served by a provider that opts out of the outer retry by design: `Custom::*` / `AWS::CloudFormation::CustomResource` and `AWS::CloudFormation::Stack` are never wrapped by the dense outer schedule, so no give-up line is produced for them. A custom resource's Lambda HANDLER is an ordinary `AWS::Lambda::Function` and does retry on the outer schedule. Check which of the two the failing logical id is before filing.

    There used to be a THIRD reason, and it is worth knowing it is gone. A rollback's reverse-replacement re-create — the arm that revives the OLD resource after a replacement failed — could never produce this line at all, whatever the error: it wrapped the create in a retry carrying an explicit schedule and a name-collision classifier, and either of those alone makes the propagation counters inert. So a rollback that hit `The role defined for the function cannot be assumed by Lambda.` printed the bare AWS sentence, retried zero times, and was indistinguishable from a build with no propagation retry at all. That path now retries on the same dense schedule and prints the same give-up line, so **you can now see this line during `cdkd rollback` and during an automatic rollback**, not only during `cdkd deploy`. The two reasons above are once again the complete set.

    Opting out of the OUTER retry is not the same as having no retry, which is what this bullet used to say. `CustomResourceProvider` retries internally instead, and that now covers both error shapes rather than one: a handler that RETURNS `FAILED` with an authz-shaped reason, and — new — an authz-shaped error THROWN by an SDK call the provider itself makes before the request reaches the handler. The two draw on SEPARATE budgets, because they cost different things. A re-invoke after a FAILED response re-runs your handler, so it stays small (`CDKD_CR_AUTHZ_MAX_RETRIES`, default 2, clamped to 10). A pre-delivery THROW reached no handler at all, so it gets the same 26 retries over 47.75s the outer schedule gives every other resource type — which is the whole point, since the propagation window this covers is measured in seconds and 0.75s of coverage would not have closed the reported failure. `CDKD_CR_AUTHZ_MAX_RETRIES=0` therefore disables re-invocations of your handler only; it does not disable the pre-delivery retry or the response-placeholder `PutObject` retry, neither of which can reach a handler. A throw that lands AFTER the invoke was accepted is never replayed regardless of its wording — the handler is running and will write to that attempt's response URL — so a `Custom::*` failure can still be genuinely single-shot; the readiness waiters are likewise never replayed — they have already polled `lambda:GetFunction` for their own 600s — so a permanent denial there surfaces after one waiter timeout rather than three. `AWS::CloudFormation::Stack` is unchanged and has no internal retry.

  The seconds count PROPAGATION backoff only, so an interleaved throttle's own wait is excluded — the figure is meant to be compared against the 47.75s budget, not read as total elapsed time.

  Add `--verbose` to see each attempt with its running total (`attempt 15/26, 25.75s backoff through this attempt`), which is what turns "it failed" into a measurement.

- **A name still held by a resource you just deleted** (`QueueDeletedRecently`,
  Step Functions' `StateMachineDeleting`, S3's `conflicting conditional
  operation`): a `2s->4s->8s->10s->10s->10s->10s->10s` grid, 64s over 8
  retries. This class is separate because it cannot inherit the generic
  47s budget — SQS's own message names a 60-second window, and a 47s budget
  against a 60s window does not converge, it just fails 47 seconds later. See
  [A name is still held by the resource you just deleted](#a-name-is-still-held-by-the-resource-you-just-deleted).

CC API polling is a different mechanism from the retry above: it waits for an
accepted operation to finish, on a `1s -> 1.5s -> 2.25s -> 3.4s -> 5.1s ->
7.6s -> 10s` schedule (a 1.5x multiplier, capped at 10s), against a 15-minute
deadline — longer for known-slow types such as OpenSearch domains and RDS /
Redshift / ElastiCache clusters.

**2. Lower the concurrency**

```bash
cdkd deploy --app "..." --concurrency 4        # default 10, concurrent resource operations
cdkd deploy --app "..." --stack-concurrency 2  # default 4, concurrent stacks
```

Asset publishing has its own limits: `--asset-publish-concurrency` (default 8)
and `--image-build-concurrency` (default 4).

### A name is still held by the resource you just deleted

**Symptoms:**

A destroy-then-redeploy loop fails on a name that looks free:

```
ProvisioningError: Failed to create resource MyQueue
Caused by: You must wait 60 seconds after deleting a queue before you can create another with the same name.
```

**Cause:**

Some services release a name asynchronously after the delete returns. cdkd
retries this class on its own `2s -> 4s -> 8s -> 10s ...` grid — 64 seconds
over 8 retries, chosen to cover SQS's stated 60-second window — so most of the
time you never see it. The types that reach it in practice:

| Type | Window |
| --- | --- |
| `AWS::SQS::Queue` | 60s, stated by the service |
| `AWS::StepFunctions::StateMachine` | ~23s of `status: DELETING` on an idle machine |
| `AWS::S3::Bucket` | bucket names are global and released asynchronously |

The Step Functions case is easy to hit without knowing it: any CDK app using
`custom_resources.Provider` with an `isCompleteHandler` carries a waiter state
machine, so an ordinary re-deploy reaches this path.

**Solutions:**

Wait and re-run — the exhaustion line says so explicitly:

```
MyQueue: gave up after 8 name-cooldown retries over 64.00s waiting for the name to be released (the full name-cooldown budget) - <the AWS message>
```

Two deliberate non-members of this class, so you do not wait for a retry that
will not come: ELBv2's `DuplicateLoadBalancerName` and DynamoDB's create-side
refusal are raised for a resource that genuinely still **exists**, and a
Secrets Manager name scheduled for deletion can be held for 7-30 days, which no
bounded budget rides out.

During a `--replace` the outer replacement loop re-enters this retry per
attempt, so a custom-named SQS queue can appear to hang for up to ~11 minutes.
That is the retry working, not a stall.

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

### `DistributionAlreadyExists` on a CloudFront deploy, and a distribution you did not ask for

cdkd retries a `CreateDistribution` that answered HTTP 500 / 502 / 503 / 504,
because those are usually transient. Some of them are not: the request can SUCCEED
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

### an ACM certificate deploy fails with "did not reach ISSUED status"

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
# CDKD_ACM_POLL_INTERVAL_MS (default 10000) changes the gap between polls.
CDKD_ACM_POLL_ATTEMPTS=120 cdkd deploy <stack>          # 20 minutes

# Do not wait at all. The certificate is created, RECORDED IN STATE, and the
# deploy returns immediately -- downstream consumers will fail until it issues,
# but the certificate survives for you to validate out of band.
cdkd deploy <stack> --no-wait
```

**`--resource-timeout` alone does not make this wait longer**: the poll cap is
the provider's own, and the deadline is the engine's, wrapped AROUND it — so
the effective wait is the **shorter** of the two.

Below the engine's 30-minute default that means `--resource-timeout` can only
cut the poll cap short. **At or above 30 minutes it becomes load-bearing**:
raising `CDKD_ACM_POLL_ATTEMPTS` past 180 without also raising
`--resource-timeout` silently caps the wait at 30 minutes. Raise both:

```bash
CDKD_ACM_POLL_ATTEMPTS=270 cdkd deploy <stack> \
  --resource-timeout AWS::CertificateManager::Certificate=50m   # 45 min of polling
```

Setting the deadline BELOW the cap is worth avoiding for a second reason: it
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
cdkd rollback MyStack                        # revert to the pre-deploy state
cdkd rollback MyStack --force                # skip the confirmation (-y / --yes also works)
cdkd rollback MyStack --revert-failed        # also revert the resource that failed mid-deploy
cdkd rollback MyStack --stack-region us-west-2
```

The prompt refuses a non-interactive stdin rather than hanging, so CI needs one
of the confirmation flags.

- **Exit `2`** means the rollback was partial — one or more ops failed
  best-effort or were skipped with a warning (e.g. a resource whose physical
  id changed after a later fix-forward attempt, or an unrecoverable DELETE).
  The rollback journal is **kept** so you can re-run `cdkd rollback` — replay
  is idempotent (already-reverted resources are skipped).
- Use `--orphan <logicalId>` (repeatable) to leave a specific resource alone
  during the revert (mirrors `cdk rollback --orphan`).
- **Secret dynamic references need live access at rollback time.** A resource
  whose properties use `{{resolve:secretsmanager:...}}` — or
  `{{resolve:ssm:...}}` pointing at a `SecureString` parameter — is written to
  state and the journal as the unresolved expression rather than the plaintext,
  so reverting it re-resolves the reference against Secrets Manager / SSM during
  the rollback. (That substitution is a redaction pass, not a guarantee: a
  position it cannot certify against the template keeps whatever value it was
  handed, so treat a value ever persisted in plaintext as compromised and rotate
  it.) If that secret has since been deleted or your credentials can no
  longer read it, that resource's revert fails (exit `2`, journal kept) —
  restore access to the secret and re-run `cdkd rollback`, or `--orphan` the
  resource to skip it.
- If `cdkd rollback` reports "nothing to roll back", the journal is already
  gone — the deploy either succeeded on a later attempt (journal deleted on
  success) or the process was killed before the journal was written (a
  SIGKILL before the PUT). In the latter case use `cdkd deploy` to resume or
  `cdkd destroy` to clean up.
- See [`cdkd rollback`](cli-rollback.md) for the full flag
  reference and known limitations.

### destroy reports `N skipped` and exits 2

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

If you suspect orphaned resources exist (e.g., due to a process crash before state could be saved), list what cdkd tracks and compare it against AWS:

```bash
# Resources in state: LogicalID, Type, PhysicalID
cdkd state resources MyStack

# Machine-readable, and with dependencies + attributes
cdkd state resources MyStack --json
cdkd state resources MyStack --long

# The full record, including resource properties
cdkd state show MyStack

# Which stacks have state at all
cdkd state list
```

Pass `--stack-region <region>` when the same stack name has state in more than
one region. Then compare against AWS:

```bash
aws cloudcontrol list-resources --type-name AWS::S3::Bucket
aws cloudcontrol list-resources --type-name AWS::Lambda::Function
```

### Recovering from Orphaned Resources

**If state was saved (most cases)**:

Running `cdkd deploy` again will reconcile the state — existing resources will be detected as already created and handled as updates or no-ops.

**If state was NOT saved (rare — process crash)**:

Adopt the resources back into state. Do not delete them, and do not hand-edit
`state.json`:

```bash
# 1. See what cdkd currently tracks.
cdkd state resources MyStack

# 2. Preview the adoption; writes no state.
cdkd import MyStack --dry-run

# 3. Adopt. Add --resource for anything reported "not found" — cdkd's
#    generated names are deterministic (no random component), but read the
#    exact name off AWS rather than constructing it: the form is
#    <StackName>-<LogicalId> only when that FITS the type's length limit,
#    otherwise cdkd truncates and appends "-" + 8 hex characters.
cdkd import MyStack --resource MyBucket=mystack-mybucket
```

Or, to start over, delete the AWS resources through cdkd rather than by hand:

```bash
cdkd state destroy MyStack --yes   # deletes the AWS resources AND the state
cdkd deploy MyStack
```

**If a rollback left a `Retain` resource behind**:

A resource carrying `DeletionPolicy: Retain` stays in AWS when a deploy rolls
back, and its state record is dropped — CloudFormation does the same, and it is
what `Retain` is for. The difference is that cdkd's generated names carry no
random suffix, so the next `cdkd deploy` asks AWS for a name the retained
resource still holds and fails with an already-exists error; that failure rolls
back too, so the deploy cannot self-resolve by re-running.

cdkd names this case for you. When the colliding name is one cdkd derived, the
failure is followed by a line saying so and giving the adoption command:

```text
ApiGatewayAccountCloudWatchRole: the name AWS reports as taken
(mystack-apigatewayaccountcl-19184149) is one cdkd DERIVED from the logical id
... To recover, adopt it back into state instead of re-creating it:
cdkd import MyStack --resource ApiGatewayAccountCloudWatchRole=mystack-apigatewayaccountcl-19184149
```

A selective `--resource` import merges into existing state and needs no
`--force` while the resource is absent from it. If the resource is not one you
want to keep, delete it in AWS — after confirming it holds nothing you need,
since `Retain` is what kept it — and re-deploy. For a type whose provider
implements no import, deleting is the only route, and the message says so
instead of offering the command.

> **Do not delete `state.json` and redeploy.** It is not a reset, and what
> happens next is not uniform: most types fail the CREATE with an
> already-exists error; `AWS::S3::Bucket`, `AWS::Logs::LogGroup` and
> `AWS::SNS::Topic` silently adopt the existing resource and re-apply your
> configuration over it; and types with an AWS-assigned id — VPC, EC2 instance,
> ACM certificate, CloudFront distribution — create a **second** resource and
> orphan the first, silently, once per attempt. That last case manufactures
> exactly the orphans this section is about.

### Known Leftover: EFS Automatic Backups

A successful `cdkd destroy` of an `AWS::EFS::FileSystem` deletes the file
system but not the AWS Backup recovery points taken while it existed. If the
file system had automatic backups on (`BackupPolicy: { Status: ENABLED }`,
which cdkd applies from the template), those recovery points stay in the
service-managed vault `aws/efs/automatic-backup-vault` for the 35-day default
retention and remain fully restorable — a copy of the data, and a charge,
outliving the stack. See
["EFS automatic backups survive destroy" in Supported Resources](supported-resources.md#efs-automatic-backups-survive-destroy)
for the `aws backup list-recovery-points-by-backup-vault` /
`aws backup delete-recovery-point` commands.

### Known Leftover: FSx Final Backups

A successful `cdkd destroy` of an `AWS::FSx::FileSystem` can leave a
chargeable final backup behind: cdkd keeps CloudFormation parity and calls
`DeleteFileSystem` with API defaults, which take a final backup for
Windows/ONTAP (observed on OpenZFS too). The backup is typically untagged, so
find it via the backup's persisted `FileSystem.FileSystemId` rather than tags.
See ["FSx final backup on destroy" in Supported Resources](supported-resources.md#fsx-final-backup-on-destroy)
for the details and the `aws fsx describe-backups` / `aws fsx delete-backup`
commands.

---

## Debugging Methods

### Adjust Log Level

```bash
# Enable verbose (debug) logging — the only way to raise the level
cdkd deploy --app "..." --verbose

# Disable the live progress renderer (plain line-by-line output; implied
# by --verbose, and useful in CI)
CDKD_NO_LIVE=1 cdkd deploy --app "..."
```

cdkd has **no log-level environment variable**. The level defaults to `info`
and is raised to `debug` only by `--verbose`, which every command accepts. One
case lowers it instead: `cdkd diff --json` pins the level to `warn` so debug
output cannot corrupt the JSON on stdout, and `--json` wins over `--verbose`.

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
cdkd deploy --app "..." --state-bucket ${STATE_BUCKET} --dry-run
```

---

## Frequently Asked Questions (FAQ)

### Q: Is a CloudFormation stack created?

A: No. A `cdkd deploy` provisions each resource directly: a hand-written **SDK
provider** first, with the **Cloud Control API** as the fallback for types (and
properties) no SDK provider covers. There is no CloudFormation stack, no change
set, and no stack events — cdkd's equivalents are `cdkd state show` and
`cdkd events`. See [Provisioning Layers](provisioning-layers.md).

Two commands do touch CloudFormation, and neither is an ordinary deploy:

- A template declaring a macro (`Transform` / `Fn::Transform`, e.g. SAM) is
  expanded by CloudFormation. cdkd creates a transient `cdkd-macro-expand-*`
  stack, reads the processed template, and deletes it again before provisioning
  anything.
- [`cdkd export`](cli-export.md) deliberately creates a real CloudFormation
  stack — that is how it hands the stack over.

### Q: Can I use CloudFormation and cdkd for the same stack?

A: One stack has one owner at a time, but you can hand it over in either
direction, and both directions are first-class.

**CloudFormation → cdkd** — adopt the resources and retire the CFn stack
record; the AWS resources are not deleted:

```bash
cdkd import MyStack --migrate-from-cloudformation
```

This needs a CDK app that already synthesizes the stack. For a hand-written
CloudFormation template, generate the CDK app first (upstream
`cdk migrate --from-stack`). Nested stacks are walked recursively.

**cdkd → CloudFormation** — build an IMPORT change set, execute it, and delete
cdkd state; the AWS resources are unchanged:

```bash
cdkd export MyStack --dry-run   # print the plan, no AWS writes
cdkd export MyStack
```

An export is all-or-nothing and refuses up front on a template resource with no
cdkd state entry, a redaction mask in the recorded properties, a type
CloudFormation cannot import, or a Custom Resource without
`--include-non-importable`.

Different stacks can also stay on different engines: a cdkd-deployed consumer
resolves `Fn::ImportValue` / `Fn::GetStackOutput` against a
CloudFormation-managed producer with no change on the producer side.

### Q: What happens if I delete the state file?

A: cdkd no longer knows about any of the stack's resources, so the next
`cdkd deploy` plans every one as a CREATE. **Do not delete the AWS resources** —
adopt them back with `cdkd import`:

```bash
cdkd import MyStack --dry-run   # preview; writes no state
cdkd import MyStack
```

With no flags, `cdkd import` resolves each physical id from the template's own
name property and then from a same-named CloudFormation stack. A resource whose
name CDK left for cdkd to generate has no name in the template, so it is
reported `not found` — name those explicitly. cdkd's generated names are
deterministic (nothing random goes into them), and the form is
`<StackName>-<LogicalId>` **when that fits the type's length limit**; when it
does not, cdkd truncates and appends `-` plus 8 hex characters
(`mystack-averylongconstructna-19184149`). So copy the name AWS reports rather
than building it by hand — for a long stack or logical id the plain form does
not exist:

```bash
cdkd import MyStack --resource MyBucket=mystack-mybucket
```

See [Importing Existing Resources](import.md) for the full flag set.

### Q: Is there a rollback feature?

A: Yes. By default, cdkd rolls back on failure. Use `--no-rollback` to skip rollback and keep partial state (Terraform-style). On next execution, remaining changes are applied as diff. To revert a `--no-rollback` (or interrupted) deploy back to its pre-deploy state instead of fixing forward, run the standalone `cdkd rollback <stack>` command — it replays a rollback journal cdkd persisted at failure time, with no synth needed.

### Q: Are custom resources supported?

A: Yes. Both type spellings work — `Custom::<Name>` and
`AWS::CloudFormation::CustomResource` (what CDK emits for a
`new cdk.CustomResource(...)` with no explicit `resourceType`) — and so do both
`ServiceToken` forms:

- **Lambda-backed**: the function is invoked, and the handler either returns
  the response directly or PUTs it to the pre-signed `ResponseURL`.
- **SNS-backed**: cdkd publishes the request to the topic and polls for the
  response.

CDK's Provider framework (`onEventHandler` + `isCompleteHandler`) is detected
automatically; the async pattern gets a long polling timeout, one hour by
default. Adjust it with
`--resource-timeout AWS::CloudFormation::CustomResource=<duration>`.

Note that `cdkd export` cannot hand a Custom Resource to CloudFormation without
`--include-non-importable` — CloudFormation cannot import them.

---

## Getting help

Nothing above matching? Open a
[GitHub Issue](https://github.com/go-to-k/cdkd/issues) with the failing
command, its output, and the resource type involved. Questions are welcome
there too.

## Related

- [CLI Reference](cli-reference.md) — every command, the output-stream contract,
  and the full exit-code table
- [State Management](state-management.md) — the state record, the lock, and the
  bucket layout behind most of the errors above
- [Architecture](architecture.md) — the pipeline a deploy runs through
- [Supported Resources](supported-resources.md) — whether a type is handled by
  an SDK provider or the Cloud Control fallback
