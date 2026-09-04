---
title: cdkd list
description: "List the stacks in a CDK app with cdkd list — display paths, wildcard selection, and the environment and dependency views."
---

# cdkd list

Prints the stacks a CDK app synthesizes, one per line, in dependency order.
It is usually the first thing you run against an unfamiliar app.

It synthesizes the app and mutates nothing, but it is not offline: synthesis
resolves the account through STS and runs whatever context lookups the app asks
for, which is what `--profile` and `--role-arn` are for here. Aliased `ls`.

```bash
cdkd list                           # every stack, one id per line
cdkd ls                             # same command
cdkd list 'MyStage/*'               # only the stacks under one stage
cdkd list --long                    # add each stack's account and region
cdkd list --show-dependencies       # add each stack's dependencies
cdkd list --long --json             # the same payload as JSON
```

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `-l`, `--long` | `false` | Print each stack's environment — name, account, region — instead of just its id. |
| `-d`, `--show-dependencies` | `false` | Print each stack's dependencies instead of just its id. |
| `--json` | `false` | Encode the `--long` / `--show-dependencies` payload as JSON instead of YAML. Has no effect on the default one-id-per-line output. |
| `-a`, `--app <command>` | `CDKD_APP`, then `cdk.json` | The CDK app command, or a path to an already-synthesized assembly directory. |
| `--output <path>` | `cdk.out` | Directory to synthesize into. |
| `-c`, `--context <key=value...>` | — | Context values, repeatable. |
| `--profile <profile>` | — | AWS profile. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | Role to assume before any AWS call. |
| `--verbose` | `false` | Debug-level logging. |
| `--region <region>` | `AWS_REGION`, then the profile | Deprecated and hidden, but honoured. Prefer `AWS_REGION` or the profile — see [`--region` / `AWS_REGION`](cli-reference.md#region-aws-region-every-command). |
| `-y`, `--yes` | `false` | Accepted for consistency with the other commands; `cdkd list` asks no confirmation, so it changes nothing. |

## Selecting stacks

Positional arguments filter the listing. They accept the same two spellings
`deploy` / `diff` / `destroy` do — a physical CloudFormation name
(`MyStage-Api`) or a CDK display path (`MyStage/Api`) — and support wildcards:

```bash
cdkd list MyStage/Api               # one stack
cdkd list 'MyStage/*'               # every stack in a stage (quote the glob)
cdkd list MyStage-Api MyStage-Db    # several, by physical name
```

Quote a wildcard, so the shell hands the pattern to cdkd rather than trying to
resolve it itself — under zsh an unmatched glob aborts the command outright.

With no argument, every stack in the app is listed.

## What it prints

The default output is one id per line, in dependency order. **The id is not
always just the display path**: where a stack's display path and its physical
CloudFormation name differ — which is what a CDK Stage produces — the line
carries both, as `MyStage/Api (MyStage-Api)`. A single-stack app with no stage
prints the bare name, so the two shapes look alike until a stage appears.

That parens form is for reading, not for piping. To feed stack names to another
command, take them from the structured output:

```bash
cdkd list --long --json | jq -r '.[].name' | while read -r name; do
  cdkd diff "$name"
done
```

`--long` and `--show-dependencies` switch to a structured document — YAML by
default, JSON under `--json`. The same renderer produces `cdkd synth`'s
template, so the document parses back unchanged; one detail worth knowing is
that an AWS account id is a string in the payload and is emitted quoted
(`account: "123456789012"`), matching what `--json` returns.

**stdout is a payload stream on this command.** The listing goes to stdout and
everything else — `Resolving missing context...`, the CDK app's re-emitted
stderr, `--verbose` output — goes to stderr, so a redirect captures the listing
alone. See
[Output streams](cli-reference.md#output-streams-when-stdout-is-a-payload).

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The listing was printed. |
| `1` | Synthesis failed, the app could not be resolved, the assembly held no stacks, or **no** pattern matched anything. |

Matching is evaluated over the whole pattern set, not per pattern: `cdkd list
Good Bad` prints `Good` and exits `0`. Only when every pattern misses is it an
error, and the message then lists the patterns given alongside the stacks that
do exist. Scripts that treat "no match" as a normal outcome need to handle that
non-zero exit.

The full cross-command table is in the [CLI Reference](cli-reference.md#exit-codes).

## Related

- [`cdkd synth`](cli-synth.md) — the same app read, emitting templates instead of names
- [`cdkd diff`](cli-diff.md) — what a deploy of a listed stack would change
- [CLI Reference](cli-reference.md) — every command, the stdout contract, and the full exit-code table
