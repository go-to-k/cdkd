---
title: cdkd synth
description: "Synthesize a CDK app to CloudFormation templates with cdkd synth — the stdout contract, the assembly directory, and CDK annotation handling."
---

# cdkd synth

Runs the CDK app and writes its CloudFormation templates to the assembly
directory, printing one stack's template to stdout. Mirrors `cdk synth`.

Name a stack to choose which template that is. Every stack is synthesized
either way — the name selects what reaches stdout and what cdkd checks, not
what gets built. See
[What a stack name narrows](#what-a-stack-name-narrows-and-what-it-does-not).

It deploys nothing, but it is not offline. Synthesis resolves the account
through STS and runs the app's context lookups, and on a template using
CloudFormation **macros** `cdkd synth` expands them for real — creating and then
deleting a transient `cdkd-macro-expand-<uuid>` stack and change set, and
uploading the template to the cdkd state bucket when it exceeds CloudFormation's
inline size limit. `cdkd deploy` / `diff` / `list` defer that expansion to a
later phase; `cdkd synth` does it during synthesis, because its output is the
expanded template.

```bash
cdkd synth                          # synthesize; print the template if there is one stack
cdkd synth MyStack                  # print MyStack's template, whatever else the app holds
cdkd synth 'MyStage/Api'            # select by CDK display path
cdkd synth MyStack > template.yaml  # capture it, progress still on stderr
cdkd synth --output build/assembly  # synthesize somewhere other than cdk.out
cdkd synth --strict                 # also fail on CDK warning annotations
cdkd synth --ignore-errors          # never fail on annotations
```

## Arguments

| Argument | Description |
| --- | --- |
| `[stacks...]` | Which stack's template to print. Accepts physical CloudFormation names (`MyStage-Api`), CDK display paths (`MyStage/Api`) and wildcards (`MyStage/*`). A name matching nothing is refused, naming what the app does hold. |

With no argument and several stacks, cdkd prints no template and lists the
stack ids you can pass. Selecting several prints none either — stdout carries
one template or nothing, so a pipe never receives two documents.

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `--strict` | `false` | Fail on CDK **warning** annotations too, not only errors. |
| `--ignore-errors` | `false` | Never fail on annotations, error ones included. Produces a template that will likely not deploy. |
| `-a`, `--app <command>` | `CDKD_APP`, then `cdk.json` | The CDK app command, or a path to an already-synthesized assembly directory. |
| `--output <path>` | `cdk.out` | Directory to synthesize into. |
| `-c`, `--context <key=value...>` | — | Context values, repeatable. |
| `--profile <profile>` | — | AWS profile. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | Role to assume before any AWS call. |
| `--verbose` | `false` | Debug-level logging. Also writes a `<stackName>.template.json` into `--output` for each SELECTED stack (every stack when you name none), alongside whatever the app wrote. |
| `--region <region>` | `AWS_REGION`, then the profile | Deprecated and hidden, but honoured. Prefer `AWS_REGION` or the profile — see [`--region` / `AWS_REGION`](cli-reference.md#region-aws-region-every-command). |
| `-y`, `--yes` | `false` | Accepted for consistency with the other commands; `cdkd synth` asks no confirmation, so it changes nothing. |

`--strict` and `--ignore-errors` are shared with `cdkd deploy`; the flags and
the annotation categories they act on are described once, in
[Deploy: tuning](cli-deploy-tuning.md). Given both, **`--strict` wins** — the
same precedence the CDK CLI uses.

## What a stack name narrows, and what it does not

Naming a stack always synthesizes the whole app — the CDK app runs once and
every context lookup it needs is resolved, exactly as `cdk synth` does. What
the name narrows is what cdkd then looks at:

| | no name | `cdkd synth MyStack` |
| --- | --- | --- |
| Stacks synthesized | all | all |
| Context lookups | all | all |
| Template on stdout | only if the app has one stack | MyStack's |
| Annotations checked | every stack | MyStack only |
| `--verbose` template dump | every stack | MyStack only |

So `--strict` on a multi-stack app fails when *any* stack carries a warning —
unless you name one, which is how you scope it to the stack you had in mind.
Use [`cdkd list`](cli-list.md) to see what the app contains.

## Where the templates go

The **CDK app** writes its own templates into the assembly directory, one file
per stack; cdkd's part is to point the app at that directory (`cdk.out` by
default, `--output` to change it) and then read what appeared. The directory is
the complete output; stdout is a convenience for reading one template.

Because the directory is a valid cloud assembly, it can be fed straight back
through `--app` to the commands that take one — `deploy`, `diff`, `destroy`,
`list`, `synth` and the rest of the app-reading family, though not the
state-only ones like `gc` or `force-unlock` — and synthesis is then skipped:

```bash
cdkd synth --output build/assembly
cdkd deploy --app build/assembly    # deploy what was just synthesized
```

Nothing is written when `--app` already points at an assembly directory: there
is no app to run, so `cdkd synth --app build/assembly` reads and reports rather
than regenerating.

## The stdout contract

With a selection of exactly one stack — the app's only stack, or the one you
named — the template goes to stdout as YAML and everything cdkd's own logger
prints (`Synthesizing CDK app...`, the `Synthesis complete!` summary, the CDK
app's re-emitted stderr) goes to stderr. With any other selection **stdout is
empty**: the template is the payload or there is nothing, never two documents,
and the summary is never a payload.

The emitted YAML parses back deep-equal to the per-stack template JSON in the
assembly directory — scalars keep their type, and the document starts at column
zero. Both properties are described in full on the CLI Reference page:

- [`cdkd synth` on a multi-stack app](cli-reference.md#cdkd-synth-on-a-multi-stack-app)
- [`cdkd synth`'s stdout parses back to the template](cli-reference.md#cdkd-synth-s-stdout-parses-back-to-the-template)

## CDK annotations

The app's `Annotations` are surfaced with CDK CLI parity: informational and
warning messages print, and an **error** annotation on any SELECTED stack aborts with
`Found errors` — the same thing `cdk synth` does. `--strict` promotes warnings
to that treatment (`Found warnings (--strict mode)`); `--ignore-errors` demotes
everything, except that `--strict` overrides it when both are given.

What the abort stops is cdkd's own output — the template on stdout and the
summary. The **app has already run** by then, so its templates are on disk in
the assembly directory whether or not the annotation check passed.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The app ran, the assembly was written, and no annotation aborted the run. |
| `1` | The app could not be resolved, the app itself failed, or an annotation aborted the run (any error annotation, or any warning under `--strict`). The assembly directory may still hold the app's templates. |

The full cross-command table is in the [CLI Reference](cli-reference.md#exit-codes).

## Related

- [`cdkd list`](cli-list.md) — the same app read, emitting stack names instead of templates
- [`cdkd diff`](cli-diff.md) — the synthesized template compared against cdkd state
- [Deploy: tuning](cli-deploy-tuning.md) — `--strict` and `--ignore-errors` in full
- [CLI Reference](cli-reference.md) — every command, the stdout contract, and the full exit-code table
