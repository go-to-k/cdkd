# SNS → SQS Event-Driven Example

Tests event-driven architecture: SNS topic with multiple SQS subscribers, DLQ, and Lambda processor.

## Resources

- SNS Topic
- 2 SQS Queues (primary + secondary with filter policy)
- SSE-removal queue (L1 `CfnQueue` with `SqsManagedSseEnabled: false`; the
  `CDKD_TEST_REMOVAL=true` redeploy drops the property and asserts the live
  queue resets to the SQS/CFn default SSE-on, in place — issue #1160 sqs batch)
- Delivery-status topic (L1 `CfnTopic` with a two-protocol
  `DeliveryStatusLogging` block — `lambda` and `http/s` — plus an
  `sns.amazonaws.com`-trusted feedback role; the `CDKD_TEST_REMOVAL=true`
  redeploy drops the block and asserts the live per-protocol feedback
  attributes reset for BOTH entries — RoleArns cleared, SampleRate 0, the
  CFn-parity removal shape — issue #1160 sns batch). The `http/s` entry is
  the canonical CDK L2 / CFn spelling of the HTTP family and covers issue
  #1529: it must land under the `HTTP` attribute prefix, and no `HTTPS*`
  attribute (a name `SetTopicAttributes` rejects) may be set.
- A `TopicPolicy` naming two topics `verify.sh` creates outside the stack
  (`CDKD_TEST_POLICY_TOPICS=true`). The `CDKD_TEST_REMOVAL=true` redeploy
  narrows it to the first topic and asserts the dropped topic is back on
  SNS's default policy; the destroy asserts both are (issue #4610).
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
