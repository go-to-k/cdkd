---
description: Provider delete path - context fields, outcomes, recursion and delegation
paths:
  - 'src/provisioning/providers/**'
---

# Provider Pattern - the delete path

Region check: [layout-provisioning.md](layout-provisioning.md). Masking: [provider-masking.md](provider-masking.md).

## `DeleteContext`

- `expectedRegion` — the region recorded in state at create time. Call `assertRegionMatch()` before treating a `*NotFound` error as idempotent delete success. Also on `UpdateContext`; a no-op when absent.
- `forceDataDelete` — consent to destroy contained DATA, set only by the engine's replacement / recreate deletes under `--force-stateful-recreation`, never by `cdkd destroy`. Gate force-cleanup on it or a template-borne opt-in (`data-delete-intent.ts`), else surface AWS's not-empty error. Never unconditional — verify CFn's behavior by live A/B.
- `finalSnapshotIdentifier` — `DeletionPolicy: Snapshot`; the provider MUST create that snapshot. Only `ATOMIC_FINAL_SNAPSHOT_TYPES` receive the field, `PRE_DELETE_SNAPSHOT_TYPES` are snapshotted engine-side, and other Snapshot-tagged shapes are refused before any delete. Extend those sets (`final-snapshot.ts`); never ignore the field.

A delete bag CAN carry plaintext and `delete()` has no masker: thread one before logging a property value (issue #2007).

## Outcomes

Returning normally means THE RESOURCE IS GONE. An arm that issued no AWS call, or whose call failed, must not: the runner would print a deleted row, DROP the state record and exit 0. A lenient `catch` is that defect through a throw, since `undefined` reads as DELETED.

- `{ outcome: 'skipped', reason }` (`compositeIdSkipResult()`, `composite-id.ts`) — the premise is "NOT destroyed", never "no AWS call was issued". The runner warns, counts `skippedCount`, emits `RESOURCE_SKIPPED`, KEEPS the record and exits 2 (a deploy too, unless `--allow-unaddressed`); never skip when the resource is known gone.
- `{ outcome: 'partial', reason }` on `ResourceUpdateResult` — a create-then-delete replacement whose delete did not land; the engine records the survivor.
- `withIndeterminateGuard(result, guard)` (`src/deployment/delete-outcome.ts`) — a pre-flight guard that could not answer while the delete went ahead. Proceed rather than refuse (such probes need permissions a least-privilege caller may lack), and name the GUARD, not the API or type: it is persisted to `deployments/*.jsonl` as a user contract.

Keep `reason` a FIXED constant with the AWS message in the warning: a reason is rendered into an `Error` whose catch classifies "already deleted" by SUBSTRING.

## Recursion and delegation

`NestedStackProvider.delete` returns `skipped` on `childResult.skippedCount > 0` or `interrupted`, and THROWS on `errorCount > 0`: an attempted-and-failed child must fail the parent's row. The split is decided by what was ATTEMPTED. The throw's wording must avoid `not found` / `does not exist` / `No policy found` / `NoSuchEntity` / `NotFoundException` / `was not found` / `ResourceNotFoundException`, which both callers read as idempotent success and DROP the state row. Its remedy must name the CHILD's state file.

A provider that DELEGATES a delete must `return await` it. A REPLACE inside `update()` splits on ORDERING: create-then-delete cannot abort, so it warns in orphan wording and reports `partial`; delete-then-create must ABORT before creating the replacement, on BOTH the skip and the throw arm, since cdkd must not issue a CREATE whose precondition it failed to establish. The abort must suit every `update()` caller.

Never interpolate a provider-supplied `reason` into a thrown message: `retryable-errors.ts` classifies by SUBSTRING, so `does not exist` or `Rate exceeded` inside it burns the backoff schedule. Interpolate the TEMPLATE logical id only, and `markNonRetryable` it.

## Skip quality

- **EXHAUST every addressable source before skipping.** A skip preserves the record, warns, exits 2 and repeats forever, so reading ONE source is a defect wherever a second carries the same value — a composite physicalId often holds an ARN the properties lack. Order sources by what was DEPLOYED.
- **Validate a fallback source, or it is worse than the skip.** Apply the `typeof === 'string'` guard to BOTH sources: a truthy non-string coerces and the call can SUCCEED against the wrong resource. Check its REGION — a provider holds ONE client, so a cross-region ARN returns `ResourceNotFoundException`, which the idempotent arm reports as DELETED.
- **A guard that admits a record must open a path that DOES something.** A record reaching a body where every branch is skipped returns `undefined`, i.e. DELETED, so trace it to an AWS call and use the SAME truthiness spelling as the branches downstream.
- **A skip warning's remedy must be true on the path taken.** "Repair state.json and re-run" holds only where the record is kept (destroy, template-removal DELETE), not on a replacement or rollback one.
