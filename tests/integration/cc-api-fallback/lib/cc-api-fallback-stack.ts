import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Cloud Control API greenfield fallback integ fixture (issue #614).
 *
 * The Lambda Function below uses the top-level CFn property
 * `RuntimeManagementConfig` which cdkd's `LambdaFunctionProvider` does
 * not wire to AWS (silent-drop). Pre-#614, this would either be silently
 * dropped (pre-PR #608) or rejected at deploy-time pre-flight (post-PR
 * #608). Post-#614, the resource is auto-routed via Cloud Control API
 * which forwards the full property map to AWS — closing the silent-drop
 * bug by default.
 *
 * `RuntimeManagementConfig` is the canonical silent-drop CC-API-fallback
 * example after the #609 RecursiveLoop backfill. Pre-history: LoggingConfig
 * → RecursiveLoop (both got backfilled); RuntimeManagementConfig is the
 * next still-silent-drop replacement trigger. Default
 * `UpdateRuntimeOn: 'Auto'`; we set `'FunctionUpdate'` so the read-back is
 * unambiguous (`'FunctionUpdate'` is a non-default value that requires the
 * CC route to forward the prop).
 *
 * The fixture's verify.sh asserts:
 *   (a) state.resources.SilentDropLambda.provisionedBy === 'cc-api'
 *   (b) the Lambda's `RuntimeManagementConfig` reached AWS (verified via
 *       `aws lambda get-runtime-management-config`)
 *   (c) `cdkd destroy` cleans up via the CC delete path
 */
export class CcApiFallbackStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Execution role for the Lambda — kept on the SDK Provider path so
    // the integ exercises the heterogeneous-state case (some siblings
    // SDK, some CC) from #614 §2.
    const role = new iam.Role(this, 'FnRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaBasicExecutionRole'
        ),
      ],
    });

    // Lambda Function with `RuntimeManagementConfig` (silent-drop in
    // cdkd's SDK Provider — wired via the separate post-create
    // `PutRuntimeManagementConfig` AWS API, not `CreateFunction`). With
    // #614, this resource is auto-routed via Cloud Control API instead of
    // the SDK Provider.
    const fn = new lambda.CfnFunction(this, 'SilentDropLambda', {
      functionName: 'cdkd-cc-api-fallback-probe',
      runtime: 'python3.12',
      handler: 'index.handler',
      role: role.roleArn,
      code: {
        zipFile: [
          'def handler(event, context):',
          '    return {"statusCode": 200, "body": "cdkd #614 probe"}',
        ].join('\n'),
      },
      runtimeManagementConfig: { updateRuntimeOn: 'FunctionUpdate' },
    });

    fn.addDependency(role.node.defaultChild as cdk.CfnElement);
  }
}
