import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as events from 'aws-cdk-lib/aws-events';
import * as logs from 'aws-cdk-lib/aws-logs';

/**
 * The value each routing phase declares on the archive, the source and the
 * destination. Consecutive deploys must differ: one the differ calls NO_CHANGE
 * never provisions a resource, so it could not flip. `announce` is deployed by
 * no phase: verify.sh's `cdkd diff` reads it, as a template that changes all
 * four resources under test.
 */
const VALUE_BY_PHASE: Record<string, 'a' | 'b'> = {
  base: 'a',
  seed: 'b',
  announce: 'a',
  pinned: 'a',
  flip: 'b',
};

/**
 * The delivery's value. It does not change at `pinned`: Cloud Control's update
 * handler refuses every update of a delivery to a CloudWatch Logs log group,
 * a tag-only patch included ("Provided delivery configuration is invalid for
 * the destination type", measured us-east-1, 2026-11-19: it sends the S3
 * settings GetDelivery reports back to UpdateDeliveryConfiguration), so a
 * pinned update cannot succeed. The flip is what moves such a record off that
 * handler.
 */
const DELIVERY_VALUE_BY_PHASE: Record<string, 'a' | 'b'> = {
  base: 'a',
  seed: 'b',
  announce: 'a',
  pinned: 'b',
  flip: 'a',
};

/**
 * physicalId-parity arm for issue 6588: an `AWS::Events::Archive` and the three
 * CloudWatch Logs delivery resources, each recorded `provisionedBy: 'cc-api'`,
 * return to the SDK provider without churn.
 *
 * covers: AWS::Events::Archive
 * covers: AWS::Logs::DeliverySource
 * covers: AWS::Logs::DeliveryDestination
 * covers: AWS::Logs::Delivery
 *
 * Each schema primaryIdentifier is what the SDK provider records: the archive
 * name, the source name, the destination name and the AWS-minted delivery id.
 * The archive changes its Description; the three Logs resources change a tag.
 *
 * The names change once, at the `seed` deploy that recreates them on Cloud
 * Control, and stay fixed from then on. The source and destination of each
 * generation point at that generation's own bus and log group, so the two
 * generations never share one: CloudWatch Logs refuses a second delivery
 * source for a resource that already has one ("This ResourceId has already
 * been used in another Delivery Source", measured us-east-1, 2026-11-19).
 * Each logical id under test is fixed.
 */
export class CcToSdkRerouteCommonTypes12Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const phaseName = process.env.CDKD_TEST_PHASE ?? 'base';
    const value = VALUE_BY_PHASE[phaseName];
    if (value === undefined) throw new Error(`unknown CDKD_TEST_PHASE '${phaseName}'`);
    // 1 for the SDK create, 2 from the Cloud Control recreate onwards.
    const generation = phaseName === 'base' ? '1' : '2';
    const tags = [{ key: 'cdkd-reroute', value }];

    // NOT under test: one bus and one log group per generation.
    const buses: Record<string, events.EventBus> = {};
    const groups: Record<string, logs.LogGroup> = {};
    for (const gen of ['1', '2']) {
      buses[gen] = new events.EventBus(this, `Bus${gen}`, {
        eventBusName: `cdkd-reroute-ct12-bus-${gen}`,
        logConfig: { includeDetail: events.IncludeDetail.FULL, level: events.Level.INFO },
      });
      groups[gen] = new logs.LogGroup(this, `Group${gen}`, {
        logGroupName: `/aws/vendedlogs/cdkd-reroute-ct12-${gen}`,
        retention: logs.RetentionDays.ONE_DAY,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
    }
    const bus = buses[generation]!;
    const group = groups[generation]!;

    const archive = new events.CfnArchive(this, 'RerouteArchive', {
      archiveName: `cdkd-reroute-ct12-archive-${generation}`,
      sourceArn: bus.eventBusArn,
      description: `cdkd reroute ct12 ${value}`,
      retentionDays: 1,
    });
    archive.overrideLogicalId('RerouteArchive');

    const source = new logs.CfnDeliverySource(this, 'RerouteDeliverySource', {
      name: `cdkd-reroute-ct12-src-${generation}`,
      logType: 'INFO_LOGS',
      resourceArn: bus.eventBusArn,
      tags,
    });
    source.overrideLogicalId('RerouteDeliverySource');

    const destination = new logs.CfnDeliveryDestination(this, 'RerouteDeliveryDestination', {
      name: `cdkd-reroute-ct12-dst-${generation}`,
      destinationResourceArn: group.logGroupArn,
      tags,
    });
    destination.overrideLogicalId('RerouteDeliveryDestination');

    // Ref of an archive, a source and a destination is its name, and of a
    // delivery its id, on both layers; the ARNs are read beside them.
    new cdk.CfnOutput(this, 'ArchiveRef', { value: archive.ref });
    new cdk.CfnOutput(this, 'ArchiveArn', { value: archive.attrArn });
    new cdk.CfnOutput(this, 'SourceRef', { value: source.ref });
    new cdk.CfnOutput(this, 'SourceArn', { value: source.attrArn });
    new cdk.CfnOutput(this, 'DestinationRef', { value: destination.ref });
    new cdk.CfnOutput(this, 'DestinationArn', { value: destination.attrArn });

    const deliveryValue = DELIVERY_VALUE_BY_PHASE[phaseName];
    if (deliveryValue === undefined) throw new Error(`no delivery value for phase '${phaseName}'`);
    const delivery = new logs.CfnDelivery(this, 'RerouteDelivery', {
      deliverySourceName: source.ref,
      deliveryDestinationArn: destination.attrArn,
      tags: [{ key: 'cdkd-reroute', value: deliveryValue }],
    });
    delivery.overrideLogicalId('RerouteDelivery');
    new cdk.CfnOutput(this, 'DeliveryRef', { value: delivery.ref });
    new cdk.CfnOutput(this, 'DeliveryArn', { value: delivery.attrArn });
  }
}
