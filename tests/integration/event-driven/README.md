# Event-Driven Architecture Example

Tests a combined event-driven architecture with multiple event sources and patterns.

## Resources

- SQS Queue + Lambda with Event Source Mapping (SQS triggers Lambda)
- SNS Topic + Lambda Subscription (SNS triggers Lambda)
- S3 Bucket with event notification to Lambda (S3 OBJECT_CREATED triggers Lambda)
- Secrets Manager Secret (generateSecretString) with env var on Lambda
- 3 Lambda functions (Python inline code, each with auto-generated IAM role)
- IAM roles/policies (auto-created by CDK)
- CfnOutputs for queue URL, topic ARN, bucket name, secret ARN

## Test Points

- Multiple event source patterns in a single stack
- SQS Event Source Mapping (SDK provider)
- SNS Lambda Subscription (SDK provider)
- S3 event notification with LambdaDestination (Custom Resource)
- Secrets Manager Secret with generateSecretString
- Lambda environment variables referencing secret ARN
- Cross-resource references (Fn::GetAtt, Ref)
- RemovalPolicy.DESTROY on all resources

## Deploy

```bash
npm install
cdkd deploy --app "npx ts-node --prefer-ts-exts bin/app.ts"
```

## Cleanup

```bash
cdkd destroy --force
```
