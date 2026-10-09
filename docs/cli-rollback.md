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
cdkd rollback MyStack --drop-failed MyQueuePolicy # forget one failed CREATE cdkd can never delete
```

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `[stack]` | — | Stack to roll back. Omit it when exactly one stack has a rollback journal. |
| `--force` | off | Skip the confirmation prompt. `-y` / `--yes` does the same. |
| `--orphan <logicalId>` | — | Skip the resource during replay, like `cdk rollback --orphan`. Repeatable. |
| `--revert-failed` | off | Also attempt to revert the resource whose operation FAILED mid-deploy. |
| `--drop-failed <logicalId>` | — | Remove one journaled failed CREATE that made its resource from the journal, after you check that resource by hand. Replays nothing and deletes nothing in AWS. See [below](#dropping-one-entry-cdkd-cannot-act-on). |
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

An operation whose resource cdkd cannot address is skipped with a warning
(exit `2`): its state record's `physicalId` (for a rolled-back CREATE, the
journaled one) is absent, empty, whitespace-only or not a string. Only a
hand-edited or torn `state.json` or journal has that shape. Nothing is sent to
AWS for it, and the resource and its record are left as they are; repair the
record's `physicalId` (`cdkd state show`) and re-converge with `cdkd deploy`. A
failed CREATE that no state record holds is named for manual attention
instead, since the journal entry was its only record. A nested stack's record
is exempt, since its child is found by name, unless it is recorded on Cloud
Control. A replacement whose new copy is kept (`UpdateReplacePolicy: Retain`)
sends nothing by that id and is reverted as usual. One case fails instead of
skipping (exit `1`, journal kept): re-adopting a retained old resource, which
only the journal names. When the journal holds a usable id for the
replacement's new resource, the message prints it: repair the record to that id
and re-run the rollback (any other id stops the revert and drops the journal's
only record of the retained old resource). When the journal holds
none, the re-run deletes whatever resource the repaired record names as the new
copy, so name the right one. When the journal's id is present but unusable too, or the record
holds a different id, nothing proves which resource is the new copy, so it is
not deleted and no repair makes the re-run succeed. Check both resources by
hand. Re-running with the `--orphan` command the message prints leaves it as it
is, but also drops the journal's only record of the retained old resource, so
note the old id the message names first. The same
applies to `--revert-failed` and to the automatic rollback.

## `--revert-failed`: revert the resource whose operation failed mid-deploy

By default the resource whose operation FAILED is left exactly as it is, because
its remote state is genuinely unknown — the operation died partway. The journal
still records that operation (its pre-operation state plus the properties the
deploy attempted), and `--revert-failed` opts into acting on it. The one
exception is a CREATE that made its resource and then failed: the journal is the
only record of that resource, so every rollback acts on it, with or without the
flag (see [Failed CREATEs that made their resource](#failed-creates-that-made-their-resource)).

| Failed operation | With `--revert-failed` |
| --- | --- |
| UPDATE | Force-reverted to its pre-deploy properties. The journal records the *attempted* properties, so patch-based providers generate a real undo diff. |
| UPDATE that was a replacement whose new resource was made and then failed (journaled beside it, see below) | Never force-reverted: the update applied nothing to the old resource. When the replacement created first, the old resource is untouched and nothing is done. When it deleted the old resource first, the rollback warns (exit `2`) that the resource state still records is gone; a deploy whose template still replaces it creates it again (one whose template was reverted to the old properties sees no change and does not), and a `cdkd destroy` drops the record. The new resource's own entry is acted on, and this one is cleared with it on every path, so a later `--revert-failed` never sees it alone. |
| UPDATE that changed the resource's `Type` | Skipped with a warning; it was a replacement in flight, and there is no in-place revert of one. |
| UPDATE whose state record has no usable `physicalId` (a `cdkd deploy` refusal over a hand-edited record still journals the op) | Skipped with a warning (exit `2`); nothing is sent. See [above](#flow) for the remedy. |
| CREATE that recorded a physical id, which state still records | Deleted, honouring its `DeletionPolicy` — see [DeletionPolicy on a rolled-back CREATE](#deletionpolicy-on-a-rolled-back-create). |
| CREATE that made its resource and then failed (the provider proved its create call returned, e.g. a Kinesis stream whose retention follow-up AWS rejected) | Deleted, honouring the template's `DeletionPolicy` as journaled — this entry is the only record of that resource. Under `Retain` it is left in AWS with no rollback-orphan record (it was never in state), so a later deploy cannot re-adopt it. Deleted only while nothing later can own it. It is skipped with a warning naming the physical id (exit `2`), since the resource may still exist untracked and need manual attention, when a NEWER journal segment holds an operation of its type naming its physical id or previous physical id, or a completed CREATE of its type; when a later segment's removal superseded its logical id; or when a rollback-orphan record holds its logical or physical id. Otherwise state decides: a state resource under its logical id with the same physical id, or one of its type holding that physical id under another logical id, tracks it and the skip is silent; a different physical id under its logical id warns (exit `2`), unless that record is the resource a replacement was replacing (see below). When the entry is one a successful fix-forward deploy kept (a delete that failed, or an S3 bucket it never empties), `cdkd rollback` and `cdkd destroy` first ask the provider again whether that record is another resource, and the preview shows the answer: proven, the entry is deleted while its creation identity still matches, or dropped when the resource is already gone; unproven, it is warned about as above. A redeploy whose create only collided with its name does not stop the delete. Roll the stack back before redeploying: a redeploy that re-creates the same name, or under `--no-rollback` completes any CREATE of its type, makes the newer entry decide, and this one is then only warned about. SDK providers whose create makes a follow-up call after their create call returned prove it where the id is known and the create made the resource (an adopted or pre-existing resource is never marked), unless their own cleanup already deleted it (`AWS::IAM::Policy` instead removes its own writes and warns when that fails). |
| CREATE that recorded a physical id, with no state record left | Nothing to do — already cleaned up (a re-run). |
| CREATE that recorded a physical id other than the one state now records under its logical id (not the record a replacement was replacing — see below) | Skipped with a warning (exit `2`); nothing is deleted. The resource it recorded may still exist, untracked: the plan line names it (`recorded <its physical id>, which is not the resource state tracks under this id; not reverted, needs manual attention`). Reached when another resource took the id without an import mark, such as a `cdkd import` by an older cdkd, or when a newer segment's reverted replacement re-created the resource under a new physical id (the recorded one is then usually already gone); a marked import is reported as in [Interaction with `cdkd import`](#interaction-with-cdkd-import). |
| CREATE that recorded no physical id | Skipped with a warning; there is nothing addressable to act on. A CREATE cdkd refused before anything was applied (another resource already holds its explicit name) is not journaled at all. |
| DELETE | Nothing to do — the resource is still in place. |

The action only engages when AWS actually provisioned the resource: it requires
a recorded physical id and either a matching state record or the provider's
proof that its create call returned, so the policy is never applied to a
resource that never existed. The physical id a failed create's error names is
not such proof on its own: it is also the name of a resource the create
collided with.

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
default deploy flow too. A plain `cdkd rollback` on such a journal clears it,
acting only on a failed CREATE that made its resource (see below; an automatic
rollback handles that one itself, so this arises only for a segment an older
cdkd wrote); the next successful deploy also acts on it (see the table below). An
automatic rollback that failed or skipped an operation is not clean and keeps
the full segment instead.

### Failed CREATEs that made their resource

A CREATE whose provider proved the resource was made before the failure (the
table row above) has no state record. The rollbacks, `cdkd destroy` and a successful deploy act
on its journal entry before they drop it, as CloudFormation's rollback deletes a
failed CREATE:

| Path | What happens to the resource |
| --- | --- |
| Automatic rollback | Deleted before the completed operations are reverted, per its `DeletionPolicy`. |
| `--no-rollback` failure | Nothing is deleted; the journal keeps the entry for a later `cdkd rollback`. |
| `cdkd rollback`, with or without `--revert-failed` | Deleted, per its `DeletionPolicy`. Other failed operations still need the flag. |
| `cdkd destroy` | Deleted first, per its `DeletionPolicy`, before the journal is removed with the state. A journal destroy cannot read is warned about and removed with the state, and nothing it records is deleted. |
| A later successful `cdkd deploy` | Deleted, per its `DeletionPolicy`, before the deploy removes the journal, but only when, after the deploy, no state record sits under its logical id and the deploy completed no operation under it (or the record under it holds a resource that a live read proves is a different one, see below), no record of the stack holds a resource of its type under its physical id, and no resource or rollback-orphan record of any other stack under the same state prefix does. A record of the stack holding that very resource tracks it, and the entry is dropped silently. Otherwise it is not deleted: the deploy warns, naming its physical id so you can delete it if it is not that record's resource, removes the entry with the journal, and exits `2`. A fix-forward that keeps the logical id under another name puts a new resource there: for an `AWS::Kinesis::Stream`, the deploy reads both streams live and deletes the earlier one when it is proven a different stream (never when it shares the record's name, when the record's stream is not found, or when a read fails; an earlier stream already gone is named at info and nothing is deleted), and a read proving it the same resource tracks it, silently. An `AWS::EC2::NatGateway` or `AWS::EC2::EIP` is compared the same way, by its `nat-` id or `eipalloc-` allocation id; an earlier one already gone (or a NAT gateway its create left `failed`) is still sent the delete, which finds it gone or removes it. An `AWS::RDS::DBCluster` or `AWS::RDS::DBInstance` is compared by its resource id (`DbClusterResourceId` / `DbiResourceId`); an identifier that differs from the record's only in case names the same resource, since RDS identifiers are case-insensitive. An `AWS::DocDB::DBCluster` or `AWS::DocDB::DBInstance` is compared the same way; an identifier now held by an RDS or Neptune resource, which share the namespace, is never read as the DocumentDB one, so it lands in the warning above. An `AWS::Neptune::DBCluster` or `AWS::Neptune::DBInstance` is compared the same way; an identifier now held by an RDS or DocumentDB resource is never read as the Neptune one, so it lands in the warning above. An `AWS::S3::Bucket` is compared by name: bucket names are global and cannot be changed, so two names are two buckets, once the record's bucket reads back in the stack's region. A bucket a failed CREATE left behind is never emptied on any of these paths, even when its template declared `autoDeleteObjects`: one that is not empty (something wrote to it after that create) is kept, named in a warning, and stays in the journal. An RDS or Neptune cluster or instance that Cloud Control provisioned is never compared, and lands there too. Every other type, and any read that cannot prove either way, lands in the warning above, so the earlier attempt's resource is left for you to delete. On either path, before the delete, a type whose physical id is a name (most types) must also prove that the resource now answering to that name is the one the failed CREATE made, since you may have deleted it and something else may have reused the name: the failed deploy records the provider's identity for it (for an `AWS::Kinesis::Stream`, its ARN and creation time; for an RDS, DocumentDB or Neptune cluster or instance, its resource id; for an `AWS::S3::Bucket`, its name, region and the `CreationDate` this account's `ListBuckets` reports; outside us-east-1 S3 moves that date on a later versioning, tagging, encryption or policy change, which leaves the bucket in the warning above), and the deploy deletes it only when a live read returns the same identity; one a live read reports gone is named at info, nothing is deleted, and its entry is dropped. With no recorded identity (a provider without one, a read that failed, or a journal an older cdkd wrote), or a different one, it lands in the warning above. Types whose physical id AWS generates and never reuses (an EC2 `vpc-` / `nat-` / `sg-` id, an EFS or FSx file system, a KMS key, an ELBv2 ARN, and similar), an `AWS::SQS::QueuePolicy` / `AWS::SNS::TopicPolicy`, whose delete compares the policy it finds, and a nested stack, whose id only cdkd mints, need no recorded identity. A top-level deploy does the same for each nested stack's journal, judged by that stack's record. A journal the deploy cannot read is warned about and removed, and nothing it records is deleted. |

A **replacement** whose new resource was made before the failure is journaled
the same way, beside the replacement's failed UPDATE, and every path above acts
on it. The state record under its logical id is then the resource the
replacement was replacing; while that record still names the same resource, it
does not count as an owner of the new one, and acting on the new one leaves it
in place. A record naming anything else still skips the new resource with a
warning.

Wherever a path above asks whether a record holds the resource under its
physical id, a type whose identifiers AWS matches regardless of case compares
them that way: a record holding `mycluster` (a `cdkd import` that spelled it
so, say) holds the cluster the journal names `MyCluster`, and the resource is
kept. These are RDS, DocumentDB and Neptune DB clusters, DB instances and
subnet groups, ElastiCache cache clusters and subnet groups, IAM roles, users,
groups, instance profiles and managed policies, and a Glue table (ASCII
letters only). Every other type compares the id exactly.

An `AWS::SQS::QueuePolicy` or `AWS::SNS::TopicPolicy` that wrote its
policy to some queues or topics and then failed is journaled under exactly
those queues or topics. When any path above deletes it, each queue is cleared, and each topic
reset to SNS's default policy, only while its policy still matches, by
content, the document the failed create attempted (secret references in it
are resolved first). A topic already on its default policy needs nothing. A
queue or topic whose policy was replaced by a different policy is left as it
is, with a warning naming it, and the rollback or deploy exits `2`;
`cdkd destroy` warns only. A successful deploy also leaves, the same way, a
queue or topic that one of its own policies just wrote, because the service
can still return the old policy for a while (SQS documents up to 60 seconds).
A queue or topic that reads back with no policy at all is cleared. The
comparison treats some IAM-equivalent spellings as equal (a bare account id
and its root ARN, a one-element list and its value, a `"*"` principal and
`{"AWS": "*"}`): SQS stores a bare account-id principal as
`arn:aws:iam::<id>:root`. When the document is missing or masked, or a
secret it references does not exist or cdkd refuses it for good, nothing is
cleared, the warning lists every queue or topic to check by hand, and the
entry is settled with exit `2`. Any other failure to read a policy or
resolve a secret (credentials, access, throttling, the network, an ambiguous
reference region in a nested stack's replay) keeps the entry, and the delete
counts as failed, for a re-run once that is fixed.

`Retain` keeps the resource in AWS and `Snapshot` takes the final snapshot, as
in the table above, and the same ownership checks skip it with a warning. A
delete that fails keeps the entry: the automatic rollback keeps its full
segment, and `cdkd destroy` keeps the state and the journal for a re-run. A
successful deploy keeps the entry only when it could not act on it (a delete
that failed, an interrupt, or a state record it could not read, or a legacy
record with no region, anywhere under the state prefix); it keeps the
journal (reduced to that entry where it can), warns, and exits `2`
(`--allow-unaddressed` exits `0`), and the next successful deploy retries it.

### Dropping one entry cdkd cannot act on

When such a delete fails for a cause you cannot fix (a secret or KMS key you
cannot read, a policy that denies the delete), every `cdkd deploy` keeps
exiting `2` and every `cdkd destroy` keeps the state. Their warnings then
print a command per entry whose delete failed:

```bash
cdkd rollback MyStack --stack-region us-east-1 --drop-failed MyQueuePolicy
```

It prints the entry (its physical id, and for a queue or topic policy the
queues or topics it was attached to, with a name derived from a secret masked)
and asks for confirmation (`--force` / `-y` skip it; without a terminal it is
refused). On `y` it removes that entry from the journal, with the failed
replacement UPDATE journaled beside it, under the stack lock, and keeps every
other entry. It replays nothing and deletes nothing in AWS: check the resource
by hand, and delete it yourself if it should not stay. After the drop no cdkd
command acts on it. A state record that cannot be read refuses the drop, since
it is what masks the printed names.

It refuses, changing nothing, an id the journal does not hold, a completed
operation (use `--orphan`), a failed operation of any other kind or one a
newer journal entry may own (neither blocks `cdkd deploy` or `cdkd destroy`), an id with more than one such entry
(remove the one you mean from `rollback-journal.json` by hand), and
`--orphan`, `--revert-failed` or `--skip-final-snapshot` beside it.

## The same stack name under another state prefix refuses the rollback

`cdkd rollback` refuses, under the lock and before the plan, the prompt or any
replay, when the state bucket also records the stack and region under another
`--state-prefix`. The replay deletes what the failed deploy created,
and for such a pair a create can have been handed the other deployment's
resource. Drop the record you are not keeping with the `cdkd state orphan ...
--state-prefix <prefix>` command the refusal prints and re-run. See
[One stack name per account and region](state-store.md#one-stack-name-per-account-and-region).
The answer comes from the stack's registry marker in the state bucket; if S3
denies it, the rollback warns and falls back to listing the bucket's prefixes.

## Known limitations

These are surfaced in the plan rather than applied silently.

- A resource **DELETED** during the deploy cannot be restored, the same as under
  CloudFormation. Deletes run after creates and updates, so a typical mid-deploy
  failure has not deleted anything yet.
- The resource whose operation **failed** is left as-is unless you pass
  [`--revert-failed`](#revert-failed-revert-the-resource-whose-operation-failed-mid-deploy),
  except a [failed CREATE that made its resource](#failed-creates-that-made-their-resource),
  which every rollback acts on.
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
    resource then needs `cdkd rollback <parent>~<child> --revert-failed`, or a
    plain `cdkd rollback <parent>~<child>` when it is a failed CREATE that made
    its resource, which a plain rollback deletes too.
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
  put it back. When a revert or delete removes a name another resource's state
  record still holds on that principal (a policy CREATED under a name another
  policy still held, say), the rollback puts back the document that record
  holds in cdkd STATE (not a copy of what AWS held) at the end, logs
  `Rollback: put back the inline policy <logicalId> records on its role`, and
  records a `ROLLBACK_RESOURCE_SUCCEEDED` event for that logical id. Nothing is
  put back, and the rollback warns, when the records holding the name disagree
  on its document, when the document or a name is redacted, or when that
  record's own rollback has not completed (it failed, or the rollback was
  interrupted first), since its record may still be the failed deploy's. The
  principal then lacks that policy until the resource next changes or
  `cdkd drift --revert` runs. A rollback killed between such a removal and the
  put-back also leaves the policy off: a re-run does not repeat the removal.
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

What counts as a replacement is what the provider reported. An update applied
in place is reverted in place even when it changed the physical id, as an SQS
`QueuePolicy` update does when its first queue changes and an SNS `TopicPolicy`
update does when its topics change. A journal written by an older cdkd does not
record the provider's answer, so there a changed physical id still reads as a
replacement. A `Type` change, and a Glue table whose recorded database differs
under an equal id, stay replacements whatever the provider answered.

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

When the re-create itself fails after its provider made the resource, the
rollback deletes what it made before reporting the failure, unless the old
resource's `DeletionPolicy` is `Retain` or `Snapshot`; a resource it keeps, or
cannot delete, is named in a warning for you to delete.

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

The same matrix governs every delete of a CREATE that failed in-flight — by
`--revert-failed`, and of one that made its resource also by a plain rollback,
the automatic rollback and `cdkd destroy` — so `Retain` does not delete what the
policy says to keep and `Snapshot` does not destroy the data un-snapshotted.

## Interaction with `cdkd export`

`cdkd export` refuses — behind a confirmation gate — to hand a stack over to
CloudFormation while a rollback journal exists. The half-deployed state is
almost certainly not what you want exported; roll back or re-deploy first.

## Interaction with `cdkd import`

Before it writes state, `cdkd import` marks each resource it adopts (its
logical id, the physical id it records, and its resource type) on every
journal segment that holds an operation for that logical id. The rollback then
runs none of those segments' operations for that id:

| The operation recorded | The rollback | Plan line |
| --- | --- | --- |
| The resource the import adopted (same physical id and type; for a DELETE, the record it removed) | Leaves it alone | `adopted by cdkd import after this deploy, left as it is` |
| Another resource under the id (another physical id or type) | Leaves it alone, warns, exits 2 | `recorded <its physical id>, which cdkd import has since replaced under this id; not reverted, check that resource by hand` |
| A replacement (including a Type change that kept its name) whose new resource the import adopted, while the old one was kept or may have been (no verdict recorded, as on a failed operation) | Leaves it alone, warns, exits 2 | `replaced <old physical id> but kept it ...` or `... and may have kept it ...`; `not reverted, check that resource by hand` |

For a replacement, only its new resource counts as what it recorded. If the
import put the old resource back, the operation is reported as above, naming
the replacement, which is left running.

Failed operations follow the same table, with or without `--revert-failed`.
They are left unreverted. If the segment is kept for a re-run, the re-run
lists them again; a run with no failures removes the segment as usual. A
displaced operation also records a `ROLLBACK_RESOURCE_SKIPPED` event. Once
its segment is removed, the plan line, which names the physical id, is the
record to act on. A physical id
derived from a secret is masked there, as in every other rollback line. Completed
operations of an id you pass to `--orphan` are not covered: the flag is
honoured.

The mark matters for a resource with an explicit name, whose physical id is
that name. A resource re-created by hand under the same name and imported
would otherwise match the journal's CREATE, and the rollback would delete it.

Segments that later deploys add carry no mark, and their operations replay as
usual. If the import cannot read or write the journal, it refuses and writes
no state.

A cdkd older than the mark wrote none. Under `--revert-failed` (or a plain
rollback, for a failed CREATE that made its resource), a failed
CREATE whose physical id such an import replaced is still left alone with a
warning, and the run exits 2 (see
[`--revert-failed`](#revert-failed-revert-the-resource-whose-operation-failed-mid-deploy));
the plan line then cannot say that an import caused it.

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
