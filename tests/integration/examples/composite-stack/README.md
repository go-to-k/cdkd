# Composite Stack Example

Tests many diverse resource types in a single stack to identify unsupported resources in cdkq.

## Resource Types

This stack creates the following resources (20+ total including auto-generated IAM):

| # | Resource Type | Logical ID | Notes |
|---|--------------|------------|-------|
| 1 | AWS::KMS::Key | EncryptionKey | With key rotation enabled |
| 2 | AWS::KMS::Alias | EncryptionKeyAlias | Alias for the KMS key |
| 3 | AWS::S3::Bucket | DataBucket | Versioned, DESTROY removal policy |
| 4 | AWS::DynamoDB::Table | ItemsTable | PK + SK, PAY_PER_REQUEST |
| 5 | AWS::SQS::Queue | DeadLetterQueue | 14-day retention |
| 6 | AWS::SQS::Queue | PrimaryQueue | With DLQ, 60s visibility |
| 7 | AWS::SNS::Topic | NotificationTopic | With display name |
| 8 | AWS::SNS::Subscription | (auto) | SQS subscription to SNS topic |
| 9 | AWS::SQS::QueuePolicy | (auto) | Allow SNS to send to SQS |
| 10 | AWS::Logs::LogGroup | AppLogGroup | 1-week retention, DESTROY |
| 11 | AWS::IAM::Role | CustomRole | Lambda execution role with inline policy |
| 12 | AWS::IAM::Policy | (auto) | Inline policy for S3 + DynamoDB access |
| 13 | AWS::Lambda::Function | ProcessorFunction | Inline Node.js code, custom role |
| 14 | AWS::Lambda::Url | (auto) | Function URL with no auth |
| 15 | AWS::Lambda::Permission | (auto) | Allow public invoke via URL |
| 16 | AWS::CloudWatch::Alarm | LambdaErrorAlarm | On Lambda errors metric |
| 17 | AWS::SecretsManager::Secret | AppSecret | Generated secret string |
| 18 | AWS::SSM::Parameter | ConfigParameter | JSON config string |

Plus auto-generated resources from CDK (IAM policies, Lambda permissions, etc.) bringing the total above 20.

## Deploy

```bash
cdkq deploy CdkqCompositeStackExample
```

## Destroy

```bash
cdkq destroy CdkqCompositeStackExample
```

## What This Tests

- Cloud Control API compatibility for diverse resource types
- SDK Provider fallback for IAM resources
- Complex dependency graphs (Lambda depends on IAM Role, S3, DynamoDB, LogGroup, SNS)
- Intrinsic function resolution (Ref, Fn::GetAtt) across many resource types
- Parallel deployment of independent resources (S3, DynamoDB, SQS, KMS can deploy in parallel)
- Proper deletion order for tightly coupled resources
