---
title: cdkd diff
description: "Preview what the next cdkd deploy would create, update and delete, and gate CI on the result."
---

# cdkd diff

`cdkd diff` synthesizes the CDK app and reports the resources the next
`cdkd deploy` would create, update or delete. It reads cdkd state and never
writes it, so it is safe to run at any time.

```bash
cdkd diff                                  # the single stack in the app
cdkd diff MyStack                          # one stack by name
cdkd diff 'MyStage/*'                      # every stack under a stage
cdkd diff --all                            # every top-level stack in the app
cdkd diff ParentStack --recursive          # descend into nested stacks
cdkd diff --all --fail                     # CI gate: exit 1 on any change
cdkd diff --all --fail-on=destructive      # CI gate: exit 1 only on a replace / delete / orphan
cdkd diff MyStack --json                   # machine-readable payload
```

## What diff compares

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

The comparison is the template against cdkd state. Live AWS resources are not
compared, so a change someone made in the AWS console does not show up here.
[`cdkd drift`](cli-drift.md) is the command that compares state with live AWS.

## Reading the output

Each changed stack gets a block headed by its name, one line per changed
resource, and a summary line:

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

A stack with nothing to do prints `✓ No changes detected for stack MyStack`
instead of a block.

| Marker | Meaning |
| --- | --- |
| `[+]` | The resource would be created. |
| `[~]` | The resource would be updated. Each changed property is listed below it. |
| `[-]` | The resource would be deleted. |
| `[requires replacement]` | Changing that property replaces the resource. |
| `(known after deploy)` | The new value is a `Ref` or `Fn::GetAtt` to a resource this deploy will create. |
| `[metadata only, no AWS API call]` | A `DeletionPolicy` / `UpdateReplacePolicy` change. cdkd records it in state and does not call AWS. |
| `[replacement propagated]` | The template value did not change. The physical ID or ARN it references will, because an upstream resource is being replaced. |
| `[attribute propagated]` | The template value did not change, but it reads an attribute or physical id of a resource being updated. The deploy sends the update only if the value moved. |
| `[may require replacement]` | On a propagated row: the property cannot change in place, so the deploy replaces the resource if the value it reads moves. |
| `[masked input or expression changed]` | The property is stored as `***` (see below). Both sides print `***`, and the deploy sends the property again. |

A property is stored as `***` when its value carries a secret in a form state
cannot record as a reference, such as EC2 `UserData` built with `Fn::Base64`
around a `{{resolve:...}}` reference. The marker appears when the expression
around the reference changed, or a non-secret input it reads did.

A changed nested stack or custom resource also lists every resource that reads
one of its outputs, attributes or physical id as an `[attribute propagated]`
update. Only the deploy learns the new values, and it skips each reader whose
value did not move.

### `[via CC API: ...]`: routing

A CREATE or UPDATE line names the properties that send the resource through
the Cloud Control API instead of cdkd's SDK provider:

```text
  [~] HttpApi (AWS::ApiGatewayV2::Api) [via CC API: Body]
```

A resource already recorded on Cloud Control stays there on its next update,
and its line reads `[via CC API: sticky]`. A line the deploy replaces is routed
like a fresh create, so it never carries `sticky`. DELETE lines are not
annotated.

### `[adopted from a rollback orphan]`

```text
  [~] Bucket (AWS::S3::Bucket) [adopted from a rollback orphan]
```

A previous deploy failed, rolled back, and left this resource in AWS because
its `DeletionPolicy` is `Retain`. The next deploy takes that resource back
into state instead of creating a new one, so the row is an update.

When the adopted resource needs no property change, there is no row. The
summary names it instead:

```text
0 to create, 0 to update, 0 to delete
1 resource(s) to adopt from a previous rollback: Bucket
```

Such a stack is not "no changes detected", and `--fail` counts the adoption as
a change. Before drawing the row, the diff checks in AWS that the resource
still exists under the recorded physical id and that no other cdkd stack
claims it. A record that fails the ownership check is reported under
`Blocking` and exits `3`.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The diff was computed. Changes may be present, unless `--fail-on` or `--fail` says otherwise. |
| `1` | The diff contains the kind of change `--fail-on` fails on, or the command itself failed. |
| `3` | The diff was computed, and `cdkd deploy` would refuse to start. |

To tell the two meanings of `1` apart, look at what was printed: `--fail`
prints the full report and then exits `1`, while a command failure prints an
error. Command failures are a synth crash, an auth error, an unresolvable
cross-stack reference, no stack matching the patterns given, more than one
stack in the app with none selected, and a cyclic nested template.

`cdkd diff` never exits `2`. Exit `3` takes precedence over `--fail`.

### Exit `3` — the deploy would refuse

The preview is printed in full first. The reasons follow under a
`Blocking (cdkd deploy will refuse):` heading. Re-running does not clear exit
`3`; one of these conditions has to be fixed.

| Condition | What to do |
| --- | --- |
| A rollback-orphan adoption whose physical name another cdkd stack's state already claims | Remove the resource from whichever stack should not own it. |
| A state container the diff could not read (see [below](#when-the-state-record-is-malformed)) | Repair the state record. |
| A rollback-orphan record whose `properties` or `attributes` map is not an object | Repair the state record. |
| A resource whose `Type` changes into or out of `AWS::CloudFormation::Stack` | Give the new resource a different logical id, or remove it in one deploy and add the replacement in the next. |
| A custom resource whose `ServiceToken` changes | Give the custom resource a new logical id (in CDK, a new construct id or `overrideLogicalId`). |

A `ServiceToken` that reads a resource this deploy creates or replaces is known
only once that resource exists. The diff warns instead, and the deploy refuses
it then; see
[a changed custom-resource ServiceToken](cli-deploy.md#a-changed-custom-resource-servicetoken).

The two state-record conditions raise exit `3` only on the top-level stack. A
nested stack with the same damage gets a warning without the exit code,
because a deploy skips an unchanged nested stack. The other three are raised
at every stack the diff visits. The full rules are in
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
| `--json` | off | Emit the diff as JSON. See [`--json`](#json). |
| `--use-cdk-bootstrap-assets` | off | Compare against the CDK bootstrap asset destinations verbatim, skipping cdkd's asset-storage redirection. |
| `--no-cfn-fallback` | fallback on | Do not fall back to CloudFormation when a cross-stack reference is missing from cdkd state. See [`--no-cfn-fallback` (deploy / diff)](cli-deploy-safety.md#no-cfn-fallback-deploy-diff). |
| `--region <region>` | AWS profile / `AWS_REGION` | Deprecated, still honored. Prefer `AWS_REGION` or your AWS profile. |

`cdkd diff` also accepts the flags every command shares: `--app`,
`--state-bucket`, `--state-prefix`, `--context`, `--profile`, `--role-arn`,
`--verbose`. See the [CLI reference](cli-reference.md).

## Stack selection

Selection follows the same rules as `cdkd deploy` and `cdkd destroy`.

| You pass | Selects |
| --- | --- |
| Nothing | The app's only stack. With more than one, cdkd lists them and exits `1`. |
| A name | The stack with that CDK display path (`MyStage/Api`) or exactly that physical name (`MyStage-Api`). |
| Several names | Their deduplicated union. |
| `'*'`, `'MyStage/*'` | One `/` segment: the top-level stacks, or one Stage's stacks. |
| `'**'` | Every stack. |
| `--all` | The top-level stacks, as the AWS CDK CLI does. cdkd names any Stage stacks it left out. |

Quote wildcards so the shell does not expand them. A pattern that matches
nothing is an error: cdkd names the patterns it tried and lists the stacks the
assembly contains. A CDK Stage that failed to load stops the diff whatever was
selected
([the failed-Stage note](cli-deploy-safety.md#a-pre-synthesized-assembly-is-trusted-input)).
More detail is under [stack selection](cli-list.md#selecting-stacks).

## `--fail-on`

`--fail-on` picks which kind of change makes `cdkd diff` exit `1`, matching
`cdk diff --fail-on`:

| Value | Exits `1` when |
| --- | --- |
| `any-change` | Anything changed. `--fail` is an alias. |
| `destructive` | A change replaces, deletes or orphans an existing resource. |
| `never` (default) | Never. `--no-fail` is an alias. |

`--fail-on` can be given only once and cannot be combined with `--fail` or
`--no-fail`. The AWS CDK CLI's `broadening` value is not available, because
cdkd does not compute a security diff.

### `any-change`

An Outputs-only change counts, and so does a rollback-orphan adoption and a
state record row the diff could not read. Nested stacks are considered only
with `--recursive`:

```bash
cdkd diff ParentStack --recursive --fail-on=any-change
```

### `destructive`

`destructive` fails only when a change would lose an existing resource: a
stateful resource whose logical ID changed in a refactor, or a property change
that requires replacement. Additions and in-place updates pass. It always
walks nested stacks, as if `--recursive` were given.

Each destructive change is listed after the diff:

```console
$ cdkd diff --fail-on=destructive MyStack
...
❌  Found 2 destructive change(s) (--fail-on=destructive):
  MyStack: AWS::S3::Bucket Bucket MyBucketF68F3FF0 will be replaced
  MyStack: AWS::DynamoDB::Table Table MyTable794EDED1 will be orphaned
```

| Impact | When |
| --- | --- |
| `will be replaced` | A create-only property changes, or the resource's `Type` changes. |
| `may be replaced` | A create-only property is fed by a value only the deploy can resolve. |
| `will be destroyed` | The resource leaves the template. |
| `will be orphaned` | The resource leaves the template under `DeletionPolicy: Retain` or `RetainExceptOnCreate`. |

`may be replaced` fails too. `AWS::CDK::Metadata` is never reported.

A removed resource is listed with the construct path its last deploy recorded
in state. A stack last saved by a cdkd release that did not record paths lists
it by logical ID only, until its next deploy that writes state.

## `--json`

`--json` prints a flat array with one record per target stack. Progress
logging is suppressed, so stdout carries only the payload.

```json
[
  {
    "stack": "MyStack",
    "region": "us-east-1",
    "changes": [
      {
        "logicalId": "ApiFunction",
        "changeType": "UPDATE",
        "resourceType": "AWS::Lambda::Function",
        "propertyChanges": [
          { "path": "Timeout", "oldValue": 3, "newValue": 30, "requiresReplacement": false }
        ]
      }
    ],
    "outputChanges": [],
    "unreadable": [],
    "unreadableContainers": [],
    "unreadableOrphans": [],
    "destructiveChanges": [],
    "children": []
  }
]
```

Every top-level field is always present, so the key set is stable.

| Field | Holds |
| --- | --- |
| `changes` | One entry per changed resource. `NO_CHANGE` resources are omitted. |
| `outputChanges` | One entry per changed output; see below. |
| `destructiveChanges` | `{logicalId, resourceType, constructPath?, impact}` per change `--fail-on=destructive` fails on. `impact` is `WILL_REPLACE`, `MAY_REPLACE`, `WILL_DESTROY` or `WILL_ORPHAN`. |
| `children` | The same record shape for each nested stack, with `--recursive` or `--fail-on=destructive`. Empty otherwise. |
| `unreadable` | The logical id of each `resources` entry the diff dropped. |
| `unreadableContainers` | `"resources"` when the whole map is not an object, `"orphans"` when that field is not a list. |
| `unreadableOrphans` | The `logicalId` of each rollback-orphan record the diff could not read, or `null` when it has none. |

When any of the three `unreadable*` fields is non-empty, `changes` is not the
whole picture; see
[when the state record is malformed](#when-the-state-record-is-malformed).

A `changes` entry carries these optional fields:

| Field | Present when |
| --- | --- |
| `propertyChanges`, `attributeChanges` | Non-empty. |
| `ccApi: string[]` | The resource would route through Cloud Control. The machine form of `[via CC API: ...]`. |

A `propertyChanges` entry marks the annotated rows with a flag that is absent
otherwise:

| Flag | Row |
| --- | --- |
| `replacementPropagated: true` | `[replacement propagated]` |
| `inPlacePropagated: true` | `[attribute propagated]` |
| `maskedExpressionChanged: true` | `[masked input or expression changed]`. `oldValue` and `newValue` are both `***`. |

On a propagated entry, `requiresReplacement: true` means "may require
replacement", not a verdict.

Each `outputChanges` entry is
`{name, changeType: "ADD" | "MODIFY" | "REMOVE", oldValue?, newValue?, oldValueRedacted?, export, nameRedacted?}`.
`oldValue` is absent on an `ADD` and `newValue` on a `REMOVE`. When a previous
value is [withheld](#secrets-and-noecho-values-in-the-output), `oldValue` is
replaced by `oldValueRedacted: true`. A name that holds a secret is masked or
withheld and carries `nameRedacted: true`; two withheld rows can share a
`name`.

Control, format and line-separator characters in the payload are written as
`\uXXXX` escapes, so it parses back to the same values and printing it cannot
run a terminal control sequence.

## `--recursive` (nested stacks)

By default `cdkd diff` does not descend into nested stacks, matching
`cdk diff`. The parent's `AWS::CloudFormation::Stack` row shows a single
`TemplateURL` / `Parameters` change and nothing below it is inspected.

`--recursive` diffs each nested stack against its own state. Each child with
changes is printed under a `Nested stack: <name>` header carrying its full
`~`-joined state name, as `cdkd state show --show-nested` prints it. Children
with no changes are walked silently.

| Nested stack | Diffs as |
| --- | --- |
| No state file yet | Every resource a CREATE. |
| Removed from the CDK code | Every resource a DELETE, recursively. |
| Its row's `Condition` evaluates false | Every resource a DELETE, when the diff can [evaluate the condition](#conditions-over-a-secret-fed-parameter). |
| Malformed state record | Reported with a warning, as [described below](#when-the-state-record-is-malformed). |

A child's input `Parameters` are resolved the way `cdkd deploy` passes them, so
a `Ref` to a parent parameter or an `Fn::If` in the row diffs as the value the
deploy sends.

One case the preview cannot list: a resource in a nested stack that reads a
`NoEcho` custom resource's value through a stack parameter. The diff sees
`***` on both sides. The deploy updates that resource when the parent's custom
resource returns a new value.

### Cyclic nested templates are refused

Each nested child is located through its `Metadata['aws:asset:path']`. The
diff refuses, and exits `1`, when that path resolves to a template already
being diffed higher up the same nesting chain:

```text
Nested stack Child under stack Parent~Child resolves to nested template
/path/to/cdk.out/child.json, which is already being diffed higher up the
same nesting chain. Its Metadata['aws:asset:path'] closes a cycle; CDK emits
an acyclic nested template tree, so this indicates the synth output was
hand-modified or generated by a non-CDK toolchain. Refusing to diff.
```

CDK emits an acyclic tree, so a `cdk.out` that CDK wrote never reaches this.
The error names the row and the file that closed the cycle.

| Case | Result |
| --- | --- |
| Two sibling rows naming the same template | Allowed. A shared child is not a cycle. |
| The same file reached through a symbolically linked directory | Counts as the same template. |
| A cycle through a row whose `Condition` is false | Refused, with the deploy's wording (`The nested template tree under stack ... contains a cycle`). |
| A chain more than 512 levels deep, or more than 10,000 nested-stack rows | Refused. |

### Nested templates outside the assembly directory are refused

The diff also refuses an `aws:asset:path` that resolves outside the directory
its parent template sits in:

```text
Nested stack Child has Metadata['aws:asset:path']=../../etc/passwd which
resolves to /etc/passwd, outside /path/to/cdk.out. CDK emits assembly paths
that stay inside the assembly directory; one that leaves it indicates the synth
output was hand-modified or generated by a non-CDK toolchain. Refusing to load.
```

A path that leaves the directory only once a symbolic link is followed is
refused the same way. An absolute `aws:asset:path` is refused by a separate
check whose message says `which is absolute`. `cdkd deploy` applies the same
rules; see
[Cyclic nested templates are refused](cli-deploy-safety.md#cyclic-nested-templates-are-refused).

## Outputs

The diff also compares the template's `Outputs` with the outputs stored in
state. A change to outputs alone is reported, and `--fail` exits `1` for it.
The usual cause is a downstream stack starting to reference this one: CDK adds
an exported output to the producer and leaves its resources untouched, and the
deploy that follows publishes the export.

```text
Stack ProducerStack:

  Outputs:
    [+] ExportsOutputFnGetAttBucketArn
          new: "arn:aws:s3:::my-bucket"
    [+] ProducerStack:ExportsOutputFnGetAttBucketArn [export]
          new: "arn:aws:s3:::my-bucket"

0 to create, 0 to update, 0 to delete
2 output(s) to add, 0 to change, 0 to remove
```

An output with an `Export.Name` shows two rows, its logical name and its
export name. The `[export]` row is the string a consumer's `Fn::ImportValue`
resolves against. Output counts have their own summary line and never add to
the create / update / delete counts.

### When the Outputs section is missing

Output values are resolved against current state with the resolver
`cdkd deploy` uses. When an output cannot be resolved, usually because it
references a resource this deploy has yet to create, the whole Outputs section
is omitted. A warning says so when some other output also differs.

An output the last deploy could not resolve, and skipped with or without a
warning, is not shown as an `ADD` on every later diff. Repair its `Value`, its
`Export.Name`, or a parameter, condition or mapping it reads, and it is
previewed normally again.

That record of skipped outputs is dropped by `cdkd import`, `cdkd drift
--accept` / `--revert`, `cdkd rollback`, `cdkd scrub`, `cdkd orphan` and
`cdkd state refresh-observed`. After one of them, a still-broken output can
show as an `ADD` again, and `cdkd diff --fail` exits `1` on an unchanged stack
until the next deploy.

The exact rules, including the cases where the diff previews the outputs that
did resolve, are in
[cdkd diff internals](cli-diff-internals.md#outputs-previewed-instead-of-omitted).

### AWS calls that resolving Outputs makes

| Output uses | Call issued |
| --- | --- |
| `Fn::ImportValue` | CloudFormation `ListExports` (subject to `--no-cfn-fallback`) |
| `Fn::GetStackOutput` | CloudFormation `DescribeStacks` (subject to `--no-cfn-fallback`) |
| `Fn::GetAZs` | EC2 `DescribeAvailabilityZones` |
| `{{resolve:ssm:...}}` | SSM `GetParameter`, issued with `WithDecryption: false` |
| `Fn::GetStackOutput` carrying a `RoleArn` | A cross-account `sts:AssumeRole` |

The `RoleArn` must be a literal in the template.

## Secrets and `NoEcho` values in the output

`cdkd diff` never fetches a secret. A `{{resolve:...}}` secret reference
prints as that expression on both sides.

| What you see | Why |
| --- | --- |
| `***` for a value | A `NoEcho: true` parameter supplied it. This covers properties, outputs, export names, `--json` and `--verbose`. |
| `(previous NoEcho value)` as the old side | The state record predates state schema `version: 11` and still holds the old value. Neither value is printed. |
| A placeholder pointing at `cdkd scrub` instead of an output's previous value | The stored value may be secret plaintext written by an older cdkd. The change is still reported. |
| `app-*** (name masked: it contains a secret)` | An export name holds a secret. |
| `<name withheld: contains a secret>` | An export name holds a secret that masking cannot hide. |

State stores `***` wherever a `NoEcho` parameter supplied a value, and the
diff cannot read AWS, so a changed `NoEcho` value is not shown as a change.
The diff prints one informational line per stack instead: `N unchanged
resource(s) read a NoEcho parameter, whose value state holds only as ***: the
deploy compares it with AWS, and updates a resource whose value changed.` That
line never counts as a change for `--fail`. See
[`version: 11` stores `NoEcho` values as `***`](state-management.md#version-11-stores-noecho-values-as-current-writers).

Masking matches on the value, so it can over-mask. An unrelated value equal to
a short `NoEcho` value (a `1`, a `true`) prints as `***` too, and a row whose
new side is masked withholds its old side.

[`cdkd scrub`](cli-scrub.md#cdkd-scrub-state-secret-hygiene-clean-audit)
repairs the state records behind a withheld previous value. The
gates that decide what is withheld, and the limits of the `NoEcho` masking,
are in [cdkd diff internals](cli-diff-internals.md#withheld-previous-values).

## A state record missing an attribute

A state record can lack an attribute an `Fn::GetAtt` reads. An older cdkd
wrote it before recording that attribute, an import recorded none, or AWS had
not assigned the value yet (the endpoint of an RDS instance deployed with
`--no-wait`).

`cdkd deploy` re-reads such a resource from AWS when a reference needs the
attribute, and `cdkd diff` issues the same read. A property or output reading
the attribute previews the value AWS reports, and a resource whose property
changes because of it previews as an UPDATE.

- The read happens only when a reference needs the attribute, at most once per
  resource per run, in the stack's own region.
- The diff does not write what it reads to state.
- If the read fails, for example on a missing permission, the row previews as
  it would without the read and the diff does not fail.
- Custom resources and nested stacks are never re-read.

> [!WARNING]
> An attribute that is itself a credential and that AWS returns unmasked, such
> as a Cognito user pool client's `ClientSecret`, is printed: in the rows, in
> `--json`, and in the `--verbose` log. This affects records an older cdkd
> wrote and records imported with `--migrate-from-cloudformation`.

## When the state record is malformed

A hand-edited or truncated state record can hold a string or a list where a
map belongs. `cdkd diff` never writes state, so it reads each damaged part as
empty, warns, and still prints a preview. `cdkd deploy` refuses the same
record.

| Damaged part | What the preview shows |
| --- | --- |
| `resources` is not an object | Every resource the template declares as a `CREATE`. |
| One `resources` entry is not an object, or has no resource type | The entry is dropped. It previews as a `CREATE` if the template still declares it, and gets no row otherwise. |
| A resource's `properties` is not an object | Every property as an addition, and a create-only one as a replacement. Do not act on these rows. |
| `outputs` is not an object | Every resolved output as an `ADD`, and no `REMOVE` rows. |
| `orphans` is not a list | No rollback-orphan adoption is previewed. |
| One `orphans` record cannot be read | The record is dropped from the adoption preview. |
| One `orphans` record whose `properties` or `attributes` is not an object | The record is kept and previewed, with a warning that the deploy refuses it. |
| `exportNames` is not a list | No stored key is reported as an export. Warning only. |

An empty `{}` or `[]` is healthy, and so is an absent `outputs` or `orphans`
field. An absent `resources` map is a defect and warns.

What you get beyond the warning:

- The dropped rows are named on one line after the counts, with
  `(resources map)` or `(orphans container)` standing for a whole container.
- `--json` lists them in `unreadable`, `unreadableContainers` and
  `unreadableOrphans`.
- `--fail` counts them as a change.
- On the stack you named, every row of the table except `exportNames` is
  reported under `Blocking` and exits `3`. A nested stack warns without the
  exit code.

Inspect the record as stored before repairing it:

```bash
cdkd state show MyStack --stack-region us-east-1 --json
```

With `--recursive`, each nested stack has its own record, so a healthy parent
can sit above a malformed child and the warning names the stack it came from.
What `cdkd deploy` does with each case is under
[State Management](state-management.md#when-resources-is-not-an-object). The
per-container rules are in
[cdkd diff internals](cli-diff-internals.md#malformed-state-records).

## List-typed parameters in `Fn::Equals`

> [!WARNING]
> A list-typed parameter compared against a string in `Fn::Equals` is always
> unequal. A resource gated on that condition is pruned, so the next deploy
> deletes it. Read the DELETE lines of `cdkd diff` before deploying.

A `Ref` to a list-shaped parameter resolves to an array, and `Fn::Equals`
compares its two sides structurally. For a `List<String>` parameter `Envs`
defaulting to `prod`:

```yaml
Fn::Equals: [{ Ref: Envs }, 'prod']     # false: ["prod"] is not "prod"
Fn::Equals: [{ Ref: Envs }, ['prod']]   # true: compare against a list
```

To make the condition true, compare against a list as above, or declare the
parameter `Type: String`.

## Nested stacks and secret references

This section applies to `--recursive` over a tree whose nested-stack input
parameters are fed by secret dynamic references
(`{{resolve:secretsmanager:...}}`, `{{resolve:ssm-secure:...}}`, or
`{{resolve:ssm:...}}` to a `SecureString`).

The diff does not decrypt such a parameter. The parent's value is carried down
as its `{{resolve:...}}` expression, which is also what the child's state
holds, so the two sides compare expression against expression and no plaintext
is printed. The diff assumes the value behind an unchanged reference is
unchanged.

A list-typed parameter fed a reference whose JSON-key slot contains a comma
(`{{resolve:secretsmanager:sec:SecretString:a,b::}}`) reports a phantom change
on every `cdkd diff --recursive`. Nothing is written and no plaintext is
exposed. How each parameter `Type` is compared is in
[cdkd diff internals](cli-diff-internals.md#how-a-secret-fed-nested-parameter-is-compared).

### Conditions over a secret-fed parameter

A condition that reads a secret-fed parameter, directly or through another
condition, cannot be evaluated by the diff. A template parameter the diff
cannot bind is treated the same way. Every other condition is evaluated as
usual.

For such a condition the diff reuses the verdict the last `cdkd deploy`
recorded in the nested stack's state, as long as the condition, the conditions
it names and its parameter inputs are unchanged since then.

Without a matching record:

- an `Fn::If` on the condition resolves to its false branch;
- a resource gated on the condition is kept and diffed, not pruned.

That can show a change the deploy will not make. It can also hide one: after a
deploy that took the false branch, an edit that makes the condition true still
shows as no change. When a record exists but no longer matches, the diff warns
and names the condition.

There is no matching record when the condition or its inputs changed since the
last deploy, when the state was written by an older cdkd or by a failed
deploy, or when the condition reads an SSM-typed or `NoEcho` parameter. The
complete list is in
[cdkd diff internals](cli-diff-internals.md#when-a-recorded-condition-verdict-is-reused).

### Secret parameters must be `Type: String`

A nested-stack input parameter fed a secret dynamic reference must be declared
`Type: String`. `cdkd deploy` refuses a `Type: Number` or `Type: List<Number>`
parameter in that position, naming the parameter:

```text
Nested-stack parameter 'DbPort' is declared 'Type: Number', but the parent
stack resolved a SECRET dynamic reference into it. ...
```

Casting the secret to a number would leave the decrypted value in the child's
state with nothing to redact it back to. `cdkd diff` warns for any parameter
whose declared type could cause this.

`CommaDelimitedList` and the other `List<...>` types are allowed only while
the secret value itself contains no comma. A JSON secret always contains
commas, so a list-typed secret parameter works only for a bare token value.

CDK synthesizes every nested-stack cross-reference parameter as
`Type: String`, so a CDK app does not hit this.

## Related

- [Deploy: waits & concurrency](cli-deploy.md): applying what this previews
- [Deploy: safety & compatibility flags](cli-deploy-safety.md): `--no-cfn-fallback` and the other guards
- [`cdkd drift`](cli-drift.md): compare state against what AWS actually holds
- [`cdkd scrub`](cli-scrub.md): repair state records holding plaintext secrets
- [Cross-Stack References](cross-stack-references.md): how `Fn::ImportValue` and `Fn::GetStackOutput` resolve
- [CLI Reference](cli-reference.md): the flags every command shares
- [cdkd diff internals](cli-diff-internals.md): the rules behind the edge cases
