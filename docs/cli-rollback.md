---
title: cdkd rollback
description: "Revert a failed deploy to the last known-good state with cdkd rollback."
---

## `cdkd rollback` (revert a failed deploy)

`cdkd rollback [STACK]` reverts a stack to its pre-deploy state after a
deploy that failed with `--no-rollback`, was interrupted with Ctrl+C, or
whose automatic rollback died partway. It is the cdkd equivalent of
`cdk rollback` / CloudFormation `RollbackStack`, and the third option (next
to fix-forward `cdkd deploy` and clean-up `cdkd destroy`) after such a
failure.

**Synth-free.** Everything it needs lives in cdkd state plus a **rollback
journal** — the exact `CompletedOperation[]` of the failed deploy, persisted
to `s3://bucket/cdkd/{stack}/{region}/rollback-journal.json` (a sibling of
`state.json`) whenever a deploy ends without a completed rollback. The
command loads that journal and replays it in reverse (delete created
resources; restore updated ones to their previous properties) via the same
rollback executor the in-process automatic rollback uses. No CDK app is
needed — a broken app is a common reason to roll back.

```bash
cdkd rollback MyStack          # roll back one stack
cdkd rollback                  # no arg: the single journaled stack (else lists candidates, exits 1)
cdkd rollback MyStack --force  # skip the confirmation prompt
cdkd rollback MyStack --orphan MyBucket --orphan MyTable
cdkd rollback MyStack --skip-final-snapshot   # DeletionPolicy: Snapshot → delete without the snapshot
cdkd rollback MyStack --stack-region us-west-2
```

Flags:

| Flag | Meaning |
| --- | --- |
| `--force` | Skip the confirmation prompt (`-y` / `--yes` also works). |
| `--orphan <logicalId>` | Repeatable. Skip the resource during replay, like `cdk rollback --orphan`. An orphaned CREATE is left in AWS and removed from state; an orphaned UPDATE is left at its new properties with state kept as-is. |
| `--revert-failed` | Also attempt to revert the resource whose operation **FAILED** mid-deploy. Off by default because the failed resource's remote state is unknown (the op died partway): a failed UPDATE is force-reverted to its pre-deploy properties (the journal records the *attempted* properties, so patch-based providers generate a real undo diff); a failed CREATE that recorded no physical id is skipped with a warning; a failed DELETE needs no revert (the resource is still in place). A failed CREATE that DID get provisioned honors its `DeletionPolicy` on the way out: `Retain` leaves it in AWS, `Snapshot` snapshots then deletes (`--skip-final-snapshot` opts out of the snapshot). Each handled failed op is stripped from the journal segment immediately (per-op), so a later completed-op failure that keeps the segment for a re-run only re-attempts what is genuinely outstanding — never a revert that already succeeded. |
| `--skip-final-snapshot` | Delete a rolled-back CREATE (completed, or failed in-flight under `--revert-failed`) whose `DeletionPolicy` is `Snapshot` WITHOUT the final snapshot the policy promises (DATA LOSS — explicit opt-out of CloudFormation parity). By default the rollback creates the snapshot first, and refuses the delete for a shape it cannot snapshot; see [`DeletionPolicy: Snapshot`](cli-destroy.md#deletionpolicy-snapshot-final-snapshots-on-delete-skip-final-snapshot). |
| `--stack-region <region>` | Disambiguate when the same stack name has state in multiple regions (same UX as the `state` subcommands). |
| `--role-arn <arn>` | Assume-role before touching AWS. If the journal recorded a role and the flag is not passed, an informational note is printed. |
| `--state-bucket <bucket>` | Same resolution as other commands. |
| `--verbose` | Standard debug logging. |

**Flow**: resolve the stack + region → acquire the stack lock (a concurrent
deploy holding it fails the command with the standard lock error;
`cdkd force-unlock` applies) → print a per-segment plan → confirm (skipped by
`--force`) → replay segments newest-first, saving state after each op and
popping each segment when it finishes cleanly → if the oldest replayed
segment was the stack's first-ever deploy and state is now empty, delete
`state.json` too. Replay is idempotent: re-running after a partial rollback
skips resources already reverted.

**Exit codes**: `0` = fully clean (journal deleted); `2` = partial (one or
more ops failed best-effort, or were skipped with a warning — the journal is
kept so you can re-run); `1` = hard error (no journal, lock held,
credentials, etc.).

**Known limitations** (surfaced in the plan, not silent):

- A resource that was **DELETED** during the deploy cannot be restored (same
  as CloudFormation). Deletes run after creates/updates, so a typical
  mid-deploy failure has not deleted anything yet.
- The resource whose operation **failed** is left as-is by default. The
  journal records the failed op (its pre-op state + the attempted
  properties), and `--revert-failed` opts in to reverting it — opt-in because the
  failed resource's remote state is genuinely unknown. A failed CREATE that
  recorded no physical id still cannot be acted on (skipped with a warning).
  Note: after a **clean automatic** rollback the journal is settled to a
  **failed-only** segment (`operations: []` plus the failed op
  records): the completed
  ops are already reverted, but the failed resource's record is kept so
  `cdkd rollback --revert-failed` works in the DEFAULT deploy flow too. A
  plain `cdkd rollback` on such a journal is a no-op replay that clears it;
  the next successful deploy also deletes it.
- **Replacements** are reverted by **reversing the
  replacement**: the old resource is
  re-CREATEd from its journaled pre-deploy state and the new resource is
  deleted (create-first; a user-supplied physical name still held by the new
  resource falls back to delete-new-first with a bounded name-release retry).
  Under `UpdateReplacePolicy: Retain` the orphaned old resource still exists,
  so it is simply re-adopted after the new one is deleted — a true clean
  revert. **Data caveat:** for a stateful type (DynamoDB / RDS / S3 / etc.)
  the old resource's data was destroyed by the replacement and cannot be
  recovered — the re-created resource starts empty (warned loudly in the
  replay; the plan labels these "reverse-replace").
- Reverts that reference old **asset objects** (e.g. Lambda `Code.S3Key`)
  need those objects to still exist — relevant to `cdkd gc` retention.
- The rolled-back COMPLETED CREATE's **`DeletionPolicy`** governs its delete,
  matching CloudFormation: `Retain` leaves the resource in AWS and drops it
  from state (the plan labels it `orphan`); `Snapshot` takes the final
  snapshot and THEN deletes, refusing (as a per-op failure, journal kept) any
  shape cdkd cannot snapshot unless `--skip-final-snapshot` is
  passed. The plan preview says
  which of the two will happen BEFORE you confirm — a shape cdkd cannot
  snapshot on the route the delete will take is labelled
  `cdkd cannot snapshot this resource; the rollback will REFUSE it` rather
  than promising a final snapshot; `RetainExceptOnCreate`
  and the default `Delete` delete plainly. `--revert-failed`'s delete of a
  resource whose CREATE FAILED mid-flight applies the SAME matrix — it acts only on a
  failed CREATE that AWS did provision (recorded physical id + matching state
  record), so `Retain` no longer deletes what the policy says to keep and
  `Snapshot` no longer destroys the data un-snapshotted.
- A re-run after a snapshot succeeded but its delete failed re-snapshots the
  name-keyed types (Redshift / ElastiCache), which only resume an IN-FLIGHT
  snapshot; EBS volumes are reused via the `cdkd:final-snapshot-of` tag. The
  rollback replay is the flow most likely to be re-run, so expect a second
  snapshot charge on those two types.

`cdkd export` refuses (with a confirmation gate) to hand a stack over to
CloudFormation while a rollback journal exists — the half-deployed state is
almost certainly not what you want exported; roll back or re-deploy first.

