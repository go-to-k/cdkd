# EventBridge Integration Test

This example tests EventBridge resource deployment with cdkd.

## Resources Created

- **Custom EventBridge Bus** - A custom event bus (`AWS::Events::EventBus`)
- **EventBridge Rule** - A scheduled rule on the custom bus with `rate(1 hour)` (`AWS::Events::Rule`)
- **Lambda Function** - Inline Python function as the rule target (`AWS::Lambda::Function`)
- **Lambda Permission** - Allows EventBridge to invoke the Lambda function (`AWS::Lambda::Permission`)
- **IAM Role** - Execution role for the Lambda function (`AWS::IAM::Role`)

## What This Tests

- EventBridge event bus creation via Cloud Control API
- EventBridge rule with schedule expression
- Lambda function with inline code (no asset publishing)
- Cross-resource dependencies (Rule depends on Bus and Lambda)
- IAM permission grants for EventBridge-to-Lambda invocation
- `Fn::GetAtt` for rule ARN, bus name, and function name outputs

## Deploy

```bash
cd tests/integration/examples/eventbridge
npm install
cdkd deploy EventBridgeStack
```

## Destroy

```bash
cdkd destroy EventBridgeStack
```
