import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

/**
 * Two SSM parameters whose explicit dependency REVERSES between versions
 * (issue #6308).
 *
 * - baseline: A depends on B (`DependsOn: [B]` on A).
 * - `CDKD_TEST_UPDATE=true`: B depends on A, and B's value changes. A's only
 *   change is losing its `DependsOn`, which the diff does not compare, so A
 *   stays NO_CHANGE; before the fix its state record kept `dependencies: [B]`
 *   beside B's new `[A]`, and `cdkd destroy` refused with a circular
 *   dependency.
 *
 * covers: AWS::SSM::Parameter
 */
export class DependsOnFlipStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const flipped = process.env.CDKD_TEST_UPDATE === 'true';

    const a = new ssm.StringParameter(this, 'A', {
      parameterName: `/${this.stackName}/a`,
      stringValue: 'a',
    });
    const b = new ssm.StringParameter(this, 'B', {
      parameterName: `/${this.stackName}/b`,
      stringValue: flipped ? 'b2' : 'b',
    });

    if (flipped) {
      b.node.addDependency(a);
    } else {
      a.node.addDependency(b);
    }
  }
}
