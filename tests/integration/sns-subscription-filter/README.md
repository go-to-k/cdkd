# SNS Subscription filterPolicy

An SNS -> SQS subscription with a `filterPolicy` — a daily CDK pattern. The
`AWS::SNS::Subscription` carries a `FilterPolicy` (a nested JSON object) that
cdkd must forward to `SetSubscriptionAttributes` exactly, without
double-stringifying or dropping it.

## What it verifies

1. **FilterPolicy reached AWS intact**: `get-subscription-attributes` returns a
   `FilterPolicy` whose `color` allowlist (`["red","green"]`) and `weight`
   numeric filter (`[{"numeric":[">",10]}]`) match what was synthesized.
2. **Clean destroy**: the topic, queue and cdkd state are gone afterward.

## Run

```bash
AWS_REGION=us-east-1 STATE_BUCKET=cdkd-state-<accountId> bash verify.sh
```
