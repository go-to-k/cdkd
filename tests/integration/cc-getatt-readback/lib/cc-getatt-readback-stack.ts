import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as pipes from 'aws-cdk-lib/aws-pipes';
import * as rg from 'aws-cdk-lib/aws-resourcegroups';

/**
 * Regression fixture for issue #1103: CC-routed types whose async CREATE
 * ResourceModel is sparse ended up with empty state `attributes`, so
 * `Fn::GetAtt` fell through the resolver's constructAttribute default to the
 * bare physicalId (the resource NAME) instead of the documented attribute
 * value. Three daily-use instances, all exercised here via CfnOutput:
 *
 *   - AWS::Pipes::Pipe            `Arn`           (was: the pipe name)
 *   - AWS::S3::AccessPoint        `Arn` + `Alias` (was: the access point name)
 *   - AWS::ResourceGroups::Group  `Arn`           (was: the group name)
 *
 * The fix overlays the readOnly attributes from a CC GetResource read-back
 * (`enrichResourceAttributes` in src/provisioning/cloud-control-provider.ts),
 * generalizing the Backup-scoped read-back shipped for issue #984.
 */
export class CcGetattReadbackStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- S3 AccessPoint (CC-routed; physicalId = access point name) ---
    const bucket = new s3.Bucket(this, 'Bucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const ap = new s3.CfnAccessPoint(this, 'Ap', {
      bucket: bucket.bucketName,
      name: 'cdkd-ccgar-ap',
    });

    // --- Pipes::Pipe (CC-routed; physicalId = pipe name), SQS -> SQS ---
    const src = new sqs.Queue(this, 'Src');
    const tgt = new sqs.Queue(this, 'Tgt');
    const pipeRole = new iam.Role(this, 'PipeRole', {
      assumedBy: new iam.ServicePrincipal('pipes.amazonaws.com'),
    });
    src.grantConsumeMessages(pipeRole);
    tgt.grantSendMessages(pipeRole);
    const pipe = new pipes.CfnPipe(this, 'Pipe', {
      name: 'cdkd-ccgar-pipe',
      roleArn: pipeRole.roleArn,
      source: src.queueArn,
      target: tgt.queueArn,
    });

    // --- ResourceGroups::Group (CC-routed; physicalId = group name) ---
    const group = new rg.CfnGroup(this, 'Rg', {
      name: 'cdkd-ccgar-rg',
      resourceQuery: {
        type: 'TAG_FILTERS_1_0',
        query: {
          resourceTypeFilters: ['AWS::AllSupported'],
          tagFilters: [{ key: 'cdkd-integ', values: ['cc-getatt-readback'] }],
        },
      },
    });

    new cdk.CfnOutput(this, 'PipeArn', { value: pipe.attrArn });
    new cdk.CfnOutput(this, 'ApArn', { value: ap.attrArn });
    new cdk.CfnOutput(this, 'ApAlias', { value: ap.attrAlias });
    new cdk.CfnOutput(this, 'RgArn', { value: group.attrArn });
    new cdk.CfnOutput(this, 'BucketName', { value: bucket.bucketName });
  }
}
