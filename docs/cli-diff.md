---
title: cdkd diff
description: "Preview what a deploy would change — cdkd diff semantics, output, and flags."
---

# cdkd diff

`cdkd diff` synthesizes the CDK app and reports the per-resource CREATE /
UPDATE / DELETE changes the next `cdkd deploy` would apply, comparing the synth
template against cdkd's S3 state. It reads state and never writes it, so it is
safe to run at any time.

```bash
cdkd diff                                  # the single stack in the app
cdkd diff MyStack                          # one stack by name
cdkd diff 'MyStage/*'                      # every stack under a stage
cdkd diff --all                            # every stack in the app
cdkd diff ParentStack --recursive          # descend into nested stacks
cdkd diff --all --fail                     # CI gate: exit 1 on any change
cdkd diff MyStack --json                   # machine-readable payload
```

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `--all` | off | Diff every stack in the app. |
| `--stack <name>` | — | A single stack name, as an alternative to the positional argument. |
| `--output <path>` | `cdk.out` | Synthesis output directory. |
| `--recursive` | off | Descend into each `AWS::CloudFormation::Stack` row and diff every nested child against its own state. |
| `--fail` | off | Exit `1` when any change is detected. |
| `--json` | off | Emit the diff as JSON instead of human-readable text. |
| `--use-cdk-bootstrap-assets` | off | Compare against the CDK bootstrap asset destinations verbatim, skipping cdkd's asset-storage redirection. |
| `--no-cfn-fallback` | fallback on | Do not fall back to CloudFormation when a cross-stack reference is missing from cdkd state. See [`--no-cfn-fallback` (deploy / diff)](cli-deploy-safety.md#no-cfn-fallback-deploy-diff). |
| `--region <region>` | AWS profile / `AWS_REGION` | Deprecated, still honored. Prefer `AWS_REGION` or your AWS profile. |

`cdkd diff` also accepts the flags every command shares — `--app`,
`--state-bucket`, `--state-prefix`, `--context`, `--profile`, `--role-arn`,
`--verbose`. See the [CLI reference](cli-reference.md).

## Stack selection

Selection follows the same rules as `cdkd deploy` and `cdkd destroy`:

- **A positional name** matches either the physical CloudFormation stack name
  (`MyStage-Api`) or the CDK display path (`MyStage/Api`). A pattern containing
  `/` is matched against the display path; one without `/` against the physical
  name.
- **Wildcards** work in both forms: `'My*'`, `'MyStage/*'`. Quote them so the
  shell does not expand them first.
- **Several names** may be given at once; the result is their deduplicated
  union.
- **`--all`** selects every stack in the synthesized app.
- **No argument** is accepted only when the app contains exactly one stack.
  With more than one, cdkd lists the available stacks and exits `1` rather than
  guessing.
- **No match** is an error, not an empty diff: cdkd names the patterns it tried
  and lists what the assembly actually contains.

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
| `[~]` | The resource would be updated, with each changed property listed below it. |
| `[-]` | The resource would be deleted. |
| `[requires replacement]` | Changing that property replaces the resource rather than updating it in place. |
| `[replacement propagated]` | The property's template value did not change — only the physical ID or ARN it references will, because an upstream resource is being replaced. The apparent `"value"` → `{Ref: ...}` delta is not a literal edit. |
| `[metadata only, no AWS API call]` | A `DeletionPolicy` / `UpdateReplacePolicy` change. cdkd records it in state; AWS is not called. |
| `(known after deploy)` | The new side is an unresolved intrinsic — a `Ref` or `Fn::GetAtt` to a resource this same deploy will create. |

### Routing annotation

Every CREATE / UPDATE line whose template uses a top-level CloudFormation
property cdkd's SDK provider does not yet wire is tagged with the properties
that force the fallback:

```text
  [~] ApiFunction (AWS::Lambda::Function) [via CC API: RuntimeManagementConfig]
```

This is the same auto-fallback the deploy engine applies, surfaced at plan time
so the routing decision is auditable before you deploy. DELETE lines are never
annotated: deletes route via the `provisionedBy` value recorded on each
resource in state, not by inspecting the template.

## Outputs

The diff also compares the template's `Outputs` against the outputs bag in
state. An **Outputs-only** change — one whose `Resources` section is
byte-identical — is reported rather than printing `No changes detected`, and
`--fail` exits `1` for it.

This matters because the deploy performs an Outputs-only persist: when a
downstream stack starts referencing a producer, CDK synth adds an `Output` with
an `Export.Name` to the producer while leaving its resources untouched. Without
the Outputs comparison, the preview would steer you away from the very deploy
that publishes the export. Removals are reported for the mirror-image reason —
dropping an export can break a consumer's `Fn::ImportValue`.

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

Rows are keyed by what actually lands in state, so an output carrying an
`Export.Name` shows **two** rows — its logical name and its export name. The
`[export]` row is the string a consumer's `Fn::ImportValue` resolves against.

The Outputs counts are a **separate** summary line. An Outputs change is a
state / exports-index write with no AWS resource operation behind it, so it
never inflates the create / update / delete counts.

Output values are resolved best-effort against current state, exactly as
`cdkd deploy` resolves them. When an output cannot be fully resolved — typically
because it references a resource this deploy has yet to create — the Outputs
section is **omitted rather than guessed**, and a warning says so, so an absent
section never silently means "unchanged". That resource's `CREATE` is already
on the resource side of the diff.

### What resolving Outputs costs

Resolving an output can issue AWS calls that the resource diff does not:

| Output uses | Call issued |
| --- | --- |
| `Fn::ImportValue` | CloudFormation `ListExports` (subject to `--no-cfn-fallback`) |
| `Fn::GetStackOutput` | CloudFormation `DescribeStacks` (subject to `--no-cfn-fallback`) |
| `Fn::GetAZs` | EC2 `DescribeAvailabilityZones` |
| `{{resolve:ssm:...}}` | SSM `GetParameter`, issued with `WithDecryption: false` |
| `Fn::GetStackOutput` carrying a `RoleArn` | A cross-account `sts:AssumeRole` |

The `RoleArn` must be a template literal, so it is never attacker-selectable.

### Withheld previous values

`cdkd diff` is the only command that prints a **stored** output value, so two
safeguards apply to that side of the output.

**A previous value that may be legacy secret plaintext is withheld** from both
the text and the `--json` output rather than printed into CI logs. The change
itself is still reported; only the old value is replaced with a placeholder
pointing at [`cdkd scrub`](cli-scrub.md#cdkd-scrub-state-secret-hygiene-clean-audit).
Three refusal gates decide this:

| Gate | Trigger | Scope |
| --- | --- | --- |
| Redacted-expression mismatch | The template side is still a `{{resolve:...}}` expression while state is not — exactly what `cdkd scrub` repairs. | Record-wide |
| Template-declared dynamic reference | The template declares the output's value as a dynamic reference. Also covers an output that was condition-skipped, which has no template side left to compare. | Record-wide |
| Unaccountable stored key | A stored key today's template cannot account for — no declared output name, no literal `Export.Name`, not in the resolved bag — i.e. an output deleted from the template. | Per-key |

The first two are record-wide because a record holding any such key was written
by a pre-redaction binary, so every previous value in it is suspect.

The per-key gate is narrower on purpose, since deleting an output is an
ordinary refactor. It fires **only** when the template still proves a secret
reference somewhere, and **not** when any stored value is itself a secret
expression — the latter shows that the last write already redacted the whole
bag. Those two conditions are what keep the refusal off stacks that handle no
secrets at all.

For a nested child **removed** from its parent's template there is no template
left to account for anything, so the refusal applies to that child's whole
stored bag whenever the parent's template proves a secret reference. That
population is repairable by
[`cdkd scrub`](cli-scrub.md#cdkd-scrub-state-secret-hygiene-clean-audit); the
refusal here is unchanged, because `diff` still cannot decide from a stored
string alone whether a value is plaintext.

**Second, output and export names and rendered values are stripped of control
and bidi characters before display.** An `Export.Name` is a value cdkd resolved
(from an `Fn::Sub`, a parameter, an SSM lookup), so unlike a CloudFormation
logical ID it never passed a validator. The `--json` payload is deliberately
left byte-faithful — it is a machine interface, and mutating a name a consumer
matches on would be worse than the display concern it would avoid.

## `--fail`

`--fail` exits `1` when any change is detected, matching `cdk diff --fail`. An
Outputs-only change counts. Without the flag, `cdkd diff` always exits `0` even
when changes are present, which is `cdk diff`'s default too.

With `--recursive`, `--fail` considers the whole nested-stack tree, so CI can
gate on tree-wide drift with a single command:

```bash
cdkd diff ParentStack --recursive --fail
```

## `--json`

`--json` emits the diff as JSON instead of human-readable text. Progress
logging is suppressed so stdout carries only the payload.

The payload is a flat array of one record per target stack:

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
    "children": []
  }
]
```

- `NO_CHANGE` resources are omitted.
- `children` and `outputChanges` are **always present** — empty on leaves and
  when the Outputs section is unchanged — so the key set is stable.
- With `--recursive`, `children` is populated with the same record shape,
  recursively.
- `propertyChanges` and `attributeChanges` appear on a change entry only when
  non-empty.
- A change entry carries `ccApi: string[]` when the resource would auto-route
  via Cloud Control API on the next deploy — the machine form of the
  `[via CC API: <props>]` annotation. It is absent when the resource routes via
  its SDK provider.

Each `outputChanges` entry is
`{name, changeType: "ADD" | "MODIFY" | "REMOVE", oldValue?, newValue?, oldValueRedacted?, export}`.
`oldValue` is absent on an `ADD` and `newValue` on a `REMOVE`; `oldValue` is
also withheld — with `oldValueRedacted: true` in its place — when state holds
legacy secret plaintext for that key.

## `--recursive` (nested stacks)

By default `cdkd diff` does not descend into nested stacks, matching
`cdk diff`: the parent's `AWS::CloudFormation::Stack` row shows up as a single
`TemplateURL` / `Parameters` change and nothing below it is inspected.

`--recursive` walks into every `AWS::CloudFormation::Stack` row in DFS order and
diffs each nested child against its **own** deployed state at
`cdkd/<parent>~<childLogicalId>/<region>/state.json`. Each child's block is
printed under a `Nested stack: <name>` header carrying the full `~`-joined state
name, matching `cdkd state show --show-nested`. Children with no changes are
walked silently, so the output shows only what the next deploy would do.

The walk previews the full next deploy:

- A nested child with **no state file yet** diffs as all-CREATE.
- A nested stack **removed from the CDK code** — present in state, absent from
  the template — diffs as all-DELETE, recursively.

## List-typed parameters in `Fn::Equals`

> **A list-typed parameter compared against a string in `Fn::Equals` is always
> unequal, and a resource gated on that condition is pruned — which means the
> next deploy DELETES it.** Run `cdkd diff` and read the DELETE lines before
> deploying if you gate resources on a list-typed parameter.

A `Ref` to a list-shaped parameter resolves to an **array**, and `Fn::Equals`
compares its two sides structurally. So for a `List<String>` parameter `Envs`
defaulting to `prod`:

```yaml
Fn::Equals: [{ Ref: Envs }, 'prod']     # FALSE — ["prod"] is not "prod"
Fn::Equals: [{ Ref: Envs }, ['prod']]   # TRUE  — compare against a list
```

That is the correct answer for a list-valued `Ref`. To make the condition true,
either compare against a list as above, or declare the parameter
`Type: String`.

This is a property of the deploy path, not of nested stacks or secrets — it
applies wherever a list-shaped parameter feeds a condition. `cdkd diff` previews
the resulting delete before any apply, which is the point of checking it first.

## Nested stacks and secret references

This section covers `--recursive` over a tree whose nested-stack input
parameters are fed by SECRET dynamic references. If your app has none of those,
none of it applies.

A child input parameter fed by a secret dynamic reference is **not decrypted at
plan time**. The parent's `Parameters` value is carried down as its
`{{resolve:...}}` expression, which is also what the child's state holds, so the
two sides compare expression-against-expression and no plaintext appears in the
output.

A redacted token is not a usable value, and two consequences follow. Both are
deliberate.

### How the token is compared

The token is cast by the child parameter's declared `Type` **only where every
part of it stays a string**, so the comparison matches what the child's state
actually holds:

| Declared `Type` | Compared as |
| --- | --- |
| `String` | The token, uncast. |
| The AWS-specific scalar types | The token, uncast. |
| The whole `AWS::SSM::Parameter::Value<...>` family | The token, uncast — the value is a Parameter Store key, not the resolved list. |
| `CommaDelimitedList` and every other `List<...>` type | Split on `,` into an array of expressions, mirroring what the deploy split before redacting. |
| `Number` / `List<Number>` | The token, uncast — casting yields `NaN` (an array of them for `List<Number>`), which matches neither side and would diff forever. |

The population of splitting types is the **family** — any `List<...>` type, plus
`CommaDelimitedList` itself — rather than a fixed list of names;
`List<AWS::EC2::Subnet::Id>`, `List<AWS::EC2::SecurityGroup::Id>` and
`List<String>` are examples of it. The line falls where it does because cdkd's
secret redaction is string-keyed end to end: a shape whose parts are all strings
stays inside that model, and a number does not.

A split reference survives as **one** element as long as it carries no comma of
its own. That holds for the secret id, the parameter name and the version stage,
and **not** for the JSON-key slot —
`{{resolve:secretsmanager:sec:SecretString:a,b::}}` splits into two. A parameter
fed such a reference reports a phantom change on every
`cdkd diff --recursive`. Nothing is written and no plaintext is exposed by it.

`cdkd diff` additionally warns for any parameter whose declared `Type` **could**
lose the plaintext under coercion, because `cdkd deploy` refuses that parameter
when the coercion actually destroys it.

### Condition pruning is skipped

A child stack is **not condition-pruned** on that run when one of its
`Conditions` transitively references a token-valued parameter. `cdkd deploy`
evaluates its conditions against the real values, so a verdict computed over an
expression could flip an `Fn::Equals` and report a phantom CREATE or DELETE of a
condition-gated child resource. The whole child template is diffed instead,
which is the same fallback an unbindable parameter already takes.

The skip is scoped to conditions that actually depend on such a parameter.
Leaving the condition map unevaluated would also make every `Fn::If` in a
property value take its FALSE branch, so a template whose conditions mention no
secret parameter is evaluated and pruned exactly as it would be without a secret
in the tree.

### Secret parameters must be `Type: String`

A nested-stack input parameter fed a secret dynamic reference must be declared
`Type: String`, or a list-shaped type — `CommaDelimitedList` or any `List<...>`
type — with the comma caveat below. `cdkd deploy` **refuses** a `Type: Number` /
`Type: List<Number>` parameter in that position, naming the parameter:

```text
Nested-stack parameter 'DbPort' is declared 'Type: Number', but the parent
stack resolved a SECRET dynamic reference into it. ...
```

cdkd keeps a resolved secret out of persisted state by rewriting **string**
leaves back to their `{{resolve:...}}` expression. Casting the value to a number
takes it out of that model, so the child stack's `state.json` would keep the
decrypted secret with nothing to redact it back to — the very disclosure this
refusal exists to prevent. Refusing names the problem; silently persisting the
plaintext does not.

CDK synthesizes every nested-stack cross-reference parameter as `Type: String`,
so a CDK app never hits this.

A list-shaped type is allowed **only while the secret itself carries no comma**,
and the refusal is decided by measuring the actual value rather than by the
declared type alone. Splitting on `,` shreds a comma-bearing secret into
fragments that no longer match the plaintext, so the same refusal fires and
names the declared type. That is the dominant Secrets Manager shape — a JSON
blob is nothing but commas — so a list-typed secret parameter is usable only for
a bare token value. This applies to every list-shaped type alike, because the
refusal asks the coercion what it destroyed rather than consulting a list of
type names.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The diff was computed. This is the exit code even when changes are present, unless `--fail` was passed. |
| `1` | `--fail` was passed and something changed, or the command itself failed. |

The failures behind the second meaning of `1` are a synth crash, an auth error,
an unresolvable cross-stack reference, no stack matching the patterns you gave,
and more than one stack in the app with no selection given.

`cdkd diff` never exits `2`. That code means partial failure, which is a
property of commands that mutate AWS.

Distinguish the two meanings of `1` by whether the diff report was printed
first: `--fail` prints the full report and then exits `1`, while a command
failure prints an error.

## Related

- [Deploy: waits & concurrency](cli-deploy.md) — applying what this previews
- [Deploy: safety & compatibility flags](cli-deploy-safety.md) — `--no-cfn-fallback` and the other guards
- [`cdkd drift`](cli-drift.md) — compare state against what AWS actually holds
- [`cdkd scrub`](cli-scrub.md) — repair state records holding plaintext secrets
- [Cross-Stack References](cross-stack-references.md) — how `Fn::ImportValue` and `Fn::GetStackOutput` resolve
- [CLI Reference](cli-reference.md) — the flags every command shares
