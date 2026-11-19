import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as events from 'aws-cdk-lib/aws-events';
import * as logs from 'aws-cdk-lib/aws-logs';

/**
 * The name generation each phase declares: 1 until `renamed`, where the
 * source and the destination take new names (and new targets) in the same
 * deploy that recreates them on Cloud Control.
 */
const GENERATION_BY_PHASE: Record<string, '1' | '2'> = {
  base: '1',
  blocked: '1',
  renamed: '2',
};

/**
 * Issue 6589: `--recreate-via-cc-api` on a CloudWatch Logs delivery source and
 * destination that an `AWS::Logs::Delivery` uses.
 *
 * covers: AWS::Logs::DeliverySource
 * covers: AWS::Logs::DeliveryDestination
 * covers: AWS::Logs::Delivery
 *
 * - `blocked` keeps every name, so the recreate deletes the source first and
 *   CloudWatch Logs refuses (ConflictException) while the delivery uses it:
 *   the deploy fails and names the delivery.
 * - `renamed` gives the source and the destination new names, so their
 *   recreate creates the new resource first and deletes the old one after the
 *   delivery has moved to it.
 *
 * Each generation's source and destination point at that generation's own bus
 * and log group: CloudWatch Logs refuses a second delivery source for a
 * resource that already has one, and the old source lives until the cleanup
 * phase. Each logical id under test is fixed.
 */
export class RecreateRenamedLogsDeliveryStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const phaseName = process.env.CDKD_TEST_PHASE ?? 'base';
    const generation = GENERATION_BY_PHASE[phaseName] ?? '1';

    // NOT under test: one bus and one log group per generation.
    const buses: Record<string, events.EventBus> = {};
    const groups: Record<string, logs.LogGroup> = {};
    for (const gen of ['1', '2']) {
      buses[gen] = new events.EventBus(this, `Bus${gen}`, {
        eventBusName: `cdkd-rrld-bus-${gen}`,
        logConfig: { includeDetail: events.IncludeDetail.FULL, level: events.Level.INFO },
      });
      groups[gen] = new logs.LogGroup(this, `Group${gen}`, {
        logGroupName: `/aws/vendedlogs/cdkd-rrld-${gen}`,
        retention: logs.RetentionDays.ONE_DAY,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
    }

    const source = new logs.CfnDeliverySource(this, 'RecreateDeliverySource', {
      name: `cdkd-rrld-src-${generation}`,
      logType: 'INFO_LOGS',
      resourceArn: buses[generation]!.eventBusArn,
    });
    source.overrideLogicalId('RecreateDeliverySource');

    const destination = new logs.CfnDeliveryDestination(this, 'RecreateDeliveryDestination', {
      name: `cdkd-rrld-dst-${generation}`,
      destinationResourceArn: groups[generation]!.logGroupArn,
    });
    destination.overrideLogicalId('RecreateDeliveryDestination');

    const delivery = new logs.CfnDelivery(this, 'RecreateDelivery', {
      deliverySourceName: source.ref,
      deliveryDestinationArn: destination.attrArn,
    });
    delivery.overrideLogicalId('RecreateDelivery');
  }
}
