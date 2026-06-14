# EventSourceMapping Fresh-Source Race Example

A **failure-seeking** integration test for `AWS::Lambda::EventSourceMapping`
created against a FRESH source (an SQS queue) and a FRESH execution role in
the SAME `cdkd deploy`.

## Why this test exists

cdkd's deploy engine is event-driven: each resource is dispatched the instant
its own dependencies complete, with NO level barrier. For an
`AWS::Lambda::EventSourceMapping` that references a queue, function, and role
all created in the same deploy, that means the `CreateEventSourceMapping` call
can fire moments after the queue / function / role-policy operations return —
before AWS has fully propagated them. Two bug classes follow:

1. **Fresh-source / fresh-role readiness race.** If the queue ARN, the function,
   or the role's `sqs:ReceiveMessage` grant has not propagated yet, AWS rejects
   the create with `InvalidParameterValueException` ("Cannot access queue" /
   "provided role ... does not have permissions" / "Function not found"). cdkd
   must order the `Ref` / `Fn::GetAtt` edges correctly AND retry on the
   eventual-consistency window. This test is the real-AWS net for that.

2. **Orphan-ESM-on-redeploy collision.** A run killed mid-deploy can leave an
   EventSourceMapping that is NOT in cdkd state. On re-deploy cdkd's diff sees
   no ESM and issues a fresh CREATE, which collides on the duplicate
   `(FunctionName, EventSourceArn)` pair with `ResourceConflictException`. The
   test's pre-flight orphan scan (per the `run-integ` skill) catches this BEFORE
   deploy.

## Configuration

This stack includes the following resources:

- **SQS Queue** — the FRESH event source.
- **Lambda Function** — inline Python consumer (no asset publishing); each
  invocation logs `CDKD_ESM_PROCESSED <body>`. Its execution role + the
  SQS-consumer inline policy are also created in this deploy (the FRESH role).
- **Event Source Mapping** — wires the queue ARN + function together
  (`enabled: true`, `batchSize: 5`, `reportBatchItemFailures: true`).

No VPC, no KMS — kept cheap.

## What `verify.sh` asserts

`verify.sh` owns its own deploy + verify + destroy cycle (run it via
`/run-integ eventsourcemapping-race`):

1. **Pre-flight orphan scan** — `list-event-source-mappings` filtered by the
   stack name; aborts with cleanup commands if a prior killed run left an
   orphan ESM (the orphan-ESM-on-redeploy guard).
2. **Deploy** — succeeds (the ESM create did NOT race the fresh source / role).
   On failure it prints the deploy output + greps the ESM-specific error lines.
3. **ESM exists + Enabled** — polls `get-event-source-mapping` until
   `State == Enabled`, and cross-checks `list-event-source-mappings` by the
   queue ARN returns the UUID.
4. **Wiring delivers** — sends a probe message to the queue and polls the
   Lambda's CloudWatch logs for the `CDKD_ESM_PROCESSED <probe>` marker
   (proves queue -> ESM -> Lambda delivery actually works).
5. **Destroy** — clean: NO orphan ESM survives (`list-event-source-mappings`
   filtered by the function is empty), the queue is gone, and the state file
   is gone.

The script is BSD-portable (no `grep -P`, no `date -d`), captures the real
deploy exit code, and emits an explicit `PASS` line on success.

## Run

```bash
# From the repo root, build first:
vp run build

# Then run the test (encodes deploy + verify + destroy + orphan scan):
/run-integ eventsourcemapping-race
```

## Clean up

`verify.sh` always destroys on exit (via a `trap`), deleting any leftover ESM,
the queue, and the cdkd state. If a run was interrupted, re-running it is safe —
the pre-flight orphan scan + pre-run cleanup handle leftovers.
