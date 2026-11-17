import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as location from 'aws-cdk-lib/aws-location';

/**
 * Integ probe for go-to-k/cdkd#6485: both types are Cloud Control routed, and
 * their Cloud Control model carries the read-only `UpdateTime`, which AWS
 * changes on every update. Before the fix an out-of-band `Description` edit
 * also reported `UpdateTime` as drift, and `cdkd drift --revert` failed with
 * `readOnlyProperties [/properties/UpdateTime] cannot be updated`, leaving the
 * real drift in place.
 */
export class DriftCcReadOnlyPropsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const collection = new location.CfnGeofenceCollection(this, 'Geo', {
      collectionName: 'CdkdIntegDriftRoGeo',
      description: 'integ',
    });
    const tracker = new location.CfnTracker(this, 'Tracker', {
      trackerName: 'CdkdIntegDriftRoTracker',
      description: 'integ',
      positionFiltering: 'TimeBased',
    });
    new location.CfnTrackerConsumer(this, 'Consumer', {
      trackerName: tracker.ref,
      consumerArn: collection.attrArn,
    });
  }
}
