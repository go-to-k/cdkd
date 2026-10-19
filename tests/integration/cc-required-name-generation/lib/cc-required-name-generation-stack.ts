import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';

/**
 * An un-named `AWS::CodeCommit::Repository` (issue #5095).
 *
 * Its CloudFormation schema REQUIRES `RepositoryName`, and only the SDK
 * provider used to generate one, so a Cloud Control create of the un-named
 * repository failed. verify.sh creates it on the SDK provider, moves it to
 * Cloud Control with `--recreate-via-cc-api`, and checks that both routes
 * named it `{stack}-{logicalId}-{suffix}` from the state's stack instance id.
 *
 * The L1 `CfnRepository` requires `repositoryName` in its props type, so the
 * resource is a raw `CfnResource`.
 *
 * covers: AWS::CodeCommit::Repository
 */
export class CcRequiredNameGenerationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new cdk.CfnResource(this, 'Repo', {
      type: 'AWS::CodeCommit::Repository',
      properties: { RepositoryDescription: 'cdkd #5095 Cloud Control generated name' },
    });
  }
}
