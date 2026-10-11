---
title: cdkd list
description: "List the stacks in a CDK app with cdkd list, and the stack selection patterns every cdkd command shares."
---

# cdkd list

`cdkd list` prints the stacks a CDK app synthesizes, one per line, in
dependency order. Run it to see what an app contains, or to feed stack names
to a script. This page also documents the stack selection patterns every
command shares. `cdkd ls` is an alias.

```bash
cdkd list                           # every stack, one id per line
cdkd list 'MyStage/*'               # only the stacks directly inside one stage
cdkd list --long                    # each stack's name, account and region
cdkd list --show-dependencies       # each stack's dependencies
cdkd list --long --json             # the same payload as JSON
```

The command changes nothing, but it is not offline. Synthesis resolves the
account through STS and runs the context lookups the app asks for, which is
what `--profile` and `--role-arn` are for here.

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `[stacks...]` | every stack | Patterns that filter the listing. See [Selecting stacks](#selecting-stacks). |
| `-l`, `--long` | `false` | Print each stack's name, account and region. |
| `-d`, `--show-dependencies` | `false` | Print each stack's dependencies. |
| `--json` | `false` | Encode the `--long` / `--show-dependencies` payload as JSON, not YAML. No effect on the default output. |
| `-a`, `--app <command>` | `CDKD_APP`, then `cdk.json` | The CDK app command, or a path to a synthesized assembly directory. |
| `--output <path>` | `cdk.out` | Directory to synthesize into. |
| `-c`, `--context <key=value...>` | | Context values. Repeatable. |
| `--profile <profile>` | | AWS profile. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | Role to assume before any AWS call. |
| `--verbose` | `false` | Debug-level logging. |
| `-y`, `--yes` | `false` | Accepted, but `cdkd list` asks no confirmation. |
| `--region <region>` | | Deprecated and hidden. See [`--region` / `AWS_REGION`](cli-reference.md#region-aws-region-every-command). |

## Selecting stacks

Every command that takes stack arguments (`deploy`, `diff`, `destroy`,
`publish-assets`, `scrub`, `synth`, `list`) matches them the same way, which
is the way the AWS CDK CLI does.

```bash
cdkd list MyStage/Api               # one stack, by its CDK path
cdkd list 'MyStage/*'               # every stack directly inside a stage
cdkd list '**'                      # every stack, at any depth
cdkd list MyStage-Api MyStage-Db    # several, by exact physical name
```

A pattern is matched against the stack's **hierarchical id**, its CDK display
path: `Api` for a top-level stack, `MyStage/Api` inside a Stage.

| Pattern | Matches |
| --- | --- |
| `Api` | The top-level stack with construct id `Api`. |
| `MyStage/Api` | That stack inside the Stage `MyStage`. |
| `'*'` | Every top-level stack. `*` matches within one `/` segment. |
| `'MyStage/*'` | The stacks directly inside `MyStage`. |
| `'**'` | Every stack, Stage stacks included. A whole segment `**` spans any number of segments. |
| `MyStage-Api` | The stack whose physical CloudFormation name is exactly `MyStage-Api`. |

Rules worth knowing:

- Quote a wildcard, so the shell passes the pattern to cdkd. Under zsh an
  unmatched glob aborts the command.
- A top-level stack whose `stackName` differs from its construct id is named
  by the construct id, as in `cdk deploy`.
- The physical-name form is a cdkd extension and is exact only.
  `'MyStage-*'` is matched against hierarchical ids, not physical names.
- When a pattern is one stack's CDK path, that stack is selected, even if
  another stack's physical name is the same string.
- Every character other than `*` matches only itself.

### Differences from `cdk`

| Syntax | `cdk` | cdkd |
| --- | --- | --- |
| `?`, `[...]`, `{a,b}`, a leading `!` | Glob syntax | Literal characters |
| `*` and `**` against a segment starting with `.` | No match | Match |

### `--all`

| Command | What `--all` selects |
| --- | --- |
| `deploy`, `destroy`, `diff` | The top-level stacks only, as in the AWS CDK CLI. One line names any Stage stacks left out. |
| `publish-assets`, `scrub` | Every stack, Stage stacks included. |

To include Stage stacks on `deploy`, `destroy` or `diff`, name them with
`'MyStage/*'` or `'**'`. Those three refuse `--all` on an app whose every stack
is inside a Stage.

Older cdkd versions let `*` cross `/`, so `'*'` and `'MyStage-*'` reached
Stage stacks. When `deploy` or `destroy` leaves out a stack that rule would
have selected, it warns in one line naming those stacks and the pattern that
selects them.

## What it prints

The default output is one id per line. Where a stack's display path and its
physical name differ, which is what a CDK Stage produces, the line carries
both:

```text
Network
MyStage/Api (MyStage-Api)
MyStage/Db (MyStage-Db)
```

That form is for reading. To feed stack names to another command, take them
from the structured output:

```bash
cdkd list --long --json | jq -r '.[].name' | while read -r name; do
  cdkd diff "$name"
done
```

`--long` and `--show-dependencies` print a structured document, YAML by
default and JSON under `--json`:

- The document parses back unchanged. An AWS account id is a string in the
  payload, so YAML quotes it (`account: "123456789012"`), matching `--json`.
- Under `--json`, a control, format, line-separator or paragraph-separator
  character left in a value, such as a zero-width space, is written as a
  `\uXXXX` escape.

The listing goes to stdout and everything else goes to stderr: progress lines
such as `Resolving missing context...`, the CDK app's own stderr and
`--verbose` output. A redirect therefore captures the listing alone. See
[Output streams](cli-reference.md#output-streams-when-stdout-is-a-payload).

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The listing was printed. |
| `1` | Synthesis failed, the app could not be resolved, the assembly held no stacks, or no pattern matched anything. |

Matching is judged over the whole set of patterns. `cdkd list Good Bad` prints
`Good` and exits `0`. Only when every pattern misses is it an error, and the
message lists the patterns given and the stacks that exist.

The table for every command is in the [CLI Reference](cli-reference.md#exit-codes).

## Related

- [`cdkd synth`](cli-synth.md): reads the same app and prints templates
- [`cdkd diff`](cli-diff.md): what a deploy of a listed stack would change
- [CLI Reference](cli-reference.md): every command, the stdout contract and exit codes
