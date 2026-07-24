# rollback-sqs-cooldown

Permanent regression fixture (issue #1218) for two `cdkd rollback` behaviors
that were previously only live-verified with ad-hoc scratch apps:

## Phase 1 — reverse-replacement through the SQS name cooldown (issue #1206)

SQS enforces a ~60s same-name re-creation cooldown after `DeleteQueue`
(`AWS.SimpleQueueService.QueueDeletedRecently`). The fixture:

1. Deploys a custom-named queue `-queue-x`.
2. Redeploys with the queue renamed to `-queue-y` (create-only `QueueName` →
   replacement, `--force-stateful-recreation`) plus an injected
   deterministically-failing resource (out-of-range `MessageRetentionPeriod`),
   under `--no-rollback` — the journal records the completed replacement and
   the old name's cooldown starts at its delete.
3. Runs `cdkd rollback --force --verbose` immediately (< 60s): the
   reverse-replacement's initial re-create must hit `QueueDeletedRecently`,
   retry through the window (asserted via the `--verbose` retry lines),
   restore `-queue-x`, delete `-queue-y`, and exit 0.

Runtime is dominated by this one ~60s cooldown wait (~3-4 min total).

## Phase 2 — failed-only journal retention cycle (issue #1208)

1. A failing deploy WITHOUT `--no-rollback` triggers a clean automatic
   rollback; the journal must survive as `reason: auto-rollback-clean` /
   `operations: []` / `failedOperations: [FailingQueue]` (asserted via a raw
   S3 read).
2. The next deploy must print the `--revert-failed` note.
3. `cdkd rollback --force --revert-failed` consumes it — the #1198
   skip-with-warning for the physical-id-less failed CREATE; journal cleared;
   exit 2 accepted.
4. After re-creating the failing state, a NO-CHANGE fix-forward deploy (bad
   resource removed) must clear the journal and the note (the PR #1212
   no-change gap regression).

## Run

```bash
AWS_REGION=us-east-1 STATE_BUCKET=<bucket> bash verify.sh
```

A clean run flips the `integ-destroy` marker (real destroy at the end) but not
`integ-broad` (narrow feature fixture).
