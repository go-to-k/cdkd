import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';

/**
 * Fixture for issues #3937 and #3931: a replacement that RENAMES a resource
 * onto a name another resource already holds.
 *
 * covers: AWS::SQS::Queue, AWS::SNS::Topic, AWS::ECR::Repository
 *
 * Both names are env-parameterized so verify.sh drives every phase from ONE
 * app, and each name is create-only, so changing it is a REPLACEMENT:
 *
 *   - `QUEUE_NAME` (`Queue`, #3937): SQS `CreateQueue` hands back an existing
 *     queue of the requested name when the attributes match, instead of
 *     refusing, so the rename "succeeded" with the holder's queue. The queue
 *     declares no attributes and no tags, so an out-of-band queue created with
 *     none is exactly what `CreateQueue` returns.
 *   - `TOPIC_NAME` (`Topic`, #3937): SNS `CreateTopic` returns an existing
 *     topic's ARN for the name — the same adoption, found through a
 *     different lookup (a `ListTopics` walk).
 *   - `REPO_NAME` (`Repo`, #3931): renamed under `--recreate-via-cc-api Repo`,
 *     the recreate that used to delete the old repository FIRST. ECR's
 *     `CreateRepository` refuses a taken name, so the holder turns the rename
 *     into a collision, and an empty repository costs nothing.
 */
export class ReplacementRenameOntoHolderStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const queueName = process.env.QUEUE_NAME;
    const topicName = process.env.TOPIC_NAME;
    const repoName = process.env.REPO_NAME;
    if (!queueName || !topicName || !repoName) {
      throw new Error(
        'QUEUE_NAME, TOPIC_NAME and REPO_NAME must all be set (verify.sh sets them per phase)'
      );
    }

    const queue = new sqs.CfnQueue(this, 'Queue', { queueName });
    queue.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const topic = new sns.CfnTopic(this, 'Topic', { topicName });
    topic.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const repo = new ecr.CfnRepository(this, 'Repo', {
      repositoryName: repoName,
      emptyOnDelete: true,
    });
    repo.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    cdk.Tags.of(repo).add('cdkd:integ-fixture', 'replacement-rename-onto-holder');
  }
}
