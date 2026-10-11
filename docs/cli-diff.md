---
title: cdkd diff
description: "Preview what the next cdkd deploy would create, update and delete, and gate CI on the result."
---

# cdkd diff

`cdkd diff` shows what the next `cdkd deploy` would do: which resources it
would create, update or delete. It changes nothing, in AWS or in cdkd state,
so it is safe to run at any time.

```bash
# the single stack in the app
cdkd diff

# one stack by name
cdkd diff MyStack

# every stack under a stage
cdkd diff 'MyStage/*'

# every top-level stack in the app
cdkd diff --all

# descend into nested stacks
cdkd diff ParentStack --recursive

# CI gate: exit 1 on any change
cdkd diff --all --fail

# CI gate: exit 1 only on a replace / delete / orphan
cdkd diff --all --fail-on=destructive

# machine-readable payload
cdkd diff MyStack --json
```

## What diff compares

Diff compares your CDK app with cdkd state. It synthesizes the app into a
template, reads the state file the last deploy wrote, and lists the
differences.

```text diagram=diff-compares
 Synthesized template            cdkd state (S3)
 what the app declares now       what the last deploy recorded
            │                              │
            └──────────────┬───────────────┘
                           ▼
                       cdkd diff
              reads both, writes neither
                           │
                           ▼
          [+] create    [~] update    [-] delete
          what the next cdkd deploy would apply
```

Diff does not look at the resources in AWS. A change someone made in the AWS
console therefore does not show up here. To compare state with what AWS
actually holds, use [`cdkd drift`](cli-drift.md).

## Reading the output

Each stack with changes gets a block. The block has the stack's name, one
entry per changed resource, and a line of totals:

```text
Stack MyStack:
  [+] AssetsBucket (AWS::S3::Bucket)
  [~] ApiFunction (AWS::Lambda::Function)
      - Timeout:
          old: 3
          new: 30
  [-] LegacyTopic (AWS::SNS::Topic)

1 to create, 1 to update, 1 to delete
```

- `[+]` marks a resource the deploy would create.
- `[~]` marks a resource the deploy would update. Each changed property is
  listed under it with its old and new value.
- `[-]` marks a resource the deploy would delete.

Resources that would not change are not listed. A stack with nothing to do
prints one line and no block:

```text
✓ No changes detected for stack MyStack
```

### Notes on a property line

A changed property can carry a note after it. The notes tell you how the
deploy will treat that property.

- `[requires replacement]`: AWS cannot change this property in place, so the
  deploy replaces the whole resource.
- `(known after deploy)`: the new value refers to a resource this deploy will
  create, so the value does not exist yet.
- `[metadata only, no AWS API call]`: a `DeletionPolicy` or
  `UpdateReplacePolicy` changed. cdkd records it in state and does not call
  AWS.
- `[masked input or expression changed]`: the property is stored as `***`
  because it carries a secret. Both sides print `***`, and the deploy sends
  the property again. See
  [cdkd diff: secrets and NoEcho values](cli-diff-secrets.md#a-property-stored-as).

### Properties that change because another resource changes

Some properties are listed although their text in the template is the same as
before. They refer to another resource, and that resource is changing.

- `[replacement propagated]`: the property refers to a resource that is being
  replaced, so the physical ID or ARN it points at will be different.
- `[attribute propagated]`: the property reads an attribute or the physical ID
  of a resource that is being updated. The value may or may not move. The
  deploy sends this update only if it did.
- `[may require replacement]`: appears on a propagated line when the property
  cannot change in place. If the value it reads moves, the deploy replaces
  this resource.

A changed nested stack or custom resource produces many `[attribute
propagated]` lines. Every resource that reads one of its outputs, attributes
or its physical ID is listed, because only the deploy learns the new values.
The deploy skips each one whose value did not move.

### `[via CC API: ...]`: routing

cdkd creates and updates most resources by calling the AWS service directly.
For some properties it sends the resource through the AWS Cloud Control API
instead. A create or update line names the properties that cause this:

```text
  [~] HttpApi (AWS::ApiGatewayV2::Api) [via CC API: Body]
```

A resource that was deployed through Cloud Control stays on it for its next
update, and its line reads `[via CC API: sticky]`. A resource the deploy
replaces is routed like a new one, so its line never says `sticky`. Delete
lines carry no routing note.

### `[adopted from a rollback orphan]`

```text
  [~] Bucket (AWS::S3::Bucket) [adopted from a rollback orphan]
```

This line means the resource already exists in AWS, left there by an earlier
failed deploy. That deploy rolled back, and the rollback kept the resource
because its `DeletionPolicy` is `Retain`. The next deploy takes the existing
resource back into state and does not create a second one. That is why the
line is an update and not a create.

When the adopted resource needs no property change, it has no line of its
own. The totals name it instead:

```text
0 to create, 0 to update, 0 to delete
1 resource(s) to adopt from a previous rollback: Bucket
```

A stack like this has a pending change, so it does not print "No changes
detected", and `--fail` counts the adoption.

Before it shows an adoption, the diff checks two things in AWS: that the
resource still exists under the recorded physical ID, and that no other cdkd
stack claims it. If another stack does claim it, the diff reports the problem
under `Blocking` and exits `3`.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The diff was computed. |
| `1` | `--fail-on` matched a change, or the command failed. |
| `3` | The diff was computed, and `cdkd deploy` would refuse to start. |

Exit `0` does not mean "no changes". Without `--fail` or `--fail-on`, a diff
that lists changes still exits `0`.

Exit `1` has two meanings, and the output tells them apart. A run that failed
on `--fail-on` prints the full report first. A command that failed prints an
error. The command fails on:

- a crash while synthesizing the app,
- an AWS authentication error,
- a cross-stack reference that cannot be resolved,
- a stack pattern that matches nothing,
- an app with more than one stack when none was selected,
- a cyclic nested template.

`cdkd diff` never exits `2`. When both exit `3` and `--fail` apply, the run
exits `3`.

### Exit `3` — the deploy would refuse

Exit `3` means the diff found something that makes `cdkd deploy` stop before
it changes anything. The preview is printed in full first, and the reasons
follow under a heading:

```text
Blocking (cdkd deploy will refuse):
```

Running the diff again does not clear exit `3`. One of these has to be fixed:

| Condition | What to do |
| --- | --- |
| A resource to adopt from a rollback is claimed by another cdkd stack | Remove it from the stack that should not own it. |
| Part of the state record cannot be read | Repair the state record. |
| The record of a resource to adopt from a rollback is damaged | Repair the state record. |
| A resource's `Type` changes to or from `AWS::CloudFormation::Stack` | Give the new resource a different logical ID, or remove it in one deploy and add the replacement in the next. |
| A custom resource's `ServiceToken` changes | Give the custom resource a new logical ID. |

In CDK, a new logical ID means a new construct ID or a call to
`overrideLogicalId`. The second and third rows are described under
[cdkd diff: incomplete or malformed state](cli-diff-state-records.md#when-the-state-record-is-malformed).

Two cases are warnings and do not exit `3`:

- A `ServiceToken` that refers to a resource this deploy creates or replaces
  is not known until that resource exists. The diff warns, and the deploy
  refuses it at that point. See
  [a changed custom-resource ServiceToken](cli-deploy-custom-resources.md#a-changed-custom-resource-servicetoken).
- A damaged state record on a nested stack gets a warning. A deploy skips a
  nested stack that did not change, so the damage does not always stop it.
  The other three conditions exit `3` on any stack the diff visits.

The full rules are in
[cdkd diff internals](cli-diff-internals.md#exit-3-the-five-conditions-and-the-nodes-that-raise-them).

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `--all` | off | Diff every top-level stack in the app. Use `'**'` to include Stage stacks. |
| `--stack <name>` | — | A single stack name, as an alternative to the positional argument. |
| `--output <path>` | `cdk.out` | Synthesis output directory. |
| `--recursive` | off | Diff every nested stack against its own state. See [`--recursive`](#recursive-nested-stacks). |
| `--fail-on <kind>` | `never` | Exit `1` on `any-change` or `destructive` changes. See [`--fail-on`](#fail-on). |
| `--fail` / `--no-fail` | off | Aliases for `--fail-on=any-change` / `--fail-on=never`. Cannot be combined with `--fail-on`. |
| `--json` | off | Emit the diff as JSON. See [cdkd diff: JSON output](cli-diff-json.md). |
| `--use-cdk-bootstrap-assets` | off | Compare against the CDK bootstrap asset destinations verbatim, skipping cdkd's asset-storage redirection. |
| `--no-cfn-fallback` | fallback on | Do not fall back to CloudFormation when a cross-stack reference is missing from cdkd state. See [`--no-cfn-fallback` (deploy / diff)](cli-deploy-safety-ci-flags.md#no-cfn-fallback-deploy-diff). |
| `--region <region>` | AWS profile / `AWS_REGION` | Deprecated, still honored. Prefer `AWS_REGION` or your AWS profile. |

`cdkd diff` also accepts the flags every command shares: `--app`,
`--state-bucket`, `--state-prefix`, `--context`, `--profile`, `--role-arn`,
`--verbose`. See the [CLI Reference](cli-reference.md).

## Stack selection

You choose stacks the same way as for `cdkd deploy` and `cdkd destroy`.

| You pass | Selects |
| --- | --- |
| Nothing | The app's only stack. |
| A name | The stack with that CDK path or physical name. |
| Several names | All of them, each once. |
| `'*'`, `'MyStage/*'` | The top-level stacks, or one Stage's stacks. |
| `'**'` | Every stack. |
| `--all` | The top-level stacks. |

Some details:

- With no argument and more than one stack in the app, cdkd lists the stacks
  and exits `1`.
- A name matches a CDK display path such as `MyStage/Api`, or exactly a
  physical name such as `MyStage-Api`.
- A `*` matches within one `/` segment of the path.
- `--all` selects what the AWS CDK CLI selects. cdkd names any Stage stacks it
  left out.
- Quote wildcards so that the shell does not expand them.

A pattern that matches nothing is an error. cdkd names the patterns it tried
and lists the stacks the app contains. A CDK Stage that fails to load stops
the diff whatever was selected; see
[the failed-Stage note](cli-deploy-safety-assembly-checks.md#a-pre-synthesized-assembly-is-trusted-input).
More detail is under [stack selection](cli-list.md#selecting-stacks).

## `--fail-on`

`--fail-on` makes `cdkd diff` exit `1` when the diff contains a kind of change
you choose. It is how you use diff as a CI check. The flag matches
`cdk diff --fail-on`.

```bash
# fail when anything would change
cdkd diff --all --fail-on=any-change

# fail only when a resource would be lost
cdkd diff --all --fail-on=destructive
```

| Value | Exits `1` when |
| --- | --- |
| `any-change` | Anything changed. `--fail` is an alias. |
| `destructive` | A change replaces, deletes or orphans an existing resource. |
| `never` (default) | Never. `--no-fail` is an alias. |

`--fail-on` can be given only once, and it cannot be combined with `--fail` or
`--no-fail`. The AWS CDK CLI's `broadening` value is not available, because
cdkd does not compute a security diff.

### `any-change`

`any-change` fails on every difference the diff reports. Three kinds are easy
to miss:

- a change to stack outputs alone,
- a resource to adopt from a rollback,
- a part of the state record the diff could not read.

Changes inside nested stacks count only when you also pass `--recursive`:

```bash
cdkd diff ParentStack --recursive --fail-on=any-change
```

### `destructive`

`destructive` fails only when a change would lose an existing resource.
Additions and updates in place pass. The two common causes are a property
change that requires replacement, and a refactor that changed the logical ID
of a resource that holds data.

This mode always checks nested stacks, as if `--recursive` were given.

Each destructive change is listed after the diff:

```console
$ cdkd diff --fail-on=destructive MyStack
...
❌  Found 2 destructive change(s) (--fail-on=destructive):
  MyStack: AWS::S3::Bucket MyBucket MyBucketF68F3FF0 will be replaced
  MyStack: AWS::DynamoDB::Table MyTable MyTable794EDED1 will be orphaned
```

Each line gives the stack, the resource type, the construct path, the logical
ID, and the impact. The impact is one of:

| Impact | When |
| --- | --- |
| `will be replaced` | A create-only property changes, or the resource's `Type` changes. |
| `may be replaced` | A create-only property reads a value only the deploy can resolve. |
| `will be destroyed` | The resource leaves the template. |
| `will be orphaned` | The resource leaves the template with `DeletionPolicy: Retain` or `RetainExceptOnCreate`. |

An orphaned resource stays in AWS, and cdkd stops managing it. `may be
replaced` fails the check too. `AWS::CDK::Metadata` is never reported.

The construct path of a removed resource comes from state, where the last
deploy recorded it. Older cdkd releases did not record paths. A stack one of
them last saved lists a removed resource by logical ID only, until the next
deploy that writes state.

## `--recursive` (nested stacks)

By default `cdkd diff` does not look inside nested stacks, which matches
`cdk diff`. The parent shows one changed `AWS::CloudFormation::Stack`
resource, with a `TemplateURL` or `Parameters` change, and nothing below it is
inspected.

`--recursive` compares each nested stack with its own state:

```bash
cdkd diff ParentStack --recursive
```

Each nested stack with changes is printed under a `Nested stack: <name>`
header. The name is the nested stack's full name in state, with `~` between
the levels, as `cdkd state show --show-nested` prints it. Nested stacks with
no changes are checked and print nothing.

What a new or removed nested stack looks like, the templates the diff refuses
to load, and nested stacks whose parameters hold secrets are covered in
[cdkd diff: nested stacks](cli-diff-nested-stacks.md).

## List-typed parameters in `Fn::Equals`

> [!WARNING]
> A list-typed parameter compared against a string in `Fn::Equals` is always
> unequal. A resource gated on that condition is pruned, so the next deploy
> deletes it. Read the DELETE lines of `cdkd diff` before deploying.

A `Ref` to a list-typed parameter resolves to a list, and `Fn::Equals`
compares the shape of its two sides as well as their content. A list is never
equal to a string. For a `List<String>` parameter `Envs` that defaults to
`prod`:

```yaml
Fn::Equals: [{ Ref: Envs }, 'prod']     # false: ["prod"] is not "prod"
Fn::Equals: [{ Ref: Envs }, ['prod']]   # true: compare against a list
```

To make the condition true, compare against a list as in the second line, or
declare the parameter `Type: String`.

## In this section

- [cdkd diff: JSON output](cli-diff-json.md): the `--json` schema, field by field.
- [cdkd diff: stack outputs](cli-diff-outputs.md): how output changes are shown,
  and why the Outputs section is sometimes missing.
- [cdkd diff: secrets and NoEcho values](cli-diff-secrets.md): why a value prints
  as `***` or is withheld.
- [cdkd diff: nested stacks](cli-diff-nested-stacks.md): `--recursive` in detail,
  refused nested templates, and secret-fed nested parameters.
- [cdkd diff: incomplete or malformed state](cli-diff-state-records.md): what the
  diff does when the state record lacks a value or is damaged.

## Related

- [Stop on Destructive Changes](destructive-changes.md): using
  `--fail-on=destructive` with `cdkd deploy --require-approval`
- [cdkd deploy](cli-deploy.md): applying what this previews
- [cdkd deploy: safety & compatibility flags](cli-deploy-safety.md): `--no-cfn-fallback` and the other guards
- [`cdkd drift`](cli-drift.md): compare state against what AWS actually holds
- [`cdkd scrub`](cli-scrub.md): repair state records holding plaintext secrets
- [Cross-Stack References](cross-stack-references.md): how `Fn::ImportValue` and `Fn::GetStackOutput` resolve
- [CLI Reference](cli-reference.md): the flags every command shares
- [cdkd diff internals](cli-diff-internals.md): the rules behind the edge cases
