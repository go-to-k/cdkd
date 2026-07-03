# SNS Inline Subscription Example (issue #980)

Tests that the inline `AWS::SNS::Topic` `Subscription` property is created and
updated end-to-end.

CDK's L2 `topic.addSubscription()` emits separate `AWS::SNS::Subscription`
resources, but the L1 `CfnTopic` `subscription: [...]` list (and migrated
CloudFormation templates) declare subscriptions INLINE on the Topic. cdkd
previously dropped that list on both `create()` and `update()` — this fixture
proves the fix reaches AWS.

## Resources

- `AWS::SNS::Topic` (L1 `CfnTopic`) with an inline `subscription` list
- 2 `AWS::SQS::Queue` (L1 `CfnQueue`) — the subscription endpoint switches
  between them across the update phase

## Test Points

- create(): the inline subscription reaches AWS (topic has >= 1 subscription,
  endpoint is queue A)
- update() (`CDKD_TEST_UPDATE=true`): switching the endpoint to queue B
  Subscribes B and Unsubscribes A
- destroy(): topic, subscriptions, and queues are all gone; state file removed

## Run

```bash
STATE_BUCKET=cdkd-state-{accountId} AWS_REGION=us-east-1 ./verify.sh
```
