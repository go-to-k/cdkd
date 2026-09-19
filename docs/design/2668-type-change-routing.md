---
title: "A resource `Type` change routes each half of the replacement on its own type — Design"
unlisted: true
---

# A `Type` change routes each half of the replacement on its own type

Issues [#2668](https://github.com/go-to-k/cdkd/issues/2668) and
[#3036](https://github.com/go-to-k/cdkd/issues/3036).

## The defect

`DiffCalculator` emits a resource whose `Type` changed on an existing logical id
as an `UPDATE` carrying the TEMPLATE's (new) type plus a synthetic
`{ path: 'Type', requiresReplacement: true }` row. The deploy engine bound that
one type and used it for BOTH halves of the replacement, pairing it with the
state record's provisioning layer. Three consequences:

- the OLD resource's delete was dispatched at the NEW type's provider: a loud API
  error, a silent leak, or — where the two types' physical-id namespaces overlap
  (a log group and a Lambda function are both addressed by a bare name) — the
  deletion of an unrelated live resource;
- every guard keyed on type evaluated the wrong one, so a stateful old type
  escaped `--force-stateful-recreation` whenever the new type was not stateful;
- the rollback journal recorded only the new type, so reversing the replacement
  re-created the old resource through the new type's provider.

Separately (#3036), the UPDATE arm's no-op re-check compares properties only and
runs before anything reads the `Type` row. Two types declaring identical
property bags were skipped under a green deploy, leaving AWS and the record on
the old type.

## The rule

**A replacement has two types. Everything aimed at the OLD physical resource
routes on the STATE record's `resourceType` and `provisionedBy`; everything aimed
at the new one routes on the template's type.** A recorded type that differs from
the template's is always a replacement — never an in-place update, never a no-op.

### Deploy engine (`provisionResourceBody`, `case 'UPDATE'`)

`oldResourceType = currentResource.resourceType`, `typeChanged = oldResourceType
!== resourceType`.

| site | routes on |
| --- | --- |
| no-op skip, and the attribute-only branch nested in it | gated on `!typeChanged` |
| `propertyDrivenReplacement` | `typeChanged \|\|` the diff's rows — read from the record, so a change shape without the `Type` row cannot reach the in-place arm |
| `isStatefulRecreateTargetForReplace` | old type |
| `oldDeleteProvider` | old type + recorded layer |
| `prepareFinalSnapshotForDelete`, all replacement sites | old type |
| every `oldDeleteProvider.delete(...)` (`--recreate-via-*`, the `--replace` delete-first helper, the post-create cleanup) | old type |
| `replaceDecision`, every `create`, the new record, `kickOffObservedCapture` | template type |
| the two name-idempotent-create guards (`createResult.physicalId === currentResource.physicalId`) | skipped only when `equalIdIsSameResource` is false (below) |
| the live-progress verb / routing tag | mirrors the dispatch's `typeChanged` |

The name-idempotent guards read an equal physical id as "the Create API handed
back the existing resource". Within one type that is right. Across two types it
is a coincidence of two namespaces — the create was genuine, and the old resource
still has to be deleted through its own provider — but ONLY when the two halves
are served by different providers, or by Cloud Control, which addresses a
resource by type AND identifier. ONE SDK provider serving both types is one
namespace: every `Custom::*` type and `AWS::CloudFormation::CustomResource` route
to `CustomResourceProvider`, where a handler returning the same
`PhysicalResourceId` for `Custom::Foo` and `Custom::Bar` names the SAME resource,
and "deleting the old one" would send `Delete` for what the create just built.
So the predicate is `equalIdIsSameResource = !typeChanged || (oldDeleteProvider
=== replaceProvider && layer !== 'cc-api')`, and the guards stay live whenever it
holds. Unsure reads as "same": the guard then refuses loudly instead of deleting.
The rollback's "adopted the live new resource" shortcut uses the same predicate
over its create provider and its delete-new provider (an unresolvable delete
provider reads as "same", which keeps the non-destructive adopt).

The create-first name-collision fallback (`--replace` delete-first) is kept for a
Type change. Cross-type namespaces do exist (RDS, Neptune and DocumentDB share
one DB-cluster identifier space), and with the delete routed on the old type the
fallback is correctly aimed.

The in-place arm and its update-failure replacement fallback are unreachable for
a Type change and were left alone.

### Rollback journal

`CompletedOperation.previousResourceType` — the state record's type, stamped on
every completed UPDATE that had a previous record. ADDITIVE, no `journalVersion`
bump, following `oldResourceRetained` and `failedOperations`: an older binary
ignores it, and the rollback journal is not part of the state schema, so
`StackState.version` is untouched. `parseRollbackJournal` refuses a non-string.

### Rollback executor

`resolveReplacementOldType(op)` is the one reader. It takes the stamped field,
falls back to `previousState.resourceType` (journaled by every binary, inside the
previous record), and REFUSES rather than guessing when:

1. neither source names a type — falling back to `op.resourceType` is exactly the
   single-type assumption being replaced;
2. the two sources disagree;
3. the types differ with `AWS::CloudFormation::Stack` on either side (see below).

A refused op classifies as `refuse-replacement-routing`, placed after the
idempotent skips (an already-reverted op needs no routing). The replay THROWS
`ROLLBACK_REPLACEMENT_UNROUTABLE`, which the per-op catch counts as a failure —
so the segment is kept, where a warning would pop it and discard the only record
of the op. Nothing is called in AWS and state is untouched; `--orphan <id>` lets
the rest of the rollback past it.

Classification is type-aware: `isReplacementOp` is true for a changed type even
when the physical id is unchanged (otherwise an overlapping-namespace Type change
would take the in-place `revert` arm), and "state already points at the old id"
additionally requires the record to be the old type. In the `reverse-replacement`
arm the re-create, its fallback name and the stateful data warning use the old
type; the delete of the new resource keeps `op.resourceType`; the
"adopted the live new resource" shortcut follows `equalIdIsSameResource` above.
The auto-named "already reverted" recognition (equal property bags) also requires
the record to be the old type, since two types can declare one identical bag.

`--revert-failed` on a failed Type change is classified `skip-failed-type-change`:
that arm is an in-place `update()` routed on the new type against the old
physical id, and there is no in-place revert of a replacement.

## What stays refused: the nested-stack pair

PR [#2674](https://github.com/go-to-k/cdkd/pull/2674) refused a Type change into
or out of `AWS::CloudFormation::Stack` because `NestedStackProvider.delete`
ignores the physical id it is handed and derives `<parent>~<logicalId>`. With the
delete routed on the old type that specific mis-aim is gone, and the refusal is
KEPT anyway:

- the replacement path deletes its old half as a best-effort cleanup step whose
  failure is a warning. For a nested row that strands a whole child stack and its
  state record under a deploy that reports success;
- the into-nested direction runs a whole child-stack deploy as one row of a
  replacement, which no test or fixture has entered;
- neither direction has been exercised against real AWS.

The guard's message and rationale were rewritten to say this rather than describe
a mis-route that no longer happens. The rollback refuses the same pair per op
(shape 3 above): only a journal from a binary older than the guard can carry one,
and what that deploy left behind is not knowable from the journal.

## `cdkd diff`

Not changed here. The row already renders `Type: old -> new [requires
replacement]`. Its routing annotation (`collectCcApiRoutes`) still pairs the
template's type with the OLD record's sticky layer for a replaced row, which the
deploy does not do; that lives in `src/cli/commands/diff-recursive.ts`, held by
another open PR when this landed, and is issue
[#3453](https://github.com/go-to-k/cdkd/issues/3453).

## Verification

`tests/unit/deployment/deploy-engine-type-change-routing.test.ts` and
`rollback-executor-type-change-routing.test.ts` use a registry double that hands
out one provider PER TYPE — with a single shared provider "delete was called" is
satisfied by the very mis-route being fixed. The real-AWS fixture
`tests/integration/type-change-replacement/` moves three rows across a Type
change (a stateful old type, two types sharing one bare-name physical id, and two
types with identical property bags) forward, through the automatic rollback, and
through `cdkd rollback`.
