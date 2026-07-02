import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as synthetics from 'aws-cdk-lib/aws-synthetics';

/**
 * Synthetics Canary via Cloud Control. This fixture is the regression guard
 * for the failed-create remnant cleanup in CloudControlProvider: the canary
 * create MATERIALIZES the canary entity first and stabilizes it afterwards,
 * and cdkd's fast path creates the execution role only ~1s earlier, so the
 * IAM-propagation race routinely lands the first create attempt in ERROR
 * state ("The role defined for the function cannot be assumed by Lambda").
 * Without the remnant cleanup, the ERROR canary keeps occupying the name and
 * every outer retry dies with AlreadyExists; with it, the retry re-creates
 * cleanly once IAM propagates. The race is timing-dependent — a run where it
 * does not fire still exercises the plain CC create/update/destroy path.
 *
 * StartCanaryAfterCreation is false so the canary never runs (no artifacts,
 * no CloudWatch cost) and the artifacts bucket stays empty for a clean
 * destroy. UPDATE (CDKD_TEST_UPDATE=true) flips the schedule expression —
 * an in-place CC UPDATE.
 *
 * NOTE: RuntimeVersion rots as AWS retires runtimes. If CREATE fast-fails on
 * an invalid runtime, pick the newest from:
 *   aws synthetics describe-runtime-versions \
 *     --query "RuntimeVersions[?DeprecationDate==null].VersionName"
 */
export class SyntheticsCanaryStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const artifacts = new s3.Bucket(this, 'Artifacts', {
      bucketName: `${this.stackName.toLowerCase()}-artifacts`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const role = new iam.Role(this, 'CanaryRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    artifacts.grantReadWrite(role);
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:ListAllMyBuckets', 's3:GetBucketLocation'],
        resources: ['*'],
      })
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: ['arn:aws:logs:*:*:*'],
      })
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': 'CloudWatchSynthetics' } },
      })
    );

    const scheduleExpr =
      process.env.CDKD_TEST_UPDATE === 'true' ? 'rate(1 hour)' : 'rate(30 minutes)';

    new synthetics.CfnCanary(this, 'Canary', {
      // Canary names are lowercase, max 21 chars — the stack name won't fit.
      name: 'cdkd-integ-canary',
      artifactS3Location: `s3://${artifacts.bucketName}/canary`,
      executionRoleArn: role.roleArn,
      runtimeVersion: 'syn-nodejs-puppeteer-16.1',
      handler: 'index.handler',
      code: {
        handler: 'index.handler',
        script:
          "const synthetics = require('Synthetics');\nexports.handler = async () => { return 'ok'; };\n",
      },
      schedule: { expression: scheduleExpr },
      runConfig: { timeoutInSeconds: 60 },
      startCanaryAfterCreation: false,
    });
  }
}
