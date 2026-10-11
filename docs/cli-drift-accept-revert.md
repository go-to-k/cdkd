---
title: "cdkd drift: accept and revert in detail"
description: "What cdkd drift --accept and --revert write, what each one declines, how to read the revert summary, and how to recover a resource deleted outside cdkd."
---

# cdkd drift: accept and revert in detail

`cdkd drift --accept` and `cdkd drift --revert` resolve the drift a report
found. This page covers what each flag writes, the cases each one declines,
and what to do about a resource that was deleted. The overview and a worked
example are on [`cdkd drift`](cli-drift.md#resolving-drift-accept-and-revert).

```bash
cdkd drift MyStack --accept --dry-run   # show what would be written to state
cdkd drift MyStack --accept --yes       # write it
cdkd drift MyStack --revert --dry-run   # show what would be changed in AWS
cdkd drift MyStack --revert --yes       # change it
```

Both flags skip resources the report lists as drift unknown, because cdkd has
no reading of them to act on.

## `--accept` (state ← AWS)

`--accept` copies the value AWS holds now into cdkd state, for every property
that drifted. It does not modify any AWS resource.

```text
Plan (--accept): update cdkd state for MyStack (us-east-1):
  ~ AssetsBucket (AWS::S3::Bucket)
    VersioningConfiguration.Status: Enabled → Suspended
```

The value is written to the snapshot drift compares against, which is the copy
of the resource cdkd read from AWS at deploy time. The properties from your
last deployed template stay as they were. A resource with no snapshot has only
the template properties, so the value is written there.

A `cdkd deploy` running at the same moment cannot be overwritten by this
write. cdkd saves the state file only if it has not changed since `--accept`
read it.

### What `--accept` declines

`--accept` declines the properties and resources below, and the plan names
each one.

- **A secret whose live value cdkd cannot identify.** cdkd will not write
  `***`, or a value it cannot identify, into state.
- **A property state holds only as `***`.** Accepting would replace the mask
  with the live plaintext. See
  [cdkd drift: secrets and redacted values](cli-drift-secrets.md).
- **A resource whose snapshot a `cdkd import` refused to record.** See
  [Clearing a baseline refusal](cli-drift-not-compared.md#clearing-a-baseline-refusal).
- **A deleted resource.** See [Deleted resources](#deleted-resources).

## `--revert` (AWS ← state)

`--revert` updates each drifted resource in AWS so that its drifted properties
return to the values cdkd recorded. Properties that did not drift are sent
with the values AWS already has, so the update leaves them alone. State is
normally not modified.

cdkd reverts several resources at once. `--concurrency <n>` sets how many, and
the default is `4`. A failure on one resource does not stop the others.

### Reading the revert summary

The run ends with a count of what happened:

```text
Revert summary: 3 reverted, 1 update-not-supported, 1 failed.
```

When anything was not reverted, the command exits `2`. Each count other than
`reverted` has a line higher up that names the resource:

| Count | Meaning |
| --- | --- |
| `reverted` | The resource was updated. |
| `failed` | The AWS update call failed. |
| `update-not-supported` | The type cannot be updated in place. |
| `reference-unresolvable` | cdkd could not work out a secret value to send. |

What to do for each:

- **`failed`** is printed on a line starting with `✗`. Read the AWS error on
  that line, fix the cause, and run `--revert` again.
- **`update-not-supported`** is printed as
  `⊘ <stack>/<id> (<type>): could not revert — ...`. Redeploy with
  `cdkd deploy --replace`, or destroy and redeploy the stack.
- **`reference-unresolvable`** means a secret reference in state could not be
  resolved again, or a masked value could not be matched to the live one. cdkd
  made no AWS call for that resource. Grant `secretsmanager:GetSecretValue` or
  `ssm:GetParameter`, or fix the reference, then run `--revert` again.

### Types that cannot be reverted in place

Some types report `update-not-supported` every time.

AWS treats these as immutable:

- `AWS::Lambda::LayerVersion`
- `AWS::Lambda::Permission`
- `AWS::ApiGateway::Deployment`

cdkd has no in-place update for these:

- `AWS::AppSync::*`
- `AWS::EFS::*`
- `AWS::KinesisFirehose::DeliveryStream`
- `AWS::ApiGatewayV2::*`
- `AWS::ApiGateway::Authorizer`, `Deployment` and `Method`
- `AWS::Glue::Database`
- `AWS::ServiceDiscovery::*`
- `AWS::ElasticLoadBalancingV2::LoadBalancer`

### What `--revert` leaves alone

A revert does not always make AWS identical to state. The plan lists each of
the cases below before the confirmation prompt, and `--dry-run` shows them
too.

| Case | What the revert does |
| --- | --- |
| A tag someone added by hand | Removes it. |
| A tag AWS manages (`AmazonECSManaged`, any `aws:` prefix) | Keeps it. |
| A resource with no snapshot | Leaves values AWS set on its own. |
| A drifted IAM Role or ManagedPolicy name | Reverts the rest, leaves the name. |
| A drifted IAM `Path`, or a managed policy's `Description` | Fails that resource. |
| An ELBv2 attribute only AWS returns | Leaves the live value. |
| A property state holds only as `***` | Keeps the live value, or refuses. |

Four of these need more explanation.

**AWS-managed tags.** The rule applies to a top-level `Tags` list. The plan
names each key the revert keeps.

**A resource with no snapshot.** Without a snapshot, cdkd cannot tell a value
AWS set on its own from a value someone added, so it leaves every value your
template never declared. The plan prints a
`! this resource has no observed-capture baseline ... LEAVES N AWS-authored
values untouched` line that names each path. To have those values reverted
too, record a snapshot first with `cdkd state refresh-observed MyStack`, or
redeploy.

**A name that cannot be reverted.** The revert warns that it left the name.
Drift keeps reporting the name until `cdkd drift --accept` records the live
one. Only a deploy renames the resource.

**A property held as `***`.** The revert keeps the value AWS has. It refuses
the whole resource when it cannot tell which live value belongs at the masked
position. The cases are in
[cdkd drift: secrets and redacted values](cli-drift-secrets.md#redacted-noecho-baselines).

### A revert that re-creates the resource

Reverting some resources means removing the resource and creating it again.
An `AWS::EC2::SecurityGroupIngress` rule, for example, is revoked and
authorized again, and AWS gives it a new `sgr-` id. cdkd then records the new
physical id and attributes in state.

How cdkd builds the update, and when a revert writes a value back to state,
is in
[cdkd drift internals](cli-drift-internals.md#how-revert-builds-the-update).

## Deleted resources

Neither flag acts on a resource AWS reports as deleted. `--revert` updates
resources in place and cannot create one. `--accept` records changed values
and does not remove a resource from state.

A run that meets a deleted resource refuses it by name and still resolves
every other drifted resource. It then exits `2`. With `--dry-run`, or when you
answer no at the prompt, it exits `0`.

A plain `cdkd deploy` does not bring the resource back either. A deploy
compares your template with cdkd state, and neither of those changed when the
resource was deleted in AWS. To recreate it, take it out of the app and put it
back:

::: steps
1. Confirm the resource is gone

   Check in the AWS console or with the AWS CLI.

2. Remove it from the CDK app and deploy

   ```bash
   cdkd deploy MyStack
   ```

   Anything in the app that refers to the resource has to come out with it,
   and this deploy deletes those resources too. If the resource is meant to
   stay gone, stop here.

3. Restore it in the CDK app and deploy again

   ```bash
   cdkd deploy MyStack
   ```
:::

## A malformed state record

A state record is malformed when it holds the wrong kind of value somewhere,
for example after a hand edit. `--accept` and `--revert` refuse such a record
before they take the lock, and the message names the stack, the region and the
logical ids involved.

A run without either flag still reports on the record. It lists the rows it
could not read as not compared and exits `2`, or `1` when something else
drifted.

Look at the record as stored before repairing it:

```bash
cdkd state show MyStack --json
```

## Related

- [`cdkd drift`](cli-drift.md): the report, the exit codes and the options
- [cdkd drift: what was not compared](cli-drift-not-compared.md): the reasons a resource was not compared
- [cdkd drift: secrets and redacted values](cli-drift-secrets.md): secret properties under `--accept` and `--revert`
- [cdkd drift internals](cli-drift-internals.md): how a revert builds its update
