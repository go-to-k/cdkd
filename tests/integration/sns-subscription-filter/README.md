# SNS Subscription filterPolicy

An SNS -> SQS subscription with a `filterPolicy` — a daily CDK pattern. The
`AWS::SNS::Subscription` carries a `FilterPolicy` (a nested JSON object) that
cdkd must forward to `SetSubscriptionAttributes` exactly, without
double-stringifying or dropping it.

## What it verifies

1. **FilterPolicy reached AWS intact**: `get-subscription-attributes` returns a
   `FilterPolicy` whose `color` allowlist (`["red","green"]`) and `weight`
   numeric filter (`[{"numeric":[">",10]}]`) match what was synthesized.
2. **A two-queue `QueuePolicy` shrinks, grows and is cleared**
   ([#4594](https://github.com/go-to-k/cdkd/issues/4594)): a standalone
   `sqs.QueuePolicy` names two RETAINED queues. Both carry the policy after
   deploy; a redeploy with `CDKD_TEST_UPDATE=shrink` drops queue B from the
   list and its policy is cleared while queue A keeps it; a redeploy of the
   full list applies it to queue B again.
3. **Clean destroy**: the topic, queue and cdkd state are gone afterward, and
   the policy is cleared from both retained queues (`verify.sh` then deletes
   them).

## Run

```bash
AWS_REGION=us-east-1 STATE_BUCKET=cdkd-state-<accountId> bash verify.sh
```
