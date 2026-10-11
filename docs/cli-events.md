---
title: cdkd events
description: "Read deployment-event history with cdkd events, and delete old history with cdkd events prune."
---

# cdkd events

`cdkd events` shows what past `cdkd deploy`, `cdkd destroy` and
`cdkd state destroy` runs did to a stack. It is cdkd's equivalent of
CloudFormation's `DescribeStackEvents`. Use it to find out why a run failed,
including a run whose stack no longer exists.

```bash
cdkd events MyStack                       # list runs, newest first
cdkd events MyStack --run '<runId>'       # one run's full event stream
cdkd events MyStack --json                # machine-readable output
cdkd events MyStack --stack-region us-west-2   # when history exists in several regions
cdkd events prune MyStack --keep 5        # keep the newest 5 runs
```

The command reads from the state bucket. It does not synthesize the app and
takes no stack lock.

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `<stack>` | required | Stack name (the physical CloudFormation name). |
| `--run <runId>` | | Print one run's full event stream, not the run listing. |
| `--stack-region <region>` | discovered | Region whose history to read. Needed when the stack has history in more than one. |
| `--json` | `false` | Print JSON. |
| `--format <format>` | | `--format json` is the same as `--json`. |
| `--state-bucket <bucket>` | `CDKD_STATE_BUCKET`, then `cdk.json` | Bucket holding the event history. |
| `--state-prefix <prefix>` | `cdkd` | Key prefix for state files. |
| `--profile <profile>` | | AWS profile. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | IAM role to assume for AWS API calls. |
| `-y`, `--yes` | `false` | Skip the `prune` confirmation. Reading asks nothing. |
| `--verbose` | `false` | Debug-level logging. |

## What is recorded

Each run's events are stored in the state bucket, separately from
`state.json`, so a destroyed stack's history stays readable.

- Events carry errors and metadata only, never resource properties.
- Recording is best-effort and never blocks a deploy or destroy.
- The newest 20 runs are kept. Older ones are removed as new runs are written.

[Deployment Events](deployment-events.md) lists the event types and the
storage layout.

## Finding the region

Without `--stack-region`, cdkd finds the region from the stored event keys,
not from `state.json`. That is why a destroyed stack is still found. A stack
with history in more than one region is an error until you name one:

```bash
cdkd events MyStack --stack-region us-west-2
```

## Output

The default output is for reading in a terminal. Every stored value is
sanitized first, so a control character in an error message, a logical id or a
provider's reason cannot rewrite a line of the output.

| Output | Control characters |
| --- | --- |
| Default | Sanitized. |
| `--json` | Not sanitized, but written as `\uXXXX` escapes, so the JSON parses back to the stored values. |

In the default output an error message is folded onto one line. One kind of
message keeps its line breaks: a rollback refusal cdkd recorded itself. Its provider text and its `To orphan it:`
command stay on their own lines, indented under the event. See
[Deployment Events](deployment-events.md#rendering-the-human-path-sanitises-json-output-escapes)
for what sanitizing does and does not cover.

## `cdkd events prune`

`cdkd events prune` deletes old runs. `cdkd destroy` and `cdkd state destroy`
keep event history on purpose, so a bucket still holds a stack's events after
the stack is gone.

```bash
cdkd events prune MyStack                   # keep the newest 20 (the default)
cdkd events prune MyStack --keep 5          # keep the newest 5
cdkd events prune MyStack --older-than 24h  # delete runs older than 24 hours
cdkd events prune MyStack --all             # delete everything, index included
cdkd events prune MyStack --all --yes       # no confirmation (CI)
```

### Options

| Flag | Default | Description |
| --- | --- | --- |
| `<stack>` | required | Stack name (the physical CloudFormation name). |
| `--keep <N>` | | Keep only the newest N runs. A non-negative integer. |
| `--older-than <duration>` | | Delete runs older than this. Units are `s`, `m` and `h`, as in `90m` or `24h`. |
| `--all` | `false` | Delete every run and the index, and purge every earlier version under the stack's `deployments/` prefix. |

`--all` cannot be combined with `--keep` or `--older-than`. `--stack-region`,
`--state-bucket`, `--state-prefix`, `--profile`, `--role-arn`, `-y` / `--yes`
and `--verbose` are inherited from `cdkd events` and mean the same here.

### Which runs are deleted

| Flags given | What is deleted |
| --- | --- |
| none | Runs beyond the newest 20. |
| `--keep N` | Runs beyond the newest N. |
| `--older-than D` | Runs older than D. |
| `--keep N` and `--older-than D` | Only runs that are both beyond the newest N and older than D. |
| `--all` | Every run, the index, and every earlier version under the stack's `deployments/` prefix. |

The prompt names what it is about to delete:

```text
Prune deployment-event history for <stack> (<region>): <scope>?
```

Any answer but yes deletes nothing and exits `0`.

### Earlier versions on the versioned state bucket

The state bucket is versioned, so deleting an object leaves its earlier
versions readable. A prune therefore also deletes the noncurrent versions of
the keys it removes.

| Case | What to know |
| --- | --- |
| `--all` | Purges every noncurrent version under the stack's `deployments/` prefix, including streams an earlier delete left behind a delete marker. |
| A region where none of the stack's history is current any more | Region discovery reads current keys only, so pass `--stack-region <region>`. A region with no earlier versions left reports that it found none. |
| No `s3:ListBucketVersions` or `s3:DeleteObjectVersion` permission | The prune still succeeds, and a warning prints before the summary line. |

> [!IMPORTANT]
> Pruning is not a remediation for a run that quoted a secret. See
> [Deleting a run stream also purges its earlier versions](deployment-events.md#deleting-a-run-stream-also-purges-its-earlier-versions)
> for what it does not reach.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The listing or event stream was printed, or the prune finished. That includes a prune that matched nothing and a declined prompt. |
| `1` | Hard error. |

The refusals behind exit `1`:

| Refusal | When |
| --- | --- |
| No deployment-event history for the stack | The stack was deployed by a cdkd version that recorded none, or its history was already pruned. |
| History in multiple regions | Run again with `--stack-region <region>`. |
| No such run id | `--run <runId>` names a run this stack's history does not hold. |
| `--all` with `--keep` / `--older-than` | `--all` deletes everything, so a retention window contradicts it. |
| `NON_INTERACTIVE_CONFIRM` | The prune confirmation was reached without a terminal. Pass `-y` / `--yes`. Piping `y` in does not work. |

Earlier versions left on the bucket after a prune are still reachable with
`cdkd events prune <stack> --all --stack-region <region>`.

The table for every command is in the [CLI Reference](cli-reference.md#exit-codes).

## Related

- [Deployment Events](deployment-events.md): event types, storage layout and the retention model
- [Destroy flags & guards](cli-destroy.md#purge-events-also-delete-deployment-event-history-on-destroy): `--purge-events`, the destroy-time equivalent of a full prune
- [CLI Reference](cli-reference.md): every command and the exit-code table
