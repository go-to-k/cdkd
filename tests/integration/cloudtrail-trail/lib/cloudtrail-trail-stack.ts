import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import type { Construct } from 'constructs';

/**
 * cdkd integration fixture: AWS::CloudTrail::Trail removal semantics
 * (issue #1160 cloudtrail batch).
 *
 * Phase 1 (default) deploys a trail with every optional UpdateTrail field set.
 * Phase 2 (`CDKD_TEST_REMOVAL=true`) drops all seven and asserts the split a
 * live CFn A/B (2026-08-10) measured: five RESET, and the CloudWatch Logs pair
 * is RETAINED. Asserting the retention is what stops an over-eager provider
 * that cleared everything from passing.
 *
 * `EventSelectors` joins the removal phase in issue #1549. It does NOT ride
 * `UpdateTrail` — it has a dedicated `PutEventSelectors` — which is why the
 * #1160 batch's UpdateTrail-shaped sweep never reached it. A second live CFn
 * A/B (2026-08-11) measured its removal as a RESET to AWS's default selector
 * (`ReadWriteType: All`), not a retention of the custom `WriteOnly` one, and
 * the empty-array shape the sibling `InsightSelectors` uses is rejected here.
 *
 * The trail is created with `IsLogging: false` so it never delivers a log
 * file — the fixture exercises the control plane only, and the bucket stays
 * empty for a clean destroy.
 */
export class CloudTrailTrailStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const removalPhase = process.env['CDKD_TEST_REMOVAL'] === 'true';
    const suffix = cdk.Stack.of(this).account;

    const trailBucket = new s3.Bucket(this, 'TrailBucket', {
      bucketName: `cdkd-integ-ct-${suffix}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      // CloudTrail can write a validation object even with logging disabled,
      // so the bucket must be able to empty itself on destroy.
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
    });

    trailBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AWSCloudTrailAclCheck',
        principals: [new iam.ServicePrincipal('cloudtrail.amazonaws.com')],
        actions: ['s3:GetBucketAcl'],
        resources: [trailBucket.bucketArn],
      })
    );
    trailBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AWSCloudTrailWrite',
        principals: [new iam.ServicePrincipal('cloudtrail.amazonaws.com')],
        actions: ['s3:PutObject'],
        // Covers BOTH phases: phase 1 writes under the key prefix, phase 2
        // (prefix reset to '') writes at the root.
        resources: [`${trailBucket.bucketArn}/*`],
        conditions: { StringEquals: { 's3:x-amz-acl': 'bucket-owner-full-control' } },
      })
    );

    const trailTopic = new sns.Topic(this, 'TrailTopic', {
      topicName: `cdkd-integ-ct-${suffix}`,
    });
    trailTopic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AWSCloudTrailSNSPolicy',
        principals: [new iam.ServicePrincipal('cloudtrail.amazonaws.com')],
        actions: ['sns:Publish'],
        resources: [trailTopic.topicArn],
      })
    );

    const trailLogGroup = new logs.LogGroup(this, 'TrailLogGroup', {
      logGroupName: `/aws/cloudtrail/cdkd-integ-${suffix}`,
      retention: logs.RetentionDays.ONE_DAY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const trailLogsRole = new iam.Role(this, 'TrailLogsRole', {
      assumedBy: new iam.ServicePrincipal('cloudtrail.amazonaws.com'),
      inlinePolicies: {
        logs: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
              // CDK's `logGroupArn` already ends with ':*'.
              resources: [trailLogGroup.logGroupArn],
            }),
          ],
        }),
      },
    });

    // The L1 is used directly: the L2 `cloudtrail.Trail` owns its own bucket
    // and does not expose the removal-relevant fields independently.
    const trail = new cloudtrail.CfnTrail(this, 'Trail', {
      trailName: `cdkd-integ-ct-${suffix}`,
      s3BucketName: trailBucket.bucketName,
      isLogging: false,
      ...(removalPhase
        ? {}
        : {
            s3KeyPrefix: 'integprefix',
            snsTopicName: trailTopic.topicName,
            // Already ':*'-suffixed by CDK; appending another one yields
            // '...:*:*', which CloudTrail rejects outright.
            cloudWatchLogsLogGroupArn: trailLogGroup.logGroupArn,
            cloudWatchLogsRoleArn: trailLogsRole.roleArn,
            isMultiRegionTrail: true,
            enableLogFileValidation: true,
            // AWS rejects a multi-region trail that excludes global service
            // events, so phase 1 sets both together.
            includeGlobalServiceEvents: true,
            // Issue #1549. `WriteOnly` is deliberately NOT the AWS default
            // (`All`), so the removal assertion can tell a RESET from a
            // retention — and from "the Put never happened at all", which is
            // exactly what the pre-fix provider did.
            eventSelectors: [{ readWriteType: 'WriteOnly', includeManagementEvents: true }],
          }),
    });
    // CloudTrail validates its bucket AND topic permissions at create time,
    // and neither policy is referenced by the trail's properties, so neither
    // dependency is implied by the template — both must be explicit or the
    // create races them.
    trail.addDependency(trailBucket.policy!.node.defaultChild as s3.CfnBucketPolicy);
    trail.addDependency(
      trailTopic.node.findChild('Policy').node.defaultChild as sns.CfnTopicPolicy
    );

    new cdk.CfnOutput(this, 'TrailName', { value: `cdkd-integ-ct-${suffix}` });
  }
}
