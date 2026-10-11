---
title: "cdkd export: the template CloudFormation receives"
description: "Which template cdkd export submits to CloudFormation: Parameter values, -c context, the changes an import requires, and what the first cdk deploy afterwards may change."
---

# cdkd export: the template CloudFormation receives

[`cdkd export`](cli-export.md) submits the template your CDK app synthesizes,
or the file you pass with `--template`. It changes that template only where a
CloudFormation import requires it.

This matters after the export. The next `cdk deploy` synthesizes the template
again and compares it with what CloudFormation holds. If the two match, the
deploy changes nothing. This page covers the inputs that decide whether they
match: Parameters, context values, drift and resource names.

```bash
# set a template Parameter
cdkd export MyStack --parameter Environment=prod

# submit this file instead of synthesizing
cdkd export MyStack --template template.yaml
```

## Template Parameters

cdkd passes the template's Parameters to both changesets. Each Parameter takes
its value from `--parameter Key=Value` when you give one, and otherwise from
the `Default` in the template.

```bash
cdkd export MyStack --parameter Environment=prod --parameter InstanceCount=2
```

Most exports need no `--parameter`. A template that CDK generates usually
declares only `BootstrapVersion`, and that Parameter has a default.

Two mistakes are errors:

- A Parameter that has neither a `--parameter` value nor a `Default`. The
  error lists the missing keys.
- A `--parameter` that names a key the template does not declare. This catches
  typos.

Parameters that a parent passes to a nested stack follow different rules; see
[Child Parameters](cli-export-nested-stacks.md#child-parameters).

## Context values passed with `-c`

`cdkd export` refuses `-c key=value` overrides, because CDK does not remember
them.

Suppose you export with `-c env=prod`. The flag applies to that one command
and is not saved to `cdk.json`. When you later run `cdk deploy` without it,
CDK synthesizes a different template, and CloudFormation updates or replaces
resources to match.

The fix is to move the values into `cdk.json` and export without `-c`:

```json
{
  "app": "npx ts-node bin/app.ts",
  "context": {
    "env": "prod"
  }
}
```

### `--accept-transient-context`

If you cannot change `cdk.json`, pass `--accept-transient-context` together
with your `-c` flags. cdkd warns and names every override. On success it
prints the `cdk diff` and `cdk deploy` commands with the same `-c` flags.

You then have to pass those flags on every later `cdk` command for this stack.

## What cdkd changes in the template

The template for phase 1 is the synthesized template with three changes. An
IMPORT changeset requires each of them.

- **`Outputs` are removed.** An IMPORT changeset may not declare outputs.
  Phase 2 restores them.
- **`DeletionPolicy: Delete` is added to each resource that has no
  `DeletionPolicy`.** An IMPORT requires one on every resource. `Delete` is
  what CloudFormation applies by default, so the addition does not show up in
  `cdk diff`.
- **An identifier property is overwritten when the template's literal value
  differs from the real one.** CloudFormation rejects a template whose
  identifier does not match the resource. This is the case described under
  [Stacks with prefixed physical names](#stacks-with-prefixed-physical-names).

cdkd leaves an identifier property alone when the template omits it, or sets
it with `Ref` or `Fn::GetAtt`.

### Template format and size

A template can be JSON or YAML. cdkd preserves YAML shorthand intrinsics
(`!Ref`, `!Sub`, `!GetAtt`, `!Join`), and submits the changesets in the same
format as the source template.

Size has two limits:

- A template larger than 51,200 bytes is uploaded to the state bucket for the
  duration of the changeset call.
- A template larger than 1 MB cannot be submitted to CloudFormation at all.
  The export refuses it and names the largest inline payloads. Move inline
  Lambda code to `lambda.Code.fromAsset(...)`, or split the stack.

## Drift baseline

cdkd submits the template as written. It does not copy the values AWS
currently holds into it.

So if someone changed a resource in AWS outside cdkd, that change is not in
the template. The first `cdk deploy` after the export changes the resource
back. To find such drift before you export:

```bash
cdkd state refresh-observed MyStack   # record what AWS holds now
cdkd drift MyStack                    # compare
```

The first command stores a drift baseline: a snapshot in the state record of
what AWS holds for each resource. [`cdkd drift`](cli-drift.md) compares
against it.

### The warning about a missing baseline

`cdkd export` warns when the state record has no drift baseline for some
resources, because `cdkd drift` cannot compare those reliably. The warning
does not stop the export.

The warning can list two more groups:

- **Resources whose baseline a `cdkd import` run refused.** They are listed
  separately, grouped by remedy, because `cdkd state refresh-observed` skips
  them too. [`cdkd import`](import.md) explains the refusal.
- **Resource entries that are not an object or have no resource type.** The
  record is damaged there. Inspect it before you export:

  ```bash
  cdkd state show MyStack --stack-region us-east-1 --json
  ```

## After the export

On success cdkd prints the `cdk diff` and `cdk deploy` commands to run next.
`cdk diff` is empty for resources whose names AWS generated, and for
sub-resources that reference their parent.

### Stacks with prefixed physical names

One case makes the next `cdk deploy` propose a replacement: a stack whose
physical names carry cdkd's stack-name prefix. Two kinds of stack have such
names:

- stacks deployed with `cdkd deploy --prefix-user-supplied-names`,
- stacks deployed before v0.94.0, when prefixing was the default.

For example:

```ts
// In the CDK app
new iam.Role(this, 'Role', {
  roleName: 'my-role', // the role in AWS is named MyStack-my-role
  assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
});
```

The export records the real name, `MyStack-my-role`, in CloudFormation. The
next `cdk deploy` synthesizes `my-role`. CloudFormation sees a change to a
name that cannot be changed in place, so it proposes to replace the role.

Before the first deploy after the export, do one of these:

- Change the CDK code to the prefixed name: `roleName: 'MyStack-my-role'`.
- Accept the replacement.

To see what the deploy would do without running it, create a changeset and
read it:

```bash
aws cloudformation create-change-set \
  --stack-name MyStack \
  --change-set-name post-export-check \
  --change-set-type UPDATE \
  --template-body file://cdk.out/MyStack.template.json \
  --capabilities CAPABILITY_NAMED_IAM
aws cloudformation describe-change-set \
  --stack-name MyStack --change-set-name post-export-check
```

## Related

- [`cdkd export`](cli-export.md): the command, the run order and the options
- [cdkd export: nested stacks](cli-export-nested-stacks.md): Parameters a parent passes to a nested stack
- [`cdkd drift`](cli-drift.md): finding drift before you export
- [cdkd state: writing subcommands](cli-state-writing.md#cdkd-state-refresh-observed): `cdkd state refresh-observed`
