import * as cdk from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

/** The export the producer publishes its topic ARN under. */
export const TOPIC_ARN_EXPORT = 'CdkdNoEchoNamedProducerTopicArn';

/**
 * A resource NAMED from a `NoEcho` parameter (go-to-k/cdkd#4849). `verify.sh`
 * generates the name per run and passes it in as the parameter's `Default`.
 *
 * - `Topic`: an SNS topic whose `TopicName` is the parameter. AWS publishes the
 *   name inside the topic's ARN, so cdkd keeps every copy of that ARN in
 *   state as AWS returns it: the record's physical id, its `TopicArn`
 *   attribute, the `TopicArnOut` output and its export. The `TopicName`
 *   attribute IS the value and stays `***`.
 * - `Sub`: an SQS subscription reading `Fn::GetAtt Topic.TopicArn`. With
 *   `CDKD_TEST_UPDATE=true` it turns on raw delivery, so the second deploy
 *   re-resolves that attribute from state.
 * - `NameOut`: an output of the value itself, which stays `***`.
 *
 * covers: AWS::SNS::Topic, AWS::SNS::Subscription, AWS::SQS::Queue
 */
export class NoEchoNamedProducerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const name = new cdk.CfnParameter(this, 'TopicNameValue', {
      type: 'String',
      noEcho: true,
      default: process.env['CDKD_TEST_NOECHO_PRODUCER_NAME'] ?? 'cdkd-test-noecho-producer-unset',
    });

    const topic = new sns.CfnTopic(this, 'Topic', { topicName: name.valueAsString });

    const queue = new sqs.Queue(this, 'Queue', {
      queueName: process.env['CDKD_TEST_NOECHO_PRODUCER_QUEUE'] ?? 'cdkd-test-noecho-producer-q-unset',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new sns.CfnSubscription(this, 'Sub', {
      topicArn: topic.attrTopicArn,
      protocol: 'sqs',
      endpoint: queue.queueArn,
      rawMessageDelivery: process.env['CDKD_TEST_UPDATE'] === 'true',
    });

    new cdk.CfnOutput(this, 'TopicArnOut', {
      value: topic.ref,
      exportName: TOPIC_ARN_EXPORT,
    });
    new cdk.CfnOutput(this, 'NameOut', { value: name.valueAsString });
  }
}

/**
 * Imports the producer's exported topic ARN in a LATER `cdkd deploy`, so it
 * reads the export from the persisted exports index, not from the producer's
 * in-process outputs.
 *
 * covers: AWS::SSM::Parameter
 */
export class NoEchoNamedConsumerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    new ssm.CfnParameter(this, 'ImportedArn', {
      name:
        process.env['CDKD_TEST_NOECHO_PRODUCER_PARAM'] ?? '/cdkd-test/noecho-producer/unset',
      type: 'String',
      value: cdk.Fn.importValue(TOPIC_ARN_EXPORT),
    });
  }
}
