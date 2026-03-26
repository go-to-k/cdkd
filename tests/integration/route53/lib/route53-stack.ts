import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as route53 from 'aws-cdk-lib/aws-route53';

/**
 * Route53 example stack
 *
 * Demonstrates:
 * - HostedZone creation
 * - A Record with static IP target
 * - Resource dependencies (RecordSet depends on HostedZone)
 * - Fn::GetAtt for outputs (HostedZoneId)
 *
 * Note: Creates a real hosted zone ($0.50/month if left running).
 * Always destroy after testing.
 */
export class Route53Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create a hosted zone for testing
    const zone = new route53.HostedZone(this, 'TestZone', {
      zoneName: `cdkd-test-${this.account}.internal`,
    });

    // A Record
    new route53.ARecord(this, 'TestARecord', {
      zone,
      recordName: 'test',
      target: route53.RecordTarget.fromIpAddresses('192.0.2.1'),
      ttl: cdk.Duration.minutes(5),
    });

    // Outputs
    new cdk.CfnOutput(this, 'HostedZoneId', {
      value: zone.hostedZoneId,
    });

    new cdk.CfnOutput(this, 'ZoneName', {
      value: zone.zoneName,
    });

    cdk.Tags.of(this).add('Project', 'cdkd');
    cdk.Tags.of(this).add('Example', 'route53');
  }
}
