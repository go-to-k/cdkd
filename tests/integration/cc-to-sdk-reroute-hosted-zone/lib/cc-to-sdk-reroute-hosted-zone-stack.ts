import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as route53 from 'aws-cdk-lib/aws-route53';

/**
 * One distinct comment per routing phase: the flip happens while PROVISIONING
 * a resource, so a deploy the differ calls NO_CHANGE would never flip it.
 */
const COMMENT_BY_PHASE: Record<string, string> = {
  base: 'before-reroute',
  seed: 'seeded-on-cc',
  pinned: 'pinned-on-cc',
  flip: 'after-reroute',
};

/**
 * physicalId-parity arm for issue 5641: a hosted zone recorded
 * `provisionedBy: 'cc-api'` returns to its SDK provider without churn.
 *
 * covers: AWS::Route53::HostedZone
 *
 * The schema's `primaryIdentifier` is `Id`. Route 53 itself answers
 * `/hostedzone/Z...`, `Route53Provider.create` strips the prefix, and Cloud
 * Control returned the bare `Z...` too (measured us-east-1, 2026-11-02). The
 * zone id is AWS-minted, so a flip that kept it is its own identity witness:
 * verify.sh proves the mint by watching the recreate change it.
 *
 * `.internal`: Route 53 refuses `example.com` as reserved by AWS.
 */
export class CcToSdkRerouteHostedZoneStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const phase = process.env.CDKD_TEST_PHASE ?? 'base';
    const zone = new route53.CfnHostedZone(this, 'RerouteZone', {
      name: `cdkd-reroute-hosted-zone-${this.account}.internal`,
      hostedZoneConfig: { comment: COMMENT_BY_PHASE[phase] ?? 'before-reroute' },
    });

    new cdk.CfnOutput(this, 'ZoneRef', { value: zone.ref });
    new cdk.CfnOutput(this, 'ZoneGetAttId', { value: zone.attrId });
    new cdk.CfnOutput(this, 'NameServers', { value: cdk.Fn.join(',', zone.attrNameServers) });
  }
}
