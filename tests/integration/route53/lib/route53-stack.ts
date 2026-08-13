import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as logs from 'aws-cdk-lib/aws-logs';

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
 * - Fn::GetAtt for outputs (HostedZoneId, HostedZone NameServers, HealthCheckId)
 * - The NameServers list read BOTH ways: through Fn::Join, and bare so the
 *   Output persists a JSON array whose element count is observable (#1873)
 * - HostedZoneTags + QueryLoggingConfig REMOVAL resets (#1160 route53 batch)
 *
 * The REMOVAL phase (gated on CDKD_TEST_REMOVAL, issue #1160 route53 batch)
 * drops the `Dropped` hosted-zone tag and the whole `QueryLoggingConfig`
 * block, so the redeploy exercises the two removal paths the provider could
 * not previously express: `applyHostedZoneTags` only ever sent `AddTags`, and
 * `applyQueryLoggingConfig` returned early on an absent block, leaving a live
 * query-logging config writing to CloudWatch forever. Real CloudFormation
 * removes both (live A/B, 2026-08-10).
 *
 * Note: Creates a real hosted zone ($0.50/month if left running).
 * Always destroy after testing.
 */
export class Route53Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const removal = process.env.CDKD_TEST_REMOVAL === 'true';

    // Query logging requires a log group in us-east-1 whose name starts with
    // `/aws/route53/`, plus an ACCOUNT-WIDE resource policy letting Route 53
    // write to it. Both stay in the template across the removal phase — only
    // the zone's reference to them is dropped, so the redeploy isolates the
    // QueryLoggingConfig removal rather than confounding it with a log-group
    // delete. `AWS::Logs::ResourcePolicy` has no SDK provider and routes via
    // Cloud Control API.
    const queryLogGroup = new logs.LogGroup(this, 'QueryLogGroup', {
      logGroupName: `/aws/route53/cdkd-test-${this.account}.internal`,
      retention: logs.RetentionDays.ONE_DAY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const queryLogPolicy = new logs.CfnResourcePolicy(this, 'QueryLogPolicy', {
      policyName: `cdkd-test-route53-query-logging-${this.account}`,
      policyDocument: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'Route53QueryLogging',
            Effect: 'Allow',
            Principal: { Service: ['route53.amazonaws.com'] },
            Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
            Resource: `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/route53/*`,
          },
        ],
      }),
    });

    // Create a hosted zone for testing
    const zone = new route53.HostedZone(this, 'TestZone', {
      zoneName: `cdkd-test-${this.account}.internal`,
    });

    // #1160 route53 batch, entry 1: HostedZoneTags had no untag diff, so a tag
    // dropped from the template stayed on the zone forever. `Keep` survives
    // both phases; `Dropped` is the removal signal.
    const zoneL1 = zone.node.defaultChild as route53.CfnHostedZone;
    zoneL1.addPropertyOverride(
      'HostedZoneTags',
      removal
        ? [{ Key: 'Keep', Value: 'yes' }]
        : [
            { Key: 'Keep', Value: 'yes' },
            { Key: 'Dropped', Value: 'gone' },
          ]
    );

    // #1160 route53 batch, entry 2: removing QueryLoggingConfig never deleted
    // the live config. Present in the baseline, absent in the removal phase.
    if (!removal) {
      zoneL1.addPropertyOverride(
        'QueryLoggingConfig.CloudWatchLogsLogGroupArn',
        queryLogGroup.logGroupArn
      );
      // The account-wide policy must exist before Route 53 will accept the
      // config; the log group reference alone does not order the policy.
      zoneL1.addDependency(queryLogPolicy);
    }

    // Exercise the #609 HostedZoneFeatures backfill: the AcceleratedRecovery
    // feature (free; targets a 60-minute RTO for DNS operations during
    // us-east-1 service disruptions) is set via a post-create
    // UpdateHostedZoneFeatures control-plane call. CDK L2's `HostedZone`
    // does not expose the `hostedZoneFeatures` property, so reach the L1
    // via `addPropertyOverride`.
    zoneL1.addPropertyOverride('HostedZoneFeatures.AcceleratedRecoveryStatus', 'ENABLED');

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

    // Route 53 HostedZone NameServers is a list-valued CloudFormation
    // attribute. Joining it exercises the complete Output resolution path:
    // provider attribute capture -> Fn::GetAtt -> Fn::Join -> state output.
    new cdk.CfnOutput(this, 'HostedZoneNameServers', {
      value: cdk.Fn.join(',', zone.hostedZoneNameServers ?? []),
    });

    // Issue #1873: the SAME attribute with NO Fn::Join, so the Output value is
    // the bare Fn::GetAtt over a list-valued attribute. This is the shape the
    // joined Output above structurally cannot check: Fn::Join with ',' renders
    // `['a','b']` and `['a,b']` to the identical string, so a single-element
    // collapse is invisible to any post-join comparison. Here cdkd stores the
    // resolved value verbatim, so `state.outputs` carries a JSON ARRAY and
    // verify.sh can assert the element COUNT and the members directly.
    //
    // `CfnOutput.value` is typed `string` because CloudFormation Outputs must
    // be strings; the cast is deliberate. cdkd resolves Outputs itself and
    // persists whatever the resolver returned (`outputs` is
    // `Record<string, unknown>`), which is exactly the user-visible shape
    // under test. This Output is therefore cdkd-specific by construction and
    // is not claimed to round-trip through real CloudFormation.
    const cfnZone = zone.node.defaultChild as route53.CfnHostedZone;
    new cdk.CfnOutput(this, 'HostedZoneNameServersList', {
      value: cdk.Fn.getAtt(cfnZone.logicalId, 'NameServers') as unknown as string,
      description: 'Bare Fn::GetAtt over the NameServers LIST (no Fn::Join) — issue #1873',
    });

    new cdk.CfnOutput(this, 'HealthCheckId', {
      value: healthCheck.attrHealthCheckId,
      description: 'Route53 Health Check ID',
    });

    // Issue #1681: `Ref` to an AWS::Route53::RecordSet returns "the name of the
    // record" (docs-verified), but cdkd stores the composite physicalId
    // `<hostedZoneId>|<name>|<type>` — of which the record name is the MIDDLE
    // segment, so neither the after-LAST-pipe nor the before-FIRST-pipe
    // extraction yields it. Pre-fix this output resolved to the whole
    // `Z...|cidr.cdkd-test-<acct>.internal|A`.
    //
    // `CfnRecordSet.ref` is the shape a real consumer takes (an L1 template, or
    // `CfnOutput(value: record.ref)`); `record.domainName` would NOT exercise
    // the resolver at all, so it has to be `.ref` here.
    new cdk.CfnOutput(this, 'CidrRecordRef', {
      value: cidrRecord.ref,
      description: 'Ref of the CIDR RecordSet — must be the record NAME, not the composite id',
    });

    cdk.Tags.of(this).add('Project', 'cdkd');
    cdk.Tags.of(this).add('Example', 'route53');
  }
}
