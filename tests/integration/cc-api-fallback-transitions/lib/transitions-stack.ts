import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * Two integ probes for #634 items 3 + 4 — both live in one app so the
 * verify.sh can deploy + destroy them in one AWS round-trip:
 *
 *   - {@link OverrideStack} (#634 item 3): the user passes
 *     `--allow-unsupported-properties AWS::Lambda::Function:RecursiveLoop`
 *     at deploy time → cdkd's routing decision picks SDK + accepts the
 *     silent drop (warn-logged). State stamps `provisionedBy: 'sdk'`;
 *     AWS does NOT receive `RecursiveLoop` (stays at the `Terminate` default).
 *
 *   - {@link UpdateTransitionStack} (#634 item 4): a fresh deploy WITHOUT
 *     `RecursiveLoop` lands the Lambda on the SDK path (state stamps
 *     `provisionedBy: 'sdk'`). A subsequent deploy where the template
 *     gained `RecursiveLoop` (toggled via the
 *     `CDKD_INTEG_USE_SILENT_DROP=true` env var) re-routes through CC
 *     API mid-life — state flips to `provisionedBy: 'cc-api'` and AWS
 *     now receives `RecursiveLoop`. This is the more dangerous path
 *     (provider swap on an existing resource) that the cc-api-fallback
 *     fixture's fresh-deploy case doesn't exercise.
 *
 * `RecursiveLoop` is the canonical silent-drop CC-API-fallback example
 * as of the #609 LoggingConfig backfill (LoggingConfig used to play this
 * role but is now wired by the SDK provider). Default is `Terminate`; we
 * set `Allow` so the read-back is unambiguous.
 *
 * Both stacks share the IAM-Role-on-SDK + Lambda-as-probe shape from
 * `tests/integration/cc-api-fallback/`. Function names are stable
 * literals so `verify.sh` can `aws lambda get-function-recursion-config`
 * against them post-deploy.
 */

/**
 * #634 item 3 — `--allow-unsupported-properties` override path.
 *
 * Template ALWAYS emits `RecursiveLoop`. The override is supplied at the
 * cdkd CLI level (verify.sh adds the flag to deploy), so the routing
 * picks SDK and silent-drops the property — same code path as the
 * `provider-registry-cc-routing.test.ts` unit test but verified
 * end-to-end against real AWS.
 */
export class OverrideStack extends cdk.Stack {
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

    const fn = new lambda.CfnFunction(this, 'OverrideProbe', {
      functionName: 'cdkd-cc-api-override-probe',
      runtime: 'python3.12',
      handler: 'index.handler',
      role: role.roleArn,
      code: {
        zipFile: [
          'def handler(event, context):',
          '    return {"statusCode": 200, "body": "cdkd #634 item 3 probe"}',
        ].join('\n'),
      },
      // Silent-drop on cdkd's SDK Provider — the verify.sh deploys with
      // `--allow-unsupported-properties AWS::Lambda::Function:RecursiveLoop`
      // so the override path fires (SDK route + accept silent drop, warn log).
      recursiveLoop: 'Allow',
    });

    fn.addDependency(role.node.defaultChild as cdk.CfnElement);
  }
}

/**
 * #634 item 4 — mid-life SDK→CC re-route on a silent-drop property added
 * after the first deploy.
 *
 * Template emits `RecursiveLoop` iff `CDKD_INTEG_USE_SILENT_DROP=true`
 * at synth time. The verify.sh deploys twice:
 *   1. with the env var unset → no `RecursiveLoop` → state stamps SDK
 *   2. with the env var set → `RecursiveLoop` reaches the template, the
 *      diff detects the new property, `getProviderFor` returns CC, state
 *      flips from `'sdk'` to `'cc-api'`, and `RecursiveLoop` lands on AWS
 */
export class UpdateTransitionStack extends cdk.Stack {
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

    const includeSilentDrop =
      process.env['CDKD_INTEG_USE_SILENT_DROP'] === 'true';

    const fn = new lambda.CfnFunction(this, 'TransitionProbe', {
      functionName: 'cdkd-cc-api-transition-probe',
      runtime: 'python3.12',
      handler: 'index.handler',
      role: role.roleArn,
      code: {
        zipFile: [
          'def handler(event, context):',
          '    return {"statusCode": 200, "body": "cdkd #634 item 4 probe"}',
        ].join('\n'),
      },
      // Toggle: stage 1 of the verify.sh synth omits this; stage 2 adds it.
      ...(includeSilentDrop ? { recursiveLoop: 'Allow' } : {}),
    });

    fn.addDependency(role.node.defaultChild as cdk.CfnElement);
  }
}
