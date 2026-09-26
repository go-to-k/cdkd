import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sqs from 'aws-cdk-lib/aws-sqs';

/**
 * The nested child. One SQS queue whose `VisibilityTimeout` comes from
 * `CHILD_VT` (default 30), so a phase can change the child template and turn
 * the parent's `Child` row into a genuine UPDATE (the nested template's asset
 * hash, and so `TemplateURL`, changes with it).
 */
class ChildNestedStack extends cdk.NestedStack {
  public readonly queue: sqs.CfnQueue;

  constructor(scope: Construct, id: string, props?: cdk.NestedStackProps) {
    super(scope, id, props);
    // Pin the row's logical id so the child state key is `<Parent>~Child`.
    (this.nestedStackResource as cdk.CfnResource).overrideLogicalId('Child');

    this.queue = new sqs.CfnQueue(this, 'ChildQueue', {
      visibilityTimeout: Number(process.env.CHILD_VT ?? '30'),
    });
  }
}

/**
 * Issue #3754: does the parent's automatic rollback revert a nested child that
 * the failed deploy had already updated?
 *
 * `FailingQueue` (added only with `INJECT_FAIL=true`) carries an out-of-range
 * `MessageRetentionPeriod` (valid range [60, 1209600]), so AWS rejects its
 * `CreateQueue` deterministically. It DEPENDS ON the nested-stack row, so the
 * child's update completes first and the parent's journal records the `Child`
 * row as a completed UPDATE before the failure triggers the rollback.
 */
export class NestedStackRollbackStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // No stack-wide `cdk.Tags` aspect: it would tag the nested-stack row too,
    // and cdkd refuses `AWS::CloudFormation::Stack` `Tags` as CFn-only.
    const child = new ChildNestedStack(this, 'Child');

    if (process.env.INJECT_FAIL === 'true') {
      const failing = new sqs.CfnQueue(this, 'FailingQueue', {
        messageRetentionPeriod: 9999999,
      });
      failing.node.addDependency(child.nestedStackResource!);
    }
  }
}
