# rename-refactor

Structural integ for the daily **"refactor rename"** pattern: the construct ids
(and thus logical ids) of a queue, a table, and a lambda change in a single
deploy, while an `events.Rule` with a stable construct id keeps targeting the
lambda. First probed live (and found CLEAN) in bug-hunt sweep 17 (2026-07-21);
this fixture pins the behavior against regression — before it, no committed
fixture exercised the removed+added-in-one-deploy path with a kept resource
referencing the renamed one.

Stack: `CdkdRenameRefactorExample`.

## What it exercises

1. **Rename = create new + retarget kept + delete old.** Generation "a"
   (`WorkQueueA` / `DataA` / `HandlerA`) becomes generation "b" under
   `CDKD_TEST_UPDATE=true`. verify.sh asserts the END STATE after one deploy:
   the new generation exists, the kept rule's single target is the new lambda
   ARN, and every old-generation resource is gone. (Intra-deploy ordering is
   the engine's concern and is not asserted here.)
2. **Reference rewiring.** The renamed lambda's env (`QUEUE_URL` /
   `TABLE_NAME`) must carry the NEW generation's values (verified by API
   read-back AND a real invoke).
3. **Pinned logical id + changed construct path = no-op.** An SSM parameter
   nested under a renamed parent has its logical id pinned via
   `overrideLogicalId('StableParam')`, so the only template change is
   `Metadata` `aws:cdk:path`. The deploy must not touch it — asserted via the
   SSM parameter `Version` staying constant (SSM increments it on every put).
4. **Destroy** removes the rule, the pinned parameter, and generation "b";
   `/aws/lambda/cdkd-rename-refactor-*` log groups (created by the functional
   invoke) are swept.

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> ./verify.sh
```
