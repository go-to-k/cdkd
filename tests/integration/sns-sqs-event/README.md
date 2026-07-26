# SNS → SQS Event-Driven Example

Tests event-driven architecture: SNS topic with multiple SQS subscribers, DLQ, and Lambda processor.

## Resources

- SNS Topic
- 2 SQS Queues (primary + secondary with filter policy)
- SSE-removal queue (L1 `CfnQueue` with `SqsManagedSseEnabled: false`; the
  `CDKD_TEST_REMOVAL=true` redeploy drops the property and asserts the live
  queue resets to the SQS/CFn default SSE-on, in place — issue #1160 sqs batch)
- Dead Letter Queue
- Lambda function triggered by primary queue
- IAM roles/policies (auto-created)
- SNS Subscriptions (with filter policy)
- SQS Queue Policies
- Event Source Mapping

## Test Points

- Multiple resource types in single stack
- SQS Queue Policy (SDK provider)
- SNS Subscription with filter policy
- DLQ configuration
- Lambda event source mapping
- Cross-resource references (Fn::GetAtt, Ref)

## Deploy

```bash
vp install
cdkd deploy --app "node bin/app.ts"
```

## Cleanup

```bash
cdkd destroy --force
```
