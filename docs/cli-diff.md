---
title: cdkd diff
description: "Preview what a deploy would change — cdkd diff semantics, output, and flags."
---

## `cdkd diff`

`cdkd diff [<stacks...>]` synthesizes the CDK app and reports the
per-resource CREATE / UPDATE / DELETE changes the next `cdkd deploy`
would apply, comparing the synth template against cdkd's S3 state.

- `--recursive` — recurse into every `AWS::CloudFormation::Stack` row and diff each
  nested-stack child against its **own** deployed state
  (`cdkd/<parent>~<childLogicalId>/<region>/state.json`), in DFS order.
  Default is non-recursive, matching `cdk diff` (which shows the parent's
  nested-stack row as a single `TemplateURL` / `Parameters` change with no
  descent). Each child's block is printed under a `Nested stack: <name>`
  header (the full `~`-joined state name, matching `cdkd state show
  --show-nested`). The walk previews the full next deploy: a nested child
  with no state file yet diffs as all-CREATE; a nested stack removed from
  the CDK code (present in state, absent from the template) diffs as
  all-DELETE recursively.

  A child input parameter fed by a SECRET dynamic reference is **not
  decrypted at plan time**. The parent's
  `Parameters` value is carried down as its `{{resolve:...}}` expression,
  which is also what the child's state now holds, so the two sides compare
  expression-vs-expression and no plaintext appears in the output. Two
  consequences follow from a redacted token not being a usable VALUE, and both
  are deliberate:

  - The token is cast by the child parameter's declared `Type` **only where
    every part of it stays a string**, so the comparison matches what the
    child's state actually holds. A `CommaDelimitedList` parameter IS split on
    `,`: its state leaf is an ARRAY of expressions, because the deploy split
    the resolved value the same way before redacting it, and the reference
    survives as ONE element as long as it carries no comma of its own. That is
    true of the secret id, the parameter name and the version stage, and NOT of
    the JSON-KEY slot — `{{resolve:secretsmanager:sec:SecretString:a,b::}}`
    splits into two. A parameter fed such a reference reports a phantom change
    on every `cdkd diff --recursive`; nothing is written and no plaintext is
    exposed by it.
    A `Type: Number` / `List<Number>` parameter keeps the **uncoerced** token,
    because casting it yields `NaN` — an ARRAY of them for `List<Number>` —
    which matches neither side and would diff forever.
    Every OTHER list-shaped `Type` is split like `CommaDelimitedList`, because
    its parts all stay strings. The population is the FAMILY — any `List<...>`
    type, plus `CommaDelimitedList` itself — rather than a list of names;
    `List<AWS::EC2::Subnet::Id>`, `List<AWS::EC2::SecurityGroup::Id>` and
    `List<String>` are examples of it. The AWS-specific
    SCALAR types, and the whole `AWS::SSM::Parameter::Value<…>` family — whose
    value is a Parameter Store KEY rather than the resolved list — keep the
    uncast token.
    A LIST-TYPED PARAMETER USED IN `Fn::Equals` CHANGES ANSWER, and this is
    not limited to the redacted-token case — it is a property of the deploy
    path. A `Ref` to a
    list-shaped parameter now resolves to an ARRAY, and `Fn::Equals` compares
    the two sides structurally, so `Fn::Equals: [{Ref: Envs}, 'prod']` over a
    `List<String>` parameter defaulting to `prod` was TRUE (`'prod'` vs
    `'prod'`) and is now FALSE (`["prod"]` vs `"prod"`). That is the correct
    answer for a list-valued `Ref`; compare against a LIST
    (`Fn::Equals: [{Ref: Envs}, ['prod']]`) or declare the parameter
    `Type: String`. The consequence is that a resource gated on such a
    condition can flip to pruned, and the next deploy DELETES it — `cdkd diff`
    previews that delete before any apply, so check a diff after upgrading if
    you gate resources on a list-typed parameter.
    The split falls exactly there because cdkd's secret redaction is
    string-keyed end to end — a shape whose parts are all strings stays inside
    that model, and a number does not. `cdkd diff` additionally WARNS for any
    parameter whose declared `Type` COULD lose the plaintext under coercion,
    because `cdkd deploy` refuses that parameter when the coercion actually
    destroys it — see "Secret parameters must be `Type: String`" below.
  - A child stack is **not condition-pruned** on that run **when one of its
    `Conditions` transitively references a token-valued parameter** — `cdkd
    deploy` evaluates its conditions against the real values, so a verdict
    computed over an expression could flip an `Fn::Equals` and report a
    phantom CREATE or DELETE of a condition-gated child resource. The whole
    child template is diffed instead, which is the same fallback an unbindable
    parameter already takes. The skip is scoped to conditions that actually
    depend on such a parameter: leaving the condition map unevaluated ALSO
    makes every `Fn::If` in a property value take its FALSE branch, so a
    template whose conditions mention no secret parameter is evaluated and
    pruned exactly as it would be without a secret in the tree.

  #### Secret parameters must be `Type: String`

  A nested-stack input parameter fed a SECRET dynamic reference must be
  declared `Type: String` (or a list-shaped `Type` — anything
  `isListParameterType` accepts, i.e. `CommaDelimitedList` or any `List<...>`
  type; the spellings named elsewhere in this section are examples, not the
  population — with the caveat below).
  `cdkd deploy` **refuses** a `Type: Number` / `Type: List<Number>` parameter
  in that position, naming the parameter:

  ```text
  Nested-stack parameter 'DbPort' is declared 'Type: Number', but the parent
  stack resolved a SECRET dynamic reference into it. ...
  ```

  cdkd keeps a resolved secret out of persisted state by rewriting **string**
  leaves back to their `{{resolve:...}}` expression. Casting the value to a
  number takes it out of that model, so the child stack's `state.json` would
  keep the DECRYPTED secret with nothing to redact it back to — the very
  disclosure this refusal exists to
  prevent. Refusing names the problem; silently persisting the plaintext does
  not. CDK synthesizes every nested-stack cross-reference parameter as
  `Type: String`, so a CDK app never hits this.

  A list-shaped `Type` is allowed only while the secret itself carries **no
  comma**, and the refusal is decided by MEASURING the actual value rather
  than by the declared type alone. Splitting on `,` shreds a comma-bearing
  secret into fragments that no longer match the plaintext, so the same
  refusal fires and names the declared type. That is the dominant
  Secrets Manager shape — a JSON blob is nothing but commas — so a list-typed
  secret parameter is usable only for a bare token value. This applies to
  every list-shaped type alike, because the refusal asks the coercion what it
  destroyed rather than consulting a list of type names.
- `--fail` — exit `1` when any change is detected (parity with `cdk diff
  --fail`). With `--recursive`, considers the whole nested-stack tree, so
  CI can gate on tree-wide drift with a single `cdkd diff <parent>
  --recursive --fail`. Without `--fail`, `cdkd diff` always exits `0` even
  when changes are present (parity with `cdk diff`'s default).
- `--json` — emit the diff as JSON instead of human-readable text. A flat
  array of `{stack, region, changes: [...], outputChanges: [...], children:
  [...]}` records (one per target stack); with `--recursive`, `children` is
  populated with the same nested shape recursively. `NO_CHANGE` resources are
  omitted; `children` and `outputChanges` are always present (empty on leaves /
  when the Outputs section is unchanged) so the key set is stable.
  Each change entry additionally carries `ccApi?: string[]` when the
  resource would auto-route via Cloud Control API on the next deploy (the
  human renderer's `[via CC API: <props>]` annotation in machine form;
  absent when the resource routes via its SDK provider). Each
  `outputChanges` entry is `{name, changeType: "ADD" | "MODIFY" | "REMOVE",
  oldValue?, newValue?, oldValueRedacted?, export}` — `oldValue` is absent on an
  `ADD` and `newValue` on a `REMOVE`, and `oldValue` is also withheld (with
  `oldValueRedacted: true` in its place) when state holds legacy secret
  plaintext for that key. Progress logging is suppressed so stdout carries
  only the JSON payload.

**Outputs section**: the diff also compares
the template's `Outputs` against the outputs bag in state, so an
**Outputs-only** change — one whose `Resources` section is byte-identical — is
reported instead of printing `No changes detected`, and `--fail` exits `1` for
it. This is the preview half of the Outputs-only persist `cdkd deploy`
performs: when a downstream stack
starts referencing a producer, CDK synth adds an `Output` with an `Export.Name`
to the producer while leaving its resources untouched, and without this the
preview steered the user away from the deploy that publishes the export.
Removals are reported too — dropping an export can break a consumer's
`Fn::ImportValue`.

```text
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
The Outputs counts are a **separate** summary line: an Outputs change is a
state / exports-index write with no AWS resource operation behind it, so it
never inflates the create / update / delete counts. Output values are resolved
best-effort against current state, exactly as `cdkd deploy` resolves them; when
an output cannot be fully resolved (typically because it references a resource
this deploy has yet to create) the Outputs section is omitted rather than
guessed — that resource's `CREATE` is already on the resource side of the diff
— and a warning says so, so an absent section never silently means "unchanged".

Because this is the only command that prints a **stored** output value, two
safeguards apply. A previous value that is legacy secret plaintext is withheld from
both the text and `--json` output rather than printed into CI logs. Two signals
identify such a record: the template side still being a `{{resolve:...}}`
expression while state is not (exactly what [`cdkd scrub`](cli-scrub.md#cdkd-scrub-state-secret-hygiene-clean-audit) repairs),
and the template declaring the output's value as a dynamic reference — the latter
also covers an output that was condition-skipped, which has no template side left
to compare. Because a record with any such key was written by a pre-redaction
binary, both of those withhold **record-wide**: every previous value in that
record is withheld, and the change itself is still reported.
A third, **per-key** refusal covers an output DELETED from the template: a stored
key today's template cannot account for (no declared output name, no literal
`Export.Name`, not in the resolved bag) has its value withheld — only when the
template still proves a secret reference anywhere, and not when any stored value
is itself a secret expression (which shows the last write already redacted the
whole bag). Deleting an output is an ordinary refactor, so those two gates are
what keep the refusal off stacks that handle no secrets at all. For a nested
child REMOVED from its parent's template there is no template left to account for
anything, so the refusal applies to that child's whole stored bag whenever the
parent's template proves a secret reference. That population is now REPAIRABLE by
[`cdkd scrub`](cli-scrub.md#cdkd-scrub-state-secret-hygiene-clean-audit); the refusal here is
unchanged, because `diff` still cannot decide from a stored string alone whether
a value is a plaintext. Second, output / export names and
rendered values are stripped of control and bidi characters before display: an
`Export.Name` is a value cdkd resolved (from an `Fn::Sub`, a parameter, an SSM
lookup), so unlike a CloudFormation logical ID it never passed a validator. The
`--json` payload is deliberately left byte-faithful — it is a machine interface,
and mutating a name a consumer matches on would be worse than the display concern
it would avoid.

Resolving `Outputs` is new work for `cdkd diff`: an output using
`Fn::ImportValue` / `Fn::GetStackOutput` may now cost a `ListExports` /
`DescribeStacks` call (subject to `--no-cfn-fallback`), an `Fn::GetAZs` output an
EC2 `DescribeAvailabilityZones`, a `{{resolve:ssm:...}}` output one
`GetParameter` issued with `WithDecryption: false`, and an `Fn::GetStackOutput`
carrying a `RoleArn` a cross-account `sts:AssumeRole` (the `RoleArn` must be a
template literal, so it is not attacker-selectable).

**Routing annotation**: every CREATE / UPDATE line whose template uses a
top-level CFn property cdkd's SDK provider does not yet wire is tagged
`[via CC API: <prop list>]` so the routing decision is auditable at plan
time — the same auto-fallback the deploy engine applies. DELETE
lines are not annotated; deletes route via the recorded `provisionedBy`
on each resource's state, not via template inspection.

Like every non-bootstrap command, `--region` is deprecated (prefer
`AWS_REGION` / your AWS profile) but still honored if passed.
Stack selection (`<stacks...>` / `--all` / wildcards / display paths)
follows the same rules as `cdkd deploy` / `cdkd destroy`.

