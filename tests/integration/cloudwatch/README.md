# CloudWatch Integration Test

This example demonstrates cdkd deployment of CloudWatch monitoring resources.

## Resources

- **CloudWatch Log Group** - Log group with 1-week retention
- **Metric Filter** - Filters log entries containing "ERROR" and emits a custom metric
- **CloudWatch Alarm** - Triggers when error count exceeds 0 in a 5-minute period
- **SNS Topic** - Receives alarm notifications

## What it tests

- CloudWatch Log Group creation with retention policy
- Metric Filter on a log group (resource dependency)
- CloudWatch Alarm with custom metric and comparison operator
- SNS Topic creation
- Alarm action linking alarm to SNS topic
- Cross-resource references (Ref, Fn::GetAtt)
- CfnOutputs for resource attributes
- Alarm `WarmUpConfiguration` / `ActionConfiguration` on the SDK route (go-to-k/cdkd#2762):
  `verify.sh` reads both back from `DescribeAlarms`, then redeploys with
  `CDKD_TEST_UPDATE=true` (warm-up changed, `ActionConfiguration` removed) and
  asserts AWS changed and cleared them; after each deploy `cdkd drift` must
  report the stack clean
- Alarm `EvaluationWindow` / `EvaluationCriteria` / `EvaluationInterval` on the
  SDK route (go-to-k/cdkd#5524): a wall-clock window that the update removes
  (no phantom drift from the default sliding window), then a PromQL alarm
  (`CDKD_TEST_PROMQL=true`) created, changed out of band and restored by
  `cdkd drift --revert`, and updated in place

## Run

```bash
AWS_REGION=us-east-1 STATE_BUCKET=<bucket> bash verify.sh
```

## Deploy

```bash
cd tests/integration/cloudwatch
vp install
cdkd deploy CloudWatchStack
```

## Destroy

```bash
cdkd destroy CloudWatchStack
```
