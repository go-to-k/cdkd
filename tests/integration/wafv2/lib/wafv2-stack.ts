import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';

/**
 * WAFv2 integration test stack.
 *
 * Resources:
 * - AWS::WAFv2::IPSet
 * - AWS::WAFv2::WebACL
 * - AWS::WAFv2::WebACLAssociation
 * - AWS::ApiGateway::RestApi
 *
 * The WebACL also exercises both CFn-vs-SDK spelling divergences in the Rules
 * tree (issue #1389), so the deploy itself is the regression signal -- pre-fix
 * the SDK serializer dropped each unknown key and CreateWebACL failed
 * validation on the missing required member:
 *
 * - Two ByteMatchStatements written with the CFn-only `SearchStringBase64`
 *   key, one nested under the rate-based rule's ScopeDownStatement and one
 *   under a NotStatement.
 * - An IPSetReferenceStatement whose CFn `Arn` member the SDK spells `ARN`,
 *   nested under an AndStatement.
 */
export class Wafv2Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // WAFv2 IP Set (for IP-based access control)
    const ipSet = new wafv2.CfnIPSet(this, 'BlockedIPs', {
      name: `cdkd-test-blocked-ips-${cdk.Aws.ACCOUNT_ID}`,
      scope: 'REGIONAL',
      ipAddressVersion: 'IPV4',
      addresses: ['192.0.2.0/24', '198.51.100.0/24'],
      description: 'Test IP set for cdkd',
    });

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
              // NESTED ByteMatchStatement (issue #1389): the scope-down of a
              // RateBasedStatement is one of the statement-tree recursion
              // points the base64 conversion has to walk. Base64 of
              // 'cdkd-scoped'.
              scopeDownStatement: {
                byteMatchStatement: {
                  searchStringBase64: 'Y2RrZC1zY29wZWQ=',
                  fieldToMatch: { uriPath: {} },
                  positionalConstraint: 'CONTAINS',
                  textTransformations: [{ priority: 0, type: 'NONE' }],
                },
              },
            },
          },
        },
        {
          // Issue #1389: SearchStringBase64 exists ONLY in CloudFormation --
          // the SDK models carry a single SearchString blob member -- so the
          // AWS SDK v3 serializer dropped the unknown key and CreateWebACL
          // failed validation on the missing required SearchString. This rule
          // therefore makes the whole deploy fail without the fix, which is
          // exactly the regression signal we want from a standard-flow fixture.
          // Base64 of 'cdkd-blocked'.
          name: 'Base64ByteMatchRule',
          priority: 2,
          action: { block: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'Base64ByteMatchRule',
            sampledRequestsEnabled: true,
          },
          statement: {
            notStatement: {
              statement: {
                byteMatchStatement: {
                  searchStringBase64: 'Y2RrZC1ibG9ja2Vk',
                  fieldToMatch: { singleHeader: { Name: 'user-agent' } },
                  positionalConstraint: 'CONTAINS',
                  textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
                },
              },
            },
          },
        },
        {
          // The other CFn-vs-SDK spelling divergence in the Rules tree: CFn
          // spells the reference-statement member `Arn`, the SDK declares it
          // `ARN` and marks it REQUIRED, so pre-fix the serializer dropped it
          // and CreateWebACL rejected the stack. Exercised at a nested
          // recursion point (under AndStatement) so the walk is covered too.
          name: 'IPSetReferenceRule',
          priority: 3,
          action: { block: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'IPSetReferenceRule',
            sampledRequestsEnabled: true,
          },
          statement: {
            andStatement: {
              statements: [
                { ipSetReferenceStatement: { arn: ipSet.attrArn } },
                {
                  byteMatchStatement: {
                    searchString: 'cdkd-plain',
                    fieldToMatch: { uriPath: {} },
                    positionalConstraint: 'CONTAINS',
                    textTransformations: [{ priority: 0, type: 'NONE' }],
                  },
                },
              ],
            },
          },
        },
      ],
    });

    // API Gateway REST API (minimal, for WebACL association)
    const api = new apigateway.RestApi(this, 'TestApi', {
      restApiName: `cdkd-wafv2-test-api`,
      description: 'Minimal API for WAFv2 WebACL association test',
      // Issue #1407: `cloudWatchRole` defaults to true, and CDK gives the
      // generated role AND the account-level `AWS::ApiGateway::Account`
      // singleton `DeletionPolicy: Retain`. cdkd honors that correctly
      // (destroy reported "7 deleted, 2 retained, 0 errors"), so the role
      // survived every run under the FIXED name
      // `Wafv2Stack-TestApiCloudWatchRole3E85D09F` and the next CREATE failed
      // with "Role with name ... already exists" — the fixture was single-use
      // per account until someone cleaned up by hand.
      //
      // This fixture never exercises API Gateway access logging, so the role
      // is dead weight. Disabling it removes both retained resources and makes
      // the fixture re-runnable.
      cloudWatchRole: false,
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

    new cdk.CfnOutput(this, 'IPSetArn', {
      value: ipSet.attrArn,
      description: 'WAFv2 IP Set ARN',
    });

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.url,
      description: 'API Gateway URL',
    });

    cdk.Tags.of(this).add('Project', 'cdkd');
    cdk.Tags.of(this).add('Example', 'wafv2');
  }
}
