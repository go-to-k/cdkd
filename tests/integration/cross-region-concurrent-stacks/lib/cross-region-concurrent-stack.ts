import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * One of TWO copies of this stack, each in its own region, deployed by ONE
 * `cdkd deploy --all` at the DEFAULT `--stack-concurrency` (issue #1981).
 *
 * Every physical name carries the stack's `letter` (`a` / `b`) and NOT the
 * region, so `verify.sh` can look each resource up by name in BOTH regions and
 * assert it exists only in its own. A resource created in the sibling's region
 * — what the pre-fix race produced — is then a named, sweepable leftover.
 *
 * The resources are chosen by HOW their provider reaches AWS, because that is
 * what decides whether the race can reach them:
 *
 * - `AWS::SNS::TopicPolicy` — `SNSTopicPolicyProvider.setTopicPolicy` reads
 *   `getAwsClients()` at CALL time, after the stack's first `await`s, which is
 *   exactly where a sibling stack's global switch used to land. The policy's
 *   `Sid` carries the letter and changes under `CDKD_TEST_UPDATE`, so both the
 *   create and the update call are observable on the live topic.
 * - `AWS::ECR::Repository` — the provider captures `providerRegion` at
 *   construction; the fix moved that read from `process.env.AWS_REGION` (which
 *   the deploy no longer sets per stack) to the stack scope.
 * - `AWS::Logs::MetricFilter` — no SDK provider, so it takes the Cloud Control
 *   route.
 * - `{{resolve:ssm:...}}` — the echo parameter's value is a dynamic reference
 *   to a name `verify.sh` seeds in BOTH regions with DIFFERENT values, so the
 *   resolved value says which region answered (issue #1957's "default
 *   concurrency" acceptance criterion, which #1981 blocked).
 * - `AWS::SQS::Queue`, `AWS::SSM::Parameter`, `AWS::Logs::LogGroup`,
 *   `AWS::SNS::Topic` — constructor-captured clients; they widen the stack so
 *   the two deploys overlap for longer.
 *
 * covers: AWS::SNS::Topic
 * covers: AWS::SNS::TopicPolicy
 * covers: AWS::SQS::Queue
 * covers: AWS::SSM::Parameter
 * covers: AWS::ECR::Repository
 * covers: AWS::Logs::LogGroup
 * covers: AWS::Logs::MetricFilter
 */
export interface CrossRegionConcurrentStackProps extends cdk.StackProps {
  /** `a` or `b`: the only thing that differs between the two copies' names. */
  readonly letter: string;
  /** The SSM name seeded in both regions; the echo parameter resolves it. */
  readonly sourceParameterName: string;
}

export class CrossRegionConcurrentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: CrossRegionConcurrentStackProps) {
    super(scope, id, props);
    const { letter } = props;
    const updated = process.env['CDKD_TEST_UPDATE'] === 'true';
    const prefix = `cdkd-xrc-${letter}`;

    const topic = new sns.Topic(this, 'Topic', { topicName: `${prefix}-topic` });
    const policy = new sns.TopicPolicy(this, 'TopicPolicy', { topics: [topic] });
    policy.document.addStatements(
      new iam.PolicyStatement({
        // Letter-scoped and phase-scoped, so verify.sh can tell WHICH stack's
        // policy landed on the topic and whether the UPDATE reached it.
        sid: `CdkdXrc${letter.toUpperCase()}${updated ? 'Updated' : 'Created'}`,
        principals: [new iam.AccountRootPrincipal()],
        actions: ['sns:Publish'],
        resources: [topic.topicArn],
      })
    );

    new sqs.Queue(this, 'Queue', {
      queueName: `${prefix}-queue`,
      visibilityTimeout: cdk.Duration.seconds(updated ? 45 : 30),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    for (const n of [1, 2, 3]) {
      new ssm.StringParameter(this, `Param${n}`, {
        parameterName: `/cdkd-xrc/${letter}/p${n}`,
        stringValue: `${letter}-${this.region}-${updated ? 'updated' : 'created'}`,
      });
    }

    new ssm.StringParameter(this, 'Echo', {
      parameterName: `/cdkd-xrc/${letter}/echo`,
      stringValue: `{{resolve:ssm:${props.sourceParameterName}}}`,
    });

    new ecr.Repository(this, 'Repo', {
      repositoryName: `${prefix}-repo`,
      emptyOnDelete: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/cdkd-xrc/${letter}`,
      retention: logs.RetentionDays.ONE_DAY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    new logs.MetricFilter(this, 'MetricFilter', {
      logGroup,
      filterName: `${prefix}-filter`,
      metricNamespace: 'CdkdXrc',
      metricName: `${prefix}-errors`,
      filterPattern: logs.FilterPattern.literal('ERROR'),
    });

    new cdk.CfnOutput(this, 'TopicArn', { value: topic.topicArn });
  }
}
