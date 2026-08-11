# AppSync GraphQL API Example

This example demonstrates deploying an AppSync GraphQL API with a DynamoDB data source using cdkd.

## Resources

- **AWS::AppSync::GraphQLApi**: GraphQL API with API_KEY authentication
- **AWS::AppSync::ApiKey**: API key for the GraphQL API
- **AWS::AppSync::GraphQLSchema**: Inline GraphQL schema (Item type with getItem query)
- **AWS::DynamoDB::Table**: Items table as the backing data source
- **AWS::IAM::Role**: Service role for AppSync to access DynamoDB
- **AWS::AppSync::DataSource**: DynamoDB data source configuration
- **AWS::AppSync::DataSource** (second): EventBridge data source —
  `EventBridgeConfig` + `MetricsConfig` (#609), backed by an
  **AWS::Events::EventBus** and an IAM role with `events:PutEvents`
- **AWS::AppSync::DataSource** (third): IAM-signed HTTP data source —
  `HttpConfig.AuthorizationConfig` (#1597), pointed at a real AWS service
  endpoint with an IAM role
- **AWS::AppSync::DataSource** (fourth): versioned DynamoDB data source —
  `DynamoDBConfig.Versioned` + `.DeltaSyncConfig` (#1597), backed by a second
  **AWS::DynamoDB::Table** as the delta-sync store
- **AWS::AppSync::Resolver**: Resolver for the getItem query with VTL mapping
  templates + `MetricsConfig` (#609)
- **AWS::AppSync::Resolver** (second): getItemV2 resolver whose mapping
  templates come from S3 (`RequestMappingTemplateS3Location` /
  `ResponseMappingTemplateS3Location` via `aws-s3-assets` Assets, #609)
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
| removal | `CDKD_TEST_REMOVAL=true` | the GraphQLApi properties with an AWS reset sentinel are actively RESET (AppSync treats an omitted `UpdateGraphqlApi` member as "no change"), while `EnhancedMetricsConfig` stays retained |

The API also asserts `provisionedBy == sdk` (for the GraphQLApi row AND every
Resolver / DataSource row), so a property slipping back out of
`handledProperties` (which would silently re-route the resource to Cloud
Control under #614) fails the run.

## Issue #609 Resolver + DataSource coverage

The same three phases also exercise the Resolver/DataSource batch:

- **Resolver `MetricsConfig`** — live on the getItem resolver. The removal
  phase drops it and asserts AWS cleared it to `DISABLED`: unlike
  `UpdateGraphqlApi`, `UpdateResolver` / `UpdateDataSource` are FULL-REPLACE
  writes (an omitted member is cleared server-side), so removal needs no reset
  sentinel — this phase is the live pin of that semantic. The EventBridge data
  source RETAINS its own `MetricsConfig` so a blanket wipe cannot pass.
- **`RequestMappingTemplateS3Location` / `ResponseMappingTemplateS3Location`**
  — live on the getItemV2 resolver via `aws-s3-assets` Assets; verify.sh
  asserts the live template equals the local asset file (cdkd fetched the S3
  body and inlined it, mirroring CFn). The update phase switches the request
  template to a v2 asset (new S3 key) and asserts the re-fetched body.
- **DataSource `EventBridgeConfig` + `MetricsConfig`** — live via the
  EventBridge data source (`AMAZON_EVENTBRIDGE` + a real `AWS::Events::EventBus`).

## Issue #1597 DataSource NESTED-config coverage

The nested-key critic opt-in for `AWS::AppSync::DataSource` exposed two silent
drops one level BELOW a handled top-level property, so nothing in the #609
coverage above could see them. Both are now live across the same three phases:

- **`HttpConfig.AuthorizationConfig`** (+ `AuthorizationType` /
  `AwsIamConfig.SigningRegion` / `.SigningServiceName`) — an unsigned data
  source deploys perfectly happily, so the create assertions read the signing
  config straight back off `GetDataSource`. The update phase moves
  `SigningRegion` (a member two levels deep) and the removal phase drops the
  whole block while `HttpConfig.Endpoint` stays put as the retained sibling.
- **`DynamoDBConfig.DeltaSyncConfig` + `.Versioned`** — the delta-sync TTLs are
  the one CFn->SDK TYPE divergence in the batch (CFn declares them as STRINGS,
  the SDK models them as longs), so the assertions pin the converted numeric
  values AWS echoes back. `Versioned` is the retained sibling of the
  `DeltaSyncConfig` removal.

**Not exercised live**, and covered by unit tests instead:

- top-level `UserPoolConfig` — requires `AuthenticationType:
  AMAZON_COGNITO_USER_POOLS` as the PRIMARY auth mode, which this fixture uses
  for an ADDITIONAL provider instead (that path maps the sibling
  `CognitoUserPoolConfig` shape, which has no `DefaultAction`)
- `MergedApiExecutionRoleArn` — only valid on `ApiType: MERGED`
- `Visibility: PRIVATE` — needs a VPC endpoint
- Resolver `CachingConfig` — needs a provisioned AppSync ApiCache
  (`AWS::AppSync::ApiCache`, hourly-billed cache instance)
- Resolver `SyncConfig` — the fixture now carries a VERSIONED delta-sync data
  source (#1597), but a `SyncConfig` resolver additionally needs the versioned
  store to back the resolver's own type, which this schema does not model
- Resolver `MaxBatchSize` — only meaningful on a Lambda direct /
  `BATCH_INVOKE` resolver, which needs a Lambda data-source arrangement this
  fixture does not carry
- Resolver `CodeS3Location` — unit-only; it rides the SAME fetch-and-inline
  helper the mapping-template S3Locations prove live
- DataSource `OpenSearchServiceConfig` / `ElasticsearchConfig` — need a real
  OpenSearch domain (30+ min create, hourly cost)
- DataSource `RelationalDatabaseConfig` — needs an Aurora Serverless cluster
  with the Data API

(unit coverage: `tests/unit/provisioning/appsync-resolver-datasource-props.test.ts`)

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
