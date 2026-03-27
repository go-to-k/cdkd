# Serverless API Integration Test

This example demonstrates cdkd deployment of a realistic serverless API pattern.

## Resources

- **API Gateway v2 HTTP API** - L1 CfnApi with `protocolType: 'HTTP'`, CfnStage, CfnIntegration, CfnRoute
- **Lambda Function** - Inline Python handler returning JSON with environment variables
- **DynamoDB Table** - On-demand billing, used for data persistence
- **SNS Topic** - Notification topic with Lambda publish permission
- **IAM Roles/Policies** - Auto-generated via `grantReadWriteData` and `grantPublish`

## What it tests

- API Gateway v2 HTTP API creation via Cloud Control API (CfnApi, CfnStage, CfnIntegration, CfnRoute)
- Lambda function with inline Python code
- DynamoDB table creation with PAY_PER_REQUEST billing
- SNS topic creation
- IAM permission grants (grantReadWriteData, grantPublish)
- Lambda permission for API Gateway invocation
- Cross-resource references (Ref, Fn::GetAtt, Fn::Join)
- Environment variable resolution (TABLE_NAME, TOPIC_ARN)
- CfnOutputs with computed values (API URL construction)
- RemovalPolicy.DESTROY for clean teardown

## Deploy

```bash
cd tests/integration/serverless-api
npm install
cdkd deploy ServerlessApiStack
```

## Destroy

```bash
cdkd destroy ServerlessApiStack
```
