import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

/**
 * Un-named FIFO queues (issue #6100): cdkd generates the name, which SQS
 * requires to end with `.fifo` (within 80 characters, the suffix included).
 *
 * - `FifoQueue`: the everyday CDK shape, `new sqs.Queue(this, 'Q', { fifo: true })`,
 *   which synthesizes `FifoQueue: true` and no `QueueName`.
 * - `FifoStringQueue`: `FifoQueue` given as the STRING `'true'`, which
 *   CloudFormation coerces to a boolean.
 * - `StandardQueue`: an un-named standard queue, the negative control (no suffix).
 *
 * `CDKD_TEST_UPDATE=true` changes `FifoQueue`'s visibility timeout (30s -> 45s),
 * an in-place update.
 *
 * covers: AWS::SQS::Queue
 */
export class SqsFifoUnnamedStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const update = process.env.CDKD_TEST_UPDATE === 'true';

    const fifo = new sqs.Queue(this, 'Fifo', {
      fifo: true,
      visibilityTimeout: cdk.Duration.seconds(update ? 45 : 30),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    (fifo.node.defaultChild as sqs.CfnQueue).overrideLogicalId('FifoQueue');

    const fifoString = new sqs.CfnQueue(this, 'FifoString');
    fifoString.addPropertyOverride('FifoQueue', 'true');
    fifoString.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    fifoString.overrideLogicalId('FifoStringQueue');

    const standard = new sqs.Queue(this, 'Standard', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    (standard.node.defaultChild as sqs.CfnQueue).overrideLogicalId('StandardQueue');
  }
}
