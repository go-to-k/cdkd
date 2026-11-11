import * as cdk from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

/**
 * Un-named FIFO queues (issue #6100): cdkd generates the name, which SQS
 * requires to end with `.fifo` (within 80 characters, the suffix included).
 *
 * - `FifoQueue`: the everyday CDK shape, `new sqs.Queue(this, 'Q', { fifo: true })`,
 *   which synthesizes `FifoQueue: true` and no `QueueName`.
 * - `FifoStringQueue`: `FifoQueue` given as the STRING `'TRUE'`, which
 *   CloudFormation coerces to a boolean.
 * - `StandardQueue`: an un-named standard queue, the negative control (no suffix).
 * - `FifoTopic`: an L1 `CfnTopic` with `FifoTopic: true` and no `TopicName`
 *   (CDK names an L2 FIFO topic itself), which SNS also requires to end with
 *   `.fifo`.
 *
 * `CDKD_TEST_UPDATE=true` changes `FifoQueue`'s visibility timeout (30s -> 45s),
 * an in-place update.
 *
 * covers: AWS::SQS::Queue
 * covers: AWS::SNS::Topic
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
    fifoString.addPropertyOverride('FifoQueue', 'TRUE');
    fifoString.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    fifoString.overrideLogicalId('FifoStringQueue');

    const standard = new sqs.Queue(this, 'Standard', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    (standard.node.defaultChild as sqs.CfnQueue).overrideLogicalId('StandardQueue');

    const topic = new sns.CfnTopic(this, 'Topic', { fifoTopic: true });
    topic.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    topic.overrideLogicalId('FifoTopic');
  }
}
