import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as route53 from 'aws-cdk-lib/aws-route53';

/**
 * Route53 example stack
 *
 * Demonstrates:
 * - HostedZone creation
 * - A Record with static IP target
 * - AWS::Route53::HealthCheck (HTTP health check)
 * - AWS::Route53::RecordSet with GeoProximityLocation (#609 backfill)
 * - AWS::Route53::CidrCollection (CC-API) + RecordSet with CidrRoutingConfig (#609 backfill)
 * - Resource dependencies (RecordSet depends on HostedZone)
 * - Fn::GetAtt for outputs (HostedZoneId, HealthCheckId)
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

    // Route53 Health Check (HTTP check against a public endpoint)
    const healthCheck = new route53.CfnHealthCheck(this, 'TestHealthCheck', {
      healthCheckConfig: {
        type: 'HTTP',
        fullyQualifiedDomainName: 'example.com',
        port: 80,
        resourcePath: '/',
        requestInterval: 30,
        failureThreshold: 3,
      },
    });

    // Exercises the #609 GeoProximityLocation backfill: a geoproximity
    // routing-policy RecordSet (requires a setIdentifier + an anchor — here
    // awsRegion, the simplest anchor needing no extra resource — plus a bias).
    new route53.CfnRecordSet(this, 'GeoProximityRecord', {
      hostedZoneId: zone.hostedZoneId,
      name: `geo.cdkd-test-${this.account}.internal`,
      type: 'A',
      ttl: '300',
      resourceRecords: ['198.51.100.1'],
      setIdentifier: 'geo-use1',
      geoProximityLocation: { awsRegion: 'us-east-1', bias: 10 },
    });

    // A CIDR collection backing the CidrRoutingConfig record below.
    // AWS::Route53::CidrCollection has NO cdkd SDK provider — it routes via
    // Cloud Control API (supported), so the integ provisions it via CC-API.
    const cidrCollection = new route53.CfnCidrCollection(this, 'TestCidrCollection', {
      name: `cdkd-test-cidr-${this.account}`,
      locations: [{ locationName: 'office', cidrList: ['10.0.0.0/8'] }],
    });

    // Exercises the #609 CidrRoutingConfig backfill: a CIDR routing-policy
    // RecordSet (a routing policy, so it REQUIRES a setIdentifier). The
    // locationName must match a location in the CIDR collection above.
    const cidrRecord = new route53.CfnRecordSet(this, 'CidrRecord', {
      hostedZoneId: zone.hostedZoneId,
      name: `cidr.cdkd-test-${this.account}.internal`,
      type: 'A',
      ttl: '300',
      resourceRecords: ['198.51.100.4'],
      setIdentifier: 'cidr-office',
      cidrRoutingConfig: { collectionId: cidrCollection.attrId, locationName: 'office' },
    });
    cidrRecord.addDependency(cidrCollection);

    // Outputs
    new cdk.CfnOutput(this, 'HostedZoneId', {
      value: zone.hostedZoneId,
    });

    new cdk.CfnOutput(this, 'ZoneName', {
      value: zone.zoneName,
    });

    new cdk.CfnOutput(this, 'HealthCheckId', {
      value: healthCheck.attrHealthCheckId,
      description: 'Route53 Health Check ID',
    });

    cdk.Tags.of(this).add('Project', 'cdkd');
    cdk.Tags.of(this).add('Example', 'route53');
  }
}
