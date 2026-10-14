import * as cdk from 'aws-cdk-lib';
import * as guardduty from 'aws-cdk-lib/aws-guardduty';
import type { Construct } from 'constructs';

/**
 * A GuardDuty detector declared with `Features`, updated in place
 * (go-to-k/cdkd#4910). cdkd routes the type through Cloud Control, whose read
 * model carries `DataSources` and the full `Features` list; before the fix
 * every update failed in `UpdateDetector`.
 *
 * `CDKD_TEST_UPDATE` is a comma-separated mode list, monotonic across phases:
 *   - `scalar`   -> `FindingPublishingFrequency: ONE_HOUR` (Features untouched)
 *   - `features` -> appends `EKS_AUDIT_LOGS: DISABLED` to `Features`
 *
 * The `cdkd-integ` tag is how `verify.sh` tells this fixture's detector from
 * one the account already has: GuardDuty allows one detector per region.
 *
 *   covers: AWS::GuardDuty::Detector
 */
export class GuarddutyDetectorUpdateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const modes = (process.env.CDKD_TEST_UPDATE ?? '').split(',');
    const features: guardduty.CfnDetector.CFNFeatureConfigurationProperty[] = [
      { name: 'RDS_LOGIN_EVENTS', status: 'ENABLED' },
    ];
    if (modes.includes('features')) {
      features.push({ name: 'EKS_AUDIT_LOGS', status: 'DISABLED' });
    }

    new guardduty.CfnDetector(this, 'Detector', {
      enable: true,
      features,
      ...(modes.includes('scalar') ? { findingPublishingFrequency: 'ONE_HOUR' } : {}),
      tags: [{ key: 'cdkd-integ', value: 'guardduty-detector-update' }],
    });
  }
}
