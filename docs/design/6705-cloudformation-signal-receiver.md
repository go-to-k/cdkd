---
title: "Design: a CloudFormation signal receiver for CreationPolicy and cfn-init (#6705)"
unlisted: true
---

# Design: a CloudFormation signal receiver for CreationPolicy and cfn-init (#6705)

## Problem

`cfn-signal --stack <name> --resource <id>` and `cfn-init --stack <name>
--resource <id>` call CloudFormation's `SignalResource` and
`DescribeStackResource`. A cdkd deploy has no CloudFormation stack, so cdkd
cannot wait on a resource's `CreationPolicy` (#6437 warns and proceeds), and
`cfn-init` never reads its `AWS::CloudFormation::Init` metadata: an instance
built with CDK's `init` boots unconfigured while the deploy reports success.

## Why the receiver must be persistent

A first design created a CloudFormation stack only for the length of a deploy.
Its integ run failed: CDK grants the instance role `SignalResource` and
`DescribeStackResource` on `AWS::StackId` only, cdkd's `AWS::StackId` is a
synthetic ARN, and without credentials CloudFormation requires the caller to be
a member of the stack. The instance could reach neither the receiver nor its
metadata. Granting the role access to the receiver would be an IAM change the
template does not declare (rejected).

So cdkd keeps ONE receiver CloudFormation stack for the cdkd stack's lifetime
and resolves `AWS::StackId` to that stack's real ARN. CDK's grant then names
the receiver, and no IAM change is needed.

## Measured (us-east-1)

| Operation | Time |
| --- | --- |
| Create the receiver (one anchor resource) | ~33 s |
| `UpdateStack` adding a waiting `WaitCondition` -> `CREATE_IN_PROGRESS` | ~5 s |
| `SignalResource` -> `CREATE_COMPLETE` (stack `UPDATE_COMPLETE`) | ~32 s |
| `UpdateStack` removing a waiter | ~32 s |
| The StackId across updates | unchanged |
| A waiter's `Metadata` while `CREATE_IN_PROGRESS` | served by `DescribeStackResource` |

## Design

**Name.** Exactly the cdkd stack's name: user data passes
`--stack ${AWS::StackName}`. Tagged `cdkd:signal-receiver=true` with a fixed
`Description`; a stack holding the name without BOTH is never touched.

**Signed calls only (measured).** Without credentials, `cfn-init` /
`cfn-signal` call CloudFormation unsigned (CloudTrail: identity `Unknown`,
`ThrottlingException` / `AccessDenied`); CloudFormation answers those only
for an instance that is a resource of its stack, which a cdkd-made instance
never is. With `--role` (CDK `includeRole: true`) the calls are signed with
the instance role and the receiver works (measured: signal received, deploy
rc 0). So a resource whose user data (own, launch template's or launch
configuration's) calls `cfn-init` / `cfn-signal` without `--role` /
`--access-key` / `--credential-file` is not a candidate: it warns, naming
`includeRole: true`. No `cfn-*` call in the user data (a signed `aws
cloudformation signal-resource`, a handle-less wait condition) is served.

**When.** Only a stack whose template declares a `CreationPolicy`
`ResourceSignal` or `AWS::CloudFormation::Init` metadata, read by signed
calls (above). Created at the first
deploy that needs it, before the diff, so `AWS::StackId` resolves to its ARN
from then on. Its StackId is recorded in state (`signalReceiverStackId`, no
schema bump). Kept while the cdkd stack exists, even if the template stops
needing it, so `AWS::StackId` never moves again. Deleted by `cdkd destroy`
(after the resources), and by `cdkd export` right before its IMPORT changeset
takes the name (the pre-flight lets a receiver hold it). `cdkd state orphan`
deletes no AWS resource, so it keeps the receiver and prints its delete
command. Created before the diff, it also exists when `--require-approval` is
declined; the next deploy adopts it by name.

**An existing stack** that starts needing a receiver gets one too: its
`AWS::StackId` moves from the synthetic ARN to the receiver's once, and the
resources reading it update through the ordinary diff (a stateful replacement
is refused by the existing guards).

**Receiver template, per deploy.** One anchor
(`AWS::CloudFormation::WaitConditionHandle`), plus one resource per template
resource that declares either:

| Resource in this deploy | Receiver resource under its logical id |
| --- | --- |
| Created, or replaced, with a `ResourceSignal` ("armed") | a NEW `AWS::CloudFormation::WaitCondition`, `CreationPolicy` `Count` = the policy's, `Timeout` `PT12H`, plus its `Metadata` |
| Anything else with `AWS::CloudFormation::Init` | kept as it is, or an `AWS::CloudFormation::WaitConditionHandle` holding the `Metadata` |

All arming happens in ONE `UpdateStack` before the DAG runs: the stack stays
`UPDATE_IN_PROGRESS` until every armed waiter completes, so no second update
can follow mid-deploy. A waiter already present from an earlier deploy is
removed first (a second update), because a completed `WaitCondition` cannot
take signals again. `Metadata` is resolved with secret dynamic references left
as tokens; a resource whose metadata reads a `NoEcho` value, or a resource not
created yet, is not covered (warn, as before).

**The wait.** After a covered resource's create (or replacement) is journaled
as a completed operation, cdkd polls its receiver resource: `CREATE_COMPLETE`
succeeds; `CREATE_FAILED`, a receiver rolled back, the policy's `Timeout`
(counted by cdkd from the create), a sibling failure or Ctrl-C fails the
deploy. Because the operation is already completed, the rollback deletes the
created resource (or reverses the replacement), as CloudFormation's does.

**The end of a deploy.** A receiver still `UPDATE_IN_PROGRESS` (an aborted
wait) gets `CancelUpdateStack`, which removes the waiters this deploy added. A
deploy starting on a receiver mid-update or mid-rollback waits for it to
settle.

**Fallbacks** (warn and create without waiting): a same-name CloudFormation
stack cdkd did not make; a denied CloudFormation call; metadata reading a
`NoEcho` parameter or attribute; a nested stack (its
`Parent~Child` name cannot be a stack name); `--dry-run` (no receiver is made;
the preview keeps the synthetic `AWS::StackId`).

## Not covered

- A replacement cdkd decides mid-deploy (an update the provider refuses) is
  not known before the DAG runs, so it is not armed and only warns.
- `UpdatePolicy` `WaitOnResourceSignals` (#6706) builds on this receiver in a
  follow-up.
- An Auto Scaling group's `MinSuccessfulInstancesPercent`: the full `Count`
  is waited for.
