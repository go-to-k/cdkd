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

## Deploy

```bash
cd tests/integration/cloudwatch
npm install
cdkd deploy CloudWatchStack
```

## Destroy

```bash
cdkd destroy CloudWatchStack
```
