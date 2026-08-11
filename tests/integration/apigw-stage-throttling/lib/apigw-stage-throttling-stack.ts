import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as logs from 'aws-cdk-lib/aws-logs';

const UPDATE = process.env.CDKD_TEST_UPDATE === 'true';

/**
 * API Gateway REST API Stage: Ref correctness + AccessLogSetting delivery
 * (issues #963 / #609).
 *
 * HISTORY: this fixture used to keep the Stage on the Cloud Control route by
 * carrying a Stage property the SDK provider did not wire (`MethodSettings`
 * until #966, then `AccessLogSetting`), pinning the #963 compound-id Ref
 * regression live (`Ref` on a CC-routed Stage leaked
 * `<restApiId>|<stageName>` into the CDK-generated Lambda Permission
 * SourceArn and the API 500'd on every request while the deploy reported
 * success). The #609 Stage backfill wired ALL remaining Stage top-level
 * properties into the SDK provider, so no template shape routes a Stage via
 * CC anymore — the after-pipe Ref extraction stays pinned by
 * tests/unit/deployment/intrinsic-functions.test.ts. verify.sh now asserts
 * the SDK-routed reality (provisionedBy=sdk, pipe-free physical id), keeps
 * the route-agnostic #963 symptom checks (SourceArn shape + a live curl),
 * and asserts the Stage's accessLogSettings actually reached AWS (the #609
 * delivery check — pre-backfill that only worked because CC forwarded the
 * full property map).
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
 * covers: AWS::Logs::LogGroup
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

    const accessLogGroup = new logs.LogGroup(this, 'AccessLogs', {
      retention: logs.RetentionDays.ONE_DAY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const api = new apigateway.RestApi(this, 'Api', {
      restApiName: 'cdkd-stage-throttling-api',
      // Skip CDK's auto-emitted AWS::ApiGateway::Account + its CloudWatch
      // role — the role is RemovalPolicy.RETAIN by default, so it would
      // survive destroy and collide (deterministic name) on the next run.
      cloudWatchRole: false,
      deployOptions: {
        stageName: 'test',
        // AccessLogSetting is SDK-wired since the #609 Stage backfill (it
        // kept this fixture on the CC route before that) — the SDK provider
        // delivers it via the post-create UpdateStage patch, and verify.sh
        // asserts it actually reached AWS.
        accessLogDestination: new apigateway.LogGroupLogDestination(accessLogGroup),
        accessLogFormat: apigateway.AccessLogFormat.clf(),
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
