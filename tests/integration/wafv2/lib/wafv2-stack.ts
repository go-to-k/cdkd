import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';

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

    // Outputs
    new cdk.CfnOutput(this, 'WebAclArn', {
      value: webAcl.attrArn,
    });

    new cdk.CfnOutput(this, 'WebAclId', {
      value: webAcl.attrId,
    });

    cdk.Tags.of(this).add('Project', 'cdkd');
    cdk.Tags.of(this).add('Example', 'wafv2');
  }
}
