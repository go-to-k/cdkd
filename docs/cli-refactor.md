---
title: cdkd refactor
description: "Keep a resource whose logical ID a construct rename changed, instead of letting the next cdkd deploy replace it."
---

# cdkd refactor

Renaming a construct, moving it under another parent construct, or moving it
to another stack changes its CloudFormation logical ID or its stack. On the
next `cdkd deploy`, the old resource is deleted and a new one is created, so
the AWS resource is replaced: a bucket, table or database loses its data.
`cdkd refactor` keeps the resource instead. It is cdkd's counterpart of
`cdk refactor`.

```bash
# show what would be renamed
cdkd refactor --dry-run

# rename, after a confirmation prompt
cdkd refactor MyStack

# then confirm the renamed resources show no change
cdkd diff MyStack

# a resource moved from one stack to another: select both stacks
cdkd refactor OldStack NewStack
```

Run it after you change the CDK code and before you deploy.
[Keep Resources When You Rename or Move Constructs](refactor.md) walks through
it step by step.

## What it changes

`cdkd refactor` rewrites cdkd state only. It never creates, updates or deletes
an AWS resource: under cdkd a resource is tracked by its state record, so
keeping it is renaming the record's key. The rename keeps the physical ID,
attributes and everything else the record holds. References to the old
logical ID in other records (dependencies, and any `Ref`, `Fn::GetAtt` or
`Fn::Sub` the record still holds) move to the new logical ID.

The write takes the stack's lock and is conditional on the state cdkd read
while planning, so a deploy running at the same time cannot be overwritten.
The state bucket keeps earlier versions of `state.json`; see
[State management](state-management.md).

## How a rename is found

A resource is renamed when the stack's state holds a logical ID the template no
longer declares, the template declares a new logical ID of the same type, and
the new resource is unchanged: diffing the template against the renamed state
shows no change for it. That is the same comparison `cdkd deploy` makes, so a
refactor never keeps a pair the next deploy would update.

When several resources of one type were renamed, cdkd first pairs them by
their properties. Resources that still look alike, for example two roles that
differ only in the policies they reference, are tried against each other with
the same diff, and each one that matches exactly one way is renamed. A very large
group of look-alikes is reported as ambiguous instead; name its pairs with
`--override-file`. Each try is one more diff of the stack, so a
refactor with look-alikes takes longer than one without.

| Situation | What cdkd refactor does |
| --- | --- |
| One removed and one added resource of a type, unchanged | Renames it |
| Several of a type, each matching exactly one old resource | Renames each |
| Two or more that match equally (for example two identical queues) | Reports them as ambiguous and writes nothing; name the pairs with `--override-file` |
| The resource was renamed and its properties also changed | Leaves it, and says so; see below |
| An `AWS::CloudFormation::Stack` (nested stack) row | Never renamed |
| A resource inside a nested stack | Not looked at; only the selected stack's own resources are |

A resource whose properties also changed is not renamed, as in `cdk refactor`.
cdkd cannot tell such a resource from a different resource of the same type,
and renaming the wrong record would point cdkd at the wrong AWS resource.
Revert the property change, run `cdkd refactor`, then deploy the property
change.

## Naming pairs with a mapping file

`--override-file` takes the mapping file `cdk refactor` reads:

```json
{
  "environments": [
    {
      "account": "123456789012",
      "region": "us-east-1",
      "resources": {
        "MyStack.QueueA1B2C3D4": "MyStack.WorkQueueE5F6A7B8"
      }
    }
  ]
}
```

Each key is the old location and each value the new one, as
`<StackName>.<LogicalId>`. A named pair must still be unchanged. When the
detection finds an ambiguous group, `cdkd refactor` prints a mapping file for
it to edit. `--revert` applies the file in reverse, which renames the records
back after the code change is undone.

A key and its value may name two different stacks, which moves the resource
between them.

## Moving a resource between stacks

When the run selects two or more stacks, a resource that one stack's template
no longer declares can move to another stack whose template newly declares a
resource of the same type. The rule is the same: the destination's diff must
show the moved resource unchanged.

- Both stacks must be selected, hold cdkd state already, and be in the same
  account and region. A refactor never creates a stack: deploy the new stack
  first.
- Look-alikes across stacks are reported as ambiguous; name them in the
  mapping file.
- A stack that would both lose and gain a resource in one run is refused. Run
  the refactor once per direction.
- Both stacks are locked. See
  [If a refactor is interrupted](#if-a-refactor-is-interrupted) for how a move
  survives a failure or a killed process.

After a move, deploy the stack that gained the resource before the stacks that
import from it. `cdkd deploy --all` orders stacks that way already.

## If a refactor is interrupted

`cdkd refactor` never leaves a stack's state half written:

- A rename is one write of the stack's `state.json`. It either happened or it
  did not.
- Ctrl+C or `SIGTERM` during the writes is held until they finish, a few
  writes taking well under a second. The command then stops and says so.
- A move between stacks is written in steps. First cdkd lists the move in
  `_refactor/pending.json` under the state prefix. Then the stack losing the
  resource records the move too, and keeps the resource. Then the stack
  gaining it adds it, the first stack drops it, and the list entry is removed.

If a move stops part way, through a network failure, a killed process or a
closed terminal, the move is still listed:

- `cdkd deploy` and `cdkd destroy` of either stack refuse. The stack losing
  the resource would delete a resource the other stack may already hold, and
  the stack gaining it would create the resource a second time. `cdkd diff`
  exits with code `3` and says why.
- Run `cdkd refactor` with either stack selected to finish the move. It checks
  what the other stack holds, adds the resource there if it is missing, and
  then drops it from the first stack.

Every `cdkd deploy` reads `_refactor/pending.json` for each stack at the same
time as that stack's state record, under its lock, so it adds no wait.
`cdkd destroy` reads it under each stack's lock. A policy that denies reading
it is treated as no move in progress, and that run does not check for one.

With `--dry-run`, `cdkd refactor` lists the interrupted moves it would finish
and writes nothing.

If a stack named in the list was changed by hand, or by an older cdkd, so that
both stacks hold a different resource under the moved logical ID,
`cdkd refactor` refuses and names both. Delete or
[orphan](orphan-vs-destroy.md) the extra resource, then re-run
`cdkd refactor`.

The state bucket also keeps earlier versions of every `state.json`, so a
record can be restored by hand.

## When it refuses

Nothing is written when `cdkd refactor` refuses:

- `cdkd diff` reports a condition `cdkd deploy` refuses to start on.
- An earlier deploy left a rollback journal: run `cdkd rollback` or a
  successful `cdkd deploy` first.
- The detection found an ambiguous group no mapping file names.
- The stack is locked by another run.
- An interrupted move involving the stack cannot be finished; the error names
  which one and why. Moves of the same stack that could be finished are
  written, and only the refused ones stay recorded.
- The state changed between planning and writing: re-run `cdkd refactor`.
- A mapping-file pair is not a removed and an added resource of one type, or
  its properties changed.
- A move names a stack that is not selected or has no state, crosses accounts
  or regions, or would make one stack both lose and gain a resource.

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `[stacks...]` | the only stack | Stacks to refactor, selected as in `cdkd diff`. |
| `--all` | `false` | Every top-level stack. |
| `--dry-run` | `false` | Print the plan and exit, without prompting or writing. |
| `--override-file <path>` | | A mapping file naming pairs, in the `cdk refactor` format. |
| `--revert` | `false` | Apply the mapping file in reverse. Requires `--override-file`. |
| `-f`, `--force` / `-y`, `--yes` | `false` | Skip the confirmation prompt. |
| `--state-bucket <bucket>` | `cdkd-state-{accountId}` | The bucket holding cdkd state. |
| `--state-prefix <prefix>` | `cdkd` | The key prefix of the stack's state. |
| `--profile <profile>` | | AWS profile. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | IAM role to assume for AWS API calls. |
| `--verbose` | `false` | Debug-level logging. |

A non-interactive run without `--yes` or `--force` refuses rather than waiting
on the prompt.
