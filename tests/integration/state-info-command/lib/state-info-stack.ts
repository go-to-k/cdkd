import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Minimal stack used by the `cdkd state info` integration test.
 *
 * The point of the test is `state info` itself (bucket / region / source /
 * schema version / stack count), not provisioning depth — so we deploy a
 * single SSM parameter (free, instant create+delete) just to populate one
 * state file in the bucket.
 */
export class StateInfoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new ssm.StringParameter(this, 'MarkerParam', {
      parameterName: '/cdkd-integ/state-info/marker',
      stringValue: 'state-info-integ-marker',
      description: 'Created by cdkd state-info integration test; deleted on destroy.',
    });
  }
}
