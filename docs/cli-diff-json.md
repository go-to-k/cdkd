---
title: "Diff: JSON output"
description: "The shape of cdkd diff --json: one record per stack, its changes, output changes, destructive changes and nested stacks."
---

# Diff: JSON output

`cdkd diff --json` prints the diff as JSON for a script or a CI job to read.
The output is an array with one record per stack you selected. Progress
messages are suppressed, so stdout holds only the JSON.

```bash
cdkd diff MyStack --json

# stacks with changes
cdkd diff --all --json | jq '.[] | select(.changes != []) | .stack'
```

## The record for one stack

```json
[
  {
    "stack": "MyStack",
    "region": "us-east-1",
    "changes": [
      {
        "logicalId": "ApiFunction",
        "changeType": "UPDATE",
        "resourceType": "AWS::Lambda::Function",
        "propertyChanges": [
          {
            "path": "Timeout",
            "oldValue": 3,
            "newValue": 30,
            "requiresReplacement": false
          }
        ]
      }
    ],
    "outputChanges": [],
    "unreadable": [],
    "unreadableContainers": [],
    "unreadableOrphans": [],
    "destructiveChanges": [],
    "children": []
  }
]
```

Every field at the top level of a record is always present, so a script can
rely on the same set of keys in every run.

| Field | Holds |
| --- | --- |
| `changes` | One entry per changed resource. |
| `outputChanges` | One entry per changed stack output. |
| `destructiveChanges` | The changes `--fail-on=destructive` fails on. |
| `children` | One record per nested stack. |
| `unreadable` | Resources in state the diff could not read. |
| `unreadableContainers` | Whole parts of state the diff could not read. |
| `unreadableOrphans` | Rollback leftovers in state the diff could not read. |

The sections below describe each one.

## `changes`

`changes` has one entry for each resource the deploy would create, update or
delete. Resources that would not change are left out.

Every entry has `logicalId`, `changeType` and `resourceType`. Three more
fields appear only when they apply:

| Field | Present when |
| --- | --- |
| `propertyChanges` | At least one property changes. |
| `attributeChanges` | At least one attribute changes. |
| `ccApi` | The resource would go through the Cloud Control API. |

`ccApi` is a list of strings. It is the JSON form of the `[via CC API: ...]`
note in the [text output](cli-diff.md#via-cc-api-routing).

### `propertyChanges`

Each entry gives the property's `path`, its `oldValue` and `newValue`, and
`requiresReplacement`.

The notes that the text output prints in square brackets appear here as
flags. A flag is present and `true` on the lines that carry the note, and
absent on all others.

| Flag | Note in the text output |
| --- | --- |
| `replacementPropagated` | `[replacement propagated]` |
| `inPlacePropagated` | `[attribute propagated]` |
| `maskedExpressionChanged` | `[masked input or expression changed]` |

Two things to know when reading these entries:

- On an entry with `maskedExpressionChanged`, `oldValue` and `newValue` are
  both `***`.
- On a propagated entry, `requiresReplacement: true` means the resource may be
  replaced. It is not a verdict, because the deploy decides once it knows the
  new value.

## `outputChanges`

Each entry describes one changed stack output:

```json
{
  "name": "BucketArn",
  "changeType": "MODIFY",
  "oldValue": "arn:aws:s3:::old-bucket",
  "newValue": "arn:aws:s3:::my-bucket",
  "export": false
}
```

| Field | Holds |
| --- | --- |
| `name` | The output's name. |
| `changeType` | `ADD`, `MODIFY` or `REMOVE`. |
| `oldValue` | The value in state. Absent on an `ADD`. |
| `newValue` | The value the deploy would publish. Absent on a `REMOVE`. |
| `export` | Whether the row is an export name. |
| `oldValueRedacted` | `true` when the old value is withheld. |
| `nameRedacted` | `true` when the name is masked or withheld. |

cdkd withholds an old value, or masks a name, when it may hold a secret. In
that case `oldValue` is replaced by `oldValueRedacted: true`. A name that
holds a secret is masked or withheld and carries `nameRedacted: true`, and two
withheld rows can then have the same `name`. The reasons are under
[Diff: secrets and NoEcho values](cli-diff-secrets.md).

## `destructiveChanges`

Each entry is one change that `--fail-on=destructive` fails on. It has
`logicalId`, `resourceType`, `impact`, and `constructPath` when state records
one.

| `impact` | Text output |
| --- | --- |
| `WILL_REPLACE` | `will be replaced` |
| `MAY_REPLACE` | `may be replaced` |
| `WILL_DESTROY` | `will be destroyed` |
| `WILL_ORPHAN` | `will be orphaned` |

What each impact means is under
[`--fail-on`](cli-diff.md#destructive).

## `children`

`children` holds one record per nested stack, in the same shape as the record
for a top-level stack. It is filled only with `--recursive` or
`--fail-on=destructive`, and is empty otherwise.

## The three `unreadable` fields

These fields are empty unless the state record is damaged. When any of them
holds an entry, `changes` does not show everything, because the diff treated
the damaged part of state as empty.

| Field | Holds |
| --- | --- |
| `unreadable` | The logical ID of each resource entry the diff dropped. |
| `unreadableContainers` | `"resources"` or `"orphans"`. |
| `unreadableOrphans` | One element per unreadable rollback leftover. |

`unreadableContainers` lists `"resources"` when the whole map of resources is
not an object, and `"orphans"` when the list of rollback leftovers is not a
list. Each element of `unreadableOrphans` is the leftover's `logicalId`, or
`null` when the record has none.

A rollback leftover is a resource a failed deploy left in AWS, which state
remembers so that the next deploy can adopt it. What the diff does with each
kind of damage is under
[Diff: incomplete or malformed state](cli-diff-state-records.md#when-the-state-record-is-malformed).

## Control characters in the payload

Control, format and line-separator characters in the payload are written as
`\uXXXX` escapes. A JSON parser turns them back into the same values, and
printing the raw payload cannot run a terminal control sequence.

## Related

- [`cdkd diff`](cli-diff.md): the text output, the exit codes and the options
- [Diff: stack outputs](cli-diff-outputs.md): what an output change is
- [Diff: incomplete or malformed state](cli-diff-state-records.md): the `unreadable` fields in context
