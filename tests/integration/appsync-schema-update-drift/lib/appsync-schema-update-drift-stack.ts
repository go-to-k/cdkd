import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import type { Construct } from 'constructs';

/**
 * An AppSync GraphQL API whose schema `verify.sh` changes between deploys
 * (go-to-k/cdkd#7127). `CDKD_TEST_SCHEMA` picks the SDL file:
 *
 * - `v1` (default): `type Query { a: String }`, a resolver on `Query.a`.
 * - `v2`: adds `Query.b` and a resolver on it.
 * - `invalid`: v2's resolvers over a schema AppSync refuses (`NoSuchType`).
 *
 * IAM auth and a None data source keep it cheap: no key, no backing store.
 */
export class AppSyncSchemaUpdateDriftStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const variant = process.env.CDKD_TEST_SCHEMA ?? 'v1';
    if (!['v1', 'v2', 'invalid'].includes(variant)) {
      throw new Error(`CDKD_TEST_SCHEMA must be v1, v2 or invalid (got ${variant})`);
    }

    const api = new appsync.GraphqlApi(this, 'Api', {
      name: 'cdkd-appsync-schema-update-drift',
      definition: appsync.Definition.fromSchema(
        appsync.SchemaFile.fromAsset(path.join(import.meta.dirname, 'schemas', `${variant}.graphql`))
      ),
      authorizationConfig: {
        defaultAuthorization: { authorizationType: appsync.AuthorizationType.IAM },
      },
    });

    const none = api.addNoneDataSource('NoneDs');
    const code = (value: string): appsync.Code =>
      appsync.Code.fromInline(
        `export function request(ctx) { return { payload: null }; }\n` +
          `export function response(ctx) { return ${JSON.stringify(value)}; }\n`
      );

    none.createResolver('QueryA', {
      typeName: 'Query',
      fieldName: 'a',
      runtime: appsync.FunctionRuntime.JS_1_0_0,
      code: code('a'),
    });
    if (variant !== 'v1') {
      none.createResolver('QueryB', {
        typeName: 'Query',
        fieldName: 'b',
        runtime: appsync.FunctionRuntime.JS_1_0_0,
        code: code('b'),
      });
    }

    new cdk.CfnOutput(this, 'ApiId', { value: api.apiId });
  }
}
