# Retain Orphan Redeploy

Regression coverage for [#2902](https://github.com/go-to-k/cdkd/issues/2902):
a redeploy that collides with a resource cdkd itself left behind.

## The loop this reproduces

A resource carrying `DeletionPolicy: Retain` stays in AWS when a deploy rolls
back, and its state record is dropped — CloudFormation does the same, and it is
what `Retain` is for. cdkd's generated physical names used to be fixed for a
stack's lifetime, so the next `cdkd deploy` of the same stack asked AWS for a
name the retained resource still held and failed with an already-exists error;
that failure rolled back too, so re-running never resolved it.

Since [#5064](https://github.com/go-to-k/cdkd/issues/5064), on a stack with a
stack instance id, a generated name is `{stack}-{logicalId}-{suffix}`, the
suffix hashing the id, the logical id and the record's **name generation**. A
record that leaves the stack (a rollback's Retain orphan,
`state orphan --resource`) retires its generation, so the next create of that
logical id asks for the next generation's name and never collides with what was
left behind — as in CloudFormation. A stack whose record was deleted
(`cdkd destroy`, a whole-stack `cdkd state orphan`) starts a NEW lifetime with
a new id altogether (phases 11b-11c).

## Pass condition

The #2902 diagnosis still covers a create whose derived name IS held — by a
resource an interrupted earlier attempt made, say. This arm plants such a
holder on the generation-1 name the redeploy derives (computed from
`state.json`'s `stackInstanceId`, never printed), and asserts that cdkd names
the cause and that the remedy it prints actually works:

| Phase | Assertion |
|---|---|
| 1 deploy | the role's physical name is cdkd's own generation-0 derivation (else the diagnosis under test could not fire) |
| 2 `state orphan --resource` | the role's record is gone, the stack keeps its instance id and retires the role's generation 0, and the role is still live |
| 2b plant | a role created out of band on the generation-1 name |
| 3 redeploy | fails on that name, AND prints the diagnosis naming it; the orphan is untouched |
| 4 import | runs the command **parsed out of that message**, and state adopts the planted role |
| 5 redeploy | now succeeds — the loop is broken |
| 6 destroy | the adopted role and state gone; the orphan (no record names it) left, then deleted by the fixture |

Phase 4 is the point: naming a remedy whose precondition the code never checks
is the defect class [#2610](https://github.com/go-to-k/cdkd/issues/2610) swept,
so the fixture runs the command cdkd emitted rather than one the fixture author
believed in.

## Why an IAM role, and why no `roleName`

Both are load-bearing. Without `roleName` the physical name is cdkd's
`{stackName}-{logicalId}-{suffix}` derivation — the advice deliberately refuses a name
cdkd did not derive, so a template-named resource would assert nothing. And
`AWS::IAM::Role` REFUSES a duplicate name; `AWS::S3::Bucket`,
`AWS::Logs::LogGroup` and `AWS::SNS::Topic` silently adopt an existing
resource, so a fixture built on one of those would redeploy green.

`cdkd state orphan --resource` manufactures the orphan rather than an injected rollback:
it reaches the same end state (resource live, record gone) deterministically,
where a failure injection's timing would decide what got created.

## The single-record orphan arm

A third stack, `CdkdRetainOrphanResourceExample`, covers
`cdkd state orphan <stack> --resource <logicalId>`
([#4602](https://github.com/go-to-k/cdkd/issues/4602)): a queue, and an SSM
parameter whose value is the queue's URL, so the parameter's record depends on
the queue.

| Phase | Assertion |
|---|---|
| 12 deploy | the parameter's record lists the queue in its `dependencies` (else the rewrite below is vacuous) |
| 13 unknown `--resource` | refuses, and the record's resource keys are unchanged |
| 14 `state orphan --resource <queue>` | exactly the queue's record is gone, the parameter's dependency on it is rewritten out, its recorded value is the queue URL, and the queue is still live |
| 15 redeploy without the queue | succeeds, never plans a delete of the queue, updates the parameter, and leaves the orphaned queue alone (cdkd holds no record of it) |
| 16 destroy | the parameter and the state are gone and the queue is not; the fixture then deletes it by URL |

The redeploy drops the queue from the template on purpose: a resource whose
construct has left the template is the case the option exists for. Redeploying
with the queue still declared would create a second queue under the next name
generation's name.

## A rollback orphan is left alone

The adoption stack, `CdkdRetainOrphanAdoptExample`, takes its orphan from a
real failed deploy (`CDKD_TEST_ADOPT=fail`: a `Retain` role, then a queue that
fails), which records it in `state.json`'s `orphans`.
[#2934](https://github.com/go-to-k/cdkd/issues/2934) re-adopted that orphan on
the next deploy; on a stack with a stack instance id
([#5064](https://github.com/go-to-k/cdkd/issues/5064)) it does not.

| Phase | Assertion |
|---|---|
| 7 failed deploy | the Retain role survives the rollback under its generation-0 name, and the rollback retires generation 0 |
| 8 | exactly one orphan record |
| 8b diff | previews NO adoption (the summary line is the sentinel that a preview rendered) |
| 9 redeploy | succeeds, warns that the orphan is not taken back (naming `cdkd import`), adopts nothing |
| 10 | the role is managed under the generation-1 name, the orphan is untouched and its record kept; the fixture then deletes the orphan |

## A new lifetime leaves kept resources alone

The adoption stack also covers what a destroyed stack's redeploy does ([#5064](https://github.com/go-to-k/cdkd/issues/5064)).
Its `fixed` mode adds `KeptTopic`, an un-named `Retain` topic: a name-adopting
type, so the destroy records it in the stack's `retained.json`.

| Phase | Assertion |
|---|---|
| 11 destroy | the role and topic are kept (RETAIN), the record and its instance id are gone |
| 11b redeploy | succeeds, warns once that 1 kept resource is not taken back (naming `cdkd import`), adopts nothing, and creates a new role and topic under new suffixed names; the kept role (same `CreateDate`) and topic are untouched |
| 11c destroy | the second lifetime's record is gone; the teardown deletes the four kept resources (two roles, two topics) |

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> AWS_REGION=us-east-1 ./verify.sh
```
