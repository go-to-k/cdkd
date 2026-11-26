import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

/**
 * Exports a queue's URL and ARN (CDK's automatic strong references); phase 2
 * renames it, which replaces it.
 *
 * covers: AWS::SQS::Queue
 */
export class ProducerStack extends cdk.Stack {
  readonly queue: sqs.Queue;
  constructor(scope: Construct, id: string, props: cdk.StackProps & { updated: boolean }) {
    super(scope, id, props);
    this.queue = new sqs.Queue(this, 'Queue', {
      queueName: props.updated ? 'cdkd-integ-xs-replace-rb-q2' : 'cdkd-integ-xs-replace-rb-q1',
    });
  }
}

/**
 * A function that imports the queue's URL into its environment, an event
 * source mapping on the queue, and the IAM grant both need. With `fail`, a
 * queue AWS refuses (`MessageRetentionPeriod` above its 14-day maximum),
 * created after the function, so the deploy fails once the function moved
 * onto the new queue and rolls back to the imported values of phase 1.
 *
 * covers: AWS::Lambda::Function
 * covers: AWS::Lambda::EventSourceMapping
 * covers: AWS::IAM::Role
 * covers: AWS::IAM::Policy
 */
export class ConsumerStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props: cdk.StackProps & { queue: sqs.Queue; fail: boolean }
  ) {
    super(scope, id, props);
    const role = new iam.Role(this, 'Role', {
      roleName: 'cdkd-integ-xs-replace-rb-role',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    const fn = new lambda.Function(this, 'Fn', {
      functionName: 'cdkd-integ-xs-replace-rb-fn',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => ({});'),
      role,
      environment: { QURL: props.queue.queueUrl },
    });
    fn.addEventSource(new sources.SqsEventSource(props.queue));
    if (props.fail) {
      new sqs.CfnQueue(this, 'Boom', {
        queueName: 'cdkd-integ-xs-replace-rb-boom',
        messageRetentionPeriod: 9999999,
      }).node.addDependency(fn);
    }
  }
}
