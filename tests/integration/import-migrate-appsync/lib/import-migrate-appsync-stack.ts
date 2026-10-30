import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as appsync from 'aws-cdk-lib/aws-appsync';

/**
 * Integ probe for `cdkd import --migrate-from-cloudformation` over every AppSync
 * type cdkd provisions (issue #5364). CloudFormation identifies the API, data
 * source, resolver and API key by ARN and the schema as `<apiId>GraphQLSchema`;
 * before the fix the import recorded those verbatim, so the API was not found
 * and the schema's reads addressed an API that does not exist.
 */
export class ImportMigrateAppSyncStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const pin = (c: cdk.CfnResource, logicalId: string) => c.overrideLogicalId(logicalId);

    const api = new appsync.CfnGraphQLApi(this, 'Api', {
      name: 'cdkd-integ-import-migrate-appsync',
      authenticationType: 'API_KEY',
    });
    pin(api, 'Api');

    const schema = new appsync.CfnGraphQLSchema(this, 'Schema', {
      apiId: api.attrApiId,
      definition: 'type Query {\n  hello: String\n}\n',
    });
    pin(schema, 'Schema');

    const key = new appsync.CfnApiKey(this, 'Key', { apiId: api.attrApiId });
    pin(key, 'Key');

    const dataSource = new appsync.CfnDataSource(this, 'Ds', {
      apiId: api.attrApiId,
      name: 'NoneDs',
      type: 'NONE',
    });
    pin(dataSource, 'Ds');

    const resolver = new appsync.CfnResolver(this, 'Res', {
      apiId: api.attrApiId,
      typeName: 'Query',
      fieldName: 'hello',
      dataSourceName: dataSource.attrName,
      requestMappingTemplate: '{"version":"2017-02-28","payload":{}}',
      responseMappingTemplate: '$util.toJson($context.result)',
    });
    pin(resolver, 'Res');
    resolver.addDependency(schema);

    // Issue #5540: CloudFormation's values are the oracle for cdkd's. The
    // run captures these from `cdk deploy` and compares cdkd's after the
    // migrate: the API key's `Arn` / `Ref` (`.../apikeys/<id>`) and the
    // schema's `Ref` (`<apiId>GraphQLSchema`).
    new cdk.CfnOutput(this, 'KeyArn', { value: key.attrArn });
    new cdk.CfnOutput(this, 'KeyRef', { value: key.ref });
    new cdk.CfnOutput(this, 'SchemaRef', { value: schema.ref });
  }
}
