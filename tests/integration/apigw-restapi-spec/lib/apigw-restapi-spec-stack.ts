import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

/** A mock GET operation in OpenAPI with the API Gateway integration extension. */
function mockGet(): Record<string, unknown> {
  return {
    get: {
      responses: { '200': { description: 'ok' } },
      'x-amazon-apigateway-integration': {
        type: 'mock',
        requestTemplates: { 'application/json': '{"statusCode": 200}' },
        responses: { default: { statusCode: '200' } },
      },
    },
  };
}

function spec(title: string, paths: string[]): Record<string, unknown> {
  return {
    openapi: '3.0.1',
    info: { title, version: '1' },
    paths: Object.fromEntries(paths.map((p) => [p, mockGet()])),
  };
}

/**
 * covers: AWS::ApiGateway::RestApi
 * covers: AWS::ApiGateway::Deployment
 * covers: AWS::ApiGateway::Stage
 * covers: AWS::ApiGateway::Method
 * covers: AWS::ApiGateway::Resource
 *
 * go-to-k/cdkd#6139: every `AWS::ApiGateway::RestApi` shape the SDK provider
 * creates and updates, in two phases (`CDKD_TEST_UPDATE=true` is phase 2).
 *
 * - `Inline`: `SpecRestApi` with an INLINE `Body` and no `Name` (the import
 *   names the API from the definition's title). Phase 2 drops `/b`, adds `/c`
 *   (an `overwrite` put deletes `/b`) and declares `BinaryMediaTypes`.
 * - `FromAsset`: `SpecRestApi` from an asset (`BodyS3Location`), REGIONAL.
 *   Phase 2 replaces the asset (`/x` -> `/y`) with `Mode: merge`, so `/x`
 *   stays.
 * - `Plain`: a `RestApi` with properties only (EDGE). Phase 2 renames it (in
 *   place, same id), drops `BinaryMediaTypes` (cleared) and `Description`
 *   (kept), changes its resource policy, its tags (one changed, one removed,
 *   one added), `ApiKeySourceType` and `DisableExecuteApiEndpoint`, and
 *   switches the endpoint to REGIONAL. Its policy uses the short
 *   `execute-api:/*` form, which both drift runs must read back as unchanged.
 * - `PolicyKept`: an L1 REST API (EDGE) whose `Policy` phase 2 removes; it
 *   stays live, as CloudFormation leaves it.
 * - `Clone`: an L1 REST API (EDGE) cloned from `Plain`.
 *
 * Three edge-optimized creates in one deploy (`Plain`, `PolicyKept`, `Clone`)
 * exercise the CreateRestApi pacing (one every 30 s per account).
 */
export class ApigwRestApiSpecStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';

    const inline = new apigw.SpecRestApi(this, 'Inline', {
      apiDefinition: apigw.ApiDefinition.fromInline(
        spec(`${this.stackName}-inline`, isUpdate ? ['/a', '/c'] : ['/a', '/b'])
      ),
      deploy: true,
      cloudWatchRole: false,
      ...(isUpdate ? { binaryMediaTypes: ['image/png'] } : {}),
    });
    // CDK names a SpecRestApi after its construct id; drop Name so the
    // definition's title names it (the ImportRestApi path with no Name).
    (inline.node.defaultChild as apigw.CfnRestApi).addPropertyDeletionOverride('Name');

    const fromAsset = new apigw.SpecRestApi(this, 'FromAsset', {
      apiDefinition: apigw.ApiDefinition.fromAsset(
        `${import.meta.dirname}/../spec/${isUpdate ? 'v2' : 'v1'}.json`
      ),
      restApiName: `${this.stackName}-asset`,
      endpointTypes: [apigw.EndpointType.REGIONAL],
      deploy: true,
      cloudWatchRole: false,
    });
    if (isUpdate) {
      (fromAsset.node.defaultChild as apigw.CfnRestApi).addPropertyOverride('Mode', 'merge');
    }

    const plain = new apigw.RestApi(this, 'Plain', {
      restApiName: isUpdate ? `${this.stackName}-plain-renamed` : `${this.stackName}-plain`,
      ...(isUpdate ? {} : { description: 'kept-on-removal', binaryMediaTypes: ['image/gif'] }),
      endpointTypes: [isUpdate ? apigw.EndpointType.REGIONAL : apigw.EndpointType.EDGE],
      minCompressionSize: cdk.Size.bytes(100),
      cloudWatchRole: false,
      apiKeySourceType: isUpdate ? apigw.ApiKeySourceType.AUTHORIZER : apigw.ApiKeySourceType.HEADER,
      disableExecuteApiEndpoint: isUpdate,
      // API Gateway answers this policy escaped and with `execute-api:/*`
      // expanded to the API's ARN; drift must read it back as unchanged.
      policy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            principals: [new iam.AnyPrincipal()],
            actions: ['execute-api:Invoke'],
            resources: [isUpdate ? 'execute-api:/*/GET/*' : 'execute-api:/*'],
          }),
        ],
      }),
    });
    cdk.Tags.of(plain).add('keep', isUpdate ? 'changed' : 'original');
    if (!isUpdate) cdk.Tags.of(plain).add('drop', 'me');
    if (isUpdate) cdk.Tags.of(plain).add('added', 'new');

    new apigw.CfnRestApi(this, 'PolicyKept', {
      name: `${this.stackName}-policykept`,
      ...(isUpdate
        ? {}
        : {
            policy: {
              Version: '2012-10-17',
              Statement: [
                { Effect: 'Allow', Principal: '*', Action: 'execute-api:Invoke', Resource: 'execute-api:/*' },
              ],
            },
          }),
    });
    plain.root.addMethod('GET', new apigw.MockIntegration({
      integrationResponses: [{ statusCode: '200' }],
      requestTemplates: { 'application/json': '{"statusCode": 200}' },
    }), { methodResponses: [{ statusCode: '200' }] });
    plain.root.addResource('items').addMethod('GET', new apigw.MockIntegration({
      integrationResponses: [{ statusCode: '200' }],
      requestTemplates: { 'application/json': '{"statusCode": 200}' },
    }), { methodResponses: [{ statusCode: '200' }] });

    new apigw.CfnRestApi(this, 'Clone', {
      name: `${this.stackName}-clone`,
      cloneFrom: plain.restApiId,
    });

    new cdk.CfnOutput(this, 'InlineId', { value: inline.restApiId });
    new cdk.CfnOutput(this, 'FromAssetId', { value: fromAsset.restApiId });
    new cdk.CfnOutput(this, 'PlainId', { value: plain.restApiId });
    new cdk.CfnOutput(this, 'PlainRoot', { value: plain.restApiRootResourceId });
  }
}
