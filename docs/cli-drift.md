---
title: cdkd drift
description: "Detect differences between cdkd state and live AWS resources, then accept or revert them."
---

# cdkd drift

`cdkd drift` reads each resource cdkd manages back from AWS and reports where
it differs from what cdkd recorded at deploy time. Use it to find changes made
outside cdkd, such as a console edit or a deleted resource. With `--accept` or
`--revert` the same command resolves what it found.

```bash
cdkd drift                              # the single stack in state
cdkd drift MyStack                      # one stack by name, with its nested stacks
cdkd drift --all                        # every stack in the state bucket
cdkd drift MyStack --stack-region us-east-1   # disambiguate a multi-region name
cdkd drift --all --json                 # machine-readable, for CI gating
cdkd drift MyStack --accept --yes       # state <- AWS (catch up to a console edit)
cdkd drift MyStack --revert --yes       # AWS <- state (undo a console edit)
cdkd drift MyStack --revert --dry-run   # preview either resolution
```

`cdkd drift` reads state only. It never synthesizes, so it takes no `--app`
and does not need the CDK app's source.

## What drift compares

```text diagram=drift-compares
 cdkd state (S3)                 Live AWS
 the values AWS reported         a fresh read of each resource
 at the last deploy
            │                              │
            └──────────────┬───────────────┘
                           ▼
                       cdkd drift
            compares the keys state records
                           │
                           ▼
  clean / drifted / deleted / not compared / drift unknown
```

cdkd does not deploy through CloudFormation, so CloudFormation's drift
detection does not apply. The comparison is cdkd state against a fresh read
from AWS. [`cdkd diff`](cli-diff.md) is the other comparison: the template
against state.

The state side is the **observed baseline**: the snapshot of the resource that
cdkd read from AWS when it deployed it (`observedProperties` in state). With
it, a console change to a property you never set in your CDK code still shows
as drift.

A resource with no observed baseline falls back to the properties from your
template, which only catches changes to properties you did set. To record a
baseline without redeploying, run
[`cdkd state refresh-observed MyStack`](cli-state.md#cdkd-state-refresh-observed).

Only keys present in state are compared. Fields AWS manages and cdkd never set
(timestamps, generated identifiers, account-wide defaults) are ignored.

## Reading the report

A stack with no drift prints one line:

```text
✓ MyStack (us-east-1): no drift detected (12 resources checked, 0 unsupported)
```

A stack with drift prints a block. A `-` line is the value in cdkd state and a
`+` line is the value AWS holds now:

```text
⚠ MyStack (us-east-1): drift detected on 2 resources

  - LegacyTopic (AWS::SNS::Topic) — DELETED outside cdkd: AWS reports it does not exist.

  ~ AssetsBucket (AWS::S3::Bucket)
    - VersioningConfiguration.Status: Enabled
    + VersioningConfiguration.Status: Suspended
```

Every resource ends in exactly one of five outcomes:

| Outcome | Meaning | In the report |
| --- | --- | --- |
| **clean** | Every recorded property was compared and matched. | Counted in the summary line. |
| **drifted** | At least one property differs. | `~ <logicalId> (<type>)` with a `-` / `+` pair per property. |
| **deleted** | AWS reports the resource does not exist. | `- <logicalId> (<type>) — DELETED outside cdkd`. |
| **not compared** | Nothing differed, but some or all properties were not compared. | Listed in a `NOT fully compared` or `only PARTIALLY compared` block, each with its reason. |
| **drift unknown** | Nothing read back proves the resource's state, typically because no provider reads its type. | `? <logicalId> (<type>)` in a block at the bottom, counted as `unsupported`. |

A deleted resource is drift and exits `1`. It is reported only when AWS itself
answers that the resource is not there. An access-denied or throttled read is
never reported as deleted.

### The summary line when not everything was compared

The `✓` is printed only when every resource cdkd attempted was fully compared.
Otherwise the line starts with `⚠` and says how much was checked:

```text
⚠ MyStack (us-east-1): no drift detected, but 1 of 3 resources fully checked (2 only partially compared), 1 unsupported
⚠ MyStack (us-east-1): no drift detected, but NOTHING was compared — 0 of 1 resource checked (1 unsupported, 0 skipped)
```

Unsupported and skipped resources are not part of the "checked" count. Custom
resources (`Custom::*`) are always skipped. A stack where nothing could be
compared still exits `0`; only the wording changes.

## Exit codes

| Code | Mode | Meaning |
| --- | --- | --- |
| `0` | detection | Nothing drifted, and nothing was left uncompared for a reason you can act on. |
| `0` | `--accept` / `--revert` | The run completed. It does not assert that every comparison completed. |
| `1` | any | Drift was detected (a deleted resource counts), or the command failed: no state found, an AWS error, bad arguments. |
| `2` | detection | Nothing drifted, but at least one comparison did not happen for a reason you can act on. |
| `2` | `--revert` | One or more resources were not reverted. |
| `2` | `--accept` / `--revert` | The run refused at least one [deleted resource](#deleted-resources). |

The cross-command table is in the [CLI Reference](cli-reference.md#exit-codes).

- Drift outranks a partial comparison: a run with both exits `1`.
- Which causes produce exit `2` is the last column of the
  [not-compared table](#why-a-resource-was-not-compared).
- `drift unknown` and skipped resources never change the exit code.
- An `--accept` or `--revert` run whose comparison was incomplete still exits
  `0`. It prints `Comparison INCOMPLETE — nothing to accept/revert, and that is
  NOT a clean bill of health` and names what was not compared.

To gate CI on "everything was compared and nothing drifted", run `cdkd drift`
without `--accept` / `--revert` and require exit `0`, or read `--json`:

```bash
cdkd drift --all --json | jq -e 'all(.[]; .drifted == [] and .deleted == [] and .notCompared == [])'
```

## Resolving drift: `--accept` and `--revert`

```text diagram=drift-accept-revert
              Drift reported on a property
                           │
          ┌────────────────┴────────────────┐
          ▼                                 ▼
   --accept                          --revert
   state <- AWS                      AWS <- state
   record the live value             push the recorded value back
   AWS is not modified               through the resource's provider
```

Pick the direction that matches the intent. The two flags are mutually
exclusive.

| | `--accept` | `--revert` |
| --- | --- | --- |
| Use when | The AWS-side change is intended and cdkd should catch up. | The AWS-side change should be undone. |
| Writes to | cdkd state only. | AWS, through each drifted resource's provider. |
| After it | The next `cdkd drift` reports clean. | The next `cdkd drift` reports clean. |

Both take the per-stack lock that `cdkd deploy` uses, print a plan, and ask
for confirmation unless `--yes` is given. Both do nothing on a clean stack,
and both skip resources reported as `drift unknown`.

A worked example, for a stack whose only drift is the `AssetsBucket` change
above:

::: steps
1. Preview the change

   ```bash
   cdkd drift MyStack --revert --dry-run
   ```

   ```text
   Plan (--revert): push cdkd state values back into AWS for MyStack (us-east-1):
     → provider.update on AssetsBucket (AWS::S3::Bucket): revert 1 property path
       VersioningConfiguration.Status: Suspended → Enabled
   --dry-run: AWS will NOT be modified. Re-run without --dry-run to apply.
   ```

   `--dry-run` takes no lock, writes nothing, and exits `0`.

2. Apply it

   ```bash
   cdkd drift MyStack --revert --yes
   ```

   The run ends with:

   ```text
   Revert summary: 1 reverted.
   ```

3. Confirm the stack is clean

   ```bash
   cdkd drift MyStack
   ```
:::

### `--accept` (state ← AWS)

`--accept` writes the AWS-current value of every drifted property into cdkd
state. AWS resources are not modified.

```text
Plan (--accept): update cdkd state for MyStack (us-east-1):
  ~ AssetsBucket (AWS::S3::Bucket)
    VersioningConfiguration.Status: Enabled → Suspended
```

The write goes to the observed baseline, so the properties from your last
deployed template stay as they were. For a resource with no observed baseline
the write goes to those properties instead.

A concurrent `cdkd deploy` cannot race the write: the save is conditional on
the state file being unchanged since it was read.

`--accept` refuses some properties and says so by name in the plan:

| Refused | Why |
| --- | --- |
| A secret-bearing property whose live value it cannot identify | It will not write `***`, or an unidentified value, into state. |
| A position state holds as the mask `***` | Accepting would write live plaintext over a redaction. |
| A resource whose baseline a `cdkd import` refused | See [Clearing a baseline refusal](#clearing-a-baseline-refusal). |
| A deleted resource | See [Deleted resources](#deleted-resources). |

### `--revert` (AWS ← state)

`--revert` calls each drifted resource's provider update to set the drifted
properties back to their recorded values. Properties that did not drift are
sent with their current AWS values, so they are left alone. State is normally
not modified.

`--concurrency <n>` (default `4`) bounds the parallel updates. One resource's
failure does not stop the rest. The run ends with a summary such as
`Revert summary: 3 reverted, 1 update-not-supported, 1 failed.` and exits `2`
when anything was not reverted.

| Line | Meaning | What to do |
| --- | --- | --- |
| `✗` ... | The AWS update call failed. Counted as `failed`. | Read the AWS error, fix the cause, re-run `--revert`. |
| `⊘ <stack>/<id> (<type>): could not revert — ...` | The type cannot be updated in place. Counted as `update-not-supported`. | Redeploy with `cdkd deploy --replace`, or destroy and redeploy. |
| Counted as `reference-unresolvable` | A secret reference in the baseline could not be re-resolved, or a masked position could not be matched. No AWS call was made. | Grant `secretsmanager:GetSecretValue` / `ssm:GetParameter`, or fix the reference. |

Types that report update-not-supported are those AWS treats as immutable
(`AWS::Lambda::LayerVersion`, `AWS::Lambda::Permission`,
`AWS::ApiGateway::Deployment`) and those cdkd has no in-place update for:
`AWS::AppSync::*`, `AWS::EFS::*`, `AWS::KinesisFirehose::DeliveryStream`,
`AWS::ApiGatewayV2::*`, `AWS::ApiGateway::Authorizer` / `Deployment` /
`Method`, `AWS::Glue::Database`, `AWS::ServiceDiscovery::*` and
`AWS::ElasticLoadBalancingV2::LoadBalancer`.

### What `--revert` leaves alone

The plan lists each of these before the confirmation prompt and under
`--dry-run`.

| Case | What the revert does |
| --- | --- |
| A tag added by a user or in the console | Removes it. |
| A service-managed tag in a top-level `Tags` list (`AmazonECSManaged`, any `aws:` prefix) | Keeps it, and names the key in the plan. |
| A resource with no observed baseline | Leaves values AWS wrote that the template never declared, and lists each path. |
| A drifted IAM Role or ManagedPolicy name | Reverts the other properties and warns that the name was left. |
| A drifted IAM `Path`, or a managed policy's `Description` | Fails that resource's revert. |
| An ELBv2 attribute key only AWS returns | Leaves the live value, with a warning. |
| A position state holds as the mask `***` | Keeps the live value, or refuses the whole resource when it cannot tell which value belongs there. |

For a resource with no observed baseline the plan prints a
`! this resource has no observed-capture baseline ... LEAVES N AWS-authored
values untouched` line naming each path. Run
`cdkd state refresh-observed MyStack` or redeploy first if you want those
reverted too.

A name that cannot be reverted keeps being reported until
`cdkd drift --accept` records the live one. Only a deploy renames the
resource.

A provider may re-create a resource to revert it: an
`AWS::EC2::SecurityGroupIngress` rule is revoked and re-authorized under a new
`sgr-` id. State then records the new physical id and attributes.

How the update is built, and when a revert writes a narrowed value back to
state, is in
[cdkd drift internals](cli-drift-internals.md#how-revert-builds-the-update).

### Deleted resources

Neither flag acts on a resource AWS reports deleted. `--revert` updates in
place and cannot recreate one, and `--accept` does not erase a state record.
Each such resource is refused by name, every other drifted resource is still
resolved, and the run exits `2`. With `--dry-run`, or when you decline the
prompt, it exits `0`.

A plain `cdkd deploy` does not recreate the resource either. A deploy compares
the template with cdkd state, and neither changed.

::: steps
1. Confirm the resource is gone

   Check in the AWS console or with the AWS CLI.

2. Remove it from the CDK app and deploy

   ```bash
   cdkd deploy MyStack
   ```

   Anything in the app that references the resource has to come out with it,
   and this deploy deletes those resources too. If the resource is meant to
   stay gone, stop here.

3. Restore it in the CDK app and deploy again

   ```bash
   cdkd deploy MyStack
   ```
:::

### A malformed state record

Detection reports on a state record it cannot fully read: the unreadable rows
are listed as not compared and the run exits `2`, or `1` when something else
drifted. `--accept` and `--revert`
refuse such a record before taking the lock, naming the stack, the region and
the logical ids. Inspect it with:

```bash
cdkd state show MyStack --json
```

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `[stacks...]` | — | Stack name(s) to check, as physical CloudFormation names. Each stack's [nested stacks](#nested-stacks) are checked with it. |
| `--all` | off | Check every stack in the state bucket. |
| `--json` | off | Emit the structured per-stack report on stdout, and nothing else. See [JSON output](#json-output). |
| `--accept` | off | Write the AWS-current values into cdkd state. Mutually exclusive with `--revert`. |
| `--revert` | off | Push cdkd state values back into AWS. Mutually exclusive with `--accept`. |
| `--dry-run` | off | With `--accept` or `--revert`: print the planned mutations and exit, without taking a lock or writing. |
| `--concurrency <number>` | `4` | Maximum concurrent provider updates during `--revert`. No effect on `--accept`. |
| `--stack-region <region>` | — | Region of the stack record to inspect. Required when one stack name has state in more than one region. |
| `-y`, `--yes` | off | Skip the confirmation prompt of `--accept` and `--revert`. |
| `--state-bucket <bucket>` | `CDKD_STATE_BUCKET` / `cdk.json` | S3 bucket holding the state records. |
| `--state-prefix <prefix>` | `cdkd` | S3 key prefix for state files. |
| `--profile <profile>` | — | AWS profile. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | IAM role to assume for AWS API calls. |
| `--verbose` | off | Verbose logging. |

With no stack named and `--all` unset, the single stack in state is selected,
with its nested stacks.

`--region` is deprecated. Prefer `AWS_REGION` or your AWS profile. It is still
honored if passed.

## Why a resource was not compared

The report names a reason for each resource it did not fully compare, and
`--json` carries it as `notCompared[].cause`. "Partly" means every other
property of the resource was compared.

| `cause` | What happened | Compared | Exit `2` |
| --- | --- | --- | --- |
| `refused` | cdkd could not attribute a secret reference in state to a region, and declined to resolve it. | Partly | Yes |
| `unresolvedToken` | State holds `{{resolve:...}}` text that is not a reference cdkd resolves. | Partly | No |
| `uncertifiedBaseline` | The baseline holds the mask `***` at [a position cdkd could not certify](#another-cause-of-a-masked-baseline-a-position-cdkd-could-not-certify). | Partly | Yes |
| `noEchoParameter` | State holds a `NoEcho` template parameter's value only as `***`. | Partly | No |
| `readFailed` | The read or the comparison failed, usually a missing permission or a throttle. | Not at all | Yes |
| `readAborted` | Five reads in a row failed in this stack, so cdkd stopped reading it that way. | Not at all | Yes |
| `baselineRefused` | A `cdkd import` refused to capture this resource's baseline. | Not at all | Yes |
| `unreadableRecord` | The state row is not readable as a resource, or its `properties` is not an object. | Not at all | Yes |
| `unreadableMap` | The record's whole `resources` map is not an object. Reported as one entry named `(resources map)`. | Not at all | Yes |

The two causes that do not produce exit `2` are permanent: no re-run can
compare the value, so failing CI on them would fail forever.

| `cause` | To clear it |
| --- | --- |
| `refused` | Spell the reference as a full ARN, which names its region. |
| `uncertifiedBaseline` | Run `cdkd deploy`; see the linked section. |
| `readFailed` | Grant the missing permission, or re-run after a throttle. |
| `readAborted` | Refresh the credentials or restore the role or permission, then re-run. |
| `baselineRefused` | See [Clearing a baseline refusal](#clearing-a-baseline-refusal). |
| `unreadableRecord`, `unreadableMap` | Repair or re-import the state record. |

Notes on individual causes:

- **`readAborted`** counts Cloud Control reads and SDK-provider reads
  separately, and a successful read resets the count. Five failures in a row
  usually mean expired credentials or a missing permission such as
  `cloudcontrol:GetResource`. Other stacks in the run are still read.
- **`refused`** also applies to a nested stack when a parent's state record is
  missing or unreadable, because a value the parent read from another region
  reaches the child without its region.
- A **drifted** resource can be partly compared too. Its changes are real, it
  carries `referencesUnresolved: true`, and it is also listed under
  `notCompared`.
- A type Cloud Control has no read handler for is `drift unknown`, not a
  failed read.

The usual reasons a secret reference cannot be resolved are a role without
`secretsmanager:GetSecretValue` / `ssm:GetParameter`, a deleted secret, and a
cross-region reference.

### Clearing a baseline refusal

The report row, the `--accept` / `--revert` refusals and
[`cdkd state show`](cli-state.md#cdkd-state-show) each name the remedy for the
resource. It depends on why the import refused it:

| Why the import refused it | What clears it |
| --- | --- |
| Its recorded properties could not position the secret redaction. | A deploy that changes the resource. A deploy that changes nothing does not. |
| It reads a template parameter whose deployed value cdkd could not prove. | Replacing the resource, or re-importing it while a CloudFormation stack can prove the value. An in-place update keeps the refusal. |
| Recorded by an older cdkd, with no reason. | Like the first row, unless the resource reads a template parameter; then like the second. |

`--accept` and `--revert` both decline such a resource. It has no trustworthy
baseline to accept into or revert to, and comparing it could print a decrypted
secret. The full rules are in
[the drift baseline an import records](import.md#the-drift-baseline-an-import-records).

A stack imported by a cdkd older than state schema v10 has no refusal marker,
so it is still compared. `cdkd drift` warns, naming the stack and the
resources without a baseline. Any later state write silences that warning
without fixing the records; re-run `cdkd import` for the stack to fix them.

## Nested stacks

cdkd deploys a nested stack's resources itself, so no CloudFormation stack
exists in AWS to read back. The resources are recorded as a stack of their
own, `<parent>~<child>`, in the parent's region. `cdkd drift` checks that
record whenever it checks the parent:

```bash
cdkd drift Parent                # Parent, then Parent~Child, then any stack below it
cdkd drift 'Parent~Child'        # the nested stack and the stacks below it, not Parent
```

Each nested stack gets its own block in the report, and drift inside one makes
the run exit `1`. A record is checked once however it is selected.
`--accept` and `--revert` act on each nested stack's drifted resources under
that record's own lock.

| The parent's `AWS::CloudFormation::Stack` row | Reported as |
| --- | --- |
| Its nested stack's record exists | `skipped`. The nested stack's own block covers it. |
| Its nested stack's record is gone | **deleted**, printed as `— RECORD MISSING` naming the record. |

A parent whose only resources are nested stacks prints
`✓ <parent> (<region>): no drift detected here — N nested stacks, each checked in its own block`.

A missing record comes about in one of two ways:

| How the record went missing | What to do |
| --- | --- |
| A `cdkd import --migrate-from-cloudformation` stopped part-way, after recording the parent | Re-run that import with `--force`. The resources are still live in the source CloudFormation stack. |
| The record was removed after a deploy, by hand or by `cdkd state orphan` | Its resources are no longer tracked and may still exist in AWS. Check before recreating the nested stack. |

`--accept` and `--revert` refuse a `RECORD MISSING` row by name, as they
refuse any deleted resource.

## Secret and redacted values

cdkd state holds a secret dynamic reference as its unresolved expression:
`{{resolve:secretsmanager:...}}`, `{{resolve:ssm-secure:...}}`, or
`{{resolve:ssm:...}}` naming a `SecureString` parameter. To compare such a
property, `cdkd drift` resolves the reference in memory. Detection writes
nothing back.

That needs read access to the referenced secrets:
`secretsmanager:GetSecretValue`, or `ssm:GetParameter` with `kms:Decrypt` on
the parameter's key. Without it, or when the secret was deleted, cdkd warns
and continues. That resource's secret-bearing properties are listed as not
compared, and every other resource is unaffected.

| AWS holds at a secret-bearing property | Reported as |
| --- | --- |
| The value the reference resolves to | Clean. |
| Anything else | Drifted, with the AWS side shown as `***`. |
| Nothing for that property (a write-only credential such as `MasterUserPassword`) | Neither clean nor drifted. It cannot be checked. |
| Nothing for a whole block (all environment variables removed) | Drifted. `--accept` refuses it; use `--revert`. |

The commonest cause of the second row is a Secrets Manager rotation, where the
deployed resource still carries the previous version. An out-of-band edit
looks identical, so cdkd prints neither value.

`--accept` refuses a drifted secret-bearing property, and the drift keeps
being reported. `--revert` resolves the reference first, so the resource
receives the secret value, not the `{{resolve:...}}` text.

`cdkd drift` does not tell you whether state holds a secret in plaintext. Run
`cdkd scrub --dry-run --fail` for that; see [`cdkd scrub`](cli-scrub.md).

### Redacted (`NoEcho`) baselines

Some positions in state hold the literal mask `***` and no reference to
resolve:

| Source of the mask | Effect on drift |
| --- | --- |
| A `NoEcho` custom-resource response value resolved into a property | Reported as drifted on every run. |
| The `Fn::Base64` encoding of a secret, such as `UserData` around a `{{resolve:...}}` reference | Reported as drifted on every run. |
| A `NoEcho` template parameter | Listed as `noEchoParameter` by path. No effect on the exit code. |

For the first two, cdkd's side is the mask and AWS's side is the real value,
so they never match. The report prints `***` on both sides and detection exits
`1` every time. No deploy clears it. cdkd reports it because the live value is
readable and cdkd cannot say whether it is the right one.

- `--accept` refuses the position.
- `--revert` keeps the value AWS has there. It refuses the whole resource
  (exit `2`) when AWS reports nothing at the position, or when the mask is in
  a list whose elements it cannot match to the recorded ones.

If a stack in this state must gate CI on drift, either stop marking the custom
resource's response `NoEcho`, or gate on `--json` and filter the known
position out.

When `--revert` refused because AWS reports nothing at the position, change a
property of the custom resource (a nonce is the usual way) and redeploy, so
its handler runs again and supplies the value.

A property whose real value is the string `***` is treated the same way; see
[State Management](state-management.md#noecho-custom-resource-responses).
List matching and the remaining refusal cases are in
[cdkd drift internals](cli-drift-internals.md#redacted-noecho-baselines).

### Another cause of a masked baseline: a position cdkd could not certify

When cdkd records an observed baseline, it replaces each decrypted secret AWS
returned with the `{{resolve:...}}` reference from the template, matching by
position. Where it cannot line the AWS response up with the reference, it
writes `***` instead of risking a secret in state. This happens when AWS
restructures or reorders the property, normalises a name (`db` returned as
`DB`), or when a `cdkd import` recorded a raw `Fn::Join` object.

A stack adopted with `cdkd import` can show this on its first `cdkd drift`.

| At the masked position | Reported as | `--accept` | `--revert` |
| --- | --- | --- | --- |
| The mask is the only difference | Not compared, cause `uncertifiedBaseline`. Detection exits `2`. | Writes nothing there. | Sends AWS's own value back unchanged. |
| Anything else differs (an edited neighbour, a resized or reordered list) | Drifted, with the AWS side masked. | Refuses it. | Often refuses the whole resource. |

The rest of the resource is compared as usual. A secret changed exactly at a
masked position cannot be seen.

The fix is a `cdkd deploy`, even one that changes nothing. At the start of
every deploy cdkd re-reads each such resource and replaces a mask with the
reference when the value AWS holds is exactly what the reference resolves to.

- A secret rotated since the resource was last deployed keeps its mask, until
  a deploy that creates or updates that resource.
- `cdkd state refresh-observed` does not clear a mask.
- A resource whose only baseline is a raw `Fn::Join` / `Fn::Sub` object is
  refused by `--revert` (exit `2`). The same `cdkd deploy` fixes it.

The shapes that produce the mask and the refresh rules are in
[cdkd drift internals](cli-drift-internals.md#a-masked-position-cdkd-could-not-certify).

### Tokens that are not references

A `{{resolve:...}}` string cdkd does not resolve is text that only looks like
a reference, or a service AWS adds later. The property is reported as not
compared with the cause `unresolvedToken`, and a warning names the token once
per resource.

When `--revert` runs because another property of the same resource drifted, it
either leaves the live value at the token's position unchanged, or writes the
token literally as `cdkd deploy` would. The warning printed before the
confirmation prompt says which. The rules are in
[cdkd drift internals](cli-drift-internals.md#tokens-that-are-not-references).

A resource deployed by a cdkd release that predates `ssm-secure` resolution
can hold the literal `{{resolve:ssm-secure:...}}` text in AWS. `cdkd drift`
reports it for a property the provider reads back, and `--revert` writes the
resolved value. A write-only property such as `MasterUserPassword` needs one
deploy that updates it.

## What is not reported as drift

| Case | Why it is skipped |
| --- | --- |
| An undeclared key whose recorded value was empty (`[]`, `{}`, `null`) | A sibling resource or AWS fills it in after the deploy, such as a cluster's `CapacityProviders` or standalone security-group rules. |
| `aws:`-prefixed tags (`aws:cdk:path`) | CDK and AWS add them; they are not your `Tags`. |
| An undeclared ELBv2 attribute the baseline holds and AWS stopped returning | AWS changes the returned key set on its own. |
| A stack-name-prefixed name on a stack deployed with `--prefix-user-supplied-names` | `my-role` in state and `MyStack-my-role` in AWS are the same name. |

An undeclared key recorded with a real value, such as an AWS-side default, is
still compared. User tags are compared for every type drift can read, in a
stable order. IAM Role, User and Group inline policies are compared too.

The prefixed-name rule covers an IAM Role, User, Group, InstanceProfile or
ManagedPolicy and an ELBv2 LoadBalancer or TargetGroup. A live name cdkd would
not derive from the template's is still reported.

### ELBv2 attributes AWS stops or starts reporting

`LoadBalancerAttributes`, `TargetGroupAttributes` and `ListenerAttributes` are
recorded in full, including keys the template never declared. AWS sometimes
stops or starts returning a key, such as `ddos_protection.syn_cookie.mode` on
an ALB.

| Case | `cdkd drift` | `--revert` |
| --- | --- | --- |
| An undeclared key the baseline holds, absent from AWS | Not reported | Does not write the key back |
| A key AWS returns that the baseline lacks | Reported | Leaves the live value in place, with a warning |
| A declared key that changes or disappears | Reported | Writes the recorded value back |
| A changed value on a key both sides hold | Reported | Writes the recorded value back |

A key only AWS returns is reported because cdkd cannot tell a key AWS started
returning from a value someone set. If the live value is expected, run
`cdkd drift --accept` to record it. Otherwise declare the value in the
template and deploy.

## Resource type coverage

Drift detection covers every resource type that can be read back. Two routes
do the reading:

- cdkd's own SDK providers, for the types in the table below;
- the Cloud Control API, for every other type it can read.

A type neither route can read is reported as `drift unknown`.

| Service | Types |
| --- | --- |
| `AWS::ApiGateway` | `Account`, `Authorizer`, `Deployment`, `Method`, `Resource`, `Stage` |
| `AWS::ApiGatewayV2` | `Api`, `Authorizer`, `Integration`, `Route`, `Stage` |
| `AWS::AppSync` | `ApiKey`, `DataSource`, `GraphQLApi`, `GraphQLSchema`, `Resolver` |
| `AWS::AutoScaling` | `AutoScalingGroup` |
| `AWS::BedrockAgentCore` | `Browser`, `CodeInterpreter`, `Evaluator`, `Runtime` |
| `AWS::CertificateManager` | `Certificate` |
| `AWS::CloudFormation` | `WaitConditionHandle` |
| `AWS::CloudFront` | `CloudFrontOriginAccessIdentity`, `Distribution`, `OriginAccessControl` |
| `AWS::CloudTrail` | `Trail` |
| `AWS::CloudWatch` | `Alarm` |
| `AWS::CodeBuild` | `Project` |
| `AWS::CodeCommit` | `Repository` |
| `AWS::Cognito` | `UserPool` |
| `AWS::DLM` | `LifecyclePolicy` |
| `AWS::DocDB` | `DBCluster`, `DBInstance`, `DBSubnetGroup` |
| `AWS::DynamoDB` | `GlobalTable`, `Table` |
| `AWS::EC2` | `EIP`, `Instance`, `InternetGateway`, `NatGateway`, `NetworkAcl`, `NetworkAclEntry`, `Route`, `RouteTable`, `SecurityGroup`, `SecurityGroupIngress`, `Subnet`, `SubnetNetworkAclAssociation`, `SubnetRouteTableAssociation`, `VPC`, `VPCGatewayAttachment` |
| `AWS::ECR` | `Repository` |
| `AWS::ECS` | `Cluster`, `Service`, `TaskDefinition` |
| `AWS::EFS` | `AccessPoint`, `FileSystem`, `MountTarget` |
| `AWS::ElastiCache` | `CacheCluster`, `SubnetGroup` |
| `AWS::ElasticLoadBalancingV2` | `Listener`, `LoadBalancer`, `TargetGroup` |
| `AWS::EMR` | `Cluster` |
| `AWS::Events` | `EventBus`, `Rule` |
| `AWS::FSx` | `FileSystem` |
| `AWS::Glue` | `Connection`, `Crawler`, `Database`, `Job`, `SecurityConfiguration`, `Table`, `Trigger`, `Workflow` |
| `AWS::IAM` | `AccessKey`, `Group`, `InstanceProfile`, `ManagedPolicy`, `Policy`, `Role`, `User`, `UserToGroupAddition` |
| `AWS::Kinesis` | `Stream`, `StreamConsumer` |
| `AWS::KinesisFirehose` | `DeliveryStream` |
| `AWS::KMS` | `Alias`, `Key` |
| `AWS::Lambda` | `EventInvokeConfig`, `EventSourceMapping`, `Function`, `LayerVersion`, `MicrovmImage`, `Permission`, `Url` |
| `AWS::Logs` | `LogGroup` |
| `AWS::Neptune` | `DBCluster`, `DBInstance`, `DBSubnetGroup` |
| `AWS::Pipes` | `Pipe` |
| `AWS::RDS` | `DBCluster`, `DBInstance`, `DBProxy`, `DBProxyEndpoint`, `DBProxyTargetGroup`, `DBSubnetGroup` |
| `AWS::Route53` | `HostedZone`, `RecordSet` |
| `AWS::S3` | `Bucket`, `BucketPolicy` |
| `AWS::S3Express` | `DirectoryBucket` |
| `AWS::S3Tables` | `Namespace`, `Table`, `TableBucket` |
| `AWS::S3Vectors` | `VectorBucket` |
| `AWS::Scheduler` | `Schedule` |
| `AWS::SecretsManager` | `Secret` |
| `AWS::ServiceDiscovery` | `HttpNamespace`, `PrivateDnsNamespace`, `PublicDnsNamespace`, `Service` |
| `AWS::SNS` | `Subscription`, `Topic`, `TopicPolicy` |
| `AWS::SQS` | `Queue`, `QueuePolicy` |
| `AWS::SSM` | `Parameter` |
| `AWS::StepFunctions` | `StateMachine` |
| `AWS::WAFv2` | `WebACL` |

Five types with an SDK provider have no read-back of their own and use the
Cloud Control route: `AWS::Budgets::Budget`, `AWS::CloudFormation::Stack`,
`AWS::CloudWatch::AnomalyDetector`, `AWS::EMR::InstanceFleetConfig` and
`AWS::EMR::InstanceGroupConfig`.

These types are always `drift unknown`, because the Cloud Control response
differs from what state holds and would report false drift on every run:

| Type | Reason |
| --- | --- |
| `AWS::ApiGateway::RestApi` | `Body` / `BodyS3Location` are write-only inputs the response omits. |
| `AWS::EC2::LaunchTemplate` | The response carries version-bumped `LaunchTemplateData` and a synthetic `LatestVersionNumber`. |
| `AWS::CloudWatch::AnomalyDetector` | Its physical id is a cdkd-derived descriptor Cloud Control cannot address. |

An `AWS::CloudFormation::Stack` row is handled as described under
[Nested stacks](#nested-stacks).

> [!NOTE]
> Several types above (`AWS::ApiGateway::Method`, `AWS::Route53::RecordSet`,
> `AWS::AppSync::DataSource` / `Resolver` / `ApiKey`, `AWS::Glue::Table`,
> `AWS::S3Tables::Namespace` / `Table`, and the EC2 sub-resources) have a
> composite, `|`-delimited physical id. Quote it on a shell command line. The
> per-type formats are in
> [State Management](state-management.md#composite-pipe-delimited-physicalids).

## JSON output

`--json` emits an array of per-stack reports:

```json
[
  {
    "stack": "MyStack",
    "region": "us-east-1",
    "drifted": [
      {
        "logicalId": "Bucket1",
        "type": "AWS::S3::Bucket",
        "changes": [
          {
            "path": "VersioningConfiguration.Status",
            "stateValue": "Enabled",
            "awsValue": "Suspended"
          }
        ],
        "referencesUnresolved": false
      }
    ],
    "deleted": [
      { "logicalId": "Topic1", "type": "AWS::SNS::Topic" }
    ],
    "clean": [
      { "logicalId": "Queue1", "type": "AWS::SQS::Queue", "referencesUnresolved": false }
    ],
    "notSupported": [
      { "logicalId": "Function1", "type": "AWS::Lambda::Function" }
    ],
    "skipped": [],
    "notCompared": []
  }
]
```

| Field | Holds |
| --- | --- |
| `drifted` | Resources with at least one differing property, with `stateValue` and `awsValue` per path. |
| `deleted` | Resources AWS reports deleted. A nested stack row whose record is gone carries `"nestedStackRecordMissing": true`. |
| `clean` | Resources fully compared and matching. Always `referencesUnresolved: false`. |
| `notSupported` | Resources reported as `drift unknown`. |
| `skipped` | Resources cdkd does not drift-check, including a nested stack row checked in its own report. |
| `notCompared` | Resources not fully compared, each with a `cause`. A partly compared drifted resource appears here as well. |
| `warnings` | Stack-level advisory strings. Omitted when there are none. |

`warnings` exists because cdkd's warnings go to stderr while the payload goes
to stdout. The strings are for a human reading a log. They carry stack names,
regions, logical ids and counts, never a property value.

A populated `notCompared`:

```json
"notCompared": [
  {
    "logicalId": "Function1",
    "type": "AWS::Lambda::Function",
    "referencesUnresolved": true,
    "cause": "refused"
  },
  {
    "logicalId": "Budget1",
    "type": "AWS::Budgets::Budget",
    "referencesUnresolved": false,
    "cause": "readFailed"
  }
]
```

| Key | Meaning |
| --- | --- |
| `cause` | One of the values in the [not-compared table](#why-a-resource-was-not-compared). Gate on this to tell a clearable cause from a permanent one. |
| `referencesUnresolved` | `true` for the causes where the rest of the resource was compared, `false` where nothing was. |

Do not filter on `referencesUnresolved` to find uncompared resources: that
drops the entries for which nothing was compared at all. Gate on
`notCompared.length` or on `cause`.

Older cdkd releases listed a resource deleted outside cdkd, and a nested stack
row, in `notSupported`.

### Streams under `--json`

With `--json`, stdout carries the payload and nothing else, in every mode. The
lines the command would otherwise print on stdout go to stderr: the
`--accept` / `--revert` plan, the confirmation prompt, the `--dry-run` notice,
the `Comparison INCOMPLETE` block, the `✓ State updated` and `Revert summary`
lines, and `--verbose` output.

```bash
cdkd drift MyStack --json --accept --yes > report.json 2> progress.log
```

The payload is not sanitised, because a consumer wants the stored value.
Control, format and line-separator characters are written as `\uXXXX` escapes,
so it parses back to the stored values and printing it cannot run a terminal
control sequence. Which other commands reserve stdout is under
[Output streams: when stdout is a payload](cli-reference.md#output-streams-when-stdout-is-a-payload).

## What the human report does to a malformed value

The report prints text it reads from the state record and from AWS: stack
names, regions, logical ids, resource types, property paths and values. It
treats all of it as untrusted, so a crafted value cannot forge a report line
or send control sequences to your terminal. The `--accept` and `--revert`
plans follow the same rules.

| Text | What the report does |
| --- | --- |
| A control character in an identifier | Replaces it with a space. Cursor-movement and link escape sequences are removed whole. |
| An identifier longer than 255 characters | Cuts it and appends `...`. |
| A property value with a control character, edge whitespace, or a leading `"` | Prints it as a JSON string, such as `"abc\n"` or `" value "`. |
| Any other string value | Prints it unquoted and unchanged. |
| An object or list value | JSON-encodes it, with the same escaping. |
| A plan value containing `->` or an arrow character | Quotes it, so the only unquoted `→` on a plan line is the separator. |

Two values that differ only by a trailing newline, a tab or padding therefore
print differently. Values that differ only by another invisible character or a
look-alike letter can still print alike. The full rules are in
[cdkd drift internals](cli-drift-internals.md#what-the-human-report-does-to-a-malformed-value).

## Related

- [Drift Detection](drift.md): the same subject, summarised for a first read
- [State Management](state-management.md): the state schema, `observedProperties`, and `cdkd state refresh-observed`
- [`cdkd scrub`](cli-scrub.md): keeping secret plaintext out of the state records drift compares against
- [`cdkd diff`](cli-diff.md): the template-vs-state comparison
- [CLI Reference](cli-reference.md): every command and the full exit-code table
- [Troubleshooting](troubleshooting.md): what to do when a drift run fails
- [cdkd drift internals](cli-drift-internals.md): the rules behind the edge cases
