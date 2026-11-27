import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import type { Construct } from 'constructs';

/**
 * A superseded stage whose new copy carries its physical id (go-to-k/cdkd#7088).
 *
 * Two REST APIs (A and B), each with a mock `GET /` and a deployment, and one
 * `AWS::ApiGateway::Stage` named `prod`. `CDKD_TEST_UPDATE=v2` moves the stage
 * from A to B: a replacement whose new copy is also `prod`, on another API.
 * `verify.sh` pins the old stage with an out-of-band base path mapping (a
 * regional custom domain on a self-signed certificate imported into ACM), so
 * its delete fails, and cdkd must keep it in `supersededResources`.
 *
 * covers: AWS::ApiGateway::RestApi, AWS::ApiGateway::Method, AWS::ApiGateway::Deployment, AWS::ApiGateway::Stage
 */
export class SupersededStageEqualIdStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const onB = process.env.CDKD_TEST_UPDATE === 'v2';
    const api = (name: string): { rest: apigw.CfnRestApi; deployment: apigw.CfnDeployment } => {
      const rest = new apigw.CfnRestApi(this, `Api${name}`, {
        name: `cdkd-integ-superseded-stage-${name}`,
      });
      const method = new apigw.CfnMethod(this, `Get${name}`, {
        restApiId: rest.ref,
        resourceId: rest.attrRootResourceId,
        httpMethod: 'GET',
        authorizationType: 'NONE',
        integration: {
          type: 'MOCK',
          requestTemplates: { 'application/json': '{"statusCode":200}' },
        },
      });
      const deployment = new apigw.CfnDeployment(this, `Deployment${name}`, {
        restApiId: rest.ref,
      });
      deployment.node.addDependency(method);
      return { rest, deployment };
    };
    const a = api('A');
    const b = api('B');
    const target = onB ? b : a;
    new apigw.CfnStage(this, 'Stage', {
      restApiId: target.rest.ref,
      deploymentId: target.deployment.ref,
      stageName: 'prod',
    });
  }
}
