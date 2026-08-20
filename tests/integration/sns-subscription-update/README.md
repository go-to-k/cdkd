# sns-subscription-update

First real-AWS coverage of `SNSSubscriptionProvider.update()` — the
delete-then-create replacement path — added with the fix for issue
[#1967](https://github.com/go-to-k/cdkd/issues/1967).

Before this fixture **no integ drove that method at all**. Every fixture that
declares a standalone `AWS::SNS::Subscription` (`composite-stack`,
`event-driven`, `full-stack-demo`, `microservices`, `sns-subscription-filter`,
`sqs-cloudwatch`, `sns-sqs-event`, `sns-pending-subscription`) only creates and
destroys one; none updates it. That gap is how the thrown-delete arm of #1967
reached main.

## What it tests

- **Phase 1 — create.** A standalone L1 `CfnSubscription` with an explicit
  `RawMessageDelivery: false`. Asserts one subscription, the right endpoint, and
  that the explicit `false` was forwarded rather than dropped.
- **Phase 2 — the regression arm.** `CDKD_TEST_UPDATE=raw-delivery` flips
  `RawMessageDelivery` to `true`, which routes to `update()`. Asserts the topic
  ends with **exactly one** subscription, that its `SubscriptionArn` **changed**
  (a fresh `Subscribe` after `Unsubscribe` mints a new GUID — measured — so the
  ARN is what proves the internal replacement actually ran), that the endpoint
  is unchanged, that the attribute converged, and that cdkd **recorded the new
  ARN** in state.
- **Phase 3 — the thrown-delete arm.** The recorded `physicalId` is rewritten to
  a malformed subscription ARN, so `Unsubscribe` throws. Asserts cdkd aborts
  **before** creating, and that the live subscription is untouched.
- **Phase 4 — repair + destroy.** Restores the real ARN and runs a real
  `cdkd destroy`, so the `integ-destroy` gate sees a clean cdkd teardown rather
  than the trap's direct deletes.

## Why `RawMessageDelivery` and not the endpoint

Measured, not assumed. `Endpoint` / `Protocol` / `TopicArn` are the three
`createOnlyProperties` in the live CloudFormation registry schema:

```console
$ aws cloudformation describe-type --type RESOURCE \
    --type-name AWS::SNS::Subscription --query Schema --output text \
  | jq -c .createOnlyProperties
["/properties/Endpoint","/properties/Protocol","/properties/TopicArn"]
```

`diff-calculator.ts` applies that schema wherever `ReplacementRulesRegistry` has
no explicit opinion, and it has none for this type — so a createOnly change sets
`requiresReplacement` and routes to **`deploy-engine.ts`'s own** replacement
branch. The engine's only `provider.update()` call site sits in the `else` of
that same `if`. **An endpoint-change fixture would execute not one line of the
method under test while looking exactly like a test of it.**

## What phase 3 can and cannot prove

Two more measurements against real SNS:

| operation | result |
| --- | --- |
| `Subscribe` repeated with identical topic / protocol / endpoint **and** identical attributes | returns the **same** `SubscriptionArn`; the topic still holds **one** subscription |
| `Subscribe` repeated with identical topic / protocol / endpoint but **different** attributes | refused: `InvalidParameter ... Subscription already exists with different attributes` |

Topic, protocol and endpoint are exactly the three createOnly properties, so any
change that reaches `update()` leaves all three identical. **The "two live
subscriptions" outcome #1967 describes therefore cannot occur on this path** —
SNS itself enforces uniqueness on that triple. Pre-fix, phase 3 failed too, just
with SNS's confusing `already exists with different attributes` surfaced from
the create instead of cdkd's own refusal.

So the discriminator is the failure **reason**, not the AWS end state: phase 3
asserts cdkd's abort IS reported and that SNS's message is **absent**, which is
the real-AWS spelling of "`create()` was never called". An assertion on the end
state alone would pass against the defect.

The duplicate remains reachable in principle when the endpoint differs — which
happens if `cloudformation:DescribeType` is unavailable and the schema fallback
in `create-only-properties.ts` degrades an endpoint change into an in-place
update. That degradation is documented in that file's own warning text and is
not drivable from a fixture without changing the deploy principal's IAM.

## Leak safety

Phase 3 deliberately leaves a malformed `physicalId` in state, and
`cdkd state destroy` cannot clear it (a malformed subscription ARN answers
`InvalidParameter`, not `NotFound`, so the delete throws every time). `cleanup`
therefore deletes the topic and queue **directly** by their deterministic names
and drops the record with `state orphan --force`. It is armed on `EXIT`, `INT`
and `TERM` in the exiting form with the rc seeded before arming, and is
idempotent — the happy path calls it once up front and once via the trap.

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> ./verify.sh
```
