# Multi-Resource Example

This example implements a practical microservice architecture with multiple AWS resources and complex dependencies.

## Purpose

Implement realistic serverless application patterns and verify that cdkd properly handles:

- Multiple resource types (S3, Lambda, DynamoDB, SQS, IAM)
- Complex dependency graphs
- Cross-resource references and permission configuration
- Event-driven architecture
- Incremental updates and change detection

## Architecture

This stack implements an event-driven data processing pipeline:

```
S3 Bucket (uploads/)
    → S3 Event Notification
        → SQS Queue (buffering)
            → Lambda Function (processor)
                → DynamoDB Table (metadata)
```

### Components

1. **S3 Data Bucket**
   - Store data files
   - Versioning enabled
   - Lifecycle rules (IA transition, old version deletion)
   - Event notification configuration (.json, .csv files)

2. **SQS Processing Queue**
   - Buffer for S3 events
   - Visibility timeout: 5 minutes
   - Long polling enabled (20 seconds)
   - Message retention period: 4 days

3. **SQS Dead Letter Queue**
   - Store failed processing messages
   - Message retention period: 14 days

4. **Lambda Processor Function**
   - Python 3.12 runtime
   - Process S3 events
   - Save metadata to DynamoDB
   - Batch processing (max 10 messages)
   - Partial batch response support

5. **DynamoDB Metadata Table**
   - Store file metadata
   - Partition Key: fileId
   - Sort Key: timestamp
   - GSI: StatusIndex (status + timestamp)
   - On-demand billing

6. **IAM Role & Policies**
   - Lambda execution role
   - S3 read permissions
   - DynamoDB write permissions
   - SQS consume permissions
   - CloudWatch Logs permissions

## Features Tested in cdkd

This example tests the following cdkd features:

### 1. Dependency Graph Construction
- Detect implicit dependencies between resources
- Determine correct deployment order
- Check for circular dependencies

### 2. Resource Type Diversity
- Compute (Lambda)
- Storage (S3, DynamoDB)
- Messaging (SQS)
- Security (IAM)
- Resource type-specific properties

### 3. Reference Resolution
- Attribute references via Fn::GetAtt
- Logical ID references via Fn::Ref
- Cross-resource references

### 4. Permission Management
- Create IAM roles and policies
- Resource-based policies (S3→SQS)
- Grant permissions between services

### 5. Event-Driven Configuration
- S3 event notifications
- Lambda SQS event source
- Event filtering

### 6. Update Scenarios
- Detect property changes
- Generate JSON Patch
- Identify changes requiring resource replacement

## Deployment Instructions

### Prerequisites
```bash
cd tests/integration/examples/multi-resource
npm install
npm run build
```

### Initial Deployment
```bash
cdkd deploy
```

The following resources will be created during deployment:
- 1x DynamoDB Table (including GSI)
- 1x S3 Bucket
- 2x SQS Queue (main and DLQ)
- 1x Lambda Function
- 1x IAM Role
- Multiple IAM Policies
- S3 event notification configuration

### Test Procedures

#### 1. Upload File to S3
```bash
# Use the bucket name obtained from Outputs
BUCKET_NAME=$(aws cloudformation describe-stacks \
  --stack-name CdkdMultiResourceExample \
  --query 'Stacks[0].Outputs[?OutputKey==`DataBucketName`].OutputValue' \
  --output text)

# Create and upload test file
echo '{"test": "data"}' > test.json
aws s3 cp test.json s3://$BUCKET_NAME/uploads/test.json
```

#### 2. Check Lambda Execution Logs
```bash
FUNCTION_NAME=$(aws cloudformation describe-stacks \
  --stack-name CdkdMultiResourceExample \
  --query 'Stacks[0].Outputs[?OutputKey==`ProcessorFunctionName`].OutputValue' \
  --output text)

aws logs tail /aws/lambda/$FUNCTION_NAME --follow
```

#### 3. Check Metadata Stored in DynamoDB
```bash
TABLE_NAME=$(aws cloudformation describe-stacks \
  --stack-name CdkdMultiResourceExample \
  --query 'Stacks[0].Outputs[?OutputKey==`MetadataTableName`].OutputValue' \
  --output text)

aws dynamodb scan --table-name $TABLE_NAME
```

### Update Scenarios

#### Scenario 1: Change Lambda Memory Size
```typescript
// lib/multi-resource-stack.ts
memorySize: 1024,  // Change from 512 to 1024
```

Expected behavior:
- cdkd detects memory size change
- Update property with JSON Patch
- Lambda function is not recreated (update only)

#### Scenario 2: Add DynamoDB GSI
```typescript
metadataTable.addGlobalSecondaryIndex({
  indexName: 'BucketIndex',
  partitionKey: {
    name: 'bucketName',
    type: dynamodb.AttributeType.STRING,
  },
});
```

Expected behavior:
- cdkd detects new GSI
- Add GSI to DynamoDB table
- Existing data is preserved

#### Scenario 3: Change S3 Lifecycle Rules
```typescript
transitions: [
  {
    storageClass: s3.StorageClass.INFREQUENT_ACCESS,
    transitionAfter: cdk.Duration.days(60),  // Change from 90 to 60
  },
],
```

Expected behavior:
- cdkd detects lifecycle rule change
- Update rules with JSON Patch
- S3 bucket is not recreated

## Dependency Graph

The dependencies in this stack are as follows:

```
DynamoDB Table
    ↓ (grants write)
IAM Role ← (assumes) Lambda Service Principal
    ↓ (uses)
Lambda Function
    ↑ (event source)
SQS Queue ← (notification) S3 Bucket
    ↑ (grants send)
S3 Service Principal
```

cdkd creates resources in the following order:
1. DynamoDB Table
2. S3 Bucket
3. SQS Queues (DLQ, Processing Queue)
4. IAM Role
5. Lambda Function
6. S3 Event Notification
7. Lambda Event Source Mapping

## Expected Behavior

### Initial Deployment
- All resources are created in the correct order
- IAM permissions are properly configured
- Event notifications work correctly

### On File Upload
1. File is uploaded to S3
2. S3 event notification is sent to SQS
3. SQS message triggers Lambda
4. Lambda processes file metadata
5. Metadata is saved to DynamoDB

### Update Deployment
- Only changed resources are updated
- Dependencies are preserved
- Data is not lost (except for RemovalPolicy.DESTROY configuration)

### Stack Deletion
- Resources are deleted in reverse dependency order
- S3 bucket is auto-deleted (autoDeleteObjects: true)
- DynamoDB table is deleted (RemovalPolicy.DESTROY)

## Troubleshooting

### If Lambda is Not Executing
```bash
# Check if there are messages in the SQS queue
aws sqs get-queue-attributes \
  --queue-url <QUEUE_URL> \
  --attribute-names ApproximateNumberOfMessages

# Check Lambda event source mapping
aws lambda list-event-source-mappings \
  --function-name <FUNCTION_NAME>
```

### If Cannot Write to DynamoDB
```bash
# Check IAM role permissions
aws iam get-role-policy \
  --role-name <ROLE_NAME> \
  --policy-name <POLICY_NAME>
```

### If S3 Event Notifications Not Working
```bash
# Check bucket notification configuration
aws s3api get-bucket-notification-configuration \
  --bucket <BUCKET_NAME>
```

## Related Documentation

- [AWS Lambda with SQS](https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html)
- [S3 Event Notifications](https://docs.aws.amazon.com/AmazonS3/latest/userguide/NotificationHowTo.html)
- [DynamoDB Global Secondary Indexes](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GSI.html)
- [AWS CDK Construct Library](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-construct-library.html)
