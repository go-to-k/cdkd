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
    // Second source queue for the named-replacement-collision phase: `Source`
    // is a length-1 createOnly property, so switching it requires REPLACEMENT
    // while the pipe keeps its user-supplied Name.
    const source2 = new sqs.Queue(this, 'Source2', { queueName: `${this.stackName}-src2` });
    const target = new sns.Topic(this, 'Target', { topicName: `${this.stackName}-tgt` });

    const role = new iam.Role(this, 'PipeRole', {
      assumedBy: new iam.ServicePrincipal('pipes.amazonaws.com'),
    });
    source.grantConsumeMessages(role);
    source2.grantConsumeMessages(role);
    target.grantPublish(role);

    // UPDATE phase (issue #960): BatchSize is a MUTABLE sub-property of
    // SourceParameters — only the stream-source sub-paths under it are
    // createOnly per the registry schema. The top-level reduction used to
    // classify ANY SourceParameters change as a replacement, which then
    // hard-failed on this pipe's user-supplied Name (AlreadyExists).
    const batchSize = process.env.CDKD_TEST_UPDATE === 'true' ? 2 : 1;
    const activeSource = process.env.CDKD_TEST_SOURCE_SWITCH === 'true' ? source2 : source;
    new pipes.CfnPipe(this, 'Pipe', {
      name: `${this.stackName}-pipe`,
      roleArn: role.roleArn,
      source: activeSource.queueArn,
      target: target.topicArn,
      sourceParameters: { sqsQueueParameters: { batchSize } },
    });
  }
}
