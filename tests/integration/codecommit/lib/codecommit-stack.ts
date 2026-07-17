import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';

/**
 * Integ probe for the AWS::CodeCommit::Repository SDK provider (issue #1045).
 *
 * The type is `ProvisioningType: NON_PROVISIONABLE`, so pre-fix cdkd rejected
 * it outright (no Cloud Control fallback exists). This fixture exercises the
 * new SDK provider end to end:
 *
 * Phase 1 (no env): create a repository with a description and two tags
 *   (`env=dev`, `team=platform`); Outputs pin `Ref` (repository ID GUID) +
 *   `GetAtt Arn` / `CloneUrlHttp` / `Name`.
 * Phase 2 (CDKD_TEST_UPDATE=true): RENAME the repository in place (CFn docs
 *   mark RepositoryName "Update requires: No interruption" — the provider
 *   must issue UpdateRepositoryName, NOT delete+create), change the
 *   description, change `env` to `prod`, and REMOVE the `team` tag (the
 *   ECR #981 untag regression class).
 */
export class CodeCommitStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';

    const repo = new codecommit.Repository(this, 'Repo', {
      // Phase 2 renames the repository — an IN-PLACE UpdateRepositoryName,
      // not a replacement (the repository ID must survive).
      repositoryName: isUpdate
        ? `${this.stackName.toLowerCase()}-repo-renamed`
        : `${this.stackName.toLowerCase()}-repo`,
      description: isUpdate ? 'updated description' : 'initial description',
    });

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
