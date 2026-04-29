import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Key } from 'aws-cdk-lib/aws-kms';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { Alarm, ComparisonOperator, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import {
  ArnPrincipal,
  Effect,
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from 'aws-cdk-lib/aws-iam';
import { LogGroup, CfnSubscriptionFilter } from 'aws-cdk-lib/aws-logs';
import { Stream } from 'aws-cdk-lib/aws-kinesis';

export class SqsCloudwatchStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const encryptionKey = new Key(this, 'EncryptionKey', {
      description: 'KMS Key for SQS Queue encryption',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      policy: new PolicyDocument({
        statements: [
          new PolicyStatement({
            sid: 'Allow administration of the key',
            effect: Effect.ALLOW,
            principals: [
              new ArnPrincipal(
                cdk.Fn.join('', ['arn:aws:iam::', cdk.Aws.ACCOUNT_ID, ':root']),
              ),
            ],
            actions: ['kms:*'],
            resources: ['*'],
          }),
        ],
      }),
    });

    const messageQueue = new Queue(this, 'MessageQueue', {
      encryption: QueueEncryption.KMS,
      encryptionMasterKey: encryptionKey,
      dataKeyReuse: cdk.Duration.seconds(300),
    });

    const alarmTopic = new Topic(this, 'AlarmNotificationTopic');

    const alarm = new Alarm(this, 'SQSQueueAlarm', {
      alarmDescription: 'Alarm for SQS Queue messages',
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      threshold: 10,
      treatMissingData: TreatMissingData.NOT_BREACHING,
      metric: messageQueue.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.seconds(60),
        statistic: 'Maximum',
      }),
    });
    alarm.addAlarmAction(new SnsAction(alarmTopic));

    const logGroup = new LogGroup(this, 'LogGroup', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const logStream = new Stream(this, 'LogStream', {
      shardCount: 1,
    });

    const subscriptionFilterRole = new Role(this, 'SubscriptionFilterRole', {
      assumedBy: new ServicePrincipal('logs.amazonaws.com'),
      inlinePolicies: {
        SubscriptionFilterPolicy: new PolicyDocument({
          statements: [
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
              resources: [logGroup.logGroupArn],
            }),
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ['kinesis:PutRecord', 'kinesis:PutRecords'],
              resources: [
                logStream.streamArn,
                cdk.Fn.join('', [logStream.streamArn, '/*']),
              ],
            }),
          ],
        }),
      },
    });

    new CfnSubscriptionFilter(this, 'LogSubscriptionFilter', {
      destinationArn: logStream.streamArn,
      filterPattern: 'ERROR',
      logGroupName: logGroup.logGroupName,
      roleArn: subscriptionFilterRole.roleArn,
    });

    new cdk.CfnOutput(this, 'SQSQueueUrl', {
      description: 'URL of the SQS Queue',
      value: messageQueue.queueUrl,
    });
  }
}
