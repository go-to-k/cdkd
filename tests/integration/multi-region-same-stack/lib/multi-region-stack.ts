import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Minimal stack for the multi-region-same-stack integration test.
 *
 * The test deploys this stack to two different regions back-to-back (same
 * stackName, different `env.region`). The SSM Parameter is region-local, so
 * each deploy creates an entirely separate AWS resource. After both deploys,
 * `cdkd state list` should show two rows for `CdkdMultiRegionExample`, one
 * per region — confirming PR 1's region-prefixed state key keeps the two
 * apart instead of overwriting one with the other (the silent-failure bug
 * that motivated PR 1).
 */
export class MultiRegionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new ssm.StringParameter(this, 'Marker', {
      parameterName: `${this.stackName}-marker`,
      stringValue: `multi-region-fixture-${this.region}`,
      description:
        'Sentinel parameter; one copy per region, used by the multi-region-same-stack integ test',
    });
  }
}
