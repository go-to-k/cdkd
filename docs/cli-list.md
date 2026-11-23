---
title: cdkd list
description: "List the stacks in a CDK app with cdkd list, and the stack selection patterns every cdkd command shares."
---

# cdkd list

`cdkd list` prints the stacks a CDK app synthesizes, one per line, in
dependency order. Run it to see what an app contains, or to feed stack names
to a script. This page also documents the stack selection patterns that every
command shares. `cdkd ls` is an alias.

```bash
# every stack, one id per line
cdkd list

# only the stacks directly inside one stage
cdkd list 'MyStage/*'

# each stack's name, account and region
cdkd list --long

# each stack's dependencies
cdkd list --show-dependencies

# the same payload as JSON
cdkd list --long --json
```

The command changes nothing in AWS, but it does call AWS. Synthesis resolves
the account through STS and runs the context lookups the app asks for
(unless `--no-lookups` is given), so
`--profile` and `--role-arn` matter here too.

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
| `--lookups`, `--no-lookups` | on | With `--no-lookups`, synthesis fails when the app needs a context lookup, instead of calling AWS. |
| `--profile <profile>` | | AWS profile. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | Role to assume before any AWS call. |
| `--verbose` | `false` | Debug-level logging. |
| `-y`, `--yes` | `false` | Accepted, but `cdkd list` asks no confirmation. |
| `--region <region>` | `AWS_REGION`, then your AWS profile | The region for a stack without `env.region`. See [Region resolution](cli-reference-region.md). |

## Selecting stacks

You select stacks by name or by pattern, and every command that takes stack
arguments matches them the same way: `deploy`, `diff`, `destroy`,
`publish-assets`, `scrub`, `synth` and `list`. The rules are the ones the AWS
CDK CLI uses.

```bash
cdkd list MyStage/Api               # one stack, by its CDK path
cdkd list 'MyStage/*'               # every stack directly inside a stage
cdkd list '**'                      # every stack, at any depth
cdkd list MyStage-Api MyStage-Db    # several, by exact physical name
```

cdkd matches a pattern against the stack's **hierarchical id**, which is its
path in the CDK app. A top-level stack has the id `Api`. A stack inside a
Stage named `MyStage` has the id `MyStage/Api`.

| Pattern | Matches |
| --- | --- |
| `Api` | The top-level stack with construct id `Api`. |
| `MyStage/Api` | That stack inside the Stage `MyStage`. |
| `'*'` | Every top-level stack. `*` matches within one `/` segment. |
| `'MyStage/*'` | The stacks directly inside `MyStage`. |
| `'**'` | Every stack, Stage stacks included. A whole segment `**` spans any number of segments. |
| `MyStage-Api` | The stack whose physical CloudFormation name is exactly `MyStage-Api`. |

Quote a pattern that contains a wildcard, so that the shell passes it to cdkd
unchanged. Under zsh an unmatched glob aborts the command.

### Edge cases

- **A stack whose `stackName` differs from its construct id.** A top-level
  stack is named by its construct id, as in `cdk deploy`.
- **Physical names are matched exactly.** Selecting by physical name is a cdkd
  extension, and it takes no wildcards. `'MyStage-*'` is matched against
  hierarchical ids only.
- **A pattern that is one stack's path and another stack's physical name.**
  The stack whose path it is gets selected.
- **Characters other than `*`.** Each matches only itself.

### Differences from `cdk`

| Syntax | `cdk` | cdkd |
| --- | --- | --- |
| `?`, `[...]`, `{a,b}`, a leading `!` | Glob syntax | Literal characters |
| `*` and `**` against a segment starting with `.` | No match | Match |

### `--all`

`--all` does not select the same stacks on every command:

| Command | What `--all` selects |
| --- | --- |
| `deploy`, `destroy`, `diff` | The top-level stacks only, as in the AWS CDK CLI. |
| `publish-assets`, `scrub` | Every stack, Stage stacks included. |

On `deploy`, `destroy` and `diff`, cdkd prints one line that names any Stage
stacks `--all` left out. To include them, name them with `'MyStage/*'` or
`'**'`. Those three commands refuse `--all` on an app whose every stack is
inside a Stage.

Older cdkd versions let `*` cross `/`, so `'*'` and `'MyStage-*'` reached
Stage stacks. When `deploy` or `destroy` leaves out a stack that the old rule
would have selected, it warns in one line. The warning names those stacks and
the pattern that selects them.

## What it prints

The default output is one id per line. A stack inside a CDK Stage has a path
and a physical name that differ, and its line carries both:

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

`--long` and `--show-dependencies` print a structured document. It is YAML by
default and JSON under `--json`.

### The structured document

`--long` and `--show-dependencies` print an array with one record per stack,
in dependency order. The array is the whole of stdout. A run that selects no
stack exits `1` and prints no array, so a successful run has at least one
record.

```json
[
  {
    "id": "MyStage/Api",
    "name": "MyStage-Api",
    "environment": {
      "account": "123456789012",
      "region": "us-east-1"
    },
    "dependencies": ["MyStage-Db"]
  }
]
```

The fields depend on the flags:

| Flags | Fields in each record |
| --- | --- |
| `--long` | `id`, `name`, `environment` |
| `--long --show-dependencies` | `id`, `name`, `environment`, `dependencies` |
| `--show-dependencies` | `id`, `dependencies` |

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Under `--long`, the stack's display name, which is its path in the CDK app (`MyStage/Api`), or the physical stack name when the assembly records no display name. Under `--show-dependencies` alone, the id as the default output prints it: `MyStage/Api (MyStage-Api)` when the path and the physical name differ, and the path alone when they match. |
| `name` | string | The stack's physical CloudFormation name. |
| `environment.account` | string | The AWS account id. It is the string `unknown-account` when the stack is environment-agnostic and has no account. |
| `environment.region` | string | The region. It is the string `unknown-region` when the stack has none. |
| `dependencies` | array of strings | The physical `stackName` of each stack this stack depends on, or that stack's artifact id when the assembly records no name. A dependency whose name equals this stack's own name and a dependency that is not a stack, such as an asset manifest, are left out. The array is empty for a stack with no dependency. |

`dependencies` is present only when `--show-dependencies` is set. `name` and
`environment` are present only under `--long`. A key that a flag combination
does not select is absent, not `null`.

`--json` changes only the encoding: the YAML document holds the same
records, key for key.

The listing goes to stdout, and everything else goes to stderr. That includes
progress lines such as `Resolving missing context...`, the CDK app's own
stderr, and `--verbose` output. A redirect therefore captures the listing
alone. See [Output streams](cli-reference-output.md).

### Edge cases

- **Account ids in YAML.** The structured document parses back unchanged. An
  AWS account id is a string in it, so YAML quotes the id
  (`account: "123456789012"`), which matches `--json`.
- **Invisible characters under `--json`.** A control, format, line-separator
  or paragraph-separator character left in a value, such as a zero-width
  space, is written as a `\uXXXX` escape.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The listing was printed. |
| `1` | Synthesis failed, the app could not be resolved, the assembly held no stacks, or no pattern matched anything. |

cdkd judges matching over the whole set of patterns. `cdkd list Good Bad`
prints `Good` and exits `0`. The command fails only when every pattern misses,
and the message then lists the patterns you gave and the stacks that exist.

[Exit codes](cli-reference-exit-codes.md) has the table for every command.

## Related

- [`cdkd synth`](cli-synth.md): reads the same app and prints templates
- [`cdkd diff`](cli-diff.md): what a deploy of a listed stack would change
- [Output streams](cli-reference-output.md): the commands whose stdout you can pipe
- [CLI Reference](cli-reference.md): every command and the shared options
