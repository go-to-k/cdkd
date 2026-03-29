# AppSync GraphQL API Example

This example demonstrates deploying an AppSync GraphQL API with a DynamoDB data source using cdkd.

## Resources

- **AWS::AppSync::GraphQLApi**: GraphQL API with API_KEY authentication
- **AWS::AppSync::ApiKey**: API key for the GraphQL API
- **AWS::AppSync::GraphQLSchema**: Inline GraphQL schema (Item type with getItem query)
- **AWS::DynamoDB::Table**: Items table as the backing data source
- **AWS::IAM::Role**: Service role for AppSync to access DynamoDB
- **AWS::AppSync::DataSource**: DynamoDB data source configuration
- **AWS::AppSync::Resolver**: Resolver for the getItem query with VTL mapping templates

## Deploy

```bash
# Set environment variables
export STATE_BUCKET="your-cdkd-state-bucket"
export AWS_REGION="us-east-1"

# Deploy
node ../../../dist/cli.js deploy \
  --app "npx ts-node --prefer-ts-exts bin/app.ts" \
  --state-bucket ${STATE_BUCKET} \
  --region ${AWS_REGION} \
  --verbose
```

## Clean up

```bash
node ../../../dist/cli.js destroy \
  --app "npx ts-node --prefer-ts-exts bin/app.ts" \
  --state-bucket ${STATE_BUCKET} \
  --region ${AWS_REGION} \
  --force
```
