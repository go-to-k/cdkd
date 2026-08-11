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
- **AWS::Cognito::UserPool** / **AWS::Lambda::Function** / **AWS::Lambda::Permission** /
  **AWS::IAM::Role**: backing resources for the additional authentication providers
  (Cognito + Lambda authorizer) the GraphQL API declares

## Issue #609 config-property coverage

`verify.sh` drives three phases and reads every value back off AWS
(`GetGraphqlApi` / `GetGraphqlApiEnvironmentVariables`), because a near-miss SDK
member spelling is dropped by the serializer with a fully green deploy:

| Phase | Env | What it proves |
| --- | --- | --- |
| baseline | — | every config property reached AWS |
| update | `CDKD_TEST_UPDATE=true` | every mutable property is re-sent on a change |
| removal | `CDKD_TEST_REMOVAL=true` | the properties with an AWS reset sentinel are actively RESET (AppSync treats an omitted member as "no change"), while `EnhancedMetricsConfig` stays retained |

The API also asserts `provisionedBy == sdk`, so a property slipping back out of
`handledProperties` (which would silently re-route the resource to Cloud
Control under #614) fails the run.

**Not exercised live**, and covered by unit tests instead:

- top-level `UserPoolConfig` — requires `AuthenticationType:
  AMAZON_COGNITO_USER_POOLS` as the PRIMARY auth mode, which this fixture uses
  for an ADDITIONAL provider instead (that path maps the sibling
  `CognitoUserPoolConfig` shape, which has no `DefaultAction`)
- `MergedApiExecutionRoleArn` — only valid on `ApiType: MERGED`
- `Visibility: PRIVATE` — needs a VPC endpoint

## Deploy

```bash
# Set environment variables
export STATE_BUCKET="your-cdkd-state-bucket"
export AWS_REGION="us-east-1"

# Deploy
node ../../../dist/cli.js deploy \
  --app "node bin/app.ts" \
  --state-bucket ${STATE_BUCKET} \
  --region ${AWS_REGION} \
  --verbose
```

## Clean up

```bash
node ../../../dist/cli.js destroy \
  --app "node bin/app.ts" \
  --state-bucket ${STATE_BUCKET} \
  --region ${AWS_REGION} \
  --force
```
