import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * Integ probe for Lambda SnapStart on Python (PublishedVersions) plus the
 * `fn.currentVersion` + Alias rotation dance — the modern cold-start
 * mitigation pattern.
 *
 * Phase 1 (no env): function with SnapStart ON_PUBLISHED_VERSIONS, a
 * published version (currentVersion), and a `live` alias tracking it.
 * Phase 2 (CDKD_TEST_UPDATE=true): an env var changes, which forces a NEW
 * Version resource (currentVersion logical-id hash churn) — cdkd must
 * update the function, publish the new version (with a SnapStart snapshot),
 * retarget the alias, and delete the old version, in that dependency order.
 *
 * covers: AWS::Lambda::Function
 * covers: AWS::Lambda::Version
 * covers: AWS::Lambda::Alias
 * covers: AWS::IAM::Role
 * Confirmed CLEAN by a /hunt-bugs sweep (2026-07-17); this fixture is the
 * regression guard.
 */
export class LambdaSnapstartStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const update = process.env.CDKD_TEST_UPDATE === 'true';

    const fn = new lambda.Function(this, 'Fn', {
      functionName: 'cdkd-integ-snapstart-fn',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(
        'import os\ndef handler(event, context):\n    return {"greeting": os.environ.get("GREETING", "none")}\n'
      ),
      environment: { GREETING: update ? 'hello-v2' : 'hello-v1' },
      snapStart: lambda.SnapStartConf.ON_PUBLISHED_VERSIONS,
      memorySize: 512,
      timeout: cdk.Duration.seconds(10),
    });

    const version = fn.currentVersion;
    const alias = new lambda.Alias(this, 'Live', {
      aliasName: 'live',
      version,
    });

    new cdk.CfnOutput(this, 'AliasArn', { value: alias.functionArn });
    new cdk.CfnOutput(this, 'VersionNumber', { value: version.version });
  }
}
