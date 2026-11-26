import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

/**
 * go-to-k/cdkd#7005: removing a resource whose `DeletionPolicy` keeps it must
 * read as an ORPHAN in `cdkd diff` and the deploy's `Changes:` line, not as a
 * delete.
 *
 * Baseline: five queues. `CDKD_TEST_REMOVAL=true` removes three of them:
 * - `QueueRet`: `RemovalPolicy.RETAIN` -> `DeletionPolicy: Retain`, orphaned.
 * - `QueueRou`: `RETAIN_ON_UPDATE_OR_DELETE` -> `RetainExceptOnCreate`, orphaned.
 * - `QueueDel`: `RemovalPolicy.DESTROY`, deleted (the control row).
 * `QueueKeep` stays so the stack outlives the removal, and `QueueHeld`
 * (`RETAIN`) stays to the destroy, whose plan must list it as kept.
 *
 * covers: AWS::SQS::Queue
 */
export class DiffOrphanRetainedRemovalStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const removal = process.env.CDKD_TEST_REMOVAL === 'true';

    new sqs.Queue(this, 'QueueKeep', {
      queueName: `${this.stackName}-keep`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    new sqs.Queue(this, 'QueueHeld', {
      queueName: `${this.stackName}-held`,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    if (!removal) {
      new sqs.Queue(this, 'QueueRet', {
        queueName: `${this.stackName}-ret`,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });
      new sqs.Queue(this, 'QueueRou', {
        queueName: `${this.stackName}-rou`,
        removalPolicy: cdk.RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
      });
      new sqs.Queue(this, 'QueueDel', {
        queueName: `${this.stackName}-del`,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
    }
  }
}
