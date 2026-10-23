---
title: cdkd refactor
description: "Keep a resource whose logical ID a construct rename changed, instead of letting the next cdkd deploy replace it."
---

# cdkd refactor

Renaming a construct, or moving it under another parent construct, changes its
CloudFormation logical ID. On the next `cdkd deploy`, the old logical ID is
deleted and the new one is created, so the AWS resource is replaced: a bucket,
table or database loses its data. `cdkd refactor` keeps the resource instead.
It is cdkd's counterpart of `cdk refactor`.

```bash
# show what would be renamed
cdkd refactor --dry-run

# rename, after a confirmation prompt
cdkd refactor MyStack

# then confirm the renamed resources show no change
cdkd diff MyStack
```

Run it after you change the CDK code and before you deploy.

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
the same diff, and each one that matches exactly one way is renamed.

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

Moving a resource between two stacks is not supported; a mapping that does so
is refused.

## When it refuses

Nothing is written when `cdkd refactor` refuses:

- `cdkd diff` reports a condition `cdkd deploy` refuses to start on.
- An earlier deploy left a rollback journal: run `cdkd rollback` or a
  successful `cdkd deploy` first.
- The detection found an ambiguous group no mapping file names.
- The stack is locked by another run.
- The state changed between planning and writing: re-run `cdkd refactor`.
- A mapping-file pair is not a removed and an added resource of one type, or
  its properties changed.

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
