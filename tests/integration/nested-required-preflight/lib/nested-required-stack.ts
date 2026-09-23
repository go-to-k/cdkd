import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

/**
 * Issue #1802 fixture. `AWS::SQS::Queue` is one of the types CloudFormation
 * enforces nested `required` lists on: its `Tags` element requires both `Key`
 * and `Value`.
 *
 * - `CDKD_TEST_PARTIAL=true` overrides `Queue`'s tag to `{Key}` only — a
 *   PRESENT block missing a required member, which pre-flight must refuse
 *   before any AWS call (on a fresh stack AND on a deployed one).
 * - `GuardedQueue` always carries a partial tag, but only inside the arm of an
 *   `Fn::If` that never resolves: pre-flight must treat the unresolved
 *   intrinsic as unknown and let the stack deploy (the positive control for
 *   the fail-safe direction).
 */
export class NestedRequiredStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const queue = new sqs.CfnQueue(this, 'Queue', {
      queueName: 'cdkd-nested-required-queue',
      tags: [{ key: 'owner', value: 'cdkd' }],
    });
    if (process.env.CDKD_TEST_PARTIAL === 'true') {
      queue.addPropertyOverride('Tags', [{ Key: 'owner' }]);
    }
    queue.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const never = new cdk.CfnCondition(this, 'Never', {
      expression: cdk.Fn.conditionEquals(cdk.Aws.REGION, 'nowhere-1'),
    });
    const guarded = new sqs.CfnQueue(this, 'GuardedQueue', {
      queueName: 'cdkd-nested-required-guarded',
    });
    guarded.addPropertyOverride(
      'Tags',
      cdk.Fn.conditionIf(never.logicalId, [{ Key: 'owner' }], [{ Key: 'owner', Value: 'guarded' }])
    );
    guarded.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
  }
}
