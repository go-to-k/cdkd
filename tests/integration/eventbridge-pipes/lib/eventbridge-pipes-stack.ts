import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as pipes from 'aws-cdk-lib/aws-pipes';

/**
 * EventBridge Pipes (SQS source -> SNS target). `AWS::Pipes::Pipe` is not in
 * cdkd's SDK provider set, so it routes through Cloud Control. Exercises a
 * role-arn intrinsic plus `SourceParameters` nested config. Confirmed CLEAN by
 * a /hunt-bugs sweep; this fixture is the regression guard.
 */
export class EventbridgePipesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const source = new sqs.Queue(this, 'Source', { queueName: `${this.stackName}-src` });
    const target = new sns.Topic(this, 'Target', { topicName: `${this.stackName}-tgt` });

    const role = new iam.Role(this, 'PipeRole', {
      assumedBy: new iam.ServicePrincipal('pipes.amazonaws.com'),
    });
    source.grantConsumeMessages(role);
    target.grantPublish(role);

    new pipes.CfnPipe(this, 'Pipe', {
      name: `${this.stackName}-pipe`,
      roleArn: role.roleArn,
      source: source.queueArn,
      target: target.topicArn,
      sourceParameters: { sqsQueueParameters: { batchSize: 1 } },
    });
  }
}
