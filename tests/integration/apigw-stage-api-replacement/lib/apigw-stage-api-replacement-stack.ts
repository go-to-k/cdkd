import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import type { Construct } from 'constructs';

/**
 * An API Gateway stage moved to a replaced API (go-to-k/cdkd#7072).
 *
 * A stage's physical id is its bare stage name, scoped by an API the id does
 * not carry, so the new stage of a replaced API has the old stage's id. cdkd
 * read that as "the create returned the existing stage" and refused the
 * deploy; CloudFormation replaces the stage.
 *
 * `CDKD_TEST_UPDATE=v2` swaps both APIs for new ones (new logical ids): an
 * HTTP API with its `$default` stage, and a REST API (a MOCK `GET /`, a
 * deployment and a `prod` stage). The stages keep their logical ids, so they
 * are replaced onto the new APIs.
 *
 * covers: AWS::ApiGatewayV2::Api, AWS::ApiGatewayV2::Stage, AWS::ApiGateway::RestApi, AWS::ApiGateway::Method, AWS::ApiGateway::Deployment, AWS::ApiGateway::Stage
 */
export class ApigwStageApiReplacementStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const v = process.env.CDKD_TEST_UPDATE === 'v2' ? 'B' : 'A';

    const http = new apigwv2.CfnApi(this, `HttpApi${v}`, {
      name: `cdkd-7072-http-${v}`,
      protocolType: 'HTTP',
    });
    new apigwv2.CfnStage(this, 'HttpStage', { apiId: http.ref, stageName: '$default', autoDeploy: true });

    const rest = new apigw.CfnRestApi(this, `RestApi${v}`, { name: `cdkd-7072-rest-${v}` });
    const method = new apigw.CfnMethod(this, `Get${v}`, {
      restApiId: rest.ref,
      resourceId: rest.attrRootResourceId,
      httpMethod: 'GET',
      authorizationType: 'NONE',
      integration: {
        type: 'MOCK',
        requestTemplates: { 'application/json': '{"statusCode": 200}' },
        integrationResponses: [{ statusCode: '200' }],
      },
      methodResponses: [{ statusCode: '200' }],
    });
    const deployment = new apigw.CfnDeployment(this, `Deployment${v}`, { restApiId: rest.ref });
    deployment.addDependency(method);
    new apigw.CfnStage(this, 'RestStage', {
      restApiId: rest.ref,
      stageName: 'prod',
      deploymentId: deployment.ref,
    });
  }
}
