# Retain Orphan Redeploy

Regression coverage for [#2902](https://github.com/go-to-k/cdkd/issues/2902):
a redeploy that collides with a resource cdkd itself left behind.

## The loop this reproduces

A resource carrying `DeletionPolicy: Retain` stays in AWS when a deploy rolls
back, and its state record is dropped — CloudFormation does the same, and it is
what `Retain` is for. cdkd's generated physical names carry no random
component, so the next `cdkd deploy` asks AWS for a name the retained resource
still holds and fails with an already-exists error; that failure rolls back too,
so re-running never resolves it. CloudFormation never shows this, because its
generated names carry a random suffix and a retained orphan cannot collide.

## Pass condition

**Not "the deploy succeeds"** — a redeploy over an orphan must FAIL. What this
fixture asserts is that cdkd names the cause and that the remedy it prints
actually works:

| Phase | Assertion |
|---|---|
| 1 deploy | the role's physical name is cdkd's own derivation (else the diagnosis under test could not fire) |
| 2 `state orphan` | the record is gone and the role is still live |
| 3 redeploy | fails, AND prints the orphan diagnosis |
| 4 import | runs the command **parsed out of that message**, and state adopts the role |
| 5 redeploy | now succeeds — the loop is broken |
| 6 destroy | role and state gone |

Phase 4 is the point: naming a remedy whose precondition the code never checks
is the defect class [#2610](https://github.com/go-to-k/cdkd/issues/2610) swept,
so the fixture runs the command cdkd emitted rather than one the fixture author
believed in.

## Why an IAM role, and why no `roleName`

Both are load-bearing. Without `roleName` the physical name is cdkd's
`{stackName}-{logicalId}` derivation — the advice deliberately refuses a name
cdkd did not derive, so a template-named resource would assert nothing. And
`AWS::IAM::Role` REFUSES a duplicate name; `AWS::S3::Bucket`,
`AWS::Logs::LogGroup` and `AWS::SNS::Topic` silently adopt an existing
resource, so a fixture built on one of those would redeploy green.

`cdkd state orphan` manufactures the orphan rather than an injected rollback:
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
with the queue still declared would create it again under the same generated
name.

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> AWS_REGION=us-east-1 ./verify.sh
```
