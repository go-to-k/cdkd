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
 * `LoggingConfig` which cdkd's `LambdaFunctionProvider` does not wire
 * to AWS (silent-drop). Pre-#614, this would either be silently dropped
 * (pre-PR #608) or rejected at deploy-time pre-flight (post-PR #608).
 * Post-#614, the resource is auto-routed via Cloud Control API which
 * forwards the full property map to AWS — closing the silent-drop bug
 * by default.
 *
 * The fixture's verify.sh asserts:
 *   (a) state.resources.SilentDropLambda.provisionedBy === 'cc-api'
 *   (b) the Lambda's `LoggingConfig` reached AWS (verified via
 *       `aws lambda get-function-configuration`)
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

    // Lambda Function with `LoggingConfig` (silent-drop in cdkd's SDK
    // Provider). With #614, this resource is auto-routed via Cloud
    // Control API instead of the SDK Provider.
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
      loggingConfig: {
        logFormat: 'JSON',
        applicationLogLevel: 'INFO',
        systemLogLevel: 'INFO',
      },
    });

    fn.addDependency(role.node.defaultChild as cdk.CfnElement);
  }
}
