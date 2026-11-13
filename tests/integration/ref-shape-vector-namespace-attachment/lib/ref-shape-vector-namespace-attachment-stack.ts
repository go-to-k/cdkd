import * as cdk from 'aws-cdk-lib';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3tables from 'aws-cdk-lib/aws-s3tables';
import * as s3vectors from 'aws-cdk-lib/aws-s3vectors';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

/**
 * Issue #6243: `Ref` on four types resolved to a value CloudFormation never
 * returns, with no warning — `AWS::S3Vectors::VectorBucket` and
 * `AWS::AppSync::GraphQLApi` to the bucket name / API id instead of the ARN,
 * `AWS::S3Tables::Namespace` to the bare name instead of
 * `<tableBucketARN>|<namespace>`, and `AWS::EC2::VPCGatewayAttachment` to
 * `<igwId>|<vpcId>` instead of `IGW|<vpcId>`.
 *
 * Each `Ref` lands in an Output that verify.sh compares with the value AWS
 * reports; the vector bucket's also reaches a resource property (an SSM
 * parameter's value). Under `CDKD_TEST_UPDATE=true` only that parameter's
 * description changes, so the second deploy re-resolves every `Ref` from the
 * stored records.
 *
 * covers: AWS::S3Vectors::VectorBucket
 * covers: AWS::AppSync::GraphQLApi
 * covers: AWS::S3Tables::TableBucket
 * covers: AWS::S3Tables::Namespace
 * covers: AWS::EC2::VPCGatewayAttachment
 */
export class RefShapeVectorNamespaceAttachmentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';

    const vectorBucket = new s3vectors.CfnVectorBucket(this, 'VectorBucket', {});
    const param = new ssm.CfnParameter(this, 'VectorBucketRefParam', {
      type: 'String',
      value: vectorBucket.ref,
      description: isUpdate ? 'vector bucket ref (updated)' : 'vector bucket ref',
    });

    const api = new appsync.CfnGraphQLApi(this, 'Api', {
      name: 'cdkd-ref-shape-6243',
      authenticationType: 'API_KEY',
    });

    // Table bucket names are account-regional; the stack-id suffix keeps a
    // re-run from colliding with a bucket still being deleted.
    const suffix = cdk.Fn.select(0, cdk.Fn.split('-', cdk.Fn.select(2, cdk.Fn.split('/', cdk.Aws.STACK_ID))));
    const tableBucket = new s3tables.CfnTableBucket(this, 'TableBucket', {
      tableBucketName: cdk.Fn.join('-', ['cdkd-ref-shape', suffix]),
    });
    const namespace = new s3tables.CfnNamespace(this, 'Namespace', {
      tableBucketArn: tableBucket.attrTableBucketArn,
      namespace: 'refshape',
    });

    const vpc = new ec2.CfnVPC(this, 'Vpc', { cidrBlock: '10.243.0.0/16' });
    const igw = new ec2.CfnInternetGateway(this, 'Igw');
    const attachment = new ec2.CfnVPCGatewayAttachment(this, 'IgwAttachment', {
      vpcId: vpc.ref,
      internetGatewayId: igw.ref,
    });

    new cdk.CfnOutput(this, 'VectorBucketRef', { value: vectorBucket.ref });
    new cdk.CfnOutput(this, 'VectorBucketArn', { value: vectorBucket.attrVectorBucketArn });
    new cdk.CfnOutput(this, 'ParamName', { value: param.ref });
    new cdk.CfnOutput(this, 'ApiRef', { value: api.ref });
    new cdk.CfnOutput(this, 'ApiId', { value: api.attrApiId });
    new cdk.CfnOutput(this, 'TableBucketRef', { value: tableBucket.ref });
    new cdk.CfnOutput(this, 'NamespaceRef', { value: namespace.ref });
    new cdk.CfnOutput(this, 'VpcId', { value: vpc.ref });
    new cdk.CfnOutput(this, 'IgwId', { value: igw.ref });
    new cdk.CfnOutput(this, 'AttachmentRef', { value: attachment.ref });
  }
}
