---
title: "cdkd drift: what was not compared"
description: "Each reason cdkd drift gives for not comparing a resource, which ones exit 2, how to clear them, and the differences drift ignores on purpose."
---

# cdkd drift: what was not compared

A `!` line in a `cdkd drift` report means cdkd could not compare a resource,
or could compare only part of it. The resource may have drifted and cdkd
cannot tell. This page explains each reason and how to clear it. The last
section lists differences drift leaves out of the report on purpose.

The block looks like this:

```text
  2 resource(s) NOT fully compared — 1 not compared AT ALL (the read or comparison failed), 1 only PARTIALLY compared (a dynamic reference cdkd could not, or refused to, resolve):
    ! ApiFunction (AWS::Lambda::Function) — the read or comparison threw, so NONE of its properties were compared
    ! Database (AWS::RDS::DBInstance) — cdkd refused to resolve a dynamic reference its state records (spell the reference as a full ARN, which names its region)
```

The heading counts two groups. "Not compared at all" means none of the
resource's properties were checked. "Only partially compared" means one or
more properties were left out and every other property was checked. Each `!`
line then names one resource and its reason.

With `--json`, the same resources are in the `notCompared` array, and each
entry has a `cause` field holding one of the names below.

## Why a resource was not compared

| `cause` | How much was compared | Exit `2` |
| --- | --- | --- |
| [`readFailed`](#readfailed-the-read-failed) | Nothing | Yes |
| [`readAborted`](#readaborted-cdkd-stopped-reading-the-stack) | Nothing | Yes |
| [`baselineRefused`](#baselinerefused-an-import-recorded-no-snapshot) | Nothing | Yes |
| [`unreadableRecord`](#unreadablerecord-and-unreadablemap-damaged-state) | Nothing | Yes |
| [`unreadableMap`](#unreadablerecord-and-unreadablemap-damaged-state) | Nothing | Yes |
| [`refused`](#refused-a-secret-reference-with-no-region) | Part | Yes |
| [`uncertifiedBaseline`](#uncertifiedbaseline-a-masked-secret-position) | Part | Yes |
| [`unresolvedToken`](#unresolvedtoken-and-noechoparameter-permanent-causes) | Part | No |
| [`noEchoParameter`](#unresolvedtoken-and-noechoparameter-permanent-causes) | Part | No |

The last column applies to a run without `--accept` or `--revert`, and only
when nothing drifted. A run that found drift exits `1` whatever else it
found.

The two causes marked "No" are permanent. Running drift again can never
compare the value, so if they produced exit `2`, a CI job that checks drift
would fail forever.

A resource that drifted can be partly compared too. Its reported changes are
real. It is listed under both `drifted` and `notCompared` in `--json`, and its
`drifted` entry carries `referencesUnresolved: true`.

A resource type cdkd cannot read back at all is a different outcome, drift
unknown, and is marked `?`. It is not a failed read.

### `readFailed`: the read failed

cdkd tried to read the resource from AWS, or to compare it, and the attempt
failed. The usual cause is a missing IAM permission or a throttled request.

```text
    ! ApiFunction (AWS::Lambda::Function) — the read or comparison threw, so NONE of its properties were compared
```

Grant the missing permission, or run the command again if AWS was throttling.

### `readAborted`: cdkd stopped reading the stack

Five reads in a row failed in the same stack, so cdkd stopped trying and
marked the remaining resources as not read. Five consecutive failures usually
mean the credentials expired, or the role lacks a permission every read needs,
such as `cloudcontrol:GetResource`.

Refresh the credentials or restore the permission, then run the command
again.

Two details limit how far this reaches. cdkd counts reads through the AWS
Cloud Control API separately from reads through its own per-type code, so one
route can stop while the other keeps working. A successful read resets the
count. Other stacks in the same run are still read.

### `refused`: a secret reference with no region

State holds a reference to a secret, and cdkd could not tell which region the
secret lives in. Resolving it in the wrong region would compare against a
different secret of the same name, so cdkd declines. The resource's secret
properties are not compared, and its other properties are.

```text
    ! Database (AWS::RDS::DBInstance) — cdkd refused to resolve a dynamic reference its state records (spell the reference as a full ARN, which names its region)
```

Write the reference in your CDK code as a full ARN, which includes the region.

This cause also appears on a nested stack when the state record of one of its
parent stacks is missing or unreadable. A value the parent read from another
region reaches the nested stack without its region, and cdkd needs the
parent's record to work the region out.

### `uncertifiedBaseline`: a masked secret position

State holds the mask `***` at a position where the template has a secret
reference, so that one position cannot be compared. Every other property of
the resource is.

Run `cdkd deploy` for the stack. The cause and the fix are explained under
[A masked position cdkd could not certify](cli-drift-secrets.md#a-masked-position-cdkd-could-not-certify).

### `baselineRefused`: an import recorded no snapshot

The resource was adopted with `cdkd import`, and the import declined to record
the snapshot drift compares against. Nothing about the resource is compared.

The fix depends on why the import declined; see
[Clearing a baseline refusal](#clearing-a-baseline-refusal).

### `unreadableRecord` and `unreadableMap`: damaged state

The state file itself is damaged. With `unreadableRecord`, one resource's
entry is not readable as a resource, or its `properties` field is not an
object. With `unreadableMap`, the whole `resources` map of the stack is not an
object, and the report shows a single entry named `(resources map)`.

Repair the state record, or import the stack again. To see the record as
stored:

```bash
cdkd state show MyStack --json
```

### `unresolvedToken` and `noEchoParameter`: permanent causes

These two do not change the exit code, because nothing you run can clear
them.

- **`unresolvedToken`**: state holds `{{resolve:...}}` text that cdkd does not
  resolve as a reference. See
  [Tokens that are not references](cli-drift-secrets.md#tokens-that-are-not-references).
- **`noEchoParameter`**: state holds the value of a `NoEcho` template
  parameter only as `***`. See
  [Redacted (`NoEcho`) baselines](cli-drift-secrets.md#redacted-noecho-baselines).

In both cases every other property of the resource is compared.

### When a secret reference cannot be resolved

A secret reference that cdkd tries to resolve and cannot is reported as a
warning, and the resource's secret properties are not compared. The usual
reasons are:

- the role lacks `secretsmanager:GetSecretValue` or `ssm:GetParameter`;
- the secret was deleted;
- the reference points at another region.

## Clearing a baseline refusal

A baseline refusal is the `baselineRefused` cause above: a `cdkd import`
declined to record the snapshot of a resource. Until the refusal is cleared, drift
does not compare the resource, and `--accept` and `--revert` both decline it.
The resource has no trustworthy snapshot to accept into or revert to, and
comparing it could print a decrypted secret.

cdkd tells you the fix for the specific resource in three places: the `!` line
in the report, the `--accept` / `--revert` refusal, and
[`cdkd state show`](cli-state.md#cdkd-state-show). The fix depends on why the
import declined.

### The import could not place the secret redaction

The resource's recorded properties did not let cdkd work out where the secret
values sit. Deploy a change to that resource. A deploy that changes nothing
does not clear the refusal.

### The resource reads a template parameter cdkd could not prove

The resource uses a template parameter, and cdkd could not prove which value
the parameter had when the resource was deployed. Two things clear it:

- replacing the resource;
- importing it again while a CloudFormation stack exists that can prove the
  value.

An update in place keeps the refusal.

### The record has no reason

An older cdkd recorded the refusal without saying why. Treat it like the first
case, unless the resource reads a template parameter. Then treat it like the
second.

The full rules are in
[the drift baseline an import records](import-after.md#the-drift-baseline-an-import-records).

### Stacks imported before refusals were recorded

A cdkd release older than state schema v10 did not record refusals at all. A
stack it imported is still compared, because nothing marks its resources.

`cdkd drift` warns about such a stack, naming the stack and the resources that
have no snapshot. The warning stops after any later write to the state file,
but the records are not fixed by that write. To fix them, run `cdkd import`
for the stack again.

## What is not reported as drift

Some differences between state and AWS are expected, and drift leaves them out
of the report.

| Difference | Why drift ignores it |
| --- | --- |
| A key your template did not declare, recorded empty | AWS or another resource fills it in later. |
| A tag whose key starts with `aws:` | CDK and AWS add these. |
| An ELBv2 attribute AWS stopped returning | AWS changes that set on its own. |
| A name with the stack-name prefix | It is the same name. |

### Keys recorded empty

When cdkd recorded a key as empty (`[]`, `{}` or `null`) and your template
never declared it, a later value there is not drift. Another resource or AWS
fills such keys in after the deploy. Examples are a cluster's
`CapacityProviders` and the rules of a security group that are declared as
separate resources.

A key your template did not declare is still compared when cdkd recorded a
real value for it, such as a default AWS applied.

### Tags

Tags with an `aws:` prefix, such as `aws:cdk:path`, are added by CDK and AWS
and are not part of your `Tags`. Your own tags are compared for every type
drift can read, in a stable order, so reordering tags is not drift. Inline
policies on an IAM Role, User or Group are compared too.

### Names prefixed with the stack name

On a stack deployed with `--prefix-user-supplied-names`, cdkd puts the stack
name in front of the names you supply. State holds `my-role` and AWS holds
`MyStack-my-role`, and drift treats them as the same name.

The rule covers an IAM Role, User, Group, InstanceProfile or ManagedPolicy,
and an ELBv2 LoadBalancer or TargetGroup. A live name that cdkd would not
derive from the template's name is still reported.

### ELBv2 attributes AWS stops or starts reporting

`LoadBalancerAttributes`, `TargetGroupAttributes` and `ListenerAttributes` are
recorded in full, including keys your template never declared. AWS sometimes
stops or starts returning a key, such as `ddos_protection.syn_cookie.mode` on
an ALB.

| Case | `cdkd drift` | `--revert` |
| --- | --- | --- |
| An undeclared key in state, absent from AWS | Not reported | Does not write it back |
| A key AWS returns that state lacks | Reported | Leaves the live value, and warns |
| A declared key that changes or disappears | Reported | Writes the recorded value |
| A changed value on a key both sides hold | Reported | Writes the recorded value |

The second row is reported because cdkd cannot tell a key AWS started
returning from a value someone set. If the live value is what you expect, run
`cdkd drift --accept` to record it. Otherwise declare the value in your
template and deploy.

## Related

- [`cdkd drift`](cli-drift.md): the report, the exit codes and the options
- [cdkd drift: secrets and redacted values](cli-drift-secrets.md): the causes that involve a secret
- [cdkd drift: JSON output](cli-drift-json.md): the `notCompared` array
- [Import Existing Resources](import.md): what `cdkd import` records for drift
- [cdkd drift internals](cli-drift-internals.md): the rules behind the edge cases
