---
title: cdkd synth
description: "Synthesize a CDK app to CloudFormation templates with cdkd synth — the stdout contract, the assembly directory, and CDK annotation handling."
---

# cdkd synth

Runs the CDK app and writes its CloudFormation templates to the assembly
directory, printing the template to stdout when the app has exactly one stack.
Mirrors `cdk synth`.

It makes no AWS mutation and reads no cdkd state — it is the step every
app-reading command performs internally, run on its own.

```bash
cdkd synth                          # synthesize; print the template if there is one stack
cdkd synth > template.yaml          # capture the template, progress still on stderr
cdkd synth --output build/assembly  # synthesize somewhere other than cdk.out
cdkd synth --strict                 # also fail on CDK warning annotations
cdkd synth --ignore-errors          # never fail on annotations
```

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `--strict` | `false` | Fail on CDK **warning** annotations too, not only errors. |
| `--ignore-errors` | `false` | Never fail on annotations, error ones included. Produces a template that will likely not deploy. |
| `-a`, `--app <command>` | `cdk.json`, then `CDKD_APP` | The CDK app command, or a path to an already-synthesized assembly directory. |
| `--output <path>` | `cdk.out` | Directory to synthesize into. |
| `-c`, `--context <key=value...>` | — | Context values, repeatable. |
| `--profile <profile>` | — | AWS profile. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | Role to assume before any AWS call. |
| `--verbose` | `false` | Debug-level logging. |
| `-y`, `--yes` | `false` | Accepted for consistency with the other commands; `cdkd synth` asks no confirmation, so it changes nothing. |

`--strict` and `--ignore-errors` are shared with `cdkd deploy`; the flags and
the annotation categories they act on are described once, in
[Deploy: tuning](cli-deploy-tuning.md).

## It has no stack selection

`cdkd synth` takes no stack argument. It synthesizes the whole app, and every
stack's annotations are checked — so `--strict` on a multi-stack app fails when
*any* stack carries a warning, not just the one you had in mind. Use
[`cdkd list`](cli-list.md) to see what the app contains.

## Where the templates go

Every stack's template is written into the assembly directory (`cdk.out` by
default, `--output` to change it), one file per stack, exactly as `cdk synth`
writes them. That directory is the complete output; stdout is a convenience for
the single-stack case.

Because the directory is a valid cloud assembly, it can be fed straight back to
any cdkd command through `--app`, which then skips synthesis:

```bash
cdkd synth --output build/assembly
cdkd deploy --app build/assembly    # deploy what was just synthesized
```

## The stdout contract

With exactly one stack, the template goes to stdout as YAML and everything
cdkd's own logger prints — `Synthesizing CDK app...`, the `Synthesis complete!`
summary, the CDK app's re-emitted stderr — goes to stderr. With several stacks,
**stdout is empty**: the template is the payload or there is nothing, and the
summary is never a payload.

The emitted YAML parses back deep-equal to the per-stack template JSON in the
assembly directory — scalars keep their type, and the document starts at column
zero. Both properties are described in full on the CLI Reference page:

- [`cdkd synth` on a multi-stack app](cli-reference.md#cdkd-synth-on-a-multi-stack-app)
- [`cdkd synth`'s stdout parses back to the template](cli-reference.md#cdkd-synth-s-stdout-parses-back-to-the-template)

## CDK annotations

The app's `Annotations` are surfaced with CDK CLI parity: informational and
warning messages print, and an **error** annotation on any stack refuses the
synthesis rather than emitting a template — the same thing `cdk synth` does.
`--strict` promotes warnings to that treatment; `--ignore-errors` demotes
everything and always emits.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Synthesis succeeded and the assembly was written. |
| `1` | The app could not be resolved, the app itself failed, or an annotation refused the synthesis (any error annotation, or any warning under `--strict`). |

The full cross-command table is in the [CLI Reference](cli-reference.md#exit-codes).

## Related

- [`cdkd list`](cli-list.md) — the same app read, emitting stack names instead of templates
- [`cdkd diff`](cli-diff.md) — the synthesized template compared against cdkd state
- [Deploy: tuning](cli-deploy-tuning.md) — `--strict` and `--ignore-errors` in full
- [CLI Reference](cli-reference.md) — every command, the stdout contract, and the full exit-code table
