import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

/**
 * The nested child (issue #6314): three SSM parameters whose explicit
 * dependencies change while none of their properties do, so every record
 * stays NO_CHANGE and the child engine refreshes dependencies only.
 *
 * - baseline: NC depends on NB.
 * - `CDKD_TEST_FAIL_NESTED=true`: NC no longer depends on NB (the child's
 *   success trims it) and the parent fails afterwards, so its rollback reverts
 *   the child; the revert must put NC's edge back.
 * - `CDKD_TEST_UPDATE=true`: NA also depends on NB, an edge added to an
 *   unchanged record, which the ROOT's success must record.
 */
class DependsOnFlipChild extends cdk.NestedStack {
  constructor(scope: Construct, id: string, prefix: string) {
    super(scope, id);
    // Pin the row's logical id so the child state key is `<Parent>~Nested`.
    (this.nestedStackResource as cdk.CfnResource).overrideLogicalId('Nested');
    const param = (name: string): ssm.StringParameter =>
      new ssm.StringParameter(this, name, {
        parameterName: `/${prefix}/nested/${name.toLowerCase()}`,
        stringValue: name,
      });
    const na = param('NA');
    const nb = param('NB');
    const nc = param('NC');
    if (process.env.CDKD_TEST_FAIL_NESTED !== 'true') nc.node.addDependency(nb);
    if (process.env.CDKD_TEST_UPDATE === 'true') na.node.addDependency(nb);
  }
}

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
 * Plus a nested child whose unchanged records' dependencies change (issue
 * #6314, above), and with `CDKD_TEST_FAIL_NESTED=true` a queue AWS rejects
 * (`MessageRetentionPeriod` out of [60, 1209600]) that depends on the nested
 * row, so the child's deploy completes before the parent fails.
 *
 * covers: AWS::SSM::Parameter, AWS::CloudFormation::Stack, AWS::SQS::Queue
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

    const child = new DependsOnFlipChild(this, 'Nested', this.stackName);
    if (process.env.CDKD_TEST_FAIL_NESTED === 'true') {
      const failing = new sqs.CfnQueue(this, 'FailingQueue', { messageRetentionPeriod: 9999999 });
      failing.node.addDependency(child.nestedStackResource!);
    }
  }
}
