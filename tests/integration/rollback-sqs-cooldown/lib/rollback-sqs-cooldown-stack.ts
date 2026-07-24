import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sqs from 'aws-cdk-lib/aws-sqs';

/**
 * Fixture for the SQS name-cooldown reverse-replacement (issue #1206) and the
 * failed-only rollback-journal retention cycle (issue #1208).
 *
 * The stack is env-parameterized so verify.sh can drive every phase from ONE
 * app (mirroring the `rollback-command` fixture pattern):
 *
 *   - `NamedQueue` — an SQS queue whose custom `queueName` carries
 *     `QUEUE_SUFFIX` (default `x`). Changing the suffix changes the
 *     create-only `QueueName` property, driving a REPLACEMENT. SQS enforces a
 *     ~60s same-name re-creation cooldown after `DeleteQueue`
 *     (`AWS.SimpleQueueService.QueueDeletedRecently`), so reverting the
 *     replacement via `cdkd rollback` inside the window forces the
 *     reverse-replacement's initial re-create through the cooldown retry
 *     schedule (issue #1206). SQS is a stateful type, so the replacement
 *     deploy needs `--force-stateful-recreation`.
 *   - `FailingQueue` — an SQS queue with an out-of-range
 *     `messageRetentionPeriod` (valid range [60, 1209600]) added ONLY when
 *     `INJECT_FAIL=true`. AWS rejects `CreateQueue`, so the deploy fails
 *     deterministically. It DEPENDS ON `NamedQueue` so the replacement
 *     completes first (event-driven DAG) — guaranteeing the journal records
 *     the replacement before the failure. Without `--no-rollback` the failure
 *     triggers a CLEAN automatic rollback, whose journal must survive as the
 *     failed-only shape (issue #1208).
 */
export class RollbackSqsCooldownStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add('cdkd:integ-fixture', 'rollback-sqs-cooldown');

    const suffix = process.env.QUEUE_SUFFIX ?? 'x';
    const named = new sqs.CfnQueue(this, 'NamedQueue', {
      queueName: `${this.stackName}-queue-${suffix}`,
      messageRetentionPeriod: 3600,
    });

    if (process.env.INJECT_FAIL === 'true') {
      const failing = new sqs.CfnQueue(this, 'FailingQueue', {
        queueName: `${this.stackName}-failing-queue`,
        messageRetentionPeriod: 9999999,
      });
      failing.node.addDependency(named);
    }
  }
}
