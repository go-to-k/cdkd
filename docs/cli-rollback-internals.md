---
title: cdkd rollback internals
description: "The exact rules behind cdkd rollback: unaddressable operations, ownership of a failed CREATE's resource, the order a replacement is reversed in, and IAM inline policy names."
unlisted: true
---

# cdkd rollback internals

The rules behind the cases that [`cdkd rollback`](cli-rollback.md),
[cdkd rollback: failed operations](cli-rollback-failed-operations.md) and
[cdkd rollback: limitations](cli-rollback-limitations.md) summarise: when an
operation is skipped or refused, how cdkd decides that a resource a failed
CREATE left behind is safe to delete, and how a replacement is reversed.

## An operation cdkd cannot address

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

## `--revert-failed`, per failed operation

| Failed operation | With `--revert-failed` |
| --- | --- |
| UPDATE | Force-reverted to its pre-deploy properties. The journal records the *attempted* properties, so patch-based providers generate a real undo diff. |
| UPDATE that was a replacement whose new resource was made and then failed (journaled beside it, see below) | Never force-reverted: the update applied nothing to the old resource. When the replacement created first, the old resource is untouched and nothing is done. When it deleted the old resource first, the rollback warns (exit `2`) that the resource state still records is gone; a deploy whose template still replaces it creates it again (one whose template was reverted to the old properties sees no change and does not), and a `cdkd destroy` drops the record. The new resource's own entry is acted on, and this one is cleared with it on every path, so a later `--revert-failed` never sees it alone. |
| UPDATE that changed the resource's `Type` | Skipped with a warning; it was a replacement in flight, and there is no in-place revert of one. |
| UPDATE whose state record has no usable `physicalId` (a `cdkd deploy` refusal over a hand-edited record still journals the op) | Skipped with a warning (exit `2`); nothing is sent. See [An operation cdkd cannot address](#an-operation-cdkd-cannot-address). |
| CREATE that recorded a physical id, which state still records | Deleted, honouring its `DeletionPolicy` — see [DeletionPolicy on a rolled-back CREATE](cli-rollback.md#deletionpolicy-on-a-rolled-back-create). |
| CREATE that made its resource and then failed (the provider proved its create call returned, e.g. a Kinesis stream whose retention follow-up AWS rejected) | Deleted, honouring the template's `DeletionPolicy` as journaled — this entry is the only record of that resource. Under `Retain` it is left in AWS with no rollback-orphan record (it was never in state), so a later deploy cannot re-adopt it. Deleted only while nothing later can own it. It is skipped with a warning naming the physical id (exit `2`), since the resource may still exist untracked and need manual attention, when a NEWER journal segment holds an operation of its type naming its physical id or previous physical id, or a completed CREATE of its type; when a later segment's removal superseded its logical id; or when a rollback-orphan record holds its logical or physical id. Otherwise state decides: a state resource under its logical id with the same physical id, or one of its type holding that physical id under another logical id, tracks it and the skip is silent; a different physical id under its logical id warns (exit `2`), unless that record is the resource a replacement was replacing (see below). When the entry is one a successful fix-forward deploy kept (a delete that failed, or an S3 bucket it never empties), `cdkd rollback` and `cdkd destroy` first ask the provider again whether that record is another resource, and the preview shows the answer: proven, the entry is deleted while its creation identity still matches, or dropped when the resource is already gone; unproven, it is warned about as above. A redeploy whose create only collided with its name does not stop the delete. Roll the stack back before redeploying: a redeploy that re-creates the same name, or under `--no-rollback` completes any CREATE of its type, makes the newer entry decide, and this one is then only warned about. SDK providers whose create makes a follow-up call after their create call returned prove it where the id is known and the create made the resource (an adopted or pre-existing resource is never marked), unless their own cleanup already deleted it (`AWS::IAM::Policy` instead removes its own writes and warns when that fails). |
| CREATE that recorded a physical id, with no state record left | Nothing to do — already cleaned up (a re-run). |
| CREATE that recorded a physical id other than the one state now records under its logical id (not the record a replacement was replacing — see below) | Skipped with a warning (exit `2`); nothing is deleted. The resource it recorded may still exist, untracked: the plan line names it (`recorded <its physical id>, which is not the resource state tracks under this id; not reverted, needs manual attention`). Reached when another resource took the id without an import mark, such as a `cdkd import` by an older cdkd, or when a newer segment's reverted replacement re-created the resource under a new physical id (the recorded one is then usually already gone); a marked import is reported as in [Interaction with `cdkd import`](cli-rollback-limitations.md#interaction-with-cdkd-import). |
| CREATE that recorded no physical id | Skipped with a warning; there is nothing addressable to act on. A CREATE cdkd refused before anything was applied (another resource already holds its explicit name) is not journaled at all. |
| DELETE | Nothing to do — the resource is still in place. |

The action only engages when AWS actually provisioned the resource: it requires
a recorded physical id and either a matching state record or the provider's
proof that its create call returned, so the policy is never applied to a
resource that never existed. The physical id a failed create's error names is
not such proof on its own: it is also the name of a resource the create
collided with.

## Failed CREATEs that made their resource

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
| A later successful `cdkd deploy` | Deleted, per its `DeletionPolicy`, before the deploy removes the journal, but only when, after the deploy, no state record sits under its logical id and the deploy completed no operation under it (or the record under it holds a resource that a live read proves is a different one, see below), no record of the stack holds a resource of its type under its physical id, and no resource or rollback-orphan record of any other stack under the same state prefix does. A record of the stack holding that very resource tracks it, and the entry is dropped silently. Otherwise it is not deleted: the deploy warns, naming its physical id so you can delete it if it is not that record's resource, removes the entry with the journal, and exits `2`. A fix-forward that keeps the logical id under another name puts a new resource there: for an `AWS::Kinesis::Stream`, the deploy reads both streams live and deletes the earlier one when it is proven a different stream (never when it shares the record's name, when the record's stream is not found, or when a read fails; an earlier stream already gone is named at info and nothing is deleted), and a read proving it the same resource tracks it, silently. An `AWS::EC2::NatGateway` or `AWS::EC2::EIP` is compared the same way, by its `nat-` id or `eipalloc-` allocation id; an earlier one already gone (or a NAT gateway its create left `failed`) is still sent the delete, which finds it gone or removes it. An `AWS::RDS::DBCluster` or `AWS::RDS::DBInstance` is compared by its resource id (`DbClusterResourceId` / `DbiResourceId`); an identifier that differs from the record's only in case names the same resource, since RDS identifiers are case-insensitive. An `AWS::DocDB::DBCluster` or `AWS::DocDB::DBInstance` is compared the same way; an identifier now held by an RDS or Neptune resource, which share the namespace, is never read as the DocumentDB one, so it lands in the warning above. An `AWS::Neptune::DBCluster` or `AWS::Neptune::DBInstance` is compared the same way; an identifier now held by an RDS or DocumentDB resource is never read as the Neptune one, so it lands in the warning above. An `AWS::S3::Bucket` is compared by name: bucket names are global and cannot be changed, so two names are two buckets, once the record's bucket reads back in the stack's region. An `AWS::DynamoDB::Table` is compared by its `TableId`, which AWS generates and never gives a later table, once the record's table reads back in the stack's region; table names are case-sensitive, so two names differing only in case are read as two tables. A bucket a failed CREATE left behind is never emptied on any of these paths, even when its template declared `autoDeleteObjects`: one that is not empty (something wrote to it after that create) is kept, named in a warning, and stays in the journal. An RDS or Neptune cluster or instance, or a DynamoDB table, that Cloud Control provisioned is never compared, and lands there too. Every other type, and any read that cannot prove either way, lands in the warning above, so the earlier attempt's resource is left for you to delete. On either path, before the delete, a type whose physical id is a name (most types) must also prove that the resource now answering to that name is the one the failed CREATE made, since you may have deleted it and something else may have reused the name: the failed deploy records the provider's identity for it (for an `AWS::Kinesis::Stream`, its ARN and creation time; for an RDS, DocumentDB or Neptune cluster or instance, its resource id; for an `AWS::S3::Bucket`, its name, region and the `CreationDate` this account's `ListBuckets` reports; outside us-east-1 S3 moves that date on a later versioning, tagging, encryption or policy change, which leaves the bucket in the warning above; for an `AWS::DynamoDB::Table`, the `TableId` its `CreateTable` returned), and the deploy deletes it only when a live read returns the same identity; one a live read reports gone is named at info, nothing is deleted, and its entry is dropped. With no recorded identity (a provider without one, a read that failed, or a journal an older cdkd wrote), or a different one, it lands in the warning above. Types whose physical id AWS generates and never reuses (an EC2 `vpc-` / `nat-` / `sg-` id, an EFS or FSx file system, a KMS key, an ELBv2 ARN, and similar), an `AWS::SQS::QueuePolicy` / `AWS::SNS::TopicPolicy`, whose delete compares the policy it finds, and a nested stack, whose id only cdkd mints, need no recorded identity. A top-level deploy does the same for each nested stack's journal, judged by that stack's record. A journal the deploy cannot read is warned about and removed, and nothing it records is deleted. |

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

## Reversing a replacement

A replacement is undone by reversing it: the old resource is re-CREATEd from its
journaled pre-deploy state, and the new resource is deleted unless its own
`UpdateReplacePolicy: Retain` says otherwise (see below). The default order is
create-first; when a user-supplied physical name is still held by the new
resource, cdkd falls back to delete-new-first with a bounded name-release retry.

A replacement that deleted the old resource BEFORE creating the new one
(`--recreate-via-cc-api`, `--recreate-via-sdk-provider`, the update-unsupported
fallback, `--replace`'s delete-first fallback, or a resource lost with a parent
that was re-created under the same id) is reversed in that order
too: the new resource is deleted first, then the old one is re-created. So a
port or name that only one of them can hold, such as an ELBv2 listener's port,
does not collide. If that delete fails or is skipped, state keeps naming the
new resource and the journal is kept. If the re-create then fails, the resource
is absent and the message says so; re-deploy to fix it forward. A journal
written by an older cdkd, and a new resource kept by `UpdateReplacePolicy:
Retain`, use the create-first order. So does a resource whose old properties
name another resource the same deploy replaced or deleted, including one whose
replacement failed after deleting it (a listener's old target group, replaced
by a create-only change): the rollback may not be able to bring that resource
back under the id they name, so deleting the new copy first could lose it. The
rollback says so in a warning and does not delete the new resource to free a
name either, so if the re-create fails, the new resource is kept.

What counts as a replacement is what the provider reported. An update applied
in place is reverted in place even when it changed the physical id, as an SQS
`QueuePolicy` update does when its first queue changes and an SNS `TopicPolicy`
update does when its topics change. A journal written by an older cdkd does not
record the provider's answer, so there a changed physical id still reads as a
replacement. A `Type` change, and a Glue table whose recorded database differs
under an equal id, stay replacements whatever the provider answered.

On the create-first order, cdkd deletes the new resource first only when it
can show that the new resource holds the name the re-create collided on:

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

## IAM inline policy names moved between resources

An IAM inline policy name moved between resources on one role, group or user in
the failed deploy (two `AWS::IAM::Policy` resources swapping names, or a policy
renamed away from a name the role's own `Policies` took) is kept by each revert
that would remove it once another revert of the same rollback has put it back.

When a revert or delete removes a name another resource's state record still
holds on that principal (a policy created under a name another policy still
held, say), the rollback puts back the document that record holds in cdkd state
(not a copy of what AWS held) at the end, logs
`Rollback: put back the inline policy <logicalId> records on its role`, and
records a `ROLLBACK_RESOURCE_SUCCEEDED` event for that logical id.

Nothing is put back, and the rollback warns, when the records holding the name
disagree on its document, when the document or a name is redacted, or when that
record's own rollback has not completed (it failed, or the rollback was
interrupted first), since its record may still be the failed deploy's. The
principal then lacks that policy until the resource next changes or
`cdkd drift --revert` runs. A rollback killed between such a removal and the
put-back also leaves the policy off: a re-run does not repeat the removal.
