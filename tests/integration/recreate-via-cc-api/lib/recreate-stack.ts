import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * Integ fixture for #615 — `--recreate-via-cc-api <LogicalId>`.
 *
 * Single Lambda Function with a conditionally-emitted `LoggingConfig`
 * top-level property. The verify.sh deploys twice:
 *
 *   Phase 1 (env `CDKD_INTEG_USE_LOGGING_CONFIG` unset): template
 *   omits `LoggingConfig` → fresh deploy → `provisionedBy: 'sdk'`,
 *   AWS has no LoggingConfig.
 *
 *   Phase 2 (env=true + `--recreate-via-cc-api RecreateProbe`):
 *   template now emits `LoggingConfig` AND the user opts into the
 *   recreate flag → cdkd detects the recreate target, forces the
 *   replacement code path even though the property change isn't
 *   `requiresReplacement` on its own (`LoggingConfig` is otherwise
 *   in-place updatable on SDK but SDK doesn't wire it). The old
 *   physical id is destroyed via SDK; the new physical id is created
 *   via Cloud Control API and stamps `provisionedBy: 'cc-api'`. AWS
 *   now has the JSON-format LoggingConfig.
 *
 * Lambda is the canonical silent-drop demo type (cc-api-fallback /
 * cc-api-fallback-transitions both use it). The function name is
 * stable across recreates (the destroy+create reuses the user-supplied
 * name, so the physical-id is identical post-recreate); the new Lambda
 * instance is witnessed by `LastModified` updating, not by the
 * physical-id changing.
 */
export class RecreateViaCcApiStack extends cdk.Stack {
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
      functionName: 'cdkd-recreate-via-cc-api-probe',
      runtime: 'python3.12',
      handler: 'index.handler',
      role: role.roleArn,
      code: {
        zipFile: [
          'def handler(event, context):',
          '    return {"statusCode": 200, "body": "cdkd #615 probe"}',
        ].join('\n'),
      },
      // Phase 1: no LoggingConfig → SDK route, `provisionedBy: 'sdk'`.
      // Phase 2: LoggingConfig added → with --recreate-via-cc-api the
      // resource is destroy+recreated via CC API.
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
