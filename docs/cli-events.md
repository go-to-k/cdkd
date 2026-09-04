---
title: cdkd events
description: "Read deployment-event history with cdkd events, and purge old history with events prune."
---

# cdkd events

`cdkd events <stack>` reads back the structured deployment events cdkd records
for every `cdkd deploy` / `cdkd destroy` run — cdkd's equivalent of
CloudFormation's `DescribeStackEvents`. Reach for it when you want to know what
a past run actually did, including a run whose stack no longer exists.

```bash
cdkd events MyStack                       # list runs, newest first
cdkd events MyStack --run <runId>         # one run's full event stream
cdkd events MyStack --format json         # machine-readable JSON (or --json)
cdkd events MyStack --stack-region us-west-2   # disambiguate multi-region history
cdkd events prune MyStack --keep 5        # keep the newest 5 runs
```

Events are persisted as JSONL under a `deployments/` key family separate from
`state.json`, so a destroyed stack's failure history stays readable. Recording
is best-effort and never blocks the deploy or destroy, and events carry error
and metadata only — never resource properties. Reads are state-driven: no
synthesis, and no stack lock is taken.

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `<stack>` | — | Stack name (physical CloudFormation name). Required. |
| `--run <runId>` | — | Print one run's full event stream instead of the run listing. |
| `--stack-region <region>` | — | Region whose history to read, when the stack has history in more than one. |
| `--json` | off | Emit machine-readable JSON. |
| `--format <format>` | — | `--format json` is equivalent to `--json`. |
| `--state-bucket <bucket>` | `CDKD_STATE_BUCKET` / `cdk.json` | S3 bucket holding the event history. |
| `--state-prefix <prefix>` | `cdkd` | S3 key prefix for state files. |
| `--profile <profile>` | — | AWS profile. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | IAM role to assume for AWS API calls. |
| `--verbose` | off | Verbose logging. |

Without `--stack-region`, cdkd discovers which region holds the stack's history
from the stored keys rather than from `state.json`, so a destroyed stack is
still found. A stack with history in more than one region is an error until you
name one.

## `cdkd events prune`

The store self-bounds to the newest 20 runs at write time, and `cdkd destroy`
deliberately keeps event history as post-mortem context — so a teardown never
returns the bucket to empty on its own. `cdkd events prune <stack>` is the
explicit purge.

```bash
cdkd events prune MyStack                   # keep the newest 20 (default)
cdkd events prune MyStack --keep 5          # keep the newest 5
cdkd events prune MyStack --older-than 24h  # delete runs older than 24h
cdkd events prune MyStack --all             # purge everything, index included
cdkd events prune MyStack --all --yes       # skip the confirmation (CI)
```

### Options

| Flag | Default | Description |
| --- | --- | --- |
| `<stack>` | — | Stack name (physical CloudFormation name). Required. |
| `--keep <N>` | — | Retain only the newest N runs. Must be a non-negative integer. |
| `--older-than <duration>` | — | Delete runs older than this. Units are `s` / `m` / `h` (e.g. `90m`, `24h`). |
| `--all` | off | Delete every recorded run and the index. Cannot be combined with `--keep` / `--older-than`. |
| `-y`, `--yes` | off | Answer the confirmation prompt automatically. |

`--stack-region`, `--state-bucket`, `--state-prefix`, `--profile`, `--role-arn`
and `--verbose` are inherited from `cdkd events` and mean the same thing here.

### Retention selection

| Flags given | What is deleted |
| --- | --- |
| none | Runs beyond the newest 20. |
| `--keep N` | Runs beyond the newest N. |
| `--older-than D` | Runs older than D. |
| `--keep N` **and** `--older-than D` | Only runs that are BOTH beyond the newest N AND older than D. |
| `--all` | Every run, plus the index. |

The prompt (`Prune deployment-event history for <stack> (<region>): <scope>?`)
names the scope it is about to apply before you answer. Answering anything but
yes deletes nothing and exits `0`.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The listing or event stream was printed, or the prune finished — including when nothing matched the criteria, and when the prompt was declined. |
| `1` | Hard error. |

The refusals behind exit `1`:

| Refusal | When |
| --- | --- |
| No deployment-event history for the stack | The stack was deployed by a cdkd version that recorded none, or its history has already been pruned. |
| History in multiple regions | Re-run with `--stack-region <region>`. |
| No such run id | `--run <runId>` names a run this stack's history does not hold. |
| `--all` with `--keep` / `--older-than` | `--all` purges everything, so a retention window is contradictory. |
| `NON_INTERACTIVE_CONFIRM` | The prune confirmation prompt was reached on a non-interactive stdin. Pass `-y` / `--yes`; piping `y` in is not a substitute. |

The full cross-command table is in the [CLI Reference](cli-reference.md#exit-codes).

## Related

- [Deployment Events](deployment-events.md) — event types, S3 key layout, flush strategy, `index.json` semantics, and the retention model
- [Destroy flags & guards](cli-destroy.md#purge-events-also-delete-deployment-event-history-on-destroy) — `--purge-events`, the destroy-time equivalent of a full prune
- [CLI Reference](cli-reference.md) — every command and the full exit-code table
