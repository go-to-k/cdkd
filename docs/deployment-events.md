# Deployment Events (`cdkd events`)

> Issue [#808](https://github.com/go-to-k/cdkd/issues/808)

When a `cdkd deploy` / `cdkd destroy` run fails, the only durable artifact
used to be the (partial) `state.json` snapshot — per-resource lifecycle
information (which operation failed, why, in what order, with what AWS
error) existed only as terminal output via the logger, which writes to
stdout/stderr. With CloudFormation, `DescribeStackEvents` gives any tool
(human or AI assistant) the full server-side deploy history via the AWS
API. cdkd now records an equivalent stream of **deployment events** to S3,
readable with `cdkd events`.

This makes post-hoc troubleshooting possible — especially handing failure
context to an AI agent on a different machine / session: one command gives
the full ordered run history.

## What gets recorded

Each deploy / destroy run appends one **JSONL** line per lifecycle event:

| Event type | When |
| --- | --- |
| `RUN_STARTED` / `RUN_FINISHED` | Once per deploy / destroy run (carries command, region, cdkd version, terminal result, per-op counts). |
| `RESOURCE_STARTED` / `RESOURCE_SUCCEEDED` / `RESOURCE_FAILED` | Per per-resource CREATE / UPDATE / DELETE (carries logicalId, resourceType, `provisionedBy`, physicalId on success, duration, error metadata on failure). |
| `RESOURCE_RETAINED` | Destroy-side skip for a `DeletionPolicy: Retain` resource. |
| `ROLLBACK_STARTED` / `ROLLBACK_RESOURCE_SUCCEEDED` / `ROLLBACK_RESOURCE_FAILED` / `ROLLBACK_FINISHED` | Deploy-failure rollback phase. |

Failure events carry an `error` object: `{ name, message, awsErrorCode?,
requestId? }`. The AWS error code + request id are extracted from the
innermost AWS-SDK-shaped error in the thrown error's `.cause` chain.

### Security: no resource properties

Events carry **error + metadata only**. Resource properties are **never**
recorded in events (they may contain secrets); properties already live in
`state.json`. The error object is the outermost error's name/message plus
the AWS error code / request id — no payloads.

## Where it lives (S3 key layout)

Events are a **separate key family** from `state.json` — there is **no
state schema bump** (state stays at its current version), so the change is
fully backward compatible and triggers no schema-migration tooling.

```
s3://{bucket}/{prefix}/{stackName}/{region}/deployments/{runId}.jsonl   # one per run
s3://{bucket}/{prefix}/{stackName}/{region}/deployments/index.json      # last N runs (newest first)
```

- `{runId}` is time-sortable + unique (e.g. `20260613T012345678Z-1a2b3c4d`).
- `index.json` is a small derived view: the last 20 runs (runId, command,
  cdkd version, start/end, result, event count), newest first.
- Because the key family is separate from `state.json`, **event files
  survive `cdkd destroy`** — a destroyed stack's failure history stays
  readable.

### Bounded growth (issue [#885](https://github.com/go-to-k/cdkd/issues/885))

Two mechanisms keep the `deployments/` prefix from growing without bound:

- **Self-bounding at write time.** When a run finalizes, the writer prunes
  `{runId}.jsonl` streams that have fallen out of the 20-run index window —
  so the per-run files stay bounded to the same window as `index.json`, not
  just the index. The prune is best-effort (a failure warns once and never
  blocks the run) and concurrency-safe: only streams strictly older than the
  oldest retained run id are deleted, and run ids are time-sortable, so a
  concurrent newer run can never be pruned out from under its writer.
- **Explicit purge: `cdkd events prune`.** `cdkd destroy` deliberately keeps
  event history (post-mortem context), so it never returns the state bucket
  to empty on its own. `cdkd events prune <stack>` is the way to reclaim that
  space — see [Pruning event history](#pruning-event-history-cdkd-events-prune).

### Best-effort, never blocking

Event recording can **never fail or block** a deploy / destroy:

- `record()` is synchronous and only buffers in memory.
- Flushes are asynchronous (debounced timer + a size threshold) and
  serialized on a write chain.
- A failed S3 write warns **at most once** and then degrades to
  debug-level logging. The deploy / destroy proceeds regardless.

### No locking

Each run writes to its own unique `{runId}.jsonl` key, so there is no
concurrent writer by construction. `index.json` is written with
**last-writer-wins** (no optimistic locking) — it is a derived view; the
per-run `.jsonl` files are the source of truth, and `cdkd events --run
<id>` reads a run directly by id even if the index lost a race.

## Reading events back: `cdkd events`

```bash
# List recorded runs for a stack, newest first
cdkd events MyStack

# Read one run's full ordered event stream
cdkd events MyStack --run 20260613T012345678Z-1a2b3c4d

# Machine-readable JSON (for tooling / AI-agent hand-off)
cdkd events MyStack --format json
cdkd events MyStack --run <id> --format json

# Disambiguate a stack with event history in more than one region
cdkd events MyStack --stack-region us-east-1
```

- With no `--run`: lists the runs from `index.json` (newest first). When
  the index is missing or unreadable it falls back to enumerating the
  `{runId}.jsonl` keys directly and deriving each run's result from its
  own JSONL (the last `RUN_FINISHED` event) — a run whose stream has no
  terminal `RUN_FINISHED` (interrupted, or its index write lost the
  last-writer-wins race) is reported as `UNKNOWN`, never fabricated as
  `FAILED`.
- With `--run <id>`: prints that run's ordered events. Malformed / torn
  final lines (from an interrupted flush) are skipped, never hiding the
  rest of the stream.
- `--format json` (or `--json`) emits the raw JSON.
- Region is auto-discovered from the `deployments/` key listing (not
  `state.json`), so it works for destroyed stacks too; `--stack-region`
  disambiguates when a stack has history in more than one region.

The command is **state-driven** — it only reads the S3 state bucket and
does not need the CDK app (no synth). It does not take a lock (the keys are
per-run unique and the index is last-writer-wins).

## Pruning event history (`cdkd events prune`)

```bash
# Keep the newest 20 runs (default), delete the rest
cdkd events prune MyStack

# Keep only the newest 5 runs
cdkd events prune MyStack --keep 5

# Delete runs older than 24 hours
cdkd events prune MyStack --older-than 24h

# Purge ALL event history for the stack (and remove the index)
cdkd events prune MyStack --all

# Skip the confirmation prompt (CI)
cdkd events prune MyStack --all --yes
```

Retention selection:

- `--all` — delete every recorded run **and** the `index.json` (full purge).
  Mutually exclusive with `--keep` / `--older-than`.
- `--keep <N>` — retain the newest N runs, delete the rest.
- `--older-than <duration>` — delete runs whose run-id timestamp is older
  than the duration (`<n>s` / `<n>m` / `<n>h`). A run id without a parseable
  timestamp is kept (the safe direction).
- `--keep <N>` **and** `--older-than <dur>` together — a run is deleted only
  when it is **both** beyond the newest-N window **and** older than the
  cutoff (the most conservative combination).
- No retention flag — defaults to keeping the newest 20 runs (matching the
  index window the writer self-bounds to).

Prompts for confirmation unless `-y` / `--yes` is passed; `--stack-region`
disambiguates a stack with history in more than one region. Like `cdkd
events`, it is **state-driven** (no synth) and does not take a lock — but
unlike the writer's best-effort auto-prune, errors surface to the caller.

After deleting the matching `{runId}.jsonl` streams it rewrites `index.json`
to drop the pruned runs, or removes the index entirely when no runs remain —
so a full `--all` purge (or a destroy followed by `prune --all`) returns the
stack's `deployments/` prefix to empty, satisfying the "state bucket empty
after teardown" convention.

## Out of scope (follow-ups)

Per issue #808: a diagnostic bundle command (`cdkd doctor --bundle`) and
MCP server exposure of state / events / diff are deliberately left as
follow-ups.
