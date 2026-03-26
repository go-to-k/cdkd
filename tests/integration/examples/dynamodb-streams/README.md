# DynamoDB Streams Example

A practical example that includes a DynamoDB table with streams enabled and a Lambda function triggered by stream events.

## Configuration

This stack includes the following resources:

- **DynamoDB Table**: Table with stream enabled (NEW_AND_OLD_IMAGES)
- **Lambda Function**: Inline Python function that processes stream records
- **Event Source Mapping**: Connects DynamoDB stream to Lambda
- **IAM Role**: Lambda execution role with DynamoDB stream read permissions

## Features Tested in cdkd

1. **DynamoDB Streams**: Table created with `StreamViewType.NEW_AND_OLD_IMAGES`
2. **Inline Lambda Code**: Function deployed with inline Python code (no asset publishing)
3. **Event Source Mapping**: AWS::Lambda::EventSourceMapping resource creation
4. **Ref in Environment Variables**: DynamoDB table name referenced in `TABLE_NAME` environment variable
5. **Resource Dependencies**: Lambda -> DynamoDB -> IAM Role -> Event Source Mapping dependency chain
6. **Fn::GetAtt**: Retrieve table ARN, stream ARN, and function name in outputs
7. **Automatic IAM Policy Generation**: Stream read permissions via `addEventSource()`

## Deploy

```bash
# Install packages
npm install

# Deploy with cdkd
node ../../../dist/cli.js deploy \
  --app "npx ts-node --prefer-ts-exts bin/app.ts" \
  --state-bucket <your-state-bucket> \
  --region us-east-1 \
  --verbose
```

## Test Points

- [ ] DynamoDB table is created with stream enabled
- [ ] Stream ARN is available via Fn::GetAtt
- [ ] Lambda function is created with inline code
- [ ] Event source mapping is created connecting stream to Lambda
- [ ] IAM policy grants DynamoDB stream read permissions to Lambda
- [ ] Environment variable `TABLE_NAME` is set to the table name
- [ ] Outputs are correctly resolved (table name, table ARN, stream ARN, function name)

## Clean up

```bash
node ../../../dist/cli.js destroy \
  --state-bucket <your-state-bucket> \
  --stack DynamodbStreamsStack \
  --region us-east-1 \
  --force
```
