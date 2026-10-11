---
title: "cdkd drift: JSON output"
description: "The shape of cdkd drift --json, how to gate CI on it, and what the command writes to stdout and stderr."
---

# cdkd drift: JSON output

`cdkd drift --json` prints the drift report as JSON on stdout, for a script or
a CI job to read. The output is an array with one object per stack.

```bash
cdkd drift --all --json > report.json
```

To fail a CI job unless everything was compared and nothing drifted:

```bash
cdkd drift --all --json \
  | jq -e 'all(.[]; .drifted == [] and .deleted == [] and .notCompared == [])'
```

## The report for one stack

```json
[
  {
    "stack": "MyStack",
    "region": "us-east-1",
    "drifted": [
      {
        "logicalId": "Bucket1",
        "type": "AWS::S3::Bucket",
        "changes": [
          {
            "path": "VersioningConfiguration.Status",
            "stateValue": "Enabled",
            "awsValue": "Suspended"
          }
        ],
        "referencesUnresolved": false
      }
    ],
    "deleted": [
      { "logicalId": "Topic1", "type": "AWS::SNS::Topic" }
    ],
    "clean": [
      {
        "logicalId": "Queue1",
        "type": "AWS::SQS::Queue",
        "referencesUnresolved": false
      }
    ],
    "notSupported": [
      { "logicalId": "Function1", "type": "AWS::Lambda::Function" }
    ],
    "skipped": [],
    "notCompared": []
  }
]
```

Each resource of the stack appears in one of the arrays. The one exception is
a drifted resource that was only partly compared, which is in both `drifted`
and `notCompared`.

| Field | Holds |
| --- | --- |
| `drifted` | Resources with a changed property. |
| `deleted` | Resources AWS reports as deleted. |
| `clean` | Resources fully compared and matching. |
| `notSupported` | Resources reported as drift unknown. |
| `skipped` | Resources cdkd does not check for drift. |
| `notCompared` | Resources not fully compared. |
| `warnings` | Stack-level messages, as strings. |

Details the table leaves out:

- A `drifted` entry lists each changed property under `changes`, with the
  value in state (`stateValue`) and the value in AWS (`awsValue`).
- A `deleted` entry for a nested stack whose state record is gone carries
  `"nestedStackRecordMissing": true`. See
  [cdkd drift: nested stacks](cli-drift-nested-stacks.md#a-nested-stack-whose-record-is-missing).
- A `clean` entry always has `referencesUnresolved: false`.
- `skipped` includes the parent's row for a nested stack, because the nested
  stack has a report of its own in the array.
- `warnings` is left out when there are none.

### `warnings`

cdkd prints its warnings on stderr, and a script reading stdout would miss
them. The `warnings` array repeats the stack-level ones in the payload. The
strings are written for a person reading a log. They contain stack names,
regions, logical ids and counts, and never a property value.

## `notCompared`

An entry in `notCompared` is a resource cdkd could not fully compare:

```json
"notCompared": [
  {
    "logicalId": "Function1",
    "type": "AWS::Lambda::Function",
    "referencesUnresolved": true,
    "cause": "refused"
  },
  {
    "logicalId": "Budget1",
    "type": "AWS::Budgets::Budget",
    "referencesUnresolved": false,
    "cause": "readFailed"
  }
]
```

`cause` says why. Its values are listed in the
[lookup table](cli-drift-not-compared.md#why-a-resource-was-not-compared),
which also says which causes can be cleared and which are permanent. Use
`cause` when a script needs to tell those apart.

`referencesUnresolved` is `true` when the rest of the resource was compared
and `false` when nothing was.

To find the resources that were not compared, test `notCompared.length` or
read `cause`. Filtering on `referencesUnresolved` does not work, because it
drops every entry for which nothing was compared.

Older cdkd releases listed a resource deleted outside cdkd, and a nested stack
row, in `notSupported`.

## Streams under `--json`

With `--json`, stdout holds the JSON and nothing else. This is true with
`--accept`, `--revert` and `--dry-run` as well. Everything the command would
otherwise print on stdout goes to stderr:

- the `--accept` or `--revert` plan,
- the confirmation prompt,
- the `--dry-run` notice,
- the `Comparison INCOMPLETE` block,
- the `✓ State updated` and `Revert summary` lines,
- `--verbose` output.

So the two streams can be captured separately:

```bash
cdkd drift MyStack --json --accept --yes > report.json 2> progress.log
```

### Values in the payload are not sanitised

The human report alters values that contain control characters. The JSON
payload does not, because a script wants the stored value. Control, format and
line-separator characters are written as `\uXXXX` escapes. A JSON parser turns
them back into the stored values, and printing the raw payload cannot run a
terminal control sequence.

Which other commands reserve stdout for a payload is under
[Output streams](cli-reference-output.md).

## Related

- [`cdkd drift`](cli-drift.md): the report, the exit codes and the options
- [cdkd drift: what was not compared](cli-drift-not-compared.md): every `cause` value
- [CLI Reference](cli-reference.md): exit codes and output streams for every command
