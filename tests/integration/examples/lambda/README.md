# Lambda Example

A practical example that includes a Lambda function and DynamoDB table.

## Configuration

This stack includes the following resources:

- **DynamoDB Table**: Table for storing items
- **Lambda Function**: Simple function with Python 3.12 runtime
- **IAM Role**: Lambda execution role with DynamoDB access permissions
- **IAM Policy**: Read/write permissions for the DynamoDB table

## Features Tested in cdkq

1. **Lambda Asset Publishing**: Code from `lambda/` directory is uploaded to S3
2. **Ref in Environment Variables**: DynamoDB table name is referenced in the `TABLE_NAME` environment variable
3. **Resource Dependencies**: Lambda → DynamoDB → IAM Role dependency chain
4. **Automatic IAM Policy Generation**: Policy creation via `grantReadWriteData()`
5. **Fn::GetAtt**: Retrieve Lambda ARN and DynamoDB ARN in outputs

## Deploy

```bash
# Install packages
npm install

# Deploy with cdkq
node ../../../dist/cli.js deploy \
  --app "npx ts-node --prefer-ts-exts bin/app.ts" \
  --state-bucket <your-state-bucket> \
  --region us-east-1 \
  --verbose
```

## Test Points

- [ ] Lambda assets are correctly published to S3
- [ ] DynamoDB table is created
- [ ] Lambda function is created with the correct role attached
- [ ] Environment variable `TABLE_NAME` is set to the table name
- [ ] IAM Policy is correctly created and attached to Lambda execution role
- [ ] Outputs are correctly resolved (function name, ARN, etc.)

## Clean up

```bash
node ../../../dist/cli.js destroy \
  --state-bucket <your-state-bucket> \
  --stack LambdaStack \
  --region us-east-1 \
  --force
```
