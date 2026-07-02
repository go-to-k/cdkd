import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';
import { Construct } from 'constructs';

/**
 * CodeDeploy Lambda canary deployment group — the canonical safe-Lambda-deploy
 * pattern (Function + currentVersion + Alias + LambdaDeploymentGroup).
 *
 * What this fixture pins:
 *
 *  1. IAM-propagation retry on CREATE (the bug this fixture ships with).
 *     AWS::CodeDeploy::DeploymentGroup has no SDK provider, so it routes via
 *     Cloud Control. Its create references the same-stack service role created
 *     ~1s earlier, and CodeDeploy validates the role's trust policy at create
 *     time — before IAM propagation settles this rejects with "AWS CodeDeploy
 *     does not have the permissions required to assume the role ...". That
 *     phrasing was missing from cdkd's retryable-error patterns (the existing
 *     'does not have required permissions' pattern has a different word
 *     order), so the deploy hard-failed instead of retrying. Every fresh
 *     deploy of this fixture re-opens that race window.
 *
 *  2. Version/Alias UPDATE flow. CDKD_TEST_UPDATE=true changes the inline
 *     code, which mints a NEW AWS::Lambda::Version logical id: the update must
 *     create the new version, point the alias at it, and delete the old one.
 *
 * Known CloudFormation divergence (intentional, documented): CDK attaches
 * `UpdatePolicy: CodeDeployLambdaAliasUpdate` to the Alias, which makes
 * CloudFormation shift alias traffic gradually through CodeDeploy (canary
 * 10%/5min). cdkd does not process UpdatePolicy — the alias is flipped
 * directly in one step. For cdkd's dev/test-iteration use case the instant
 * flip is the desired behavior; the DeploymentGroup itself is still created
 * and usable for real CodeDeploy deployments triggered outside cdkd.
 */
export class CodedeployLambdaDeploymentGroupStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';

    const fn = new lambda.Function(this, 'Fn', {
      functionName: 'cdkd-codedeploy-canary-fn',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(
        `exports.handler = async () => ({ version: '${isUpdate ? 'v2' : 'v1'}' });`
      ),
    });

    const alias = new lambda.Alias(this, 'Alias', {
      aliasName: 'live',
      version: fn.currentVersion,
    });

    const application = new codedeploy.LambdaApplication(this, 'Application', {
      applicationName: 'cdkd-codedeploy-integ-app',
    });

    new codedeploy.LambdaDeploymentGroup(this, 'DeploymentGroup', {
      application,
      alias,
      deploymentGroupName: 'cdkd-codedeploy-integ-dg',
      deploymentConfig: codedeploy.LambdaDeploymentConfig.CANARY_10PERCENT_5MINUTES,
    });
  }
}
