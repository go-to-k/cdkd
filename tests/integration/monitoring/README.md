# Monitoring Pattern Integration Test

This example demonstrates cdkd deployment of a monitoring pattern combining multiple AWS resources.

## Resources

- **Lambda Function** - Inline Python function as the monitored target
- **CloudWatch Dashboard** - Dashboard with TextWidget and GraphWidget (Lambda metrics)
- **CloudWatch Alarm** - Triggers when Lambda error count exceeds threshold
- **CloudWatch Logs LogGroup** - Log group with 1-week retention
- **SNS Topic** - Receives alarm notifications

## What it tests

- Lambda Function creation with inline code
- CloudWatch Dashboard with multiple widget types (TextWidget, GraphWidget)
- CloudWatch Alarm based on Lambda error metric
- SNS Topic creation
- Alarm action linking alarm to SNS topic
- CloudWatch Logs LogGroup with retention policy and removal policy
- Cross-resource references (Ref, Fn::GetAtt)
- CfnOutputs for resource attributes
- Resource tagging (Project, Example)

## Deploy

```bash
cd tests/integration/monitoring
npm install
cdkd deploy MonitoringStack
```

## Destroy

```bash
cdkd destroy MonitoringStack
```
