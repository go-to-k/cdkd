import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Fixture stack for `cdkd local invoke --from-state` (PR 2).
 *
 * One Lambda + one S3 bucket. The Lambda's env has `BUCKET_NAME` set to
 * `Ref: MyBucket` so PR 1's local-invoke would drop it (it's an
 * intrinsic). With PR 2's `--from-state`, after `cdkd deploy`, the
 * deployed bucket name is read from cdkd state and substituted, so the
 * Lambda echoes the literal physical bucket name back.
 *
 * Bucket carries `removalPolicy: DESTROY` + `autoDeleteObjects: true` so
 * the integ teardown is fully self-contained.
 *
 * `ACCOUNT_TAG` splices `${AWS::AccountId}`, and `LocalReadRole` is a
 * state-read role the verify script passes as `--role-arn`, so the
 * `--from-state` pseudo-parameter account is exercised with a role published
 * (issue go-to-k/cdkd#3230). Same account as the caller: this arm proves the
 * role path resolves, not that the account differs — that half is unit-tested.
 */
export class LocalInvokeFromStateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, 'MyBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    new lambda.Function(this, 'EchoBucketHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      environment: {
        // The whole point of the integ: this is an intrinsic-valued env
        // var. Without --from-state it would be dropped (PR 1). With
        // --from-state, the deployed bucket name flows through.
        BUCKET_NAME: bucket.bucketName,
        // A literal env var to confirm --from-state doesn't break
        // normal-case behavior on its way through.
        STATIC_VALUE: 'always-the-same',
        // `${AWS::AccountId}` inside a Fn::Join, substituted only under
        // --from-state from the account the state was read in.
        ACCOUNT_TAG: cdk.Fn.join('', ['acct-', cdk.Aws.ACCOUNT_ID]),
      },
      timeout: cdk.Duration.seconds(10),
    });

    // The `--role-arn` the verify script reads state through, scoped to the
    // state bucket: `cdkd local invoke --from-state` asks the role only for
    // that bucket's location, listing and objects (and `GetCallerIdentity`,
    // which needs no grant). The bucket name follows the verify script's.
    const stateBucketName =
      process.env['STATE_BUCKET'] || `cdkd-state-${cdk.Aws.ACCOUNT_ID}`;
    const readRole = new iam.Role(this, 'LocalReadRole', {
      assumedBy: new iam.AccountRootPrincipal(),
    });
    readRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetBucketLocation', 's3:ListBucket'],
        resources: [`arn:${cdk.Aws.PARTITION}:s3:::${stateBucketName}`],
      })
    );
    readRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [`arn:${cdk.Aws.PARTITION}:s3:::${stateBucketName}/*`],
      })
    );
  }
}
