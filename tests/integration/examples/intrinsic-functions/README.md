# Intrinsic Functions Example

This example demonstrates cdkq's ability to resolve CloudFormation intrinsic functions during deployment.

## Features

This stack tests the following intrinsic function types:

- **Ref**: References to resource physical IDs (e.g., bucket name)
- **Fn::GetAtt**: Get resource attributes (e.g., bucket ARN, role ARN)
- **Fn::Join**: String concatenation (e.g., `bucket-arn/*`)
- **Fn::Sub**: String substitution (implicit in CDK constructs)

## Resources

- **AWS::S3::Bucket**: S3 bucket (no dependencies)
- **AWS::IAM::Role**: IAM role that references the bucket
- **AWS::IAM::Policy**: Inline policy using bucket ARN (Fn::GetAtt)

## Dependency Graph

```
S3 Bucket
    ↓ (Ref, Fn::GetAtt)
IAM Role
    ↓
IAM Policy (inline)
```

## Deploy

```bash
# Set environment variables
export STATE_BUCKET="your-cdkq-state-bucket"
export AWS_REGION="us-east-1"

# Bootstrap (first time only)
node ../../../../dist/cli.js bootstrap \
  --state-bucket ${STATE_BUCKET} \
  --region ${AWS_REGION}

# Deploy
node ../../../../dist/cli.js deploy \
  --app "npx ts-node --prefer-ts-exts bin/app.ts" \
  --state-bucket ${STATE_BUCKET} \
  --region ${AWS_REGION} \
  --verbose
```

## Expected Behavior

During deployment, you should see logs like:

```
Resolved Ref to resource: TestBucket560B80BC -> actual-bucket-name
Resolved Fn::GetAtt: TestBucket560B80BC.Arn -> arn:aws:s3:::actual-bucket-name
Resolved Fn::Join: arn:aws:s3:::actual-bucket-name/*
```

## Clean up

```bash
node ../../../../dist/cli.js destroy \
  --state-bucket ${STATE_BUCKET} \
  --stack CdkqIntrinsicFunctionsExample \
  --region ${AWS_REGION} \
  --force
```

## What This Tests

1. **Dependency Analysis**: cdkq correctly identifies that IAM role depends on S3 bucket
2. **Intrinsic Function Resolution**: cdkq resolves Ref and Fn::GetAtt before provisioning
3. **Attribute Enrichment**: cdkq generates missing attributes (e.g., S3 bucket ARN) when Cloud Control API doesn't return them
4. **SDK Providers**: cdkq uses IAM SDK provider for IAM::Policy (not supported by Cloud Control API)
