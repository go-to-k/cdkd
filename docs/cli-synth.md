---
title: cdkd synth
description: "Synthesize a CDK app to CloudFormation templates with cdkd synth: what reaches stdout, the assembly directory, and CDK annotation handling."
---

# cdkd synth

`cdkd synth` runs the CDK app, writes its CloudFormation templates to the
assembly directory, and prints one stack's template to stdout. It mirrors
`cdk synth`.

```bash
# print the template if the app has one stack
cdkd synth

# print MyStack's template
cdkd synth MyStack

# select by CDK display path
cdkd synth 'MyStage/Api'

# capture it; progress stays on stderr
cdkd synth MyStack > template.yaml

# synthesize somewhere other than cdk.out
cdkd synth --output build/assembly

# also fail on CDK warning annotations
cdkd synth --strict
```

cdkd synthesizes every stack whether or not you name one. The name chooses
which template reaches stdout and which stack cdkd checks for annotations.

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `[stacks...]` | the only stack | Which stack's template to print. Takes the patterns under [Selecting stacks](cli-list.md#selecting-stacks). |
| `--strict` | `false` | Fail on CDK warning annotations too, not only errors. |
| `--ignore-errors` | `false` | Never fail on annotations. The template will likely not deploy. |
| `-a`, `--app <command>` | `CDKD_APP`, then `cdk.json` | The CDK app command, or a path to a synthesized assembly directory. |
| `--output <path>` | `cdk.out` | Directory to synthesize into. |
| `-c`, `--context <key=value...>` | | Context values. Repeatable. |
| `--profile <profile>` | | AWS profile. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | Role to assume before any AWS call. |
| `--verbose` | `false` | Debug-level logging. Also writes `<stackName>.template.json` into `--output` for each selected stack. |
| `-y`, `--yes` | `false` | Accepted, but `cdkd synth` asks no confirmation. |
| `--region <region>` | | Deprecated and hidden. See [Region resolution](cli-reference-region.md). |

cdkd refuses a name that matches no stack, and the message names the stacks
the app does hold. When you pass both `--strict` and `--ignore-errors`,
`--strict` wins, as in the CDK CLI.

## What a stack name narrows, and what it does not

Naming a stack still synthesizes the whole app. The CDK app runs once, and
every context lookup it needs is resolved, as with `cdk synth`. The name
narrows only what cdkd does afterwards:

| | No name | `cdkd synth MyStack` |
| --- | --- | --- |
| Stacks synthesized | all | all |
| Context lookups | all | all |
| Template on stdout | only if the app has one stack | MyStack's |
| Annotations checked | every stack | MyStack only |
| `--verbose` template files | every stack | MyStack only |

One consequence is that `--strict` on an app with several stacks fails when
any stack carries a warning, unless you name the stack you mean.
[`cdkd list`](cli-list.md) shows what the app contains.

## The stdout contract

stdout carries one template or nothing. It never carries two templates, and it
never carries progress text.

```bash
cdkd synth MyStack | yq '.Resources | keys'
cdkd synth MyStack > template.yaml 2> progress.log
```

| Selection | stdout |
| --- | --- |
| Exactly one stack: the app's only stack, or the one you named | That stack's template, as YAML |
| No name, on an app with several stacks | Empty. cdkd lists the stack ids you can pass. |
| A pattern that selects several stacks | Empty |

Everything else goes to stderr: `Synthesizing CDK app...`, the
`Synthesis complete!` summary, and the CDK app's own stderr.

To get every stack's template at once, read the per-stack files from the
assembly directory.

### The YAML parses back to the template

The document that a YAML parser returns is deep-equal to the stack's template
JSON in the assembly directory. That holds under a YAML 1.1 reader such as
`yq`, and under a YAML 1.2 reader.

- Scalars keep their type. A number stays a number (`ExpirationInDays: 90`),
  and a numeric string stays a string (`schemaVersion: "2.2"`).
- The document starts at column 0, with no leading blank line.

## Where the templates go

The CDK app writes its templates into the assembly directory, one file per
stack. cdkd points the app at that directory, which is `cdk.out` by default or
the value of `--output`, and then reads what the app wrote. The directory is
the complete output. stdout is a convenience for reading one template.

The directory is a valid cloud assembly, so you can pass it to `--app` on the
commands that read a CDK app. Those commands then skip synthesis:

```bash
cdkd synth --output build/assembly
cdkd deploy --app build/assembly    # deploy what was just synthesized
```

`cdkd synth --app build/assembly` writes nothing. There is no app to run, so
the command reads the assembly and reports on it.

## AWS calls synth makes

`cdkd synth` deploys nothing, but it does call AWS:

- Synthesis resolves the account through STS and runs the app's context
  lookups.
- A template that uses CloudFormation macros is expanded for real, because
  the output is the expanded template.

To expand macros, cdkd creates a temporary `cdkd-macro-expand-<uuid>` stack
and change set, and then deletes them. When the template exceeds
CloudFormation's inline size limit, cdkd uploads it to the cdkd state
bucket. `cdkd deploy`, `cdkd diff` and `cdkd list` defer that expansion to a
later phase.

## CDK annotations

cdkd handles the app's `Annotations` as the CDK CLI does:

| Annotation on a selected stack | Result |
| --- | --- |
| Info or warning | Printed. The run continues. |
| Error | The run aborts with `Found errors`. |
| Warning, under `--strict` | The run aborts with `Found warnings (--strict mode)`. |
| Any, under `--ignore-errors` | Printed. The run continues, unless `--strict` is also set. |

An abort stops cdkd's own output, which is the template on stdout and the
summary. The app has already run by then, so its templates are in the assembly
directory whether or not the check passed.
[CDK annotation messages](cli-deploy-tuning.md#cdk-annotation-messages) has
the detail these flags share with `cdkd deploy`.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The app ran, the assembly was written, and no annotation aborted the run. |
| `1` | The app could not be resolved, the app failed, a name matched no stack, or an annotation aborted the run. The assembly directory may still hold the app's templates. |

[Exit codes](cli-reference-exit-codes.md) has the table for every command.

## Related

- [`cdkd list`](cli-list.md): reads the same app and prints stack names
- [`cdkd diff`](cli-diff.md): the synthesized template compared against cdkd state
- [Deploy: tuning](cli-deploy-tuning.md): `--strict` and `--ignore-errors` in full
- [Output streams](cli-reference-output.md): the commands whose stdout you can pipe
