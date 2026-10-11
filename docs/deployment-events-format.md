---
title: Deployment Event Format
description: "The fields of a cdkd deployment event, the skip, guard and rollback-skip events in detail, what cdkd masks before recording an event, and how the history is laid out in the state bucket."
---

# Deployment Event Format

This page is the reference for the events cdkd records for every deploy,
destroy and rollback run. To read a run back, start with
[Review Past Deploys](deployment-events.md); the flags of the command are in
[`cdkd events`](cli-events.md).

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
| `eventType` | every event | One of the [event types](deployment-events.md#the-events-one-run-records) |
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

## Related

- [Review Past Deploys](deployment-events.md): reading a run back
- [`cdkd events`](cli-events.md): flags, output formats and `prune`
- [State Store](state-management.md): the state bucket, its policy and
  replication
