import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigw from 'aws-cdk-lib/aws-apigateway';

/**
 * One distinct description per routing phase: the flip happens while
 * PROVISIONING a resource, so a deploy the differ calls NO_CHANGE would never
 * flip it.
 */
const DESCRIPTION_BY_PHASE: Record<string, string> = {
  base: 'before-reroute',
  seed: 'seeded-on-cc',
  pinned: 'pinned-on-cc',
  flip: 'after-reroute',
};

/**
 * physicalId-parity arm for issue 6141: a REST API recorded
 * `provisionedBy: 'cc-api'` returns to its SDK provider without churn.
 *
 * covers: AWS::ApiGateway::RestApi
 *
 * The REST API id is AWS-minted, so a flip that kept it is its own identity
 * witness: verify.sh proves the mint by watching the recreate change it. A
 * child Resource and Method are attached through `RootResourceId` so the
 * fixture can observe that attribute surviving the flip and the API still
 * holding its method. No Deployment or Stage: the method is read back with
 * `get-method`.
 */
export class CcToSdkRerouteRestApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const phase = process.env.CDKD_TEST_PHASE ?? 'base';
    const api = new apigw.CfnRestApi(this, 'RerouteApi', {
      name: 'cdkd-reroute-rest-api',
      description: DESCRIPTION_BY_PHASE[phase] ?? 'before-reroute',
    });
    const resource = new apigw.CfnResource(this, 'RerouteResource', {
      restApiId: api.ref,
      parentId: api.attrRootResourceId,
      pathPart: 'ping',
    });
    new apigw.CfnMethod(this, 'RerouteMethod', {
      restApiId: api.ref,
      resourceId: resource.ref,
      httpMethod: 'GET',
      authorizationType: 'NONE',
      integration: {
        type: 'MOCK',
        requestTemplates: { 'application/json': '{"statusCode": 200}' },
      },
      methodResponses: [{ statusCode: '200' }],
    });

    // The risky path: an API whose shape comes from an inline OpenAPI definition
    // (no Name; the title names it), plus a child that is NOT in the definition.
    // A flip that re-applied the definition with an overwrite would wipe `/extra`
    // or rename the API.
    // Unchanged in the pinned phase, so it reaches the flip still on Cloud
    // Control: Cloud Control re-puts the Body on every update, which deletes
    // the out-of-definition /extra below before the flip could be observed.
    const specApi = new apigw.CfnRestApi(this, 'RerouteSpecApi', {
      description: DESCRIPTION_BY_PHASE[phase === 'pinned' ? 'seed' : phase] ?? 'before-reroute',
      body: {
        openapi: '3.0.1',
        info: { title: 'cdkd-reroute-spec-api', version: '1' },
        paths: {
          '/from-spec': {
            get: {
              responses: { '200': { description: 'ok' } },
              'x-amazon-apigateway-integration': {
                type: 'mock',
                requestTemplates: { 'application/json': '{"statusCode": 200}' },
                responses: { default: { statusCode: '200' } },
              },
            },
          },
        },
      },
    });
    const extra = new apigw.CfnResource(this, 'RerouteExtra', {
      restApiId: specApi.ref,
      parentId: specApi.attrRootResourceId,
      pathPart: 'extra',
    });
    new apigw.CfnMethod(this, 'RerouteExtraMethod', {
      restApiId: specApi.ref,
      resourceId: extra.ref,
      httpMethod: 'GET',
      authorizationType: 'NONE',
      integration: {
        type: 'MOCK',
        requestTemplates: { 'application/json': '{"statusCode": 200}' },
      },
      methodResponses: [{ statusCode: '200' }],
    });

    new cdk.CfnOutput(this, 'ApiRef', { value: api.ref });
    new cdk.CfnOutput(this, 'ApiRootResourceId', { value: api.attrRootResourceId });
    new cdk.CfnOutput(this, 'ResourceRef', { value: resource.ref });
  }
}
