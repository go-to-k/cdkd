import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * Integ fixture for the #651 follow-up — mixed-direction recreate in a
 * single deploy.
 *
 * Two Lambda Functions whose template flips inversely across phases so
 * one migrates SDK->CC (forward) and the other CC->SDK (reverse) in the
 * SAME `cdkd deploy` call:
 *
 *   - `FwdProbe`: Phase 1 WITHOUT RecursiveLoop (lands SDK).
 *                 Phase 2 WITH RecursiveLoop + --recreate-via-cc-api.
 *                 Result: provisionedBy flips 'sdk' -> 'cc-api'.
 *   - `BackProbe`: Phase 1 WITH RecursiveLoop (auto-routes to CC).
 *                  Phase 2 WITHOUT RecursiveLoop + --recreate-via-sdk-provider.
 *                  Result: provisionedBy flips 'cc-api' -> 'sdk'.
 *
 * `RecursiveLoop` is the canonical silent-drop demo property as of the
 * #609 LoggingConfig backfill (default Terminate; set Allow here).
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

    // Phase selector. Phase 1: FwdProbe has no RecursiveLoop, BackProbe
    // has it (so it auto-routes to CC). Phase 2: inverted — FwdProbe
    // gets RecursiveLoop (so the recreate-via-cc-api flag has a real
    // forward-migration property to honor), BackProbe loses it (so the
    // reverse direction's inverse-ambiguous-intent guard doesn't refuse).
    const phase = process.env['CDKD_INTEG_PHASE'] === '2' ? 2 : 1;

    // RecursiveLoop default is 'Terminate'; 'Allow' is the non-default we set
    // so the silent-drop / CC-route is observable on AWS.
    const recursiveLoop = 'Allow';

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
      ...(phase === 2 ? { recursiveLoop } : {}),
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
      ...(phase === 1 ? { recursiveLoop } : {}),
    });
    back.addDependency(role.node.defaultChild as cdk.CfnElement);
  }
}
