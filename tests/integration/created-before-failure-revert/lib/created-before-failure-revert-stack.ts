import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as sns from 'aws-cdk-lib/aws-sns';

/**
 * ECR arm of issue #4583: a CREATE that fails AFTER its create call returned,
 * in a provider whose catch does not delete what it made.
 *
 * covers: AWS::ECR::Repository
 *
 * CreateRepository succeeds; the follow-up PutLifecyclePolicy is rejected by
 * ECR (InvalidParameterException: `tagStatus` must be one of `tagged`,
 * `untagged`, `any`). cdkd sends the text as-is, with no pre-flight of its
 * own, so the repository exists with no state record and the provider marks
 * it created-before-failure. The repository is explicitly named so verify.sh
 * can probe and sweep it by name.
 */
export class CreatedBeforeFailureEcrStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const repo = new ecr.CfnRepository(this, 'OrphanRepo', {
      repositoryName: `${id.toLowerCase()}-orphan-repo`,
      lifecyclePolicy: {
        lifecyclePolicyText: JSON.stringify({
          rules: [
            {
              rulePriority: 1,
              selection: {
                tagStatus: 'cdkd-not-a-tag-status',
                countType: 'imageCountMoreThan',
                countNumber: 1,
              },
              action: { type: 'expire' },
            },
          ],
        }),
      },
    });
    repo.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
  }
}

/**
 * SNS arm of issue #4583: the same failure shape in a provider whose catch
 * DELETES what it made. The cleanup succeeds, so nothing is left to journal.
 *
 * covers: AWS::SNS::Topic
 *
 * CreateTopic succeeds; the follow-up SetTopicAttributes(DataProtectionPolicy)
 * is rejected by SNS (the policy lacks its required members — the same value
 * `partial-create-handback` measured live). That call sits inside the
 * provider's wiring try, whose catch deletes the topic before rethrowing.
 */
export class CreatedBeforeFailureSnsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const topic = new sns.CfnTopic(this, 'Topic', {
      topicName: `${id}-topic`,
      dataProtectionPolicy: { Name: 'cdkd-invalid' },
    });
    topic.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
  }
}
