# SNS → SQS Event-Driven Example

Tests event-driven architecture: SNS topic with multiple SQS subscribers, DLQ, and Lambda processor.

## Resources

- SNS Topic
- 2 SQS Queues (primary + secondary with filter policy)
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
npm install
cdkd deploy --app "npx ts-node --prefer-ts-exts bin/app.ts"
```

## Cleanup

```bash
cdkd destroy --force
```
