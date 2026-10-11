---
title: Deployment Events
description: "What cdkd records for each deploy, destroy and rollback run, how to read a failed run back with cdkd events, and how the history is stored and pruned."
---

# Deployment Events (`cdkd events`)

Every `cdkd deploy`, `cdkd destroy`, `cdkd state destroy` and `cdkd rollback`
run records what it did to each resource: which operation started, whether it
succeeded, and the AWS error if it failed. The events are stored in the state
bucket, so you can read a failed run back later, from another machine, or
after the stack is gone. It is cdkd's equivalent of CloudFormation's
`DescribeStackEvents`.

```bash
cdkd events MyStack                          # list recorded runs, newest first
cdkd events MyStack --run 20260813T051530123Z-1a2b3c4d   # one run, in order
cdkd events MyStack --run '<runId>' --json   # the same, as JSON for tooling
cdkd events prune MyStack --keep 5           # delete all but the newest 5 runs
```

Flags and defaults are in the [`cdkd events`](cli-events.md) reference. This
page explains what the events mean.

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

   Each row is one run: run id, command, result, start and end time, the cdkd
   version, and the number of events.

2. Read the failed run

   ```bash
   cdkd events MyStack --run 20260813T051530123Z-1a2b3c4d
   ```

   Events print in the order they were recorded. A failed resource has its
   error on the line below it: the error name, the AWS error code in
   parentheses, the message, and `requestId=<id>` when AWS returned one.

3. Hand it to a tool

   ```bash
   cdkd events MyStack --run 20260813T051530123Z-1a2b3c4d --json > run.json
   ```
:::

A stack with history in more than one region needs `--stack-region <region>`.
The command reads only the state bucket: it does not synthesize the CDK app
and takes no lock.

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
| `eventType` | every event | One of the [event types](#event-types) |
| `stackName` | every event | The stack; a nested child's events name the child and sit in the parent's run |
| `command`, `region`, `cdkdVersion` | `RUN_STARTED` | `deploy`, `destroy` or `rollback`; a `cdkd state destroy` records `destroy` |
| `result` | `RUN_FINISHED` | `SUCCEEDED` or `FAILED` |
| `counts` | `RUN_FINISHED` | `created`, `updated`, `deleted`, and `failed` / `skipped` when non-zero |
| `operation` | resource events | `CREATE`, `UPDATE` or `DELETE` |
| `logicalId`, `resourceType` | resource events | The template logical id and its type |
| `physicalId` | success and skip events | The AWS id, when known |
| `provisionedBy` | resource events | `sdk` or `cc-api`: the layer that handled it |
| `durationMs` | success, failure, `RUN_FINISHED` | Elapsed milliseconds |
| `reason` | skip and guard events | One line saying why |
| `guard` | `RESOURCE_GUARD_INDETERMINATE` | The id of the guard that could not answer |
| `error` | failure events | `{ name, message, awsErrorCode?, requestId?, ownLines? }` |

`error.awsErrorCode` and `error.requestId` come from the innermost AWS SDK
error behind the failure. Events never carry resource properties.

## Event types

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
| `RESOURCE_SUCCEEDED` | It completed. |
| `RESOURCE_FAILED` | It failed; `error` says why. |
| `RESOURCE_RETAINED` | A delete skipped a `DeletionPolicy: Retain` resource. The resource is kept on purpose and its state record is dropped. |
| `RESOURCE_SKIPPED` | cdkd could not address the resource, so it may still exist. Its state record is kept. |
| `RESOURCE_GUARD_INDETERMINATE` | A safety check before a delete could not reach a verdict, and cdkd proceeded. |
| `ROLLBACK_STARTED`, `ROLLBACK_FINISHED` | A rollback begins and ends. |
| `ROLLBACK_RESOURCE_SUCCEEDED`, `ROLLBACK_RESOURCE_FAILED` | One operation was reverted, or could not be. |
| `ROLLBACK_RESOURCE_SKIPPED` | The rollback declined one operation and left the resource as the failed deploy left it. |

Rollback events are recorded both by the automatic rollback of a failed deploy
and by a standalone `cdkd rollback`, which records them under its own run id
with `command: rollback`.

### `RESOURCE_SKIPPED`: the resource was not destroyed

A skip means "this row was not destroyed". Nothing failed, so the event has no
`error`; the cause is in `reason`, printed on its own line:

```text
  2026-08-13T05:15:35.201Z  RESOURCE_SKIPPED  MyTable (AWS::Glue::Table)  DELETE
      malformed physicalId in state — no delete issued
  2026-08-13T05:15:35.640Z  RUN_FINISHED  FAILED  +0/~0/-1 ⚠1
```

It is recorded by `cdkd destroy`, `cdkd state destroy`, and by a `cdkd deploy`
that deletes a resource removed from the template. The causes:

| Cause | AWS call issued |
| --- | --- |
| The composite physical id in state is malformed | None |
| The state record lacks the id or property the delete is addressed by (Lambda layer or permission, Custom Resource, IAM policy, IAM user-group addition) | None |
| A nested stack's own destroy skipped or was interrupted | The child's other resources were deleted first |
| A replacement whose delete left the old resource alive | The update itself succeeded |

In the last case `RESOURCE_SKIPPED` sits next to a `RESOURCE_SUCCEEDED` for
the same logical id. The two are not a contradiction: the success names the
new resource, and the skip names the predecessor that survived and is no
longer in state.

### A run with a skipped resource is recorded `FAILED`

`RUN_FINISHED` carries `counts.skipped` when it is non-zero, and the run's
`result` is `FAILED`, on deploy and on destroy. `cdkd events` prints the count
as `⚠N` after the `+created/~updated/-deleted` triple.

`--allow-unaddressed` changes the exit code only. The run is still recorded
`FAILED`, because the events record what happened. On destroy, the `FAILED`
result also keeps `--purge-events` from discarding the history.

### `RESOURCE_GUARD_INDETERMINATE`: a check could not answer

Before some deletes, cdkd runs a safety check on the target. When the check
cannot reach a verdict (for example because `s3:GetBucketLocation` is denied),
cdkd proceeds and records this event with the guard's id and the reason:

```text
  2026-09-02T05:15:35.118Z  RESOURCE_GUARD_INDETERMINATE  MyBucket (AWS::S3::Bucket)  DELETE  guard=cc-delete-region-identity  [cc-api]
      s3:GetBucketLocation on my-bucket could not be answered: Access Denied
  2026-09-02T05:15:36.098Z  RESOURCE_SUCCEEDED  MyBucket (AWS::S3::Bucket)  DELETE  [cc-api]  980ms
```

The event records that a delete went ahead without its target being confirmed.
A guard can be disabled by denying the permission it depends on, and the
warning cdkd prints does not outlive the run; this row does.

How to read it:

- It sits beside the resource's own outcome row and does not replace it. It
  changes no `counts` field and not the run's `result`.
- `operation` is always `DELETE`, the call the guard ran on, even when that
  delete is a step inside an update or replacement.
- It is recorded by destroy, by a deploy that deletes (a removed resource, a
  replacement, a `--recreate-via-*` recreate), and by a rollback. A rollback
  uses this same event type, beside its `ROLLBACK_RESOURCE_*` row.
- A delete that threw carries no guard event, so on destroy it never
  accompanies a `RESOURCE_FAILED`. On deploy and rollback it can, when the
  guarded delete returned and a later step of the same operation failed.

The destroy summary also counts these
(`Stack MyStack destroyed (1 deleted, 1 unverified, 0 errors)`) and warns,
naming the resources. Deploy and rollback add no summary count.

A nested-stack child destroyed from inside its parent's destroy records no
events of its own. For a guard suppressed there, the summary line and its
warning are the only trace.

### `ROLLBACK_RESOURCE_SKIPPED`: an operation the rollback declined

The rollback leaves the resource exactly as the failed deploy left it when it
cannot revert the operation:

- the deploy deleted the resource (a rollback cannot re-create it);
- the record or its recorded `properties` baseline is missing;
- a later attempt changed the physical id;
- the operation failed and there is nothing to revert it to.

The event has a `reason` and no `error` or `physicalId`. An automatic rollback
that skipped an operation keeps the rollback journal, so a later
`cdkd rollback` replays it, records the skip again and exits `2`.

## Where events are stored

Events live beside `state.json` under their own keys, so they survive
`cdkd destroy`:

```text
s3://<state-bucket>/<state-prefix>/<stack>/<region>/deployments/
├── 20260813T051530123Z-1a2b3c4d.jsonl   one file per run, one event per line
├── 20260812T101502456Z-9f8e7d6c.jsonl
└── index.json                           the newest 20 runs, newest first
```

A run id starts with its timestamp, so run files sort by time. `index.json`
is a derived summary (run id, command, cdkd version, start and end, result,
event count); the run files are the source of truth.

| Situation | What `cdkd events` does |
| --- | --- |
| `index.json` is missing or unreadable | Lists the run files and takes each result from the run's last `RUN_FINISHED`. |
| A run has no `RUN_FINISHED` (interrupted) | Reports its result as `UNKNOWN`, never as `FAILED`. |
| A run file ends in a torn line | Skips that line and prints the rest. |
| The stack was destroyed | Still finds the history: the region is discovered from the stored keys. |

### Recording never blocks a run

Events are buffered in memory and flushed to S3 in the background. A failed
write warns once and the deploy or destroy continues. Each run writes its own
file, so runs never contend; `index.json` is last-writer-wins, and
`cdkd events --run '<runId>'` reads a run directly even if the index lost a
race. A `--dry-run` records nothing.

### How long history is kept

| Mechanism | Effect |
| --- | --- |
| Every run, when it finishes | Deletes run files that fell out of the newest 20. Best-effort; a failure warns once. |
| `cdkd events prune MyStack` | Deletes runs by the retention you choose. |
| `cdkd destroy --purge-events` | Deletes all of the stack's history after a clean destroy. Kept when the destroy fails or is interrupted. |

`cdkd destroy` and `cdkd state destroy` keep the history by default, so the
state bucket is not empty after a destroy. `cdkd state destroy` has no
`--purge-events`; run `cdkd events prune MyStack --all` afterwards.

## What events do not contain

Events carry metadata and errors only. Resource properties are never recorded,
because they may hold secrets.

That is not enough alone, because an AWS validation error can quote a property
value back inside its message (`Value '...' at 'password' failed to satisfy
constraint`). cdkd therefore masks secret values in an event's `reason` and
error message before recording it, replacing each with its `{{resolve:...}}`
reference:

- `cdkd deploy`, its automatic rollback and `cdkd rollback` mask the secrets
  they resolved. A nested stack is masked under its parent's secrets too.
- `cdkd destroy` and `cdkd state destroy` resolve no secret, but mask the name
  of a resource that was named from one.

`error.name`, `awsErrorCode` and `requestId` are not masked. They are AWS
identifiers and never carry a value you supplied.

### What the masking does not cover

The mask replaces literal occurrences of a known secret, so it has limits:

| Limit | Detail |
| --- | --- |
| Secrets shorter than 4 characters | Not replaced unless the whole message is the secret. |
| A value AWS quotes back altered | JSON-escaped, truncated, re-cased or URL-encoded text does not match. |
| `NoEcho` template parameters | Masked only where the run resolved them. A standalone `cdkd rollback` re-resolves a journal that names no parameter, so its events are not masked. |
| The `physicalId` field | Stored as AWS returned it, even for a resource named from a secret. A cleanup needs that id, and `state.json` records it too. |

> [!WARNING]
> Treat `deployments/*.jsonl` as sensitive, and rotate any secret a run is
> known to have quoted. Masking a later write does not remove an earlier one,
> and deleting the run afterwards does not make the secret safe again; see
> [what the purge does not reach](#deleting-a-run-stream-also-purges-its-earlier-versions).

## Rendering: the human path sanitises, JSON output escapes

Several stored fields are written by a provider or come from your template: a
logical id, a `reason` that includes a physical name, an AWS error message.
The plain `cdkd events` output sanitises every stored value before printing
it, so a terminal escape sequence inside one cannot clear the screen or
repaint a line.

| You see | It means |
| --- | --- |
| `<unrenderable>` | A value was recorded and sanitising left nothing of it. |
| `?` in place of a count | The stored counter is not a number. |
| `?` in place of a start or end time | The time is not shown: none was recorded, or it sanitised away. |
| A result in grey | The result is `UNKNOWN` or could not be rendered; it is not reported as a failure. |
| An error line with a name and no message | The error had an empty message. |

The run listing prints each field only as one token of at most 64 printable
characters, and names the stack and region in its header only when each is a
plain identifier. The listing sits above a command you copy, and a stored
value containing spaces could otherwise imitate that line. Values cdkd writes
itself always pass.

An error message is folded onto one line, with one exception. A rollback
refusal that cdkd built itself is marked `error.ownLines: true` and prints one
line per line, indented deeper than any event row, so its `To orphan it:`
command stays on a line apart from provider text. Any other message folds,
because a provider's own newline could otherwise forge such a row.

`--json` and `--format json` are not sanitised, because replacing characters
would corrupt what tooling reads. The output is escaped instead: every
control, format and line-separator character (C0, DEL, C1, `U+2028`, `U+2029`,
the bidi controls, the zero-width characters) is written as a `\uXXXX` escape.
The payload parses back to exactly the stored values, and printing it cannot
run a control sequence.

The reader trusts what is stored. Someone who can write the state bucket can
forge a whole event, `ownLines` included.

## Pruning event history (`cdkd events prune`)

```bash
cdkd events prune MyStack                    # keep the newest 20 runs
cdkd events prune MyStack --keep 5           # keep the newest 5
cdkd events prune MyStack --older-than 24h   # delete runs older than 24 hours
cdkd events prune MyStack --all --yes        # delete everything, no prompt
```

| Flag | Deletes |
| --- | --- |
| none | Everything but the newest 20 runs. |
| `--keep <N>` | Everything but the newest N runs. |
| `--older-than <duration>` | Runs older than `<n>s`, `<n>m` or `<n>h`. A run id with no readable timestamp is kept. |
| `--keep` with `--older-than` | Only runs that are both outside the newest N and older than the duration. |
| `--all` | Every run and `index.json`. Cannot be combined with the other two. |

The command asks for confirmation unless you pass `--yes`, and reports errors
instead of only warning. After deleting run files it rewrites `index.json`, or
removes it when no runs remain.

### Deleting a run stream also purges its earlier versions

`cdkd bootstrap` turns versioning on for the state bucket. A delete by key
then only writes a delete marker, and every earlier version stays readable
with `GetObject` and a `VersionId`. A run file is rewritten in full on every
flush, so one run leaves several earlier versions.

Every delete of event history therefore also deletes noncurrent versions:

| Delete | Versions purged |
| --- | --- |
| `cdkd events prune --all`, `cdkd destroy --purge-events` | Every noncurrent version under the stack's `deployments/` prefix, including run files deleted earlier. |
| `cdkd events prune --keep` / `--older-than`, and the automatic prune when a run finishes | Only those of the run files they delete. |

The `--all` sweep is scoped to the exact
`<state-prefix>/<stack>/<region>/deployments/` prefix, so a stack whose name
extends this one's (`MyStack2`) is untouched. Each key's current version is
kept, so a run that a concurrent deploy is writing loses only earlier flushes.
On an unversioned bucket nothing extra is deleted.

The purge needs `s3:ListBucketVersions` and `s3:DeleteObjectVersion` on the
state bucket; [State Management](state-management.md) has a bucket policy that
grants them. Without them the prune or destroy still succeeds, and a warning
naming the two actions prints before the summary line. Because the automatic
prune purges too, a deploy or destroy of a stack past 20 runs can print the
same warning each time.

What the purge does not reach:

- **Run files deleted earlier by a partial prune.** `--keep`, `--older-than`
  and the automatic prune find keys by an ordinary listing, so a file already
  behind a delete marker is not revisited. `--all` (or
  `cdkd destroy --purge-events`) reaches it.
- **A region with no current history.** The sweep covers one region, and
  region discovery reads current keys only. For a region where none of the
  stack's history is current any more, pass `--stack-region <region>`.
  Without it the prune stops with "No deployment-event history found", or
  sweeps only another region that still has current history.
- **Earlier versions of a rewritten `index.json`.** A partial prune rewrites
  the index, so its earlier versions survive. They hold run summaries, never
  event bodies. `--all` deletes the index and purges them.
- **A replicated bucket's destination**, which keeps its own copies. See
  [State Management](state-management.md).

After an `--all` prune with nothing current left, the summary line reads
`No runs matched`. It says it found no earlier versions, naming the region,
when the sweep removed none with content, so a mistyped `--stack-region` is
visible. It says the versions could not be purged when the sweep could not
finish.

To see what survives for a stack, and remove it yourself:

```bash
# cdkd is the default --state-prefix; substitute yours if you set one.
aws s3api list-object-versions --bucket <state-bucket> \
  --prefix "<state-prefix>/<stack>/<region>/deployments/" \
  --query 'Versions[?IsLatest==`false`].{Key:Key,Id:VersionId,Size:Size}' \
  --output table

aws s3api delete-object --bucket <state-bucket> \
  --key "<state-prefix>/<stack>/<region>/deployments/<runId>.jsonl" \
  --version-id <VersionId>
```

A purge does not remedy a run that quoted a secret. Rotate the secret: the
events were readable until the purge, and a replica or an earlier copy may
still hold them.

## Related

- [`cdkd events`](cli-events.md): flags and defaults
- [`cdkd rollback`](cli-rollback.md): the rollback whose events are recorded
  here
- [State Management](state-management.md): the state bucket, its policy and
  replication
- [Troubleshooting](troubleshooting.md): what to do with a failed deploy
