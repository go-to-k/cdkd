---
title: events
description: "Read deployment-event history with cdkd events, and purge old history with events prune."
---

## `events` (read deployment-event history)

`cdkd events <stack>` reads back the structured deployment events cdkd
records for every `cdkd deploy` / `cdkd destroy` run — cdkd's local
equivalent of CloudFormation's `DescribeStackEvents`. Events are
persisted as JSONL under a `deployments/` key family separate from
`state.json` (no state schema bump), so a destroyed stack's failure
history stays readable. Event recording is best-effort and never blocks
the deploy / destroy; events carry error + metadata only (never resource
properties).

```bash
cdkd events MyStack                       # list runs, newest first
cdkd events MyStack --run <runId>         # one run's full event stream
cdkd events MyStack --format json         # machine-readable JSON (or --json)
cdkd events MyStack --stack-region <r>    # disambiguate multi-region history
```

### `events prune` (purge old event history)

The store self-bounds to the last 20 runs at write time, but `cdkd destroy`
deliberately keeps event history as post-mortem context, so it never returns
the bucket to empty on its own. `cdkd events prune <stack>` is the explicit
purge:

```bash
cdkd events prune MyStack                 # keep the newest 20 (default)
cdkd events prune MyStack --keep 5        # keep the newest 5
cdkd events prune MyStack --older-than 24h  # delete runs older than 24h
cdkd events prune MyStack --all           # purge everything (+ the index)
cdkd events prune MyStack --all --yes     # skip the confirmation (CI)
```

`--all` is mutually exclusive with `--keep` / `--older-than`. With both
`--keep` and `--older-than`, a run is deleted only when it is BOTH beyond the
newest-N window AND older than the cutoff. Prompts for confirmation unless
`-y` / `--yes`; `--stack-region` disambiguates a multi-region stack.

State-driven (no synth, no lock). See
**[Deployment Events](deployment-events.md)** for the full
reference: event types, S3 key layout, flush strategy, `index.json`
semantics, and the retention model.

