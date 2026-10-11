import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as ssm from 'aws-cdk-lib/aws-ssm';

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

    addOrphanRepo(this, `${id.toLowerCase()}-orphan-repo`);
  }
}

/** The ECR repository whose lifecycle policy ECR rejects after CreateRepository. */
function addOrphanRepo(scope: Construct, repositoryName: string): void {
  const repo = new ecr.CfnRepository(scope, 'OrphanRepo', {
    repositoryName,
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

/**
 * The nested child of {@link CreatedBeforeFailureNestedStack}: always
 * `ChildAnchor`; with `NESTED_ORPHAN=1` also the ECR arm's `OrphanRepo`, so a
 * `--no-rollback` update of the parent journals the repository in the CHILD's
 * rollback journal.
 */
class OrphanRepoChild extends cdk.NestedStack {
  constructor(scope: Construct, id: string, repositoryName: string) {
    super(scope, id);
    // Pin the row's logical id so the child state key is `<Parent>~Child`.
    (this.nestedStackResource as cdk.CfnResource).overrideLogicalId('Child');

    new ssm.CfnParameter(this, 'ChildAnchor', { type: 'String', value: 'cdkd-4738' });
    if (process.env.NESTED_ORPHAN === '1') addOrphanRepo(this, repositoryName);
  }
}

/**
 * go-to-k/cdkd#4738: a nested child whose only skip is a journaled orphan.
 *
 * covers: AWS::CloudFormation::Stack
 *
 * Deployed first without `NESTED_ORPHAN`, so `Child` exists; then with it and
 * `--no-rollback`, so the child's journal holds `OrphanRepo`, which no creation
 * identity proves. `cdkd destroy` of the parent keeps the repository (exit 2),
 * deletes the child's state, and must delete the parent's state in the SAME
 * run, not keep its `Child` row.
 */
export class CreatedBeforeFailureNestedStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new OrphanRepoChild(this, 'Child', `${id.toLowerCase()}-orphan-repo`);
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
