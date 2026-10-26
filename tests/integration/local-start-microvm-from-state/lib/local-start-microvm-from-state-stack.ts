import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * A deployed Lambda MicroVM image whose EnvironmentVariables are intrinsics of
 * other resources in the stack, for `cdkd local start-microvm --from-state`
 * (go-to-k/cdkd#5330): `BUCKET_NAME` is a `Ref` and `BUCKET_ARN` a
 * `Fn::GetAtt ... Arn` of an empty bucket, `PARAM_NAME` a `Ref` of an SSM
 * parameter. Only cdkd's state can fill them in locally.
 *
 * The code is an `s3assets.Asset` of `app/`, which is what the local command
 * builds: it finds the bundle in cdk.out by the `<hash>.zip` key at the end of
 * `CodeArtifact.Uri`. The DEPLOYED build reads that same key from a prefix of
 * the state bucket that verify.sh uploads to (MICROVM_ARTIFACT_URI), with the
 * build role reading only that prefix, as `lambda-microvm-image` does.
 *
 * The image declares no lifecycle hooks, so the cloud build snapshots once the
 * app listens on 8080 and the local run is ready on the first HTTP answer.
 *
 * Every name carries the run's `CDKD_MVMFS_RUN` token.
 *
 * covers: AWS::Lambda::MicrovmImage
 * covers: AWS::S3::Bucket
 * covers: AWS::SSM::Parameter
 * covers: AWS::IAM::Role
 */
export class LocalStartMicrovmFromStateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const run = process.env['CDKD_MVMFS_RUN'] ?? 'r0';
    const prefix = `cdkd-integ-mvmfs-${run}`;
    const stateBucket = process.env['STATE_BUCKET'] ?? 'REPLACE_ME';
    const artifactPrefix = `cdkd-integ-microvm-fs-artifacts/${run}`;

    const code = new s3assets.Asset(this, 'Code', { path: path.join(here, '..', 'app') });
    const artifactUri =
      process.env['MICROVM_ARTIFACT_URI'] ?? `s3://${stateBucket}/${artifactPrefix}/${code.s3ObjectKey}`;

    const bucket = new s3.Bucket(this, 'Bucket', {
      bucketName: `${prefix}-${this.account}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const param = new ssm.StringParameter(this, 'Param', {
      parameterName: `/cdkd-integ/mvmfs/${run}`,
      stringValue: `value-${run}`,
    });

    // The role Lambda assumes during the image build to download the code
    // artifact and write build logs (copied from lambda-microvm-image).
    const buildRole = new iam.Role(this, 'BuildRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'cdkd integ: MicroVM image build role (local start-microvm --from-state)',
    });
    buildRole.assumeRolePolicy?.addStatements(
      new iam.PolicyStatement({
        actions: ['sts:TagSession'],
        principals: [new iam.ServicePrincipal('lambda.amazonaws.com')],
      })
    );
    buildRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [`arn:aws:s3:::${stateBucket}/${artifactPrefix}/*`],
      })
    );
    buildRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: ['arn:aws:logs:*:*:*'],
      })
    );

    // `CfnResource`, as in lambda-microvm-image, so the template shape does not
    // depend on which aws-cdk-lib release ships the L1.
    new cdk.CfnResource(this, 'Image', {
      type: 'AWS::Lambda::MicrovmImage',
      properties: {
        Name: prefix,
        BaseImageArn: cdk.Fn.sub(
          'arn:${AWS::Partition}:lambda:${AWS::Region}:aws:microvm-image:al2023-1'
        ),
        BuildRoleArn: buildRole.roleArn,
        CodeArtifact: { Uri: artifactUri },
        Description: 'cdkd integ: local start-microvm --from-state',
        CpuConfigurations: [{ Architecture: 'ARM_64' }],
        Resources: [{ MinimumMemoryInMiB: 4096 }],
        EnvironmentVariables: [
          { Key: 'BUCKET_NAME', Value: bucket.bucketName },
          { Key: 'BUCKET_ARN', Value: bucket.bucketArn },
          { Key: 'PARAM_NAME', Value: param.parameterName },
        ],
      },
    });

    new cdk.CfnOutput(this, 'CodeKey', { value: code.s3ObjectKey });
  }
}
