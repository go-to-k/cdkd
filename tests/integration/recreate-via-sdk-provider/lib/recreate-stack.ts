import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * Integ fixture for #651 — `--recreate-via-sdk-provider <LogicalId>`.
 *
 * Reverse direction of #615: a Lambda Function that lands sticky on
 * `provisionedBy: 'cc-api'` (Phase 1 deploys WITH LoggingConfig so the
 * silent-drop auto-route fires) is destroyed + recreated via cdkd's
 * SDK Provider (Phase 2 re-deploys WITHOUT LoggingConfig + the new
 * flag), so the new physical id stamps `provisionedBy: 'sdk'`. The
 * verify.sh asserts:
 *
 *   - Phase 1: state has `provisionedBy: 'cc-api'`, AWS-side LoggingConfig
 *     is JSON (the CC route forwarded it).
 *   - Phase 2: state flips `'cc-api'` → `'sdk'`, AWS-side LoggingConfig
 *     is gone (the SDK Provider doesn't wire it; in --recreate-via-sdk-provider
 *     we drop LoggingConfig from the template so the inverse ambiguous-intent
 *     guard doesn't refuse), and the Lambda's `LastModified` changed.
 *   - Phase 3: destroy clean (state file + Lambda + role gone).
 *
 * The function name is stable across recreates (same as in the #615
 * fixture: the destroy + recreate cycle reuses the user-supplied
 * `functionName`); `LastModified` distinguishes the two instances.
 */
export class RecreateViaSdkProviderStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const role = new iam.Role(this, 'FnRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaBasicExecutionRole'
        ),
      ],
    });

    const includeLoggingConfig =
      process.env['CDKD_INTEG_USE_LOGGING_CONFIG'] === 'true';

    const fn = new lambda.CfnFunction(this, 'RecreateProbe', {
      functionName: 'cdkd-recreate-via-sdk-provider-probe',
      runtime: 'python3.12',
      handler: 'index.handler',
      role: role.roleArn,
      code: {
        zipFile: [
          'def handler(event, context):',
          '    return {"statusCode": 200, "body": "cdkd #651 probe"}',
        ].join('\n'),
      },
      // Phase 1: LoggingConfig present → cdkd's auto-route via Cloud
      // Control API kicks in (the SDK Provider would silent-drop the
      // property), and the new state record stamps `provisionedBy: 'cc-api'`.
      // Phase 2: env unset → LoggingConfig dropped from the template;
      // combined with `--recreate-via-sdk-provider RecreateProbe`, cdkd
      // destroys the CC-managed copy and creates a fresh one via SDK,
      // stamping `provisionedBy: 'sdk'`.
      ...(includeLoggingConfig
        ? {
            loggingConfig: {
              logFormat: 'JSON',
              applicationLogLevel: 'INFO',
              systemLogLevel: 'INFO',
            },
          }
        : {}),
    });

    fn.addDependency(role.node.defaultChild as cdk.CfnElement);
  }
}
