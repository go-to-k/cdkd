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
last deployed template stay as they were. A resource with no snapshot, recorded
by an older cdkd, gets one: `--accept` captures it from AWS, as
[`cdkd state refresh-observed`](cli-state-writing.md#cdkd-state-refresh-observed) does, so the template
properties stay as they were too.
That keeps your next `cdkd deploy` from undoing what you accepted. A list entry
added in AWS and accepted is not read as an entry to remove.

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

One accepted value keeps being reported, and `--accept` warns that it will.
On a Cognito user pool whose template declares no MFA factor under
`MfaConfiguration: OFF`, a software-token factor in `EnabledMfas` is compared
against the template, not the recorded value. Only `cdkd drift --revert`, or
a template that declares the factor with `MfaConfiguration` set to `OPTIONAL`
or `ON`, clears it.

## `--revert` (AWS ← state)

`--revert` updates each drifted resource in AWS so that its drifted properties
return to the values cdkd recorded. Properties that did not drift are sent
with the values AWS already has, so the update leaves them alone. State is
normally not modified.

One value is left out instead. On a Cognito user pool under
`MfaConfiguration: OFF`, `SMS_MFA` in `EnabledMfas` is not sent back. A pool
with an `SmsConfiguration` reports that factor even with MFA off, and AWS
refuses an SMS factor beside `OFF`. The pool keeps its SMS configuration.

An email-OTP factor left on such a pool is different. A pool moved from
email-OTP MFA to `OFF` by an older cdkd release still holds its
`EmailMfaConfiguration`, so drift reports `EMAIL_OTP` in `EnabledMfas`. The
revert sends no email block beside `OFF`, which AWS refuses, and clears the
factor with `SetUserPoolMfaConfig` `OFF` instead.

cdkd reverts several resources at once. `--concurrency <n>` sets how many, and
the default is `4`. A failure on one resource does not stop the others.

### Reading the revert summary

The run ends with a count of what happened:

```text
Revert summary: 3 reverted, 1 update-not-supported, 1 failed.
```

After the updates, cdkd reads each stack with a reverted resource again and
compares it the way `cdkd drift` does. A property that still differs is read
up to twice more over about 13 seconds, since a read right after an update can
lag.

When anything was not reverted, or AWS did not apply a revert, the command
exits `2`. Each count other than `reverted` has a line higher up that names
the resource:

| Count | Meaning |
| --- | --- |
| `reverted` | AWS accepted the update. |
| `not applied by AWS` | AWS accepted the update, but the re-read still shows the drift on a property the revert sent, and AWS does not hold the value sent there. Also counted in `reverted`. |
| `not verified` | The re-read could not compare the resource. Also counted in `reverted`; does not change the exit code. |
| `failed` | The AWS update call failed. |
| `update-not-supported` | The type cannot be updated in place. |
| `reference-unresolvable` | cdkd could not work out a secret value to send. |

What to do for each:

- **`failed`** is printed on a line starting with `✗`. Read the AWS error on
  that line, fix the cause, and run `--revert` again.
- **`not applied by AWS`** is printed as
  `✗ <stack>/<id> (<type>): not applied by AWS — ...`, naming the properties
  that still differ. The service ignored the value it was sent, so running
  `--revert` again sends the same update. This is usually a cdkd bug; please
  report it. A property that drifted elsewhere on the resource after the
  revert does not count.
- **`not verified`** is printed as
  `? <stack>/<id> (<type>): reverted, but cdkd could not verify it: ...`. Run
  `cdkd drift` to check the resource.
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
- `AWS::Lambda::Permission` (see
  [A revert never replaces a resource](#a-revert-never-replaces-a-resource))

cdkd has no in-place update for these:

- `AWS::AppSync::*`
- `AWS::EFS::*`
- `AWS::KinesisFirehose::DeliveryStream`
- `AWS::ApiGatewayV2::*`
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
template never declared. A policy document whose service adds nothing to it
is the exception. That covers the IAM policy documents, S3 bucket, SQS queue
and SNS topic policies, KMS key policies and Secrets Manager resource
policies; [cdkd drift](cli-drift.md) lists them. A key only AWS holds there
was added out of band, and the revert sends your template's document whole.
An IAM role's, user's or group's managed policies, inline policies,
permissions boundary and group memberships are another: the revert removes
each one that your template does not declare and no other resource of the
stack writes, and the plan lists each. An inline policy adopted with
`cdkd drift --accept` is pinned to the document it
had then: if the stack or tool that owns it later changes that document,
drift reports the change and `--revert` puts the recorded document back, so
accept again instead. An inline policy that a resource of the same stack writes (an
`AWS::IAM::Policy` or `RolePolicy`) is different: drift compares it against
that resource's template, so `--accept` does not silence an out-of-band edit
of its document. `--revert` puts the template's document back; to keep the
edit, put it in that resource's template and deploy. The plan prints a
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

### A revert never replaces a resource

When a provider could reach the recorded values only by deleting the resource
and creating it again, the revert refuses that resource before any AWS call and
reports it `update-not-supported` (`could not revert`); the run exits 2. Re-deploy
with `cdkd deploy --replace` to replace it. The refusals are:

- `AWS::SNS::Subscription`: `FilterPolicy` and `FilterPolicyScope` drifted
  together, an attribute SNS cannot reset, a `PendingConfirmation`
  subscription, a `TopicArn` / `Protocol` / `Endpoint` that differs from the
  live one, or a subscription AWS no longer has or returns no attributes for.
  A mutable attribute is still reverted in place.
- `AWS::CertificateManager::Certificate`: a `DomainName`,
  `SubjectAlternativeNames`, `ValidationMethod`, `DomainValidationOptions`,
  `CertificateAuthorityArn`, `CertificateExport` or `KeyAlgorithm` difference.
  The DomainName that ACM lists among the SubjectAlternativeNames it reports is
  not a difference.
- `AWS::EC2::SecurityGroupIngress`: a rule whose protocol, ports or source
  differ from the record, a description update that finds no rule, or a
  recorded description that is redacted. A description is still reverted in
  place. A record holding its rule's `sgr-` id reads that rule, so a rule
  moved to other ports or another source out of band
  (`ModifySecurityGroupRules`, which keeps the id) is reported on this resource
  and its revert is refused; the group's revert never revokes it.
- `AWS::Lambda::Permission`: always, since it has no update API.
- `AWS::ApiGateway::Resource`: a changed `PathPart`.
- `AWS::EC2::Route`: a bag that names another route than the physical id.
- `AWS::IAM::Policy`: a PolicyName other than the one the policy is recorded
  under (a rename would put the policy under the new name and remove the old).

If a provider still reports a replacement or a different physical id, the
revert counts the resource as failed and names both ids; state records what
AWS then holds, so the new resource is not orphaned.

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
