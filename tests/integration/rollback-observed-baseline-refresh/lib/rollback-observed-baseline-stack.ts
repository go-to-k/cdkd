import * as cdk from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

/**
 * go-to-k/cdkd#6526: an in-place rollback restore refreshes the restored
 * resource's drift baseline.
 *
 * v1 (default): an `s3.Bucket` with ONE lifecycle rule declared WITHOUT an
 * `id`, so the template carries no `Id` and S3 generates one on every
 * `PutBucketLifecycleConfiguration`. The baseline cdkd captures after the
 * create records that generated id.
 *
 * v2 (`ROLLBACK_BASELINE_FAIL=true`): the lifecycle rule is removed (an
 * in-place UPDATE of the bucket) and an `AWS::SQS::Queue` with an
 * out-of-range `MessageRetentionPeriod` (valid range [60, 1209600]) is added,
 * made to DEPEND on the bucket, so the bucket update completes before the
 * queue's create fails. The automatic rollback then restores the bucket in
 * place: its re-PUT of the v1 rule makes S3 generate a NEW id. Before the fix
 * the restored record kept the v1 baseline, so `cdkd drift` reported the rule
 * `Id` as drifted.
 *
 * go-to-k/cdkd#7129: a rollback that RE-CREATES a resource records its drift
 * baseline too. v1 also holds a public hosted zone under a run-scoped fake
 * domain (`cdkd-rb-baseline-<account>-<region>.internal`, never delegated: the records
 * only need to exist, not resolve) and a CNAME `www` with a 300 s TTL, which
 * CDK synthesizes as the STRING `"300"`. v2 renames it to `www2` (TTL 60), a
 * replacement the Route 53 provider runs delete-first inside its update, so
 * the rollback re-creates `www` from its recorded properties. Before the fix
 * the re-created record had no baseline and drift compared `"300"` with the
 * readback's `300`. The failing queue depends on the record too, so the
 * rename completes before the queue fails.
 */
export class RollbackObservedBaselineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const fail = process.env.ROLLBACK_BASELINE_FAIL === 'true';

    const bucket = new s3.Bucket(this, 'Bkt', {
      bucketName: `cdkd-rb-baseline-${this.account}-${this.region}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      ...(!fail && {
        lifecycleRules: [{ expiration: cdk.Duration.days(30), prefix: 'tmp/' }],
      }),
    });

    const zone = new route53.PublicHostedZone(this, 'Zone', {
      zoneName: `cdkd-rb-baseline-${this.account}-${this.region}.internal`,
    });
    const record = new route53.CnameRecord(this, 'Cname', {
      zone,
      recordName: fail ? 'www2' : 'www',
      domainName: 'example.com',
      ttl: cdk.Duration.seconds(fail ? 60 : 300),
    });

    if (fail) {
      // L1, so CDK does not reject the out-of-range value at synth.
      const failing = new sqs.CfnQueue(this, 'FailingQueue', {
        queueName: 'CdkdRollbackObservedBaseline-failing',
        messageRetentionPeriod: 10,
      });
      failing.node.addDependency(bucket);
      failing.node.addDependency(record);
    }
  }
}
