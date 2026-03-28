import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';

/**
 * WAFv2 integration test stack.
 *
 * Resources:
 * - AWS::WAFv2::WebACL
 * - AWS::WAFv2::WebACLAssociation
 * - AWS::ApiGateway::RestApi
 */
export class Wafv2Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // WAFv2 Web ACL with basic rules
    const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      defaultAction: { allow: {} },
      scope: 'REGIONAL',
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'cdkd-test-webacl',
        sampledRequestsEnabled: true,
      },
      name: `cdkd-test-webacl-${cdk.Aws.ACCOUNT_ID}`,
      description: 'cdkd integration test WebACL',
      rules: [
        {
          name: 'RateLimitRule',
          priority: 1,
          action: { block: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'RateLimitRule',
            sampledRequestsEnabled: true,
          },
          statement: {
            rateBasedStatement: {
              limit: 2000,
              aggregateKeyType: 'IP',
            },
          },
        },
      ],
    });

    // API Gateway REST API (minimal, for WebACL association)
    const api = new apigateway.RestApi(this, 'TestApi', {
      restApiName: `cdkd-wafv2-test-api`,
      description: 'Minimal API for WAFv2 WebACL association test',
    });
    api.root.addMethod('GET', new apigateway.MockIntegration({
      integrationResponses: [{ statusCode: '200' }],
      requestTemplates: { 'application/json': '{"statusCode": 200}' },
    }), {
      methodResponses: [{ statusCode: '200' }],
    });

    // WebACL Association (attach WAF to API Gateway stage)
    new wafv2.CfnWebACLAssociation(this, 'WebAclAssociation', {
      webAclArn: webAcl.attrArn,
      resourceArn: api.deploymentStage.stageArn,
    });

    // Outputs
    new cdk.CfnOutput(this, 'WebAclArn', {
      value: webAcl.attrArn,
    });

    new cdk.CfnOutput(this, 'WebAclId', {
      value: webAcl.attrId,
    });

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.url,
      description: 'API Gateway URL',
    });

    cdk.Tags.of(this).add('Project', 'cdkd');
    cdk.Tags.of(this).add('Example', 'wafv2');
  }
}
