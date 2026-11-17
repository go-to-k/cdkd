import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';
import * as sqs from 'aws-cdk-lib/aws-sqs';
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
 *  2. Version/Alias UPDATE flow. CDKD_TEST_UPDATE=<code> changes the inline
 *     code (unset: v1, `true`: v2, any other value is the code's version
 *     string), which mints a NEW AWS::Lambda::Version logical id: the update
 *     must create the new version and point the alias at it.
 *
 *  3. `UpdatePolicy: CodeDeployLambdaAliasUpdate` (go-to-k/cdkd#6437). CDK
 *     attaches it to the Alias, naming the application, the deployment group
 *     and the `preHook` function with `Ref`s. Skipped by default (the alias
 *     is switched directly); with `--update-policy` cdkd shifts the alias
 *     through a CodeDeploy deployment (canary 10% / 5 min) and waits for it.
 *     The BeforeAllowTraffic hook reports `Succeeded`, or `Failed` under
 *     CDKD_TEST_HOOK=fail, which fails the deployment before any traffic
 *     moves. CDKD_TEST_FAIL=true adds a queue AWS refuses, created after the
 *     alias, so a deploy fails after a successful shift.
 */
export class CodedeployLambdaDeploymentGroupStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const update = process.env.CDKD_TEST_UPDATE;
    const codeVersion = !update ? 'v1' : update === 'true' ? 'v2' : update;
    const hookStatus = process.env.CDKD_TEST_HOOK === 'fail' ? 'Failed' : 'Succeeded';

    const fn = new lambda.Function(this, 'Fn', {
      functionName: 'cdkd-codedeploy-canary-fn',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(
        `exports.handler = async () => ({ version: '${codeVersion}' });`
      ),
    });

    const alias = new lambda.Alias(this, 'Alias', {
      aliasName: 'live',
      version: fn.currentVersion,
    });

    const application = new codedeploy.LambdaApplication(this, 'Application', {
      applicationName: 'cdkd-codedeploy-integ-app',
    });

    // The BeforeAllowTraffic hook: CodeDeploy invokes it with the deployment
    // id and the hook execution id, and waits for it to report a status.
    const preHook = new lambda.Function(this, 'PreTrafficHook', {
      functionName: 'cdkd-codedeploy-canary-hook',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(
        [
          "const { CodeDeployClient, PutLifecycleEventHookExecutionStatusCommand } = require('@aws-sdk/client-codedeploy');",
          'exports.handler = async (event) => {',
          '  await new CodeDeployClient({}).send(new PutLifecycleEventHookExecutionStatusCommand({',
          '    deploymentId: event.DeploymentId,',
          '    lifecycleEventHookExecutionId: event.LifecycleEventHookExecutionId,',
          `    status: '${hookStatus}',`,
          '  }));',
          '};',
        ].join('\n')
      ),
    });

    // CDKD_TEST_FAIL=true: a queue AWS refuses (MessageRetentionPeriod out of
    // range), created after the alias, so the deploy fails once the alias's
    // CodeDeploy shift has succeeded and its rollback has a shift to revert.
    if (process.env.CDKD_TEST_FAIL === 'true') {
      const failing = new sqs.CfnQueue(this, 'FailingQueue', {
        queueName: 'cdkd-codedeploy-canary-failing-queue',
        messageRetentionPeriod: 9999999,
      });
      failing.addDependency(alias.node.defaultChild as cdk.CfnResource);
    }

    new codedeploy.LambdaDeploymentGroup(this, 'DeploymentGroup', {
      application,
      alias,
      preHook,
      deploymentGroupName: 'cdkd-codedeploy-integ-dg',
      deploymentConfig: codedeploy.LambdaDeploymentConfig.CANARY_10PERCENT_5MINUTES,
    });
  }
}
