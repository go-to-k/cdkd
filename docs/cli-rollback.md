---
title: cdkd rollback
description: "Revert a failed deploy to the last known-good state with cdkd rollback."
---

# cdkd rollback

`cdkd rollback [STACK]` reverts a stack to its pre-deploy state after a deploy
that failed with `--no-rollback`, was interrupted with Ctrl-C, or whose
automatic rollback died partway. It is the cdkd equivalent of `cdk rollback` /
CloudFormation `RollbackStack`, and the third option after such a failure —
next to fixing forward with `cdkd deploy` and cleaning up with `cdkd destroy`.

```bash
cdkd rollback MyStack                         # roll back one stack
cdkd rollback                                 # the single journaled stack, if there is exactly one
cdkd rollback MyStack --force                 # skip the confirmation prompt
cdkd rollback MyStack --orphan MyBucket           # leave a resource out of the replay
cdkd rollback MyStack --revert-failed         # also revert the resource that failed mid-deploy
cdkd rollback MyStack --skip-final-snapshot   # DeletionPolicy: Snapshot -> delete without the snapshot
cdkd rollback MyStack --stack-region us-west-2 # disambiguate a multi-region stack
```

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `[stack]` | — | Stack to roll back. Omit it when exactly one stack has a rollback journal. |
| `--force` | off | Skip the confirmation prompt. `-y` / `--yes` does the same. |
| `--orphan <logicalId>` | — | Skip the resource during replay, like `cdk rollback --orphan`. Repeatable. |
| `--revert-failed` | off | Also attempt to revert the resource whose operation FAILED mid-deploy. |
| `--skip-final-snapshot` | off | Delete a rolled-back CREATE whose `DeletionPolicy` is `Snapshot` without the final snapshot (data loss). |
| `--stack-region <region>` | — | Region of the target stack, when the same name has state in more than one. |
| `--state-bucket <bucket>` | `CDKD_STATE_BUCKET` / `cdk.json` | S3 bucket holding the state records and the journal. |
| `--state-prefix <prefix>` | `cdkd` | S3 key prefix for state files. |
| `--profile <profile>` | — | AWS profile. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | IAM role to assume for AWS API calls. |
| `--verbose` | off | Verbose logging. |

An orphaned CREATE is left in AWS and removed from state; an orphaned UPDATE is
left at its new properties with state kept as-is.

If the journal recorded a `--role-arn` for the failed deploy and you do not pass
one, cdkd prints an informational note — the rollback then runs with ambient
credentials.

A re-created resource gets the physical name the failed deploy would have
given it. The journal records whether that deploy prefixed user-declared names
with the stack name ([`--prefix-user-supplied-names`](cli-deploy-tuning.md#prefix-user-supplied-names)),
and the rollback replays under that setting, so you do not pass the flag again.
A journal written by an older cdkd does not carry the setting. The rollback
then takes it from `CDKD_PREFIX_USER_SUPPLIED_NAMES`, then the `cdk.json` in
the current directory, else the default (no prefix), and prints a warning
saying which setting it chose. If the failed
deploy ran with `--prefix-user-supplied-names`, re-run with
`CDKD_PREFIX_USER_SUPPLIED_NAMES=true`.

The setting can change between deploys. A resource created by an earlier deploy
under the other setting keeps its name, so a rollback that re-creates or
reverts it follows its physical ID instead. This covers IAM roles, users,
groups, instance profiles and managed policies, and ELBv2 load balancers and
target groups — the types whose declared name the setting rewrites. For these,
cdkd uses whichever setting turns the declared name into the name the resource
had (for an ARN, its name segment), and prints a line when that is not the
failed deploy's setting. When neither setting produces it, cdkd keeps the
failed deploy's setting and prints a warning naming the resource, since the
re-created resource may get a different physical name.

## Synth-free

Everything `cdkd rollback` needs lives in cdkd state plus a **rollback
journal** — the exact set of completed operations from the failed deploy,
persisted to `s3://bucket/cdkd/{stack}/{region}/rollback-journal.json` (a
sibling of `state.json`) whenever a deploy ends without a completed rollback.
The command loads that journal and replays it in reverse — deleting created
resources, restoring updated ones to their previous properties — through the
same rollback executor the in-process automatic rollback uses.

No CDK app is needed, which matters because a broken app is a common reason to
roll back in the first place.

## Flow

1. Resolve the target stack and region. With no stack argument, cdkd looks for
   journaled stacks: exactly one is used, several are listed for you to pick
   from, and none is reported as "nothing to roll back".
2. Acquire the stack lock for the whole replay. A concurrent deploy holding it
   fails the command with the standard lock error; `cdkd force-unlock` applies.
3. Load the state record and the journal. A record whose own `region` field
   disagrees with the region of the key it is stored under, while it still
   lists resources, is refused here, before anything is replayed — see
   [State management](state-management.md#directory-layout).
4. Print the plan, one block per journal segment, newest first. A stack name
   or region that is not a plain identifier (which only a hand-written state
   key can be) is described rather than shown in the plan header, the
   confirmation prompt, the completion lines and the nested-stack plan
   lines, with a pointer to `cdkd state list --long` under the header, and
   at the end of each nested-stack block, that described one.
5. Confirm (skipped by `--force` / `-y`).
6. Replay the segments newest-first, saving state after each operation and
   popping each segment once it finishes cleanly.
7. If the oldest replayed segment was the stack's first-ever deploy and state is
   now empty, delete `state.json` too, so `cdkd list` shows no ghost stack.

Replay is idempotent: re-running after a partial rollback skips the resources
that are already reverted.

## `--revert-failed`: revert the resource whose operation failed mid-deploy

By default the resource whose operation FAILED is left exactly as it is, because
its remote state is genuinely unknown — the operation died partway. The journal
still records that operation (its pre-operation state plus the properties the
deploy attempted), and `--revert-failed` opts into acting on it:

| Failed operation | With `--revert-failed` |
| --- | --- |
| UPDATE | Force-reverted to its pre-deploy properties. The journal records the *attempted* properties, so patch-based providers generate a real undo diff. |
| UPDATE that changed the resource's `Type` | Skipped with a warning; it was a replacement in flight, and there is no in-place revert of one. |
| CREATE that recorded a physical id | Deleted, honouring its `DeletionPolicy` — see [DeletionPolicy on a rolled-back CREATE](#deletionpolicy-on-a-rolled-back-create). |
| CREATE that recorded no physical id | Skipped with a warning; there is nothing addressable to act on. A CREATE cdkd refused before anything was applied (another resource already holds its explicit name) is not journaled at all. |
| DELETE | Nothing to do — the resource is still in place. |

The action only engages when AWS actually provisioned the resource: it requires
both a recorded physical id and a matching state record, so the policy is never
applied to a resource that never existed.

Each handled failed operation is stripped from its journal segment immediately.
A later failure that keeps the segment for a re-run therefore re-attempts only
what is genuinely outstanding, never a revert that already succeeded.

A refusal here is recoverable rather than final. The operation stays in the
journal, so once a half-created resource settles into a snapshot-capable state —
an RDS instance rejects a final-snapshot delete while it is `creating` — a re-run
completes it. `--skip-final-snapshot` is the opt-out if you would rather drop
the data.

After a **clean automatic** rollback the journal is settled to a failed-only
segment: the completed operations are already reverted, but the failed
resource's record is kept, so `cdkd rollback --revert-failed` works in the
default deploy flow too. A plain `cdkd rollback` on such a journal is a no-op
replay that clears it; the next successful deploy also deletes it. An
automatic rollback that failed or skipped an operation is not clean and keeps
the full segment instead.

## Known limitations

These are surfaced in the plan rather than applied silently.

- A resource **DELETED** during the deploy cannot be restored, the same as under
  CloudFormation. Deletes run after creates and updates, so a typical mid-deploy
  failure has not deleted anything yet.
- The resource whose operation **failed** is left as-is unless you pass
  [`--revert-failed`](#revert-failed-revert-the-resource-whose-operation-failed-mid-deploy).
- **Replacements** are reverted by reversing the replacement — see below.
- Reverts that reference old **asset objects** (a Lambda `Code.S3Key`, for
  instance) need those objects to still exist, which is what `cdkd gc`'s
  retention window protects.
- A rolled-back CREATE's **`DeletionPolicy`** governs its delete — see below.
- A **nested stack** row is reverted by replaying the child stack's own
  journal for the same deploy run, so no CDK app is needed; the plan lists
  that replay under the row.
  - **No record for the run** (an older cdkd wrote the journal, or it was
    removed by hand): the row fails and the journal is kept for a re-run.
  - **The child replay skipped an operation**: the row is reported partial,
    the rollback exits 2, and the record is kept.
  - **The child's own deploy failed** in that run: a plain rollback of the
    parent refuses while the child's journal holds that run's completed
    operations. `--revert-failed` replays them in order; the child's failed
    resource then needs `cdkd rollback <parent>~<child> --revert-failed`.
  - **A direct rollback of the child** is refused while its parent's journal
    still holds the run, while that journal cannot be read, or while the
    top-level stack is locked by a running deploy; the message names the
    top-level stack to roll back. A record whose run the parent no longer
    holds is listed in the plan and discarded after you confirm, so it cannot
    block the child's own rollback.
  - Run without a stack name, `cdkd rollback` does not offer a child's
    journal separately when its parent has one.
  - A secret reference that names no region (a Secrets Manager or SSM
    parameter NAME rather than an ARN) is refused, not re-resolved, when the
    parent or any stack above it reads a value from another region: the
    parent may have supplied it from there. A direct rollback of the child
    cannot see those regions, so it refuses every such reference. The
    operation fails and the journal is kept; set the property yourself, or
    spell the reference as a full ARN.
- An **IAM inline policy name** moved between resources on one role, group or
  user in the failed deploy (two `AWS::IAM::Policy` resources swapping names, or
  a policy renamed away from a name the role's own `Policies` took) is kept by
  each revert that would remove it once another revert of the same rollback has
  put it back. A policy CREATED under a name another policy still held is
  deleted with that name, so the other policy loses its grant until it next
  changes or `cdkd drift --revert` runs.
- A re-run after a snapshot succeeded but its delete failed **re-snapshots** the
  name-keyed types (Redshift, ElastiCache), which resume only an in-flight
  snapshot. EBS volumes are reused via their `cdkd:final-snapshot-of` tag. The
  rollback replay is the flow most likely to be re-run, so expect a second
  snapshot charge on those two types.

### Reversing a replacement

A replacement is undone by reversing it: the old resource is re-CREATEd from its
journaled pre-deploy state, and the new resource is deleted unless its own
`UpdateReplacePolicy: Retain` says otherwise (see below). The default order is
create-first; when a user-supplied physical name is still held by the new
resource, cdkd falls back to delete-new-first with a bounded name-release retry.

cdkd deletes the new resource first only when it can show that the new
resource holds the name the re-create collided on:

- **An explicit name** matches when the new resource's state record has the
  same name property, spelled exactly alike (case is ignored only where the
  service ignores it, such as IAM and RDS names), under the same parent (such
  as the event bus of a rule or the database of a Glue table), or when its
  physical id names it. For a Route 53 record, the DNS name and hosted zone
  must match.
- **A name cdkd generates** (the template names none) matches only through the
  new resource's physical id, and only for a type whose generated name cdkd
  knows exactly. That is the name a Cloud Control re-create sent, or one of the
  SDK providers checked to send cdkd's rule unchanged.
- **IAM roles, users, groups, instance profiles and managed policies, and ELBv2
  load balancers and target groups** turn even an explicit name into a
  different name before sending it: a stack-name prefix that
  `--prefix-user-supplied-names` controls, and a character rewrite. For
  these, cdkd works out the name this re-create actually sent (under the
  setting it chose, above) and matches it
  only against the new resource's physical id. A matching recorded name is not
  enough.

A collision with anything else (a resource an earlier failed attempt left
behind, or one created outside the stack) fails the operation instead: nothing
is deleted, the message names the colliding name, and the journal is kept. The
same refusal applies when cdkd cannot tell. That happens when the re-create
asked for no name cdkd can derive, the name is redacted or empty, the new
resource's state record and its last read-back name it differently, the type has
no name property cdkd knows, or a `Type` change pairs types cdkd does not know
to share names. Remove or rename whatever holds the name, then re-run
`cdkd rollback`. If the holder is the new resource itself, delete it by hand
and re-run: the rollback then proceeds. Or pass `--orphan <logicalId>` to leave
that resource alone.

When the replacing deploy left the old resource alive — it declared
`UpdateReplacePolicy: Retain` at the time — the old resource is simply
re-adopted instead of being re-created, a true clean revert. cdkd reads that
verdict from what the deploy actually DID, recorded on the rollback journal,
rather than re-deriving it from the previous state record: the two answers
differ on the deploy that adds or removes the attribute, and either direction
of the disagreement is destructive (adding it made the rollback re-create a
resource that was still running; removing it made the rollback point state at a
resource that had just been deleted).

**`UpdateReplacePolicy: Retain` also protects the NEW resource from the
rollback.** If the resource the replacement created declares it, the rollback
does not delete that copy: it is left running and dropped from state, and the
run reports it with a `⚠` warning and exits 2. The survivor's physical id is
also recorded durably in the deployment events (`cdkd events`), which carry it
as a field next to the layer that manages it — a rollback runs during an
already-failing deploy, so the terminal is the least likely place the id still
is, and state deliberately no longer names the resource. Note what that means for the
re-adopt case above: the attribute that made the deploy retain the old resource
is the same one recorded on the new resource, so a rollback that re-adopts the
old copy never deletes the new one either — both survive, and state names the
old one. This matches CloudFormation,
which reports `DELETE_SKIPPED` for the new copy and orphans it out of the stack
(`DeletionPolicy` has no effect here — only `UpdateReplacePolicy` does; both
were measured against real CloudFormation, since the AWS documentation does not
state it). One combination cannot be honoured and is refused instead: when the
old resource's re-create collides with a physical name the retained new
resource still holds, cdkd will not delete the pinned resource to free the
name, so the operation fails with the conflict named and the journal is kept —
delete the new resource yourself, or drop `UpdateReplacePolicy: Retain`, then
re-run `cdkd rollback`.

**Data caveat.** This applies to a stateful type (DynamoDB, RDS, S3 and so on)
replaced **without** `UpdateReplacePolicy: Retain` — under `Retain` the old
resource is re-adopted with its data, as described just above. On the plain
arm the old resource's data was destroyed by the replacement and is not
recovered by the rollback: the re-created resource starts empty. The replay
warns loudly on that arm only, and the plan labels these items
"reverse-replace".

**Type changes.** A replacement that changed the resource's `Type` is reversed
through both types: the old resource is re-created by its own type's provider
and the new one deleted by its own, and the plan shows the pair as
`from NEW to OLD`. An operation whose old type the journal cannot name is shown as
`(REFUSED)` and fails on replay with the journal kept — see
[Type changes on an existing logical id](cli-deploy-safety.md#type-changes-on-an-existing-logical-id).
`--revert-failed` skips a failed `Type` change with a warning: that operation
was a replacement in flight, and there is no in-place revert of one.

### DeletionPolicy on a rolled-back CREATE

The delete of a rolled-back CREATE follows its `DeletionPolicy`, matching
CloudFormation:

| `DeletionPolicy` | What the rollback does |
| --- | --- |
| `Retain` | Leaves the resource in AWS and moves it into a rollback-orphan record a later deploy can re-adopt. The plan labels it `orphan`. |
| `Snapshot` | Takes the final snapshot, then deletes. A shape cdkd cannot snapshot is refused as a per-operation failure, and the journal is kept. |
| `RetainExceptOnCreate`, `Delete` | Deletes plainly. |
| absent | CloudFormation's default: `Snapshot` for an `AWS::RDS::DBCluster` or a standalone `AWS::RDS::DBInstance`, otherwise a plain delete. |

The plan preview says which of these will happen **before** you confirm. A shape
cdkd cannot snapshot on the route the delete will take is labelled
`cdkd cannot snapshot this resource; the rollback will REFUSE it` rather than
promising a final snapshot. `--skip-final-snapshot` opts out of the snapshot
entirely; the per-type mechanism and the refusal rules are the same ones
[`cdkd destroy`](cli-destroy.md#deletionpolicy-snapshot-final-snapshots-on-delete-skip-final-snapshot)
documents.

The same matrix governs `--revert-failed`'s delete of a CREATE that failed
in-flight, so `Retain` does not delete what the policy says to keep and
`Snapshot` does not destroy the data un-snapshotted.

## Interaction with `cdkd export`

`cdkd export` refuses — behind a confirmation gate — to hand a stack over to
CloudFormation while a rollback journal exists. The half-deployed state is
almost certainly not what you want exported; roll back or re-deploy first.

## Interaction with `cdkd import`

Before it writes state, `cdkd import` marks each resource it adopts on every
journal segment that holds an operation for it. A resource is matched on its
logical id and on the physical id the import records. The rollback leaves
those operations alone, failed ones included under `--revert-failed`, and the
plan lists each one as `adopted by cdkd import after this deploy, left as it
is`.

Two cases still go through the ordinary replay:

- An operation of the same logical id that recorded a different physical
  resource, for example an auto-named resource the deploy created before you
  imported another one under that id. A completed operation plans and warns
  as usual. A failed one is not reverted under `--revert-failed`, because the
  record now names another resource.
- An id you pass to `--orphan`, which is honoured.

The mark matters for a resource with an explicit name, whose physical id is
that name. A resource re-created by hand under the same name and imported
would otherwise match the journal's CREATE, and the rollback would delete it.

Segments that later deploys add carry no mark, and their operations replay as
usual. If the import cannot read or write the journal, it refuses and writes
no state.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Fully clean. The journal is deleted. |
| `1` | Hard error: no journal for the named stack, several journaled stacks and no stack argument, the lock held by another run, a journal written by a newer cdkd, credentials, and so on. |
| `2` | Partial: one or more operations failed, or the run was interrupted, and the journal is kept so you can re-run; or an operation was skipped with a warning, which a re-run would skip again, so its segment is cleared and the skip is recorded as a `ROLLBACK_RESOURCE_SKIPPED` event (`cdkd events`); or an operation was reverted but left a resource cdkd no longer tracks (a new copy retained by `UpdateReplacePolicy: Retain` or one whose delete failed) or was not fully reversed (a reverse-replacement whose re-create returned the live new resource), recorded as a `ROLLBACK_RESOURCE_SUCCEEDED` event carrying a `reason`. |

A bare `cdkd rollback` on an account where **no** stack has a journal is not an
error: it prints "nothing to roll back" and exits `0`. Declining the confirmation
prompt also exits `0`; reaching that prompt on a non-interactive stdin does not —
it refuses with `NON_INTERACTIVE_CONFIRM` and exits `1`. Pass `--force` (or `-y`
/ `--yes`) instead of piping `y` in.

Ctrl-C (or SIGTERM, which is routed through the same path) stops the replay after
the current operation, leaves the journal in place and exits `2`.

The full cross-command table is in the [CLI Reference](cli-reference.md#exit-codes).

## Related

- [Rollback](rollback.md) — how automatic and manual rollback fit together
- [Destroy flags & guards](cli-destroy.md) — the other way out of a failed deploy
- [State Management](state-management.md) — state records, locks, and force-unlock
- [`cdkd gc`](cli-gc.md) — the asset retention a replay depends on
- [Troubleshooting](troubleshooting.md) — what to do when a rollback fails
