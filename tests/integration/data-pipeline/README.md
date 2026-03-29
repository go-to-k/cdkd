# Data Pipeline Integration Test

This example demonstrates cdkd deployment of a data processing pipeline.

## Resources

- **SQS Queue (Input)** - Receives messages for processing
- **SQS Queue (DLQ)** - Dead letter queue for failed messages (maxReceiveCount: 3)
- **Lambda Function** - Inline Python processor that reads SQS messages
- **SQS Event Source Mapping** - Connects input queue to Lambda (batchSize: 10)
- **DynamoDB Table** - Output store for processed data
- **IAM Role/Policy** - Lambda execution role with DynamoDB write and SQS read permissions

## What it tests

- SQS Queue creation with dead letter queue configuration
- Lambda function with inline code and environment variables
- SQS event source mapping with batch size
- DynamoDB table creation (PAY_PER_REQUEST billing)
- IAM permissions via grantWriteData (cross-resource references)
- Ref and Fn::GetAtt resolution across resources
- CfnOutputs for queue URLs, table name, function name
- RemovalPolicy.DESTROY for all resources

## Deploy

```bash
cd tests/integration/data-pipeline
npm install
cdkd deploy DataPipelineStack
```

## Destroy

```bash
cdkd destroy DataPipelineStack
```
