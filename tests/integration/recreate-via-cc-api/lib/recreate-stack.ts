import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';

/**
 * Integ fixture for #615 — `--recreate-via-cc-api <LogicalId>`.
 *
 * Single Lambda Function with a conditionally-emitted `RecursiveLoop`
 * top-level property. The verify.sh deploys twice:
 *
 *   Phase 1 (env `CDKD_INTEG_USE_SILENT_DROP` unset): template
 *   omits `RecursiveLoop` → fresh deploy → `provisionedBy: 'sdk'`,
 *   AWS has the default RecursiveLoop=Terminate.
 *
 *   Phase 2 (env=true + `--recreate-via-cc-api RecreateProbe`):
 *   template now emits `RecursiveLoop` AND the user opts into the
 *   recreate flag → cdkd detects the recreate target, forces the
 *   replacement code path even though the property change isn't
 *   `requiresReplacement` on its own (`RecursiveLoop` is otherwise
 *   in-place updatable on SDK but SDK doesn't wire it). The old
 *   physical id is destroyed via SDK; the new physical id is created
 *   via Cloud Control API and stamps `provisionedBy: 'cc-api'`. AWS
 *   now has RecursiveLoop=Allow.
 *
 * `RecursiveLoop` is the canonical silent-drop demo property as of the
 * #609 LoggingConfig backfill (cc-api-fallback / cc-api-fallback-transitions
 * both use it too). The function name is stable across recreates (the
 * destroy+create reuses the user-supplied name, so the physical-id is
 * identical post-recreate); the new Lambda instance is witnessed by
 * `LastModified` updating, not by the physical-id changing.
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

    const includeSilentDrop =
      process.env['CDKD_INTEG_USE_SILENT_DROP'] === 'true';

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
      // Phase 1: no RecursiveLoop → SDK route, `provisionedBy: 'sdk'`.
      // Phase 2: RecursiveLoop added → with --recreate-via-cc-api the
      // resource is destroy+recreated via CC API.
      ...(includeSilentDrop ? { recursiveLoop: 'Allow' } : {}),
    });

    fn.addDependency(role.node.defaultChild as cdk.CfnElement);

    // Issue [#648] — S3 bucket used to verify the live `ListObjectsV2`
    // probe at plan time. The bucket is empty post-deploy; the
    // verify.sh script later pre-stages an object via `aws s3 cp` and
    // asserts that `cdkd deploy --recreate-via-cc-api RecreateProbeBucket`
    // is refused with `has-objects` in the pre-flight error block.
    //
    // RETAIN removal policy + no auto-delete: the verify.sh cleanup
    // step empties the bucket via `aws s3 rm --recursive` before
    // `cdkd destroy`. CDK auto-delete pulls in a Custom Resource which
    // we don't want as a confound for this fixture's `provisionedBy`
    // assertions.
    const bucket = new s3.CfnBucket(this, 'RecreateProbeBucket', {
      bucketName: `cdkd-recreate-via-cc-api-probe-${cdk.Aws.ACCOUNT_ID}`,
    });
    bucket.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
  }
}
