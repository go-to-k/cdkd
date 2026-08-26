# Custom Resource Provider (isCompleteHandler) Example

This example demonstrates the CDK Provider framework with the async custom resource pattern using `isCompleteHandler`, and — since issues
[#2054](https://github.com/go-to-k/cdkd/issues/2054) /
[#1866](https://github.com/go-to-k/cdkd/issues/1866) — a second, synchronous
custom resource that MANAGES an SSM parameter and can be told to refuse its own
Delete.

Run it with `verify.sh` (the assertions live there); a bare
`cdkd deploy` / `cdkd destroy` still works and exercises arm A only.

## What it tests

- **CDK Provider framework**: Uses `aws-cdk-lib/custom-resources.Provider` with both `onEventHandler` and `isCompleteHandler`
- **Step Functions orchestration**: The Provider construct creates a Step Functions state machine to orchestrate the async polling
- **S3 pre-signed URL for cfn-response**: Long-lived (2 hour expiry) pre-signed URLs for the async callback
- **Async pattern detection**: cdkd detects `IsComplete: false` and polls via the isComplete handler
- **Long polling timeout**: Tests that cdkd properly waits for the async operation to complete
- **A refused Delete is NOT recorded as deleted** (issue #2054): with
  `CDKD_TEST_UPDATE=cr-delete-fails` the second resource's handler answers
  `Status: 'FAILED'` and leaves its SSM parameter alive. `cdkd destroy` must
  KEEP the state record, print the row as `skipped`, and exit 2 — the parameter
  is then read back BY ITS REAL AWS NAME to show the refusal was truthful.
- **...and the NEXT destroy drops that record anyway** — the bound #2054 does
  not close. The same run deletes the backing Lambda (the runner walks every
  reverse-DAG level regardless of skips), so run 2 hits the issue-#804
  pre-check, treats the resource as already deleted and exits 0 **with the
  parameter still live**. Phase 4 pins exactly that, and pins that the drop is
  no longer SILENT. Closing it properly needs a durable "a prior run skipped
  this" signal, which lives in the state schema or in `DeleteContext`.
- **CDK's own `autoDeleteObjects` still works against the new StackId** — issue
  #1866's own verification bar. The bucket holds an object AWS would refuse to
  delete, so "the bucket is gone" is a statement about that handler.
- **A CLEAN cdkd destroy happens too** (phase 7). Destroys #1 and #2 are
  non-clean by design, so without this the run could not honestly flip
  `integ-destroy`. Phase 6 rebuilds unarmed and phase 7 tears the stack down
  with 0 errors, 0 skips and 0 orphans; the trap's direct deletes are the
  safety net, never the teardown.
- **The synthetic `StackId` carries the real account / region** (issue #1866):
  the handler writes the `StackId` cdkd handed it into that same parameter, so
  the value is asserted against
  `arn:aws:cloudformation:<region>:<account>:stack/cdkd-DeleteRefusalResource/cdkd`.
  It is the only handler-visible surface for that value — before #1866 every
  handler saw `us-east-1` and account `000000000000` regardless of the deploy.

## Architecture

```
CustomResource
    |
    v
Provider (Step Functions State Machine)
    |
    +--> onEventHandler (Lambda)
    |       Returns { IsComplete: false } for Create/Update
    |       Returns { IsComplete: true } for Delete
    |
    +--> isCompleteHandler (Lambda)
            Returns { IsComplete: true, Data: { Result: "..." } }
```

## Architecture (arm B)

```
Custom::CdkdDeleteRefusal  ──ServiceToken──>  DeleteRefusalHandler (Lambda)
                                                  |
                                                  +--> Create/Update: PutParameter(value = event.StackId)
                                                  +--> Delete, REFUSE_DELETE=0: DeleteParameter, SUCCESS
                                                  +--> Delete, REFUSE_DELETE=1: leave it, answer FAILED
```

`REFUSE_DELETE` is a scalar PROPERTY of the handler, never the presence of a
resource: a mode-gated resource is deleted by any later deploy whose mode list
omits the token, which here is exactly the object the refusal must leave behind.

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> ./verify.sh
```

Phases: deploy -> arm the refusal -> destroy #1 (exit 2, record kept) ->
destroy #2 (record dropped, resource still live) -> out-of-band removal ->
**redeploy INTO the state machine's name cooldown** -> destroy #3 (clean).

### Why phase 6 redeploys without waiting for the state machine

`cdkd destroy` returns when it has ISSUED every delete, not when AWS has
finished them. Two resources here are torn down asynchronously while still
holding their name:

- the CDK Provider framework's waiter **state machine** — measured: after
  `DeleteStateMachine`, `DescribeStateMachine` answers `status: DELETING` for
  ~23s, and `CreateStateMachine` with the same name during that window fails
  `StateMachineDeleting: State Machine is being deleted`. This fixture's first
  real-AWS run died exactly there: 26 resources created, then a full rollback.
- the autoDelete **bucket**, whose name is explicit and globally unique.

Nothing else needs it, and that is evidence rather than assumption — the failed
run created every IAM role, policy and Lambda in the template before dying on
the state machine, so their deletes had already released their names.

Phase 6 used to poll the state machine to gone first — a **workaround with a
filed cause**, [#2116](https://github.com/go-to-k/cdkd/issues/2116): cdkd's
`isNameCooldownError` matched only `QueueDeletedRecently` / `wait 60 seconds`,
so the Step Functions wording was recognised by nothing and an ordinary
destroy-then-redeploy failed hard where CloudFormation converges.

**That wait is now the live arm.** #2116 taught the classifier both Step
Functions spellings and made a name cooldown retryable on the ORDINARY create
path (not only at the delete-then-re-create sites), so the redeploy rides the
window out by itself. The phase asserts the POSITIVE marker — exit code 0 plus
`Deployment completed successfully` — which only the fixed classifier produces;
pre-fix the identical run rolled 26 resources back. It also logs a
`PREMISE: window OPEN / CLOSED` line taken immediately before the redeploy, so
a run where AWS finished the delete early is visible as "did not exercise the
retry" rather than passing silently.

The **bucket** wait stays. S3's `OperationAborted` is retryable on the ordinary
create path, but `BucketAlreadyOwnedByYou` is short-circuited to idempotent
success by the S3 provider, so a re-create landing on that spelling would adopt
a bucket on its way out — a different defect, not this one.

## Deploy / destroy by hand (arm A only)

```bash
cdkd deploy CustomResourceProviderStack
cdkd destroy CustomResourceProviderStack
```
