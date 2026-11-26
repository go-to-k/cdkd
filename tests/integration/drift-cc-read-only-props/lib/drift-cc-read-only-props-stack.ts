import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as location from 'aws-cdk-lib/aws-location';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/** go-to-k/cdkd#7007: the export a consumer stack imports. */
export const UPDATE_TIME_EXPORT = 'CdkdIntegDriftRoTrackerUt';

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
      description: process.env.CDKD_INTEG_TRACKER_DESCRIPTION ?? 'integ',
      positionFiltering: 'TimeBased',
    });
    if (process.env.CDKD_INTEG_TRACKER_TAG !== undefined) {
      cdk.Tags.of(tracker).add('cdkd-integ-7007', process.env.CDKD_INTEG_TRACKER_TAG);
    }
    new ssm.CfnParameter(this, 'TimeReader', { type: 'String', value: tracker.attrUpdateTime });
    new cdk.CfnOutput(this, 'TrackerUpdateTime', {
      value: tracker.attrUpdateTime,
      exportName: UPDATE_TIME_EXPORT,
    });
    new location.CfnTrackerConsumer(this, 'Consumer', {
      trackerName: tracker.ref,
      consumerArn: collection.attrArn,
    });
  }
}

/** go-to-k/cdkd#7007: imports the Tracker's UpdateTime export. */
export class DriftCcReadOnlyPropsConsumerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    new ssm.CfnParameter(this, 'Imported', {
      type: 'String',
      value: cdk.Fn.importValue(UPDATE_TIME_EXPORT),
    });
  }
}
