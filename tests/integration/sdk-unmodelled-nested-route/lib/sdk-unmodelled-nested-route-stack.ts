import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as route53 from 'aws-cdk-lib/aws-route53';

/**
 * Per phase: whether the template declares the members the AWS SDK does not
 * model, and the comment both resources carry. Consecutive deploys differ on
 * each resource, since a NO_CHANGE resource is never provisioned and so
 * could never move between routes.
 */
const PHASES: Record<string, { nested: boolean; comment: string }> = {
  base: { nested: false, comment: 'a' },
  route: { nested: true, comment: 'a' },
  removal: { nested: false, comment: 'a' },
  back: { nested: false, comment: 'b' },
};

/**
 * go-to-k/cdkd#6690: a nested member the shipped AWS SDK client does not model
 * (`SDK_UNMODELLED_NESTED_PATHS`) routes its resource through Cloud Control,
 * which forwards it, instead of the SDK serializer dropping it.
 *
 * covers: AWS::CloudFront::Distribution, AWS::Route53::HostedZone, AWS::ApiGateway::RestApi, AWS::ApiGateway::Authorizer
 *
 * Both start on the SDK route; adding the member moves each to Cloud Control
 * on the SAME physical id (both are `sdk-coverage` sticky-exempt types, whose
 * ids the two layers share); removing it keeps Cloud Control, which clears
 * it; the next change returns each to the SDK provider.
 *
 * The members are property overrides: aws-cdk-lib's L1s may predate them.
 * `OriginHttpVersion: http2` is refused by CloudFront itself (AccessDenied to
 * the CloudFormation handler, us-east-1, 2026-11-21): `http1.1` is the value
 * this account can set, and an origin that never set it reads it absent.
 * `NS_OCCLUSION_CHECK` is a guardrail Cloud Control applies on a STANDARD
 * zone (ChangeHistory needs another tier: measured us-east-1, 2026-11-21, it
 * stays DISABLED). The distribution is DISABLED: it serves nothing, and its
 * delete skips the disable and its propagation.
 */
export class SdkUnmodelledNestedRouteStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const phase = PHASES[process.env.CDKD_TEST_PHASE ?? 'base'] ?? PHASES.base!;

    // `.internal`: Route 53 refuses `example.com` as reserved by AWS.
    const zone = new route53.CfnHostedZone(this, 'NestedRouteZone', {
      name: `cdkd-nested-route-${this.account}.internal`,
      hostedZoneConfig: { comment: `cdkd-nested-route phase-${phase.comment}` },
    });
    zone.overrideLogicalId('NestedRouteZone');

    const distribution = new cloudfront.CfnDistribution(this, 'NestedRouteDistribution', {
      distributionConfig: {
        enabled: false,
        comment: `cdkd-nested-route phase-${phase.comment}`,
        origins: [
          {
            id: 'origin',
            domainName: 'example.com',
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
    distribution.overrideLogicalId('NestedRouteDistribution');

    if (phase.nested) {
      zone.addPropertyOverride('HostedZoneFeatures.ChangeGuardrails', [
        { Name: 'NS_OCCLUSION_CHECK', Status: 'ENABLED' },
      ]);
      distribution.addPropertyOverride(
        'DistributionConfig.Origins.0.CustomOriginConfig.OriginHttpVersion',
        'http1.1'
      );
    }

    // The same refresh added `AWS::ApiGateway::Authorizer` `JwtConfiguration`,
    // which the SDK models and the provider now sends: a JWT authorizer stays
    // on the SDK route, its audience changing with the comment.
    const api = new apigateway.CfnRestApi(this, 'NestedRouteApi', {
      name: `cdkd-nested-route-${this.account}`,
    });
    api.overrideLogicalId('NestedRouteApi');
    const authorizer = new apigateway.CfnAuthorizer(this, 'NestedRouteJwtAuthorizer', {
      restApiId: api.ref,
      name: 'jwt',
      type: 'JWT',
      identitySource: 'method.request.header.Authorization',
    });
    authorizer.overrideLogicalId('NestedRouteJwtAuthorizer');
    authorizer.addPropertyOverride('JwtConfiguration', {
      Issuers: [
        {
          Issuer: 'https://accounts.google.com',
          Audiences: [`cdkd-nested-route-${phase.comment}`],
          AdditionalClaims: [
            { ClaimName: 'tenant', Format: 'SINGLE_STRING', Required: true, ExpectedValues: ['t-1'] },
          ],
        },
      ],
      DefaultAlgorithms: ['RS256'],
    });

    new cdk.CfnOutput(this, 'ZoneRef', { value: zone.ref });
    new cdk.CfnOutput(this, 'DistributionRef', { value: distribution.ref });
  }
}
