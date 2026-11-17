import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as s3vectors from 'aws-cdk-lib/aws-s3vectors';

/**
 * The value each routing phase declares on every resource under test.
 * Consecutive deploys must differ: one the differ calls NO_CHANGE never
 * provisions a resource, so it could not flip. verify.sh runs its `cdkd diff`
 * with `pinned`, because `seed` and `flip` declare the same value.
 */
const VALUE_BY_PHASE: Record<string, 'a' | 'b'> = {
  base: 'a',
  seed: 'b',
  pinned: 'a',
  flip: 'b',
};

/** The authorizer's cache TTL in each value: the mutable property it changes. */
const AUTHORIZER_TTL: Record<'a' | 'b', number> = { a: 300, b: 120 };

/**
 * physicalId-parity arm for issue 6490, batch 8: an `AWS::ApiGatewayV2::Stage`,
 * `::Integration`, `::Route` and `::Authorizer`, an `AWS::AppSync::GraphQLApi`
 * and an `AWS::S3Vectors::VectorBucket`, each recorded
 * `provisionedBy: 'cc-api'`, return to the SDK provider without churn.
 *
 * covers: AWS::ApiGatewayV2::Stage
 * covers: AWS::ApiGatewayV2::Integration
 * covers: AWS::ApiGatewayV2::Route
 * covers: AWS::ApiGatewayV2::Authorizer
 * covers: AWS::AppSync::GraphQLApi
 * covers: AWS::S3Vectors::VectorBucket
 *
 * Every id DIFFERS between the layers (measured us-east-1, 2026-11-17): Cloud
 * Control records `<apiId>|<stageName>`, `<apiId>|<integrationId>`,
 * `<apiId>|<routeId>`, `<authorizerId>|<apiId>` (API id LAST), the GraphQL
 * API's ARN and the vector bucket's ARN; the SDK providers record the bare id
 * or name, and each exemption entry's normalizer keeps it on the flip.
 *
 * Mutable properties: the stage's and integration's Description, the route's
 * OperationName, the authorizer's AuthorizerResultTtlInSeconds, the GraphQL
 * API's XrayEnabled and the vector bucket's Tags (its only mutable property).
 * No resource under test is referenced by another one, and each logical id is
 * fixed. The HTTP API stays on the SDK route and never changes.
 *
 * The authorizer is a REQUEST authorizer whose URI names a function that does
 * not exist: API Gateway does not resolve it until a request is authorized,
 * and nothing calls the API. The route has no target, which an HTTP API
 * allows.
 */
export class CcToSdkRerouteCommonTypes8Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const phase = process.env.CDKD_TEST_PHASE ?? 'base';
    const value = VALUE_BY_PHASE[phase] ?? 'a';
    // `removed`: the resources under test leave the template while the HTTP
    // API stays, so their deletes run on the flipped records and the v2
    // children can be probed gone with their parent still alive (a deleted
    // API takes its children with it, which would hide a delete sent to the
    // wrong id).
    const removed = phase === 'removed';

    const api = new apigwv2.CfnApi(this, 'RerouteHttpApi', {
      name: 'cdkd-reroute-common-types-8',
      protocolType: 'HTTP',
      description: 'cdkd sticky-CC reroute batch 8',
    });
    api.overrideLogicalId('RerouteHttpApi');

    new cdk.CfnOutput(this, 'HttpApiId', { value: api.ref });
    if (removed) return;

    const stage = new apigwv2.CfnStage(this, 'RerouteStage', {
      apiId: api.ref,
      stageName: 'reroute',
      description: `phase-${value}`,
    });
    stage.overrideLogicalId('RerouteStage');

    const integration = new apigwv2.CfnIntegration(this, 'RerouteIntegration', {
      apiId: api.ref,
      integrationType: 'HTTP_PROXY',
      integrationMethod: 'GET',
      integrationUri: 'https://example.com',
      payloadFormatVersion: '1.0',
      description: `phase-${value}`,
    });
    integration.overrideLogicalId('RerouteIntegration');

    const route = new apigwv2.CfnRoute(this, 'RerouteRoute', {
      apiId: api.ref,
      routeKey: 'GET /reroute',
      operationName: `phase-${value}`,
    });
    route.overrideLogicalId('RerouteRoute');

    const authorizer = new apigwv2.CfnAuthorizer(this, 'RerouteAuthorizer', {
      apiId: api.ref,
      name: 'cdkd-reroute-ct8-authorizer',
      authorizerType: 'REQUEST',
      authorizerPayloadFormatVersion: '2.0',
      enableSimpleResponses: true,
      identitySource: ['$request.header.Authorization'],
      authorizerUri: `arn:${this.partition}:apigateway:${this.region}:lambda:path/2015-03-31/functions/arn:${this.partition}:lambda:${this.region}:${this.account}:function:cdkd-reroute-ct8-none/invocations`,
      authorizerResultTtlInSeconds: AUTHORIZER_TTL[value],
    });
    authorizer.overrideLogicalId('RerouteAuthorizer');

    const graphqlApi = new appsync.CfnGraphQLApi(this, 'RerouteGraphQLApi', {
      name: 'cdkd-reroute-ct8-gql',
      authenticationType: 'API_KEY',
      xrayEnabled: value === 'b',
    });
    graphqlApi.overrideLogicalId('RerouteGraphQLApi');

    const vectorBucket = new s3vectors.CfnVectorBucket(this, 'RerouteVectorBucket', {
      vectorBucketName: 'cdkd-reroute-ct8-vb',
      tags: [{ key: 'phase', value: `phase-${value}` }],
    });
    vectorBucket.overrideLogicalId('RerouteVectorBucket');

    new cdk.CfnOutput(this, 'StageRef', { value: stage.ref });
    new cdk.CfnOutput(this, 'IntegrationRef', { value: integration.ref });
    new cdk.CfnOutput(this, 'RouteRef', { value: route.ref });
    new cdk.CfnOutput(this, 'AuthorizerRef', { value: authorizer.ref });
    // Ref of both is the ARN, on either layer; GetAtt ApiId is the bare id.
    new cdk.CfnOutput(this, 'GraphQLApiRef', { value: graphqlApi.ref });
    new cdk.CfnOutput(this, 'GraphQLApiId', { value: graphqlApi.attrApiId });
    new cdk.CfnOutput(this, 'VectorBucketRef', { value: vectorBucket.ref });
  }
}
