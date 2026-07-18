import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as iam from 'aws-cdk-lib/aws-iam';

// The fixture runs as an ES module (`node` loads the .ts app via ESM), so
// `__dirname` is undefined — derive it from import.meta.url.
const thisDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Integ probe for the AWS::CodeCommit::Repository SDK provider (issues #1045,
 * #1065, #1066).
 *
 * The type is `ProvisioningType: NON_PROVISIONABLE`, so pre-fix cdkd rejected
 * it outright (no Cloud Control fallback exists). This fixture exercises the
 * SDK provider end to end, including the `Code` seed-content + `Triggers`
 * support added in issue #1066:
 *
 * Phase 1 (no env): create a repository with a description and two tags
 *   (`env=dev`, `team=platform`), a `Code` seed (the `seed/` directory zipped
 *   into the initial commit on `main`), and a `Triggers` entry notifying an
 *   SNS topic on all repository events; Outputs pin `Ref` (repository ID
 *   GUID) + `GetAtt Arn` / `CloneUrlHttp` / `Name`.
 * Phase 2 (CDKD_TEST_UPDATE=true): RENAME the repository in place (CFn docs
 *   mark RepositoryName "Update requires: No interruption" — the provider
 *   must issue UpdateRepositoryName, NOT delete+create), change the
 *   description, change `env` to `prod`, and REMOVE the `team` tag (the
 *   ECR #981 untag regression class). The `Code` seed + `Triggers` are
 *   unchanged (Code is create-only; the trigger set is identical) and must
 *   survive the rename.
 */
export class CodeCommitStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';

    // SNS topic that the repository trigger notifies. CodeCommit validates a
    // trigger's SNS destination against the topic's access policy at
    // PutRepositoryTriggers time, so the topic policy (granting
    // codecommit.amazonaws.com sns:Publish) must be applied BEFORE the
    // repository's trigger — an explicit dependency enforces the order.
    const topic = new sns.Topic(this, 'TriggerTopic', {
      topicName: `${this.stackName.toLowerCase()}-triggers`,
    });
    const topicPolicy = new sns.TopicPolicy(this, 'TriggerTopicPolicy', {
      topics: [topic],
    });
    topicPolicy.document.addStatements(
      new iam.PolicyStatement({
        sid: 'AllowCodeCommitPublish',
        actions: ['sns:Publish'],
        principals: [new iam.ServicePrincipal('codecommit.amazonaws.com')],
        resources: [topic.topicArn],
      })
    );

    // KmsKeyId is deliberately NOT exercised here (a dedicated KMS key adds
    // cost + a 7-day pending-deletion tail for a property that is unit-tested
    // on both create and update paths); the repo uses the AWS-managed
    // aws/codecommit key.
    const repo = new codecommit.Repository(this, 'Repo', {
      // Phase 2 renames the repository — an IN-PLACE UpdateRepositoryName,
      // not a replacement (the repository ID must survive).
      repositoryName: isUpdate
        ? `${this.stackName.toLowerCase()}-repo-renamed`
        : `${this.stackName.toLowerCase()}-repo`,
      description: isUpdate ? 'updated description' : 'initial description',
      // `Code` (create-only): the seed/ directory is zipped as a CDK file
      // asset and unpacked into the repository's initial commit on `main`.
      code: codecommit.Code.fromDirectory(path.join(thisDir, '..', 'seed'), 'main'),
    });

    // `Triggers` (mutable): notify the SNS topic on every repository event.
    // Named so the integ can assert it via GetRepositoryTriggers.
    repo.notify(topic.topicArn, {
      name: 'commit-notify',
      events: [codecommit.RepositoryEventTrigger.ALL],
    });
    // Ensure the topic policy is in place before the trigger is put.
    repo.node.addDependency(topicPolicy);

    // Phase 1: env=dev, team=platform. Phase 2: env changed to prod, team
    // removed entirely (untag path).
    cdk.Tags.of(repo).add('env', isUpdate ? 'prod' : 'dev');
    if (!isUpdate) {
      cdk.Tags.of(repo).add('team', 'platform');
    }

    new cdk.CfnOutput(this, 'RepositoryId', {
      // Ref returns the repository ID (a GUID) — CFn parity via the
      // provider-stored RepositoryId attribute.
      value: (repo.node.defaultChild as codecommit.CfnRepository).ref,
    });
    new cdk.CfnOutput(this, 'RepositoryArn', { value: repo.repositoryArn });
    new cdk.CfnOutput(this, 'RepositoryCloneUrlHttp', { value: repo.repositoryCloneUrlHttp });
    new cdk.CfnOutput(this, 'RepositoryName', { value: repo.repositoryName });
  }
}
