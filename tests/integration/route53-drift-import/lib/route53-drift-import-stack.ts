import * as cdk from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import type { Construct } from 'constructs';

/**
 * A public hosted zone with the record shapes `cdkd drift` and `cdkd import`
 * read by name + type + SetIdentifier:
 *
 * - `Gone`: a simple A record verify.sh deletes out of band (#6660).
 * - `Wildcard`: a simple A record on `*`, switched to an alias out of band
 *   and reverted (#6661); `Target` is the alias target.
 * - `WeightedA` / `WeightedB`: one name + type told apart by SetIdentifier.
 * - `Group`: a RecordSetGroup verify.sh deletes one member of (#6660).
 *
 * Every record names the zone by `Ref`, so `cdkd import` resolves each one
 * against the zone it imported in the same run (#6662).
 */
export class Route53DriftImportStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const zoneName = process.env.CDKD_TEST_ZONE_NAME;
    if (!zoneName) throw new Error('CDKD_TEST_ZONE_NAME is required');

    const zone = new route53.PublicHostedZone(this, 'Zone', { zoneName });

    new route53.ARecord(this, 'Gone', {
      zone,
      recordName: 'gone',
      target: route53.RecordTarget.fromIpAddresses('192.0.2.1'),
      ttl: cdk.Duration.seconds(60),
    });
    new route53.ARecord(this, 'Target', {
      zone,
      recordName: 'target',
      target: route53.RecordTarget.fromIpAddresses('192.0.2.2'),
      ttl: cdk.Duration.seconds(60),
    });
    new route53.ARecord(this, 'Wildcard', {
      zone,
      recordName: '*',
      target: route53.RecordTarget.fromIpAddresses('192.0.2.3'),
      ttl: cdk.Duration.seconds(60),
    });
    for (const [id, host, weight] of [
      ['WeightedA', 'a.example.com', 10],
      ['WeightedB', 'b.example.com', 20],
    ] as const) {
      new route53.CnameRecord(this, id, {
        zone,
        recordName: 'weighted',
        domainName: host,
        weight,
        setIdentifier: id,
        ttl: cdk.Duration.seconds(60),
      });
    }
    new route53.CfnRecordSetGroup(this, 'Group', {
      hostedZoneId: zone.hostedZoneId,
      recordSets: [
        { name: `g1.${zoneName}.`, type: 'A', ttl: '60', resourceRecords: ['192.0.2.10'] },
        { name: `g2.${zoneName}.`, type: 'TXT', ttl: '60', resourceRecords: ['"group member"'] },
      ],
    });
  }
}
