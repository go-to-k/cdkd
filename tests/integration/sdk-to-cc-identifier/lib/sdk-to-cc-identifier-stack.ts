import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import type { Construct } from 'constructs';

/**
 * SDK -> Cloud Control identifier translation fixture (issue #6976).
 *
 * covers: AWS::ApiGateway::RestApi
 * covers: AWS::ApiGateway::Method
 * covers: AWS::ApiGateway::Deployment
 *
 * Phase 1 creates the Deployment through the SDK provider (physical id = the
 * bare deployment id). Phase 2 (CDKD_TEST_UPDATE=true) adds `StageDescription`,
 * which is SDK-unwired for the type and not create-only, so the UPDATE is
 * auto-routed to Cloud Control, whose primary identifier is
 * `<DeploymentId>|<RestApiId>`. Without the translation the bare id is sent to
 * Cloud Control and the update fails.
 */
export class SdkToCcIdentifierStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';

    const api = new apigateway.CfnRestApi(this, 'Api', {
      name: 'cdkd-sdk-to-cc-id-api',
    });
    api.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const method = new apigateway.CfnMethod(this, 'RootGet', {
      restApiId: api.ref,
      resourceId: api.attrRootResourceId,
      httpMethod: 'GET',
      authorizationType: 'NONE',
      integration: {
        type: 'MOCK',
        requestTemplates: { 'application/json': '{"statusCode": 200}' },
        integrationResponses: [{ statusCode: '200' }],
      },
      methodResponses: [{ statusCode: '200' }],
    });
    method.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const deployment = new apigateway.CfnDeployment(this, 'Deployment', {
      restApiId: api.ref,
      description: 'cdkd-sdk-to-cc-id',
      ...(isUpdate ? { stageDescription: { description: 'moved' } } : {}),
    });
    deployment.addDependency(method);
    deployment.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
  }
}
