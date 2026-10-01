import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';

/**
 * Fixture for issues #3937 and #3931: a replacement that RENAMES a resource
 * onto a name another resource already holds — and for #4180, a plain CREATE
 * onto one.
 *
 * covers: AWS::SQS::Queue, AWS::SNS::Topic, AWS::ECS::Cluster, AWS::ECR::Repository
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
 *   - `CLUSTER_NAME` (`Cluster`, #3937): ECS `CreateCluster` returns an existing
 *     ACTIVE cluster of the name. An empty cluster costs nothing.
 *   - `REPO_NAME` (`Repo`, #3931): renamed under `--recreate-via-cc-api Repo`,
 *     the recreate that used to delete the old repository FIRST. ECR's
 *     `CreateRepository` refuses a taken name, so the holder turns the rename
 *     into a collision, and an empty repository costs nothing.
 *   - `NEW_QUEUE_NAME` (`NewQueue`, #4180): optional. When set, the stack
 *     gains a second queue, so the deploy CREATES it under that name — the
 *     plain-CREATE sibling of the `QUEUE_NAME` rename.
 */
export class ReplacementRenameOntoHolderStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const queueName = process.env.QUEUE_NAME;
    const topicName = process.env.TOPIC_NAME;
    const clusterName = process.env.CLUSTER_NAME;
    const repoName = process.env.REPO_NAME;
    if (!queueName || !topicName || !clusterName || !repoName) {
      throw new Error(
        'QUEUE_NAME, TOPIC_NAME, CLUSTER_NAME and REPO_NAME must all be set (verify.sh sets them per phase)'
      );
    }

    const queue = new sqs.CfnQueue(this, 'Queue', { queueName });
    queue.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const topic = new sns.CfnTopic(this, 'Topic', { topicName });
    topic.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const cluster = new ecs.CfnCluster(this, 'Cluster', { clusterName });
    cluster.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const newQueueName = process.env.NEW_QUEUE_NAME;
    if (newQueueName) {
      const newQueue = new sqs.CfnQueue(this, 'NewQueue', { queueName: newQueueName });
      newQueue.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    }

    const repo = new ecr.CfnRepository(this, 'Repo', {
      repositoryName: repoName,
      emptyOnDelete: true,
    });
    repo.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    cdk.Tags.of(repo).add('cdkd:integ-fixture', 'replacement-rename-onto-holder');
  }
}
