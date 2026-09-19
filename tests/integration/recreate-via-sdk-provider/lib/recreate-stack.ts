import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * Integ fixture for #651 — `--recreate-via-sdk-provider <LogicalId>`.
 *
 * Reverse direction of #615: a Lambda Function recorded as
 * `provisionedBy: 'cc-api'` is destroyed + recreated via cdkd's SDK Provider,
 * so the new instance stamps `provisionedBy: 'sdk'`.
 *
 * HOW THE CC BASELINE IS SEEDED. With `--recreate-via-cc-api`, never with the
 * silent-drop auto-route. The auto-route needs a property the SDK provider
 * does NOT handle, and that is a moving premise: this fixture seeded through
 * `LoggingConfig`, then `RecursiveLoop`, then `RuntimeManagementConfig`, and
 * each was later wired into `lambda-function-provider.ts`, after which the
 * baseline silently landed on `'sdk'` and the run failed before reaching
 * anything it tests. The type's remaining silent drops cannot carry a
 * fixture: `CapacityProviderConfig` / `FunctionScalingConfig` need Lambda
 * Managed Instances capacity, and `PublishToLatestPublished` is an
 * undocumented CloudFormation directive. The explicit flag depends on no
 * coverage table, so a backfill cannot rot it. (The auto-route itself is
 * covered by `sdk-to-cc-autoroute` and `cc-api-fallback`.)
 *
 * Phase env `CDKD_INTEG_PHASE`, set by verify.sh:
 *
 *   - `base` (default): no `RuntimeManagementConfig`. Plain deploy -> `'sdk'`.
 *   - `seed`: WITH `RuntimeManagementConfig`, deployed with
 *     `--recreate-via-cc-api RecreateProbe` -> `'cc-api'`. AWS-side
 *     `UpdateRuntimeOn` is `FunctionUpdate`, which witnesses that the Cloud
 *     Control create really provisioned the function.
 *   - `recreate`: WITHOUT `RuntimeManagementConfig`, deployed with
 *     `--recreate-via-sdk-provider RecreateProbe` -> `'sdk'`. THE ARM.
 *     AWS-side `UpdateRuntimeOn` is back at the `Auto` default and
 *     `LastModified` changed.
 *
 * `RuntimeManagementConfig` toggles with the phase because routing is decided
 * while PROVISIONING: a deploy the differ classifies NO_CHANGE never reaches
 * the provider, so a recreate flag on an unchanged template does nothing
 * (go-to-k/cdkd#2651). Both layers handle the property today; it is here as
 * the property delta and the AWS-side witness, NOT as a routing trigger.
 *
 * The function name is stable across recreates (the destroy + recreate cycle
 * reuses the user-supplied `functionName`, which is what forces the
 * delete-before-create order); `LastModified` distinguishes the instances.
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

    const phase = process.env['CDKD_INTEG_PHASE'] ?? 'base';
    if (!['base', 'seed', 'recreate'].includes(phase)) {
      throw new Error(`Unknown CDKD_INTEG_PHASE '${phase}' (expected base | seed | recreate)`);
    }
    const withRuntimeManagementConfig = phase === 'seed';

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
      // `seed` only — see the phase table in the class comment.
      ...(withRuntimeManagementConfig
        ? { runtimeManagementConfig: { updateRuntimeOn: 'FunctionUpdate' } }
        : {}),
    });

    fn.addDependency(role.node.defaultChild as cdk.CfnElement);
  }
}
