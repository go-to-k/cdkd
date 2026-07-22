import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

/**
 * Exercises `AWS::Lambda::MicrovmImage` (LambdaMicrovmImageProvider) end to end.
 *
 * The code artifact (a zip of Dockerfile + app.js) is uploaded to S3 by
 * verify.sh BEFORE deploy; its S3 URI and bucket name are passed in via env
 * vars so the build role's `s3:GetObject` policy targets the right bucket. The
 * MicroVM image build is asynchronous: cdkd's provider polls until the image
 * reaches CREATED.
 *
 * `AWS::Lambda::MicrovmImage` has no L1 `CfnMicrovmImage` in the installed
 * aws-cdk-lib, so the resource is declared via the `CfnResource` escape hatch
 * (the same shape a real user writes until CDK ships the L1).
 */
export class LambdaMicrovmImageStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const artifactUri = process.env['MICROVM_ARTIFACT_URI'] ?? 's3://REPLACE_ME/artifact.zip';
    const artifactBucket = process.env['MICROVM_ARTIFACT_BUCKET'] ?? 'REPLACE_ME';

    // Build role Lambda assumes during the image build to download the code
    // artifact from S3 and write build logs to CloudWatch.
    const buildRole = new iam.Role(this, 'BuildRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'cdkd integ: MicroVM image build role',
    });
    // The MicroVM build assumes the role with session tags.
    buildRole.assumeRolePolicy?.addStatements(
      new iam.PolicyStatement({
        actions: ['sts:TagSession'],
        principals: [new iam.ServicePrincipal('lambda.amazonaws.com')],
      })
    );
    buildRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [`arn:aws:s3:::${artifactBucket}/*`],
      })
    );
    buildRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: ['arn:aws:logs:*:*:*'],
      })
    );

    // CDKD_TEST_UPDATE flips the tags to a NEW set (add + remove + change) so
    // verify.sh can exercise the tags-only UPDATE path: it must reconcile via
    // TagResource / UntagResource WITHOUT triggering an image rebuild.
    const update = process.env['CDKD_TEST_UPDATE'] === 'true';
    const tags = update
      ? [
          { Key: 'env', Value: 'prod' },
          { Key: 'team', Value: 'infra' },
        ]
      : [{ Key: 'env', Value: 'dev' }];

    const image = new cdk.CfnResource(this, 'MicrovmImage', {
      type: 'AWS::Lambda::MicrovmImage',
      properties: {
        Name: 'cdkd-integ-microvm-image',
        BaseImageArn: cdk.Fn.sub(
          'arn:${AWS::Partition}:lambda:${AWS::Region}:aws:microvm-image:al2023-1'
        ),
        BuildRoleArn: buildRole.roleArn,
        CodeArtifact: { Uri: artifactUri },
        Description: 'cdkd integ MicroVM image',
        CpuConfigurations: [{ Architecture: 'ARM_64' }],
        Resources: [{ MinimumMemoryInMiB: 4096 }],
        Tags: tags,
      },
    });

    new cdk.CfnOutput(this, 'MicrovmImageArn', {
      value: image.getAtt('ImageArn').toString(),
    });
  }
}
