# import-migrate-appsync

`cdkd import --migrate-from-cloudformation` over every AppSync type cdkd
provisions (issue [#5364](https://github.com/go-to-k/cdkd/issues/5364)).

CloudFormation and cdkd identify these resources differently:

| Resource | CloudFormation's physical id | cdkd's physical id |
|---|---|---|
| `AWS::AppSync::GraphQLApi` | the API ARN | `<apiId>` |
| `AWS::AppSync::GraphQLSchema` | `<apiId>GraphQLSchema` | `<apiId>` |
| `AWS::AppSync::DataSource` | the data source ARN | `<apiId>\|<name>` |
| `AWS::AppSync::Resolver` | the resolver ARN | `<apiId>\|<type>\|<field>` |
| `AWS::AppSync::ApiKey` | the key ARN (`.../apikeys/<id>`) | `<apiId>\|<keyId>` |

Before the fix the import recorded CloudFormation's ids verbatim: the API was
reported not found, and `cdkd drift` read the schema as deleted.

The run asserts every record carries cdkd's id, that `cdkd drift` reports none
of them drifted or deleted, that an unchanged `cdkd deploy` updates nothing, and
that cdkd's stack outputs (the API key's `Arn` / `Ref`, the schema's `Ref` and `Id`) equal
CloudFormation's (issue [#5540](https://github.com/go-to-k/cdkd/issues/5540)).
It then destroys with gone-probes.

## Run

```bash
STATE_BUCKET=<your-cdkd-state-bucket> ./verify.sh
```
