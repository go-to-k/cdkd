import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';

const UPDATE = process.env.CDKD_TEST_UPDATE === 'true';

/**
 * API Gateway REST API whose Stage carries `MethodSettings` (issue #963).
 *
 * `deployOptions.throttlingRateLimit` / `throttlingBurstLimit` synthesize a
 * Stage `MethodSettings` block, which cdkd's SDK provider does not wire — so
 * the #614 silent-drop routing provisions the Stage via Cloud Control, whose
 * primaryIdentifier is the compound `<restApiId>|<stageName>`. Pre-fix, the
 * `Ref` on that Stage leaked the compound id into the CDK-generated Lambda
 * Permission SourceArn (`.../<restApiId>|test/GET/hello`), API Gateway could
 * not invoke the Lambda, and the deployed API returned 500 on every request
 * while the deploy reported success. verify.sh curls the route and asserts
 * the Lambda body actually comes back (the functional check a green deploy
 * summary cannot substitute for), and greps the Lambda resource policy for
 * a compound-id-free SourceArn.
 *
 * UPDATE phase (CDKD_TEST_UPDATE=true): adds a second route (a new Resource +
 * Method + a hash-suffixed replacement Deployment) and changes the throttling
 * limits — the new route must serve and the old Deployment must be deleted.
 *
 * covers: AWS::ApiGateway::RestApi
 * covers: AWS::ApiGateway::Resource
 * covers: AWS::ApiGateway::Method
 * covers: AWS::ApiGateway::Deployment
 * covers: AWS::ApiGateway::Stage
 * covers: AWS::Lambda::Function
 * covers: AWS::Lambda::Permission
 */
export class ApigwStageThrottlingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const fn = new lambda.Function(this, 'Handler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(
        'exports.handler = async (e) => ({ statusCode: 200, body: JSON.stringify({ ok: true, path: e.path }) });'
      ),
    });

    const api = new apigateway.RestApi(this, 'Api', {
      restApiName: 'cdkd-stage-throttling-api',
      // Skip CDK's auto-emitted AWS::ApiGateway::Account + its CloudWatch
      // role — the role is RemovalPolicy.RETAIN by default, so it would
      // survive destroy and collide (deterministic name) on the next run.
      cloudWatchRole: false,
      deployOptions: {
        stageName: 'test',
        // -> Stage MethodSettings -> the SDK provider does not wire it ->
        // #614 routing sends the Stage through Cloud Control (the #963 trigger).
        throttlingRateLimit: UPDATE ? 50 : 100,
        throttlingBurstLimit: UPDATE ? 25 : 50,
      },
    });

    api.root.addResource('hello').addMethod('GET', new apigateway.LambdaIntegration(fn));
    if (UPDATE) {
      api.root.addResource('items').addMethod('GET', new apigateway.LambdaIntegration(fn));
    }

    new cdk.CfnOutput(this, 'ApiUrl', { value: api.url });
  }
}
