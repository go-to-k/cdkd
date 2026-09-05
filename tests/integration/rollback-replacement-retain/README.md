# rollback-replacement-retain

Real-AWS regression net for issue
[#2598](https://github.com/go-to-k/cdkd/issues/2598) — on a **replacement
rollback**, `UpdateReplacePolicy: Retain` governs the fate of the
replacement's **new** physical copy, and `DeletionPolicy` does not.

## What it covers that no other fixture does

Six `rollback-*` fixtures exercise the replacement-rollback arms
(`rollback-command`, `rollback-cross-region-secret`,
`rollback-deletion-policy-snapshot`, `rollback-failure-injection`,
`rollback-replay-effective-props`, `rollback-sqs-cooldown`) and **not one of
them declares `UpdateReplacePolicy: Retain` on a replaced resource**. So they
all measure the DEFAULT (delete) polarity. The retain branch — the one that
decides whether cdkd destroys a physical resource the user explicitly marked to
survive — had no real-AWS coverage at all.

## Ground truth

Measured with a live CloudFormation A/B (us-east-1, 2026-09-05): a forced
`AWS::SSM::Parameter` replacement plus a deterministically failing sibling,
rolled back.

| DeletionPolicy | UpdateReplacePolicy | new copy | decisive CFn event |
| --- | --- | --- | --- |
| (none) | (none) | DELETED | `DELETE_COMPLETE` |
| Retain | (none) | DELETED | `DELETE_COMPLETE` |
| (none) | Retain | SURVIVED | `DELETE_SKIPPED` |

`DELETE_SKIPPED` carries no `ResourceStatusReason`, so the status value is the
only discriminator. A retained new copy is **orphaned out of the stack**, not
kept as a managed resource — the A/B proved that by deleting the whole stack
afterwards and finding the retained parameter still alive.

## The three subjects

| logical id | DeletionPolicy | UpdateReplacePolicy | new copy must be | role |
| --- | --- | --- | --- | --- |
| `RetainParam` | (none) | Retain | ALIVE | the polarity under test |
| `ControlParam` | (none) | (none) | GONE | default polarity |
| `DeletionPolicyParam` | Retain | (none) | GONE | refutes "DeletionPolicy governs it" |

A retain-only fixture cannot tell "the retain branch works" from "cdkd never
deletes anything on this path", so `ControlParam` is mandatory.
`DeletionPolicyParam` is the sharper control: an edit that re-pointed the
retention verdict at `deletionPolicy` would still satisfy `ControlParam` and
fails here.

`RetainParam` deliberately carries **no** `DeletionPolicy` — that is what lets
`cdkd destroy` remove the re-adopted OLD copy in the final phase, leaving the
untracked survivor as the only thing standing.

## Why `AWS::SSM::Parameter`

`Name` is create-only, so flipping it forces a property-driven replacement; the
type has an SDK provider; a parameter name is released the instant it is
deleted, so the control arms' re-create of the old name is deterministic
(unlike an SQS queue name, which rides a ~60s deletion cooldown, or a globally
unique bucket name); and parameters are free, so the deliberate `Retain`
survivor costs nothing while it is alive.

`AWS::SSM::Parameter` is in `STATEFUL_TYPES`, so the two control arms need
`--force-stateful-recreation` on the failing deploy. `RetainParam` does not — a
`Retain` `UpdateReplacePolicy` exempts the stateful guard, because the old copy
survives and there is no data loss to consent to — and the flag changes nothing
on its arm.

## Phases

| # | Step | Assertion |
| --- | --- | --- |
| 1 | Deploy v1 | all three parameters live; state records `UpdateReplacePolicy: Retain` on `RetainParam` and `DeletionPolicy: Retain` on `DeletionPolicyParam`, and nothing else |
| 2 | Deploy v2: rename all three (create-only -> replacement) with a failing SQS queue wired AFTER them | the deploy exits non-zero |
| 3 | Read the deploy log | the deploy engine ORPHANED the old `retain-v1`; the rollback took `reverse-replacement-readopt`; it warned naming `retain-v2`; both controls took `reverse-replacement`; neither control was announced as retained |
| 4 | Probe SSM by name | **`retain-v2` is ALIVE**; `control-v2` and `deletion-policy-v2` are GONE; all three v1 copies are back |
| 5 | Read state.json | every record points at its v1 copy, and `retain-v2` appears NOWHERE |
| 6 | Read `cdkd events --run <failed> --format json` | the retained subject's `ROLLBACK_RESOURCE_SUCCEEDED` carries `physicalId` = `retain-v2`, a `reason` naming BOTH ids, and `provisionedBy`; both control rows carry NEITHER `physicalId` nor `reason` |
| 7 | `cdkd destroy` | `retain-v1` + `control-v1` gone; `retain-v2` still alive (untracked); `deletion-policy-v1` still alive (`DeletionPolicy: Retain`); state.json gone; the fixture then deletes the two deliberate survivors and asserts the whole parameter path is empty |

Each log grep in phase 3 carries a **sentinel** — a second, independent marker
that separates "the condition did not occur" from "the wording drifted and this
grep is now blind". Phase 6's sentinel is the count of
`ROLLBACK_RESOURCE_SUCCEEDED` rows: a `jq` selection matching nothing answers
"field absent" exactly as a genuinely dropped field does.

## Why phase 6 is the load-bearing one

Phase 3's warn grep is what an **interactive** user sees. A rollback runs
during an already-failing deploy, usually non-TTY with the log truncated or
discarded — so a survivor named only in a `logger.warn` dies with the terminal:
`cdkd events` would show a clean success, state names only the OLD copy, and a
live, billing, untracked resource is left with nothing anywhere pointing at it.
`Retain` is exactly the marker users put on data-bearing resources, so that is
the worst population to lose the id for. The full contract is **alive in AWS +
absent from state + named in the durable event** — phases 4, 5 and 6.

The control rows' *absence* of `physicalId` / `reason` is the inverse bug and
is asserted for the same reason: on every non-retain path the new copy was
DELETED, so an unconditional `physicalId` would point a cleanup pass at a
resource this rollback just destroyed.

**Stated bound on the `provisionedBy` assertion.** The retain branch reports
the SURVIVOR's layer (read off the state record) where every other path reports
the OP's. For a single SDK-routed type both are `sdk`, so the assertion pins
that the field is present and correct — not that the two sources are told
apart. Discriminating them would need the survivor's record to route
differently from the journaled op, which one replacement of one type cannot
produce.

## Leak safety

`Retain` means cdkd will not clean up after this fixture, so the fixture must.
`sweep_params` deletes every parameter under `/cdkd-integ/rollback-replacement-retain`
and runs pre-run, from `cleanup`, and from the `EXIT` / `INT` / `TERM` traps.
That is also why the parameter names are FIXED rather than per-run unique: a
per-run-id name would strand its leftovers under a name no later run can find,
while a fixed name plus a pre-run path sweep is self-healing (`PutParameter`
runs with `Overwrite: false`, so a leftover would otherwise fail phase 1 with
`ParameterAlreadyExists`).

## Run it

```bash
/run-integ rollback-replacement-retain
```
