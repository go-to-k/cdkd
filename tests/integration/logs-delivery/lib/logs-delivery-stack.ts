import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';

export const SOURCE_NAME = 'cdkd-integ-logs-delivery-src';
export const DESTINATION_NAME = 'cdkd-integ-logs-delivery-dst';

/**
 * An EventBridge bus's logs delivered to a CloudWatch Logs log group through
 * the three CloudWatch Logs delivery resources, each created through its SDK
 * provider.
 *
 * With `CDKD_TEST_UPDATE=true` every one of them changes in place: all three
 * gain a tag, the destination policy's statement id changes, and the delivery
 * narrows its `RecordFields`. (`FieldDelimiter` is not used: AWS refuses one
 * for a CloudWatch Logs destination, measured.) The log group's data
 * protection policy gains a second data identifier (go-to-k/cdkd#6609: the
 * baseline captured right after its `PutDataProtectionPolicy` is drift-clean).
 *
 * covers: AWS::Logs::DeliverySource
 * covers: AWS::Logs::DeliveryDestination
 * covers: AWS::Logs::Delivery
 */
export class LogsDeliveryStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const update = process.env.CDKD_TEST_UPDATE === 'true';
    const tags = update ? [{ key: 'cdkd-integ', value: 'updated' }] : undefined;

    const bus = new events.EventBus(this, 'Bus', {
      eventBusName: 'cdkd-integ-logs-delivery-bus',
      logConfig: { includeDetail: events.IncludeDetail.FULL, level: events.Level.INFO },
    });
    const group = new logs.LogGroup(this, 'Group', {
      logGroupName: '/aws/vendedlogs/cdkd-integ-logs-delivery',
      retention: logs.RetentionDays.ONE_DAY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      dataProtectionPolicy: new logs.DataProtectionPolicy({
        identifiers: update
          ? [logs.DataIdentifier.EMAILADDRESS, logs.DataIdentifier.IPADDRESS]
          : [logs.DataIdentifier.EMAILADDRESS],
      }),
    });

    const source = new logs.CfnDeliverySource(this, 'Source', {
      name: SOURCE_NAME,
      logType: 'INFO_LOGS',
      resourceArn: bus.eventBusArn,
      tags,
    });
    const destination = new logs.CfnDeliveryDestination(this, 'Destination', {
      name: DESTINATION_NAME,
      destinationResourceArn: group.logGroupArn,
      tags,
      deliveryDestinationPolicy: {
        deliveryDestinationName: DESTINATION_NAME,
        deliveryDestinationPolicy: {
          Version: '2012-10-17',
          Statement: [
            {
              Sid: update ? 'AllowCreateDeliveryUpdated' : 'AllowCreateDelivery',
              Effect: 'Allow',
              Principal: { AWS: this.account },
              Action: 'logs:CreateDelivery',
              Resource: `arn:${this.partition}:logs:${this.region}:${this.account}:delivery-destination:${DESTINATION_NAME}`,
            },
          ],
        },
      },
    });
    const delivery = new logs.CfnDelivery(this, 'Delivery', {
      deliverySourceName: source.ref,
      deliveryDestinationArn: destination.attrArn,
      recordFields: update ? ['resource_arn', 'event_bus_name'] : undefined,
      tags,
    });
    delivery.addDependency(source);

    new cdk.CfnOutput(this, 'DeliveryId', { value: delivery.ref });
  }
}
