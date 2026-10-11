---
title: Deployment Events
description: "What cdkd records for each deploy, destroy and rollback run, how to read a failed run back with cdkd events, and where the history is stored."
---

# Deployment Events (`cdkd events`)

cdkd keeps a record of every `cdkd deploy`, `cdkd destroy`,
`cdkd state destroy` and `cdkd rollback` run. The record lists what the run
did to each resource: which operation started, whether it succeeded, and the
AWS error if it failed. It is stored in the state bucket, so you can read a
failed run later, from another machine, or after the stack is gone. It is
cdkd's equivalent of CloudFormation's `DescribeStackEvents`.

```bash
# list recorded runs, newest first
cdkd events MyStack

# one run, in order
cdkd events MyStack --run 20260813T051530123Z-1a2b3c4d

# the same, as JSON for tooling
cdkd events MyStack --run '<runId>' --json
```

This page explains what the events mean and how to read a run. The flags,
the output formats and `cdkd events prune` are in the
[`cdkd events`](cli-events.md) reference.

## Read a failed run

::: steps
1. List the runs

   ```bash
   cdkd events MyStack
   ```

   ```text
   Deployment runs for MyStack (us-east-1)
     20260813T051530123Z-1a2b3c4d  deploy  FAILED  2026-08-13T05:15:30.123Z -> 2026-08-13T05:15:41.870Z  cdkd 0.296.28  9 events
     20260812T101502456Z-9f8e7d6c  deploy  SUCCEEDED  2026-08-12T10:15:02.456Z -> 2026-08-12T10:15:20.011Z  cdkd 0.296.28  8 events
   ```

   Each row is one run: its run id, the command, the result, the start and end
   time, the cdkd version, and the number of events.

2. Read the failed run

   ```bash
   cdkd events MyStack --run 20260813T051530123Z-1a2b3c4d
   ```

   The events print in the order they were recorded. Look for a
   `RESOURCE_FAILED` row. The line below it holds the error: the error name,
   the AWS error code in parentheses, the message, and `requestId=<id>` when
   AWS returned one.

3. Hand it to a tool

   ```bash
   cdkd events MyStack --run 20260813T051530123Z-1a2b3c4d --json > run.json
   ```
:::

The command reads only the state bucket. It does not synthesize the CDK app
and takes no lock.

## The events one run records

A run is a sequence of events. It opens with `RUN_STARTED`, records a start
and an outcome for each resource operation, and closes with `RUN_FINISHED`.
A deploy that fails and rolls back records the rollback in the same run.

```text diagram=events-run
  RUN_STARTED                       command, region, cdkd version
       │
       ▼
  RESOURCE_STARTED                  one per resource operation
       │
       ├──────────────────────┐
       ▼                      ▼
  RESOURCE_SUCCEEDED     RESOURCE_FAILED          carries the error
       │                      │
       │                      ▼
       │                 ROLLBACK_STARTED to ROLLBACK_FINISHED
       │                      │
       └──────────┬───────────┘
                  ▼
  RUN_FINISHED                      result and counts
```

| Event type | Recorded when |
| --- | --- |
| `RUN_STARTED`, `RUN_FINISHED` | Once each per run. |
| `RESOURCE_STARTED` | A resource create, update or delete begins. |
| `RESOURCE_SUCCEEDED` | The operation completed. |
| `RESOURCE_FAILED` | The operation failed; `error` says why. |
| `RESOURCE_RETAINED` | A delete left a `DeletionPolicy: Retain` resource in place. |
| `RESOURCE_SKIPPED` | cdkd could not delete the resource, so it may still exist. |
| `RESOURCE_GUARD_INDETERMINATE` | A safety check before a delete could not answer, and cdkd proceeded. |
| `ROLLBACK_STARTED`, `ROLLBACK_FINISHED` | A rollback begins and ends. |
| `ROLLBACK_RESOURCE_SUCCEEDED`, `ROLLBACK_RESOURCE_FAILED` | One operation was undone, or could not be. |
| `ROLLBACK_RESOURCE_SKIPPED` | The rollback declined one operation. |

`RESOURCE_RETAINED` and `RESOURCE_SKIPPED` both leave a resource in AWS, for
different reasons. A retained resource is kept on purpose, and cdkd drops its
state record. A skipped resource was meant to be deleted, and cdkd keeps its
state record.

The automatic rollback of a failed deploy records its rollback events in the
deploy's run. A standalone `cdkd rollback` records them under its own run id,
with `command: rollback`.

## What one event holds

Each event is one JSON object, stored as one line of the run's file:

```json
{
  "timestamp": "2026-08-13T05:15:33.412Z",
  "eventType": "RESOURCE_SUCCEEDED",
  "stackName": "MyStack",
  "operation": "CREATE",
  "logicalId": "Uploads5E5E9B2F",
  "resourceType": "AWS::S3::Bucket",
  "physicalId": "acme-uploads",
  "provisionedBy": "sdk",
  "durationMs": 1840
}
```

`cdkd events --run` prints the same event as one row:

```text
  2026-08-13T05:15:33.412Z  RESOURCE_SUCCEEDED  Uploads5E5E9B2F (AWS::S3::Bucket)  CREATE  [sdk]  1840ms
```

| Field | On | Meaning |
| --- | --- | --- |
| `timestamp` | every event | ISO 8601 time the event was recorded |
| `eventType` | every event | One of the [event types](#the-events-one-run-records) |
| `stackName` | every event | The stack |
| `command`, `region`, `cdkdVersion` | `RUN_STARTED` | `command` is `deploy`, `destroy` or `rollback` |
| `result` | `RUN_FINISHED` | `SUCCEEDED` or `FAILED` |
| `counts` | `RUN_FINISHED` | `created`, `updated`, `deleted`, and `failed` / `skipped` when non-zero |
| `operation` | resource events | `CREATE`, `UPDATE` or `DELETE` |
| `logicalId`, `resourceType` | resource events | The template logical ID and its type |
| `physicalId` | success and skip events | The AWS id, when known |
| `provisionedBy` | resource events | `sdk` or `cc-api`: how cdkd made the call |
| `durationMs` | success, failure, `RUN_FINISHED` | Elapsed milliseconds |
| `reason` | skip and guard events | One line saying why |
| `guard` | `RESOURCE_GUARD_INDETERMINATE` | The id of the check that could not answer |
| `error` | failure events | `{ name, message, awsErrorCode?, requestId?, ownLines? }` |

Three details about these fields:

- A `cdkd state destroy` run records `command: destroy`.
- A nested stack's events carry the nested stack's name in `stackName` and
  are stored in the parent's run.
- `error.awsErrorCode` and `error.requestId` come from the innermost AWS SDK
  error behind the failure.

### Placeholders in the output

`cdkd events` cleans every stored value before printing it (see
[Output](cli-events.md#output)). Where a value is missing or cannot be shown,
you see a placeholder:

| You see | It means |
| --- | --- |
| `<unrenderable>` | A value was recorded, and cleaning left nothing of it. |
| `?` in place of a count | The stored count is not a number. |
| `?` in place of a start or end time | The time is not shown: none was recorded, or cleaning left nothing. |
| A result in grey | The result is `UNKNOWN` or could not be shown. It is not a failure. |
| An error line with a name and no message | The error had an empty message. |

## A resource that was not deleted: `RESOURCE_SKIPPED`

A skip means cdkd did not delete a resource it was asked to delete. Nothing
failed, so the event has no `error`. The cause is in `reason`, printed on its
own line:

```text
  2026-08-13T05:15:35.201Z  RESOURCE_SKIPPED  MyTable (AWS::Glue::Table)  DELETE
      malformed physicalId in state — no delete issued
  2026-08-13T05:15:35.640Z  RUN_FINISHED  FAILED  +0/~0/-1 ⚠1
```

The event is recorded by `cdkd destroy`, by `cdkd state destroy`, and by a
`cdkd deploy` that deletes a resource you removed from the template. There
are four causes:

- **The physical id in state is malformed.** cdkd makes no AWS call.
- **The state record lacks what the delete needs.** This applies to a Lambda
  layer or permission, a Custom Resource, an IAM policy and an IAM user-group
  addition, whose delete is addressed by an id or property in the record.
  cdkd makes no AWS call.
- **A nested stack's own destroy skipped a resource or was interrupted.** The
  nested stack's other resources were deleted first.
- **A replacement could not delete the old resource.** The update itself
  succeeded.

In the last case, `RESOURCE_SKIPPED` appears next to a `RESOURCE_SUCCEEDED`
for the same logical ID. The success refers to the new resource. The skip
refers to the old one, which still exists and is no longer in state.

### A run with a skipped resource is recorded `FAILED`

When a run skips a resource, its `RUN_FINISHED` event has `result: FAILED`
and a `counts.skipped` number. This holds for deploy and for destroy.
`cdkd events` prints the number as `⚠N` after the
`+created/~updated/-deleted` counts.

`--allow-unaddressed` changes the command's exit code only. The run is still
recorded as `FAILED`, because the events record what happened. On destroy, a
`FAILED` result also stops `--purge-events` from deleting the history.

## A delete cdkd could not verify: `RESOURCE_GUARD_INDETERMINATE`

Before some deletes, cdkd runs a safety check on the target. When the check
cannot answer, for example because `s3:GetBucketLocation` is
denied, cdkd goes ahead with the delete and records this event:

```text
  2026-09-02T05:15:35.118Z  RESOURCE_GUARD_INDETERMINATE  MyBucket (AWS::S3::Bucket)  DELETE  guard=cc-delete-region-identity  [cc-api]
      s3:GetBucketLocation on my-bucket could not be answered: Access Denied
  2026-09-02T05:15:36.098Z  RESOURCE_SUCCEEDED  MyBucket (AWS::S3::Bucket)  DELETE  [cc-api]  980ms
```

The event exists so that an unverified delete leaves a lasting trace. A
denied permission is enough to switch a check off, and the warning cdkd
prints does not outlive the run.

How to read it:

- The event appears beside the resource's own outcome row and does not
  replace it. It changes no `counts` field and does not change the run's
  `result`.
- `operation` is always `DELETE`, because a delete is what the check
  guarded. That holds even when the delete is a step inside an update or a
  replacement.
- Destroy records it, and so does a deploy that deletes: a removed resource,
  a replacement, or a `--recreate-via-*` recreate. A rollback records this
  same event type beside its `ROLLBACK_RESOURCE_*` row.

`cdkd destroy` also counts these in its summary line, and warns with the
names of the resources:

```text
Stack MyStack destroyed (1 deleted, 1 unverified, 0 errors)
```

Deploy and rollback add no such count.

### Edge cases

- **A delete that threw an error has no guard event.** On destroy, the event
  therefore never accompanies a `RESOURCE_FAILED`. On deploy and rollback it
  can, when the guarded delete returned and a later step of the same operation
  failed.
- **A nested stack destroyed as part of its parent's destroy records no
  events of its own.** For a check that could not answer there, the summary
  line and its warning are the only trace.

## An operation the rollback declined: `ROLLBACK_RESOURCE_SKIPPED`

A rollback undoes a failed deploy one operation at a time. When it cannot
undo an operation, it leaves the resource exactly as the failed deploy left
it and records this event. That happens when:

- the deploy deleted the resource, which a rollback cannot create again;
- the state record, or the `properties` it recorded to return to, is missing;
- a later attempt changed the physical id;
- the operation failed and there is nothing to revert it to.

The event has a `reason` and no `error` or `physicalId`.

An automatic rollback that skipped an operation keeps the rollback journal,
the file in the state bucket that lists what the failed deploy did. A later
`cdkd rollback` reads it again, records the skip again, and exits `2`.

## What events do not contain

Events carry metadata and errors only. cdkd never records resource
properties in them, because properties can hold secrets.

An error message can still quote a property value. AWS validation errors do
this, as in `Value '...' at 'password' failed to satisfy constraint`. So
before cdkd records an event, it replaces each secret value it knows in the
`reason` and the error message with that secret's `{{resolve:...}}`
reference:

- `cdkd deploy`, its automatic rollback and `cdkd rollback` replace the
  secrets they resolved. A nested stack's events are also checked against its
  parent's secrets.
- `cdkd destroy` and `cdkd state destroy` resolve no secret. They replace the
  name of a resource that was named from one.

`error.name`, `awsErrorCode` and `requestId` are left as they are. They are
AWS identifiers and never carry a value you supplied.

### What the masking misses

cdkd finds a secret by searching for its exact text, which has limits:

- **A secret shorter than 4 characters** is not replaced, unless the whole
  message is the secret.
- **A value AWS quotes back in a changed form** does not match: JSON-escaped,
  truncated, in a different case, or URL-encoded.
- **A `NoEcho` template parameter** is replaced only where the run resolved
  it. A standalone `cdkd rollback` works from a journal that names no
  parameter, so its events are not masked for these.
- **The `physicalId` field** is stored as AWS returned it, even for a
  resource named from a secret. A cleanup needs that id, and `state.json`
  records it too.

> [!WARNING]
> Treat the event files as sensitive, and rotate any secret a run is known to
> have quoted. Masking a later event does not remove an earlier one, and
> deleting the run afterwards does not make the secret safe again. See
> [what a prune does not reach](cli-events.md#earlier-versions-on-the-versioned-state-bucket).

## Where events are stored

Events are stored beside `state.json` under their own keys, which is why
they survive `cdkd destroy`:

```text
s3://<state-bucket>/<state-prefix>/<stack>/<region>/deployments/
├── 20260813T051530123Z-1a2b3c4d.jsonl   one file per run, one event per line
├── 20260812T101502456Z-9f8e7d6c.jsonl
└── index.json                           the newest 20 runs, newest first
```

A run id starts with its timestamp, so the run files sort by time.
`index.json` is a summary cdkd derives from the run files: run id, command,
cdkd version, start and end, result, and event count. The run files hold the
truth, and `cdkd events` copes when the summary or a file is incomplete:

- **`index.json` is missing or unreadable.** cdkd lists the run files and
  takes each result from the run's last `RUN_FINISHED`.
- **A run has no `RUN_FINISHED`**, because it was interrupted. cdkd reports
  its result as `UNKNOWN`, never as `FAILED`.
- **A run file ends in a half-written line.** cdkd skips that line and prints
  the rest.
- **The stack was destroyed.** cdkd still finds the history, because it finds
  the region from the stored keys.

### Recording never blocks a run

cdkd buffers events in memory and writes them to S3 in the background. If a
write fails, cdkd warns once and the deploy or destroy continues.

Each run writes its own file, so two runs never compete for one. They do
share `index.json`, where the last writer wins. `cdkd events --run '<runId>'`
reads the run file directly, so it works even when the index lost such a
race. A `--dry-run` records nothing.

### How long history is kept

cdkd keeps the newest 20 runs of a stack. Three things delete history:

| What | Effect |
| --- | --- |
| Every run, when it finishes | Deletes the run files beyond the newest 20. A failure warns once. |
| [`cdkd events prune`](cli-events.md#cdkd-events-prune) | Deletes the runs you choose. |
| `cdkd destroy --purge-events` | Deletes all of the stack's history after a clean destroy. |

`cdkd destroy` and `cdkd state destroy` keep the history by default, so the
state bucket is not empty after a destroy. `--purge-events` also keeps it
when the destroy fails or is interrupted. `cdkd state destroy` has no
`--purge-events` flag; run `cdkd events prune MyStack --all` afterwards.

Deleting a run file from a versioned bucket leaves earlier versions behind.
[Earlier versions on the versioned state bucket](cli-events.md#earlier-versions-on-the-versioned-state-bucket)
explains what each delete removes.

## Related

- [`cdkd events`](cli-events.md): flags, output formats and `prune`
- [`cdkd rollback`](cli-rollback.md): the rollback whose events are recorded
  here
- [State Management](state-management.md): the state bucket, its policy and
  replication
- [Troubleshooting](troubleshooting.md): what to do with a failed deploy
