import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';

/**
 * The value each routing phase declares on the resource under test.
 * Consecutive deploys must differ: one the differ calls NO_CHANGE never
 * provisions a resource, so it could not flip. verify.sh runs its `cdkd diff`
 * with `pinned`, because `seed` and `flip` declare the same value.
 */
const VALUE_BY_PHASE: Record<string, 'a' | 'b'> = {
  base: 'a',
  seed: 'b',
  pinned: 'a',
  flip: 'b',
};

/** The origin domain; nothing is ever requested through the distribution. */
export const ORIGIN_DOMAIN = 'example.com';

/**
 * physicalId-parity arm for issue 6490, batch 11: an
 * `AWS::CloudFront::Distribution` recorded `provisionedBy: 'cc-api'` returns
 * to the SDK provider without churn.
 *
 * covers: AWS::CloudFront::Distribution
 *
 * Both layers record the same id (measured us-east-1, 2026-11-18): the
 * CloudFront-minted distribution Id, the schema primaryIdentifier, which is
 * also the identity witness, since a recreate mints another. The mutable
 * property is DistributionConfig.Comment.
 *
 * The distribution is created DISABLED: it serves nothing, and every delete
 * (the recreate's and the destroy's) then skips the disable and its
 * propagation. It is the only resource, with a fixed logical id, so this
 * fixture shares nothing with the RDS batch-11 fixture and the two slow cycles
 * run apart.
 */
export class CcToSdkRerouteCloudFrontDistributionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const phase = process.env.CDKD_TEST_PHASE ?? 'base';
    const value = VALUE_BY_PHASE[phase] ?? 'a';

    const distribution = new cloudfront.CfnDistribution(this, 'RerouteDistribution', {
      distributionConfig: {
        enabled: false,
        comment: `cdkd-reroute-cf phase-${value}`,
        origins: [
          {
            id: 'origin',
            domainName: ORIGIN_DOMAIN,
            customOriginConfig: { originProtocolPolicy: 'https-only' },
          },
        ],
        defaultCacheBehavior: {
          targetOriginId: 'origin',
          viewerProtocolPolicy: 'redirect-to-https',
          // The managed CachingDisabled policy.
          cachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
        },
      },
    });
    distribution.overrideLogicalId('RerouteDistribution');

    // Ref of a distribution is its Id on both layers; GetAtt Id and
    // DomainName are read beside it.
    new cdk.CfnOutput(this, 'DistributionRef', { value: distribution.ref });
    new cdk.CfnOutput(this, 'DistributionId', { value: distribution.attrId });
    new cdk.CfnOutput(this, 'DistributionDomainName', { value: distribution.attrDomainName });
  }
}
