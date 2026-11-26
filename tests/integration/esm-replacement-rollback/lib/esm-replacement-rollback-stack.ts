import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as les from 'aws-cdk-lib/aws-lambda-event-sources';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

/**
 * go-to-k/cdkd#7011. `ESM_ROLLBACK_QUEUE=2` renames the queue, so the queue is
 * replaced and the mapping with it; `ESM_ROLLBACK_FAIL=true` adds a queue AWS
 * refuses, ordered after the mapping so the new mapping is still `Creating`
 * when the rollback deletes it.
 */
export class EsmReplacementRollbackStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    cdk.Tags.of(this).add('cdkd:integ-fixture', 'esm-replacement-rollback');

    const generation = process.env.ESM_ROLLBACK_QUEUE === '2' ? '2' : '1';
    const queue = new sqs.Queue(this, 'Queue', {
      queueName: `${this.stackName}-q${generation}`,
    });
    const fn = new lambda.Function(this, 'Consumer', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => ({});'),
    });
    fn.addEventSource(new les.SqsEventSource(queue, { batchSize: 1 }));

    if (process.env.ESM_ROLLBACK_FAIL === 'true') {
      // Out-of-range retention (valid range is [60, 1209600]): AWS rejects CreateQueue.
      const failing = new sqs.CfnQueue(this, 'FailingQueue', {
        queueName: `${this.stackName}-failing`,
        messageRetentionPeriod: 9999999,
      });
      // After the mapping's create returns, so the failure fires while it is
      // still `Creating`.
      const mapping = fn.node.findAll().find((c) => c instanceof lambda.CfnEventSourceMapping);
      if (!mapping) throw new Error('fixture: no CfnEventSourceMapping under the consumer');
      failing.node.addDependency(mapping);
    }
  }
}
