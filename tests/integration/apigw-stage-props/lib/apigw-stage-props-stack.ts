import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';

/**
 * AWS::ApiGateway::Stage silent-drop property backfill fixture (issue #609).
 *
 * covers: AWS::ApiGateway::RestApi
 * covers: AWS::ApiGateway::Method
 * covers: AWS::ApiGateway::Deployment
 * covers: AWS::ApiGateway::Stage
 * covers: AWS::ApiGateway::ClientCertificate
 * covers: AWS::Logs::LogGroup
 *
 * Exercises the formerly silent-drop Stage properties end to end via L1s
 * (the L2 RestApi's deployOptions cannot express ClientCertificateId or a
 * canary block directly):
 *
 * - Phase 1: AccessLogSetting (post-create UpdateStage patch delivery),
 *   CanarySetting (PercentTraffic + DeploymentId + StageVariableOverrides +
 *   UseStageCache), ClientCertificateId (post-create patch).
 * - Phase 2 (CDKD_TEST_UPDATE=true): AccessLogSetting REMOVED (whole-block
 *   `remove /accessLogSettings`), ClientCertificateId REMOVED (scalar clear
 *   `replace /clientCertificateId ''`), CanarySetting kept with
 *   PercentTraffic changed 10 -> 25 and the StageVariableOverrides key
 *   dropped (per-key `remove /canarySettings/stageVariableOverrides/flag`)
 *   — the #1160 absent-field-removal semantics, live.
 *
 * CacheClusterEnabled / CacheClusterSize are NOT exercised live: a stage
 * cache cluster takes ~20-30 minutes to provision and bills per hour; the
 * wire shape is pinned by unit tests (see the PR body's recorded decision).
 * DocumentationVersion needs a DocumentationPart/Version resource pair and
 * stays unit-only for the same fixture-scope reason.
 */
export class ApigwStagePropsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';

    const api = new apigateway.CfnRestApi(this, 'Api', {
      name: 'cdkd-stage-props-api',
    });

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

    const deployment = new apigateway.CfnDeployment(this, 'Deployment', {
      restApiId: api.ref,
    });
    deployment.addDependency(method);

    const clientCert = new apigateway.CfnClientCertificate(this, 'ClientCert', {
      description: 'cdkd-stage-props-cert',
    });

    const logGroup = new logs.CfnLogGroup(this, 'AccessLogs', {
      logGroupName: 'cdkd-stage-props-logs',
      retentionInDays: 1,
    });
    logGroup.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // API Gateway rejects the CloudWatch `:*`-suffixed log-group ARN that
    // Fn::GetAtt returns — build the bare log-group ARN instead.
    const accessLogArn = this.formatArn({
      service: 'logs',
      resource: 'log-group',
      resourceName: 'cdkd-stage-props-logs',
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    });

    const stage = new apigateway.CfnStage(this, 'Stage', {
      restApiId: api.ref,
      stageName: 'live',
      deploymentId: deployment.ref,
      variables: { flag: 'main' },
      canarySetting: {
        percentTraffic: isUpdate ? 25 : 10,
        deploymentId: deployment.ref,
        useStageCache: false,
        ...(isUpdate ? {} : { stageVariableOverrides: { flag: 'canary' } }),
      },
      ...(isUpdate
        ? {}
        : {
            accessLogSetting: {
              destinationArn: accessLogArn,
              format: '{"requestId":"$context.requestId","status":"$context.status"}',
            },
            clientCertificateId: clientCert.ref,
          }),
    });
    stage.addDependency(logGroup);

    new cdk.CfnOutput(this, 'RestApiId', { value: api.ref });
    new cdk.CfnOutput(this, 'StageName', { value: stage.ref });
  }
}
