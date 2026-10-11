---
title: Review Past Deploys
description: "Read back what a past cdkd deploy, destroy or rollback did with cdkd events: list the runs, find the failed resource and its AWS error, and know how long the history is kept."
---

# Review Past Deploys

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

The flags, the output formats and `cdkd events prune` are in
[`cdkd events`](cli-events.md). Every field of an event, and the skip and
guard events in detail, are in [Deployment Event Format](deployment-events-format.md).

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

A run that skipped a resource is recorded `FAILED` even though no operation
failed. [Deployment Event Format](deployment-events-format.md#a-resource-that-was-not-deleted-resource-skipped)
lists the causes of a skip.

## How long history is kept

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
- [Deployment Event Format](deployment-events-format.md): every field, the
  skip and guard events, masking and storage
- [`cdkd rollback`](cli-rollback.md): the rollback whose events are recorded
  here
- [Troubleshooting](troubleshooting.md): what to do with a failed deploy
