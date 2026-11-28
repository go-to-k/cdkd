import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as assets from 'aws-cdk-lib/aws-s3-assets';
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
 *
 * A second API (`S3Api` / `S3Schema`, go-to-k/cdkd#7139) is an L1
 * `CfnGraphQLSchema` sourced from `DefinitionS3Location` (an S3 asset of the
 * same SDL file; `invalid` keeps it on `v2`), the shape the drift heal reads
 * the declared object for. No resolver: its schema alone is what drift compares.
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

    const s3Variant = variant === 'invalid' ? 'v2' : variant;
    const s3Api = new appsync.CfnGraphQLApi(this, 'S3Api', {
      name: 'cdkd-appsync-schema-s3-heal',
      authenticationType: 'AWS_IAM',
    });
    const schemaAsset = new assets.Asset(this, 'S3SchemaAsset', {
      path: path.join(import.meta.dirname, 'schemas', `${s3Variant}.graphql`),
    });
    new appsync.CfnGraphQLSchema(this, 'S3Schema', {
      apiId: s3Api.attrApiId,
      definitionS3Location: schemaAsset.s3ObjectUrl,
    });
    new cdk.CfnOutput(this, 'S3ApiId', { value: s3Api.attrApiId });
  }
}
