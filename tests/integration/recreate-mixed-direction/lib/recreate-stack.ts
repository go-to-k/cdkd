import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * Integ fixture for the #651 follow-up — mixed-direction recreate in a
 * single deploy.
 *
 * Two Lambda Functions that migrate in OPPOSITE directions in the SAME
 * `cdkd deploy` call: `FwdProbe` SDK->CC (forward) and `BackProbe` CC->SDK
 * (reverse). Phase env `CDKD_INTEG_PHASE`, set by verify.sh:
 *
 *   - `0` (default): neither function has RuntimeManagementConfig. Plain
 *     deploy -> both `'sdk'`.
 *   - `1` (seed): BackProbe gains RuntimeManagementConfig, deployed with
 *     `--recreate-via-cc-api BackProbe` -> Fwd `'sdk'`, Back `'cc-api'`. This
 *     is the inverted baseline the arm starts from.
 *   - `2` (THE ARM): inverted — FwdProbe gains RuntimeManagementConfig +
 *     `--recreate-via-cc-api FwdProbe`; BackProbe loses it +
 *     `--recreate-via-sdk-provider BackProbe`. Result: Fwd `'sdk'` ->
 *     `'cc-api'`, Back `'cc-api'` -> `'sdk'`.
 *
 * HOW BackProbe's CC BASELINE IS SEEDED. With `--recreate-via-cc-api`, never
 * with the silent-drop auto-route. The auto-route needs a property the SDK
 * provider does NOT handle, and that is a moving premise: this fixture seeded
 * through `LoggingConfig`, then `RecursiveLoop`, then
 * `RuntimeManagementConfig`, and each was later wired into
 * `lambda-function-provider.ts`, after which BackProbe silently landed on
 * `'sdk'` and the run failed before reaching anything it tests. The type's
 * remaining silent drops cannot carry a fixture (`CapacityProviderConfig` /
 * `FunctionScalingConfig` need Lambda Managed Instances capacity;
 * `PublishToLatestPublished` is an undocumented CloudFormation directive).
 * The explicit flag depends on no coverage table, so a backfill cannot rot it.
 *
 * `RuntimeManagementConfig` (default `UpdateRuntimeOn: 'Auto'`; set
 * `'FunctionUpdate'` here) toggles with the phase because routing is decided
 * while PROVISIONING: a deploy the differ classifies NO_CHANGE never reaches
 * the provider, so a recreate flag on an unchanged resource does nothing
 * (go-to-k/cdkd#2651). Both layers handle the property today; it is here as
 * the property delta and as an AWS-side witness, NOT as a routing trigger.
 *
 * The single Phase 2 deploy mixes both flags so the deploy engine's
 * recreate-target processing handles both directions in one DAG run.
 * Each target's destroy uses the recorded provisionedBy (correct
 * provider for the old physical resource) and create uses the forced
 * direction hint (correct provider for the new physical resource).
 *
 * Distinct fixture (not extending recreate-via-cc-api / recreate-via-sdk-provider)
 * so each fixture stays single-purpose and the mixed-direction code
 * path has its own reproducible scenario in the integ matrix.
 */
export class RecreateMixedDirectionStack extends cdk.Stack {
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

    // Phase selector — see the phase table in the class comment.
    const rawPhase = process.env['CDKD_INTEG_PHASE'] ?? '0';
    if (!['0', '1', '2'].includes(rawPhase)) {
      throw new Error(`Unknown CDKD_INTEG_PHASE '${rawPhase}' (expected 0 | 1 | 2)`);
    }
    const phase = Number(rawPhase);

    // RuntimeManagementConfig.UpdateRuntimeOn default is 'Auto'; 'FunctionUpdate'
    // is the non-default we set so the property is observable on AWS.
    const runtimeManagementConfig = { updateRuntimeOn: 'FunctionUpdate' };

    const fwd = new lambda.CfnFunction(this, 'FwdProbe', {
      functionName: 'cdkd-recreate-mixed-direction-fwd',
      runtime: 'python3.12',
      handler: 'index.handler',
      role: role.roleArn,
      code: {
        zipFile: [
          'def handler(event, context):',
          '    return {"statusCode": 200, "body": "cdkd #651 fwd probe"}',
        ].join('\n'),
      },
      ...(phase === 2 ? { runtimeManagementConfig } : {}),
    });
    fwd.addDependency(role.node.defaultChild as cdk.CfnElement);

    const back = new lambda.CfnFunction(this, 'BackProbe', {
      functionName: 'cdkd-recreate-mixed-direction-back',
      runtime: 'python3.12',
      handler: 'index.handler',
      role: role.roleArn,
      code: {
        zipFile: [
          'def handler(event, context):',
          '    return {"statusCode": 200, "body": "cdkd #651 back probe"}',
        ].join('\n'),
      },
      ...(phase === 1 ? { runtimeManagementConfig } : {}),
    });
    back.addDependency(role.node.defaultChild as cdk.CfnElement);
  }
}
