---
title: Deployment Events
description: "Durable per-resource deployment event history via cdkd events — cdkd's equivalent of CloudFormation DescribeStackEvents, with S3 layout and pruning."
---

# Deployment Events (`cdkd events`)

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

```bash
cdkd events MyStack                    # list recorded runs, newest first
cdkd events MyStack --run <id>         # one run's full ordered event stream
cdkd events MyStack --format json      # machine-readable, for tooling
cdkd events MyStack --stack-region us-east-1   # disambiguate a multi-region name
cdkd events prune MyStack              # keep the newest 20 runs, delete the rest
cdkd events prune MyStack --all --yes  # purge all history for the stack
```

## What gets recorded

Each deploy / destroy run appends one **JSONL** line per lifecycle event:

| Event type | When |
| --- | --- |
| `RUN_STARTED` / `RUN_FINISHED` | Once per deploy / destroy / rollback run (carries command, region, cdkd version, terminal result, per-op counts). The `command` field is `deploy`, `destroy`, or `rollback`. |
| `RESOURCE_STARTED` / `RESOURCE_SUCCEEDED` / `RESOURCE_FAILED` | Per per-resource CREATE / UPDATE / DELETE (carries logicalId, resourceType, `provisionedBy`, physicalId on success, duration, error metadata on failure). |
| `RESOURCE_RETAINED` | Destroy-side skip for a `DeletionPolicy: Retain` resource — the AWS resource is kept **on purpose** and its state record is dropped. |
| `RESOURCE_SKIPPED` | A skip where cdkd could **not address** the resource, so it may still exist. Emitted by `cdkd destroy` AND by the `cdkd deploy` DELETE branch (a resource removed from the template whose provider refused the delete). Three producers: a malformed composite physicalId in state (no AWS call issued at all); a state record missing the id or the property the delete is addressed BY — Lambda layer / permission, Custom Resource, IAM policy / user-group (also no AWS call at all); and a nested stack whose own destroy skipped or was interrupted (the child's other resources *were* deleted first) — so the invariant is "this row was not destroyed", not "nothing happened". The opposite of `RESOURCE_RETAINED` in both halves: keeping the AWS resource is not intended, and the state record is **kept** so the orphan stays traceable. Carries no `error` (nothing failed); the cause is in `reason`. It is ALSO emitted for a **partial UPDATE**: a replacement whose inner delete left the OLD resource alive. That row is the one case where `RESOURCE_SKIPPED` sits NEXT TO a `RESOURCE_SUCCEEDED` for the same logical id rather than replacing it — the resource named by the SUCCEEDED event was updated, and the SKIPPED event names the predecessor that survived and is no longer in state. Reading the pair as a contradiction is the mistake to avoid: the invariant above still holds, because the row the skip describes is the old resource, not the new one. |
| `RESOURCE_GUARD_INDETERMINATE` | A **pre-flight safety guard** ran on this resource, could **not reach a verdict**, and was therefore not enforced — cdkd proceeded anyway. Carries `guard` (a stable machine-readable id, e.g. `cc-delete-region-identity`) and `reason` (why it could not answer). This row says nothing about whether the operation succeeded: it sits **alongside** the resource's own `RESOURCE_SUCCEEDED` / `RESOURCE_SKIPPED` row rather than replacing it (never a `RESOURCE_FAILED` one — a guard travels back on the delete's RETURN value, so a delete that threw carries none), and it does **not** move any `counts` field or the run's `result`. Carries no `error` — nothing failed. The durability is the point: a guard is disabled by DENYING the permission it depends on (an `s3:GetBucketLocation` `Deny` in a bucket policy, settable by anyone holding `s3:PutBucketPolicy` on the target), and the `logger.warn` cdkd prints does not survive the run — so without this row, a destroy that proceeded **without** confirming its target was indistinguishable, afterwards, from one that confirmed it. Emitted by `cdkd destroy` today. |
| `ROLLBACK_STARTED` / `ROLLBACK_RESOURCE_SUCCEEDED` / `ROLLBACK_RESOURCE_FAILED` / `ROLLBACK_FINISHED` | Rollback phase — emitted both by the deploy-failure automatic rollback AND by a standalone `cdkd rollback` run, which records them under its own `runId` (with `command: rollback` in `index.json`). |

A `RUN_FINISHED` additionally carries `counts.skipped` when non-zero, on
destroy AND on deploy. **Both verbs
record `result: 'FAILED'` for it.** Deploy previously recorded
`SUCCEEDED` on the grounds that the state record was kept and the next deploy
re-attempts the delete — but that run now exits 2, and a post-mortem saying a
run succeeded while the same run returned 2 is a split verdict, not a nuance.
(Self-healing is still real, and is why the resource is a warning rather than a
failed ROW; it is not why the RUN would have succeeded.) `--allow-unaddressed`
changes the exit code only — the run is still recorded `FAILED`, because what
the events store records is what happened, not what the operator chose to
tolerate. On destroy the `FAILED` result also keeps `--purge-events` from
discarding the history. `cdkd
events` renders the count as `⚠N` after the `+created/~updated/-deleted` triple:

```text
2026-08-13T05:15:35Z  RUN_FINISHED  destroy  us-east-1  FAILED  +0/~0/-1  ⚠1
2026-08-13T05:15:35Z  RESOURCE_SKIPPED  MyTable (AWS::Glue::Table)  DELETE
      malformed physicalId in state — no delete issued
```

`RESOURCE_SKIPPED` carries a **`reason`** — the same one-line cause shown on the
destroy status line — rendered on its own line beneath the event. The events
store is the durable post-mortem, so a skip recorded without a cause would be
close to useless there. Like every other event field this is metadata only:
provider-authored prose about the *identifier*, never resource properties.

`RESOURCE_GUARD_INDETERMINATE` carries the same **`reason`** field, plus a
**`guard`** id. `reason` is likewise the whole value of the row — the outcome
("cdkd proceeded") is already implied by the event type, so what is left to say
is why the guard could not answer; distinct causes get distinct text even where
they reach the same proceed-anyway outcome, because the remedies differ (grant
an IAM permission vs. repair a state record vs. fix a credential chain).
`cdkd events` renders `guard=<id>` as a column and the reason on its own line:

```text
2026-09-02T05:15:35Z  RESOURCE_GUARD_INDETERMINATE  MyBucket (AWS::S3::Bucket)  DELETE  guard=cc-delete-region-identity  [cc-api]
      s3:GetBucketLocation on my-bucket could not be answered: Access Denied
2026-09-02T05:15:36Z  RESOURCE_SUCCEEDED  MyBucket (AWS::S3::Bucket)  DELETE  [cc-api]  980ms
```

The destroy summary carries the count half of the same signal
(`Stack MyStack destroyed (1 deleted, 1 unverified, 0 errors)`) plus a warning
naming the resources and pointing back at `cdkd events`. Note that
`cdkd destroy --purge-events` deletes this history along with the rest after a
clean destroy — that flag is an explicit "delete my history" instruction and
this row is history like any other. An attacker who can deny a probe cannot
make an operator pass the flag, so the two are independent; if you want the
record kept, do not pass it.

`cdkd state destroy` records **no** deployment events at all (it threads no
recorder), so its only surface for a suppressed guard is the summary line and
its warning.

Failure events carry an `error` object: `{ name, message, awsErrorCode?,
requestId? }`. The AWS error code + request id are extracted from the
innermost AWS-SDK-shaped error in the thrown error's `.cause` chain.

### Security: no resource properties, and a MASKED error message

Events carry **error + metadata only**. Resource properties are **never**
recorded in events (they may contain secrets); properties already live in
`state.json`. The error object is the outermost error's name/message plus
the AWS error code / request id — no payloads.

**Withholding the payload is not sufficient on its own**, which is the part
this section used to leave unsaid. AWS validation errors routinely quote the
offending property VALUE back inside the `message` — `Value 'hunter2' at
'password' failed to satisfy constraint ...` — so a resolved Secrets Manager /
SSM `SecureString` value can reach the event `message` without any property ever
being recorded. Because `deployments/{runId}.jsonl` is a **durable S3 sink**,
that is worse than a terminal line: it persists after the run.

Each of the two producers that holds a resolved secret bag therefore masks the
message before it is recorded, substituting the `{{resolve:...}}` expression the
way state redaction does: `DeployEngine` masks
every event through `maskSecretsInEvent`, and the **rollback executor** masks
its own. The rollback half lives in the executor rather than in each caller
because the replay re-resolves journaled properties to plaintext and has two
entry points that would otherwise diverge: the standalone `cdkd rollback`
command recorded events with no masking at all, while a deploy's in-process
auto-rollback masked with the DEPLOY's secrets bag — a different generation from
the one the replay resolved from the journal, so a rotated secret or a reference
only the previous generation carried was missed. Masking at the shared executor
makes both callers equal; the deploy engine's own `maskSecretsInEvent` still runs
and double-masking is a no-op.

The `name`, `awsErrorCode` and `requestId` fields are NOT masked — they are AWS
enum-shaped identifiers that never carry a caller-supplied value.

#### What the masking does NOT cover

The mask is a **literal-occurrence substitution**, so it is bounded in three
ways. None of these is new — they are inherited from `maskSecretsInText` and
predate the masking described above — but they are worth stating HERE rather
than only at the log sites, because a durable sink keeps whatever gets through:

- **Secrets shorter than 4 characters are not substituted**
  (`MIN_NEEDLE_LENGTH` in `src/deployment/secret-redaction.ts`) unless the whole
  message IS the secret. A 1-3 character needle would rewrite unrelated text
  across every message, so the substring scan declines it.
- **Only a VERBATIM occurrence is matched.** A message that quotes the value
  back JSON-escaped, truncated (`Value 'hunte...'`), re-cased, or URL-encoded
  passes through unchanged, because the scanned string no longer contains the
  recorded plaintext.
- **A `NoEcho: true` template parameter is outside the model entirely.** The
  masker works from the resolver's `{{resolve:...}}` bag, and a `Ref` to a
  `NoEcho` parameter has no such expression to map back to, so its value is
  never recorded and never masked.

Treat `deployments/*.jsonl` as sensitive on that basis, and rotate any secret
whose plaintext a run is known to have quoted — masking a later write does not
un-persist an earlier one.

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

### Bounded growth

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
- **Purge as part of destroy: `cdkd destroy --purge-events`.** Opts into
  deleting the stack's event history immediately after a *clean* destroy, so
  the bucket returns fully empty in one command. Kept on a failed /
  interrupted destroy (those events aid the retry); equivalent for an
  already-destroyed stack is `cdkd events prune <stack> --all`.

### Best-effort, never blocking

Event recording can **never fail or block** a deploy / destroy:

- Events are buffered in memory as the run proceeds; nothing is written
  to S3 inline with a resource operation.
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

A diagnostic bundle command (`cdkd doctor --bundle`) and
MCP server exposure of state / events / diff are deliberately left as
follow-ups.
