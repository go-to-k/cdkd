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
  `RawMessageDelivery: false`, deployed with `--strict-getatt`. Asserts one
  subscription, the right endpoint, and that the explicit `false` was forwarded
  rather than dropped. Since issue
  [#3329](https://github.com/go-to-k/cdkd/issues/3329) it also asserts the
  recorded `attributes.Arn` and the resolved `SubscriptionArn` Output, which is
  a `Fn::GetAtt` on the subscription — the two fail differently, so both are
  checked: the ATTRIBUTE is the discriminator (it was absent before that
  change), while the OUTPUT would resolve either way through the physical-id
  fallback, which is what `--strict-getatt` closes off.
- **Phase 2 — the regression arm.** `CDKD_TEST_UPDATE=raw-delivery,filter-b`
  flips `RawMessageDelivery` to `true` and edits the `FilterPolicy`, which
  routes to `update()`. Since issue
  [#4853](https://github.com/go-to-k/cdkd/issues/4853) both apply **in place**:
  the topic ends with exactly one subscription whose `SubscriptionArn`,
  recorded `attributes.Arn` and Output are **unchanged**.
- **Phases 2a, 2d, 2b, 2r, 2c — further in-place edits and their limits.** A
  scope-only edit (2a); a `RedrivePolicy` to a dead-letter queue (2d); the
  filter, its scope and the `RedrivePolicy` dropped from the template, cleared
  on the same subscription (2b — SNS clears a `RedrivePolicy` only with the
  value omitted, issue [#6835](https://github.com/go-to-k/cdkd/issues/6835));
  a re-create inside a deploy that then fails (2r, issue
  [#6731](https://github.com/go-to-k/cdkd/issues/6731)); and a policy plus
  scope change the provider makes by re-creating, which `cdkd diff` must report
  (2c, issue [#6509](https://github.com/go-to-k/cdkd/issues/6509)). The
  `verify.sh` header holds the detail.
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
therefore deletes the topic and both queues **directly** by their deterministic names
and drops the record with `state orphan --force`. It is armed on `EXIT`, `INT`
and `TERM` in the exiting form with the rc seeded before arming, and is
idempotent — the happy path calls it once up front and once via the trap.

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> ./verify.sh
```
