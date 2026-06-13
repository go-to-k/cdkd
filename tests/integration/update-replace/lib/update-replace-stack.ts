import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

/**
 * UPDATE / replacement breadth example stack.
 *
 * Exercises BOTH cdkd update paths in a single fixture, gated on the
 * `CDKD_TEST_UPDATE=true` env var (read at synth time so a second deploy
 * synthesizes the mutated template without any code change):
 *
 *   In-place update() (physical id unchanged):
 *     - AWS::S3::Bucket    VersioningConfiguration off -> on
 *     - AWS::Lambda::Function  Environment var + MemorySize change
 *     - AWS::IAM::Role     inline Policy document edit (add an action)
 *     - AWS::EC2::SecurityGroup  ingress rule added
 *
 *   Replacement (new physical id; BucketName is in the replacement-rules
 *   registry's S3 `replacementProperties` set):
 *     - AWS::S3::Bucket    BucketName suffix change -> delete + recreate
 *
 * All resources are cheap (no VPC NAT / RDS): the SecurityGroup uses the
 * account's default VPC so no VPC is provisioned by the stack.
 */
export class UpdateReplaceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';

    // --- In-place: S3 Bucket versioning toggle -------------------------
    // Versioning starts OFF, flips ON under CDKD_TEST_UPDATE. The bucket
    // keeps its (auto-generated) physical id across the update — only
    // VersioningConfiguration changes, which the replacement-rules
    // registry marks updateable for AWS::S3::Bucket.
    const inPlaceBucket = new s3.Bucket(this, 'InPlaceBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: false,
      versioned: isUpdate,
    });

    // --- Replacement: S3 Bucket name change ----------------------------
    // BucketName is in the S3 replacementProperties set, so changing the
    // suffix forces delete + recreate -> a NEW physical id. The name is
    // derived from the (stable across deploys) account + region so it is
    // globally unique without a random suffix that would itself change
    // every synth.
    const replaceSuffix = isUpdate ? 'v2' : 'v1';
    const replaceBucket = new s3.Bucket(this, 'ReplaceBucket', {
      bucketName: `cdkd-update-replace-${this.account}-${this.region}-${replaceSuffix}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: false,
    });

    // --- In-place: IAM Role inline policy edit -------------------------
    // The inline policy starts with s3:GetObject only; under
    // CDKD_TEST_UPDATE it also grants s3:PutObject. RoleName is fixed so
    // the role keeps its physical id (RoleName is the only S3-style
    // replacement trigger for IAM::Role and we do NOT change it); the
    // Policies document is updateable in place.
    const role = new iam.Role(this, 'WorkerRole', {
      roleName: `cdkd-update-replace-${this.region}-worker`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    const actions = ['s3:GetObject'];
    if (isUpdate) {
      actions.push('s3:PutObject');
    }
    role.addToPolicy(
      new iam.PolicyStatement({
        actions,
        resources: [replaceBucket.arnForObjects('*')],
      })
    );

    // --- In-place: Lambda env var + memorySize change ------------------
    // Inline code (no asset publishing). STAGE env var dev -> prod and
    // MemorySize 128 -> 256 under CDKD_TEST_UPDATE — both updateable in
    // place for AWS::Lambda::Function (FunctionName unchanged, so the
    // function keeps its physical id / ARN).
    new lambda.Function(this, 'WorkerFn', {
      functionName: `cdkd-update-replace-${this.region}-fn`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(
        'exports.handler = async () => ({ statusCode: 200, body: "ok" });'
      ),
      memorySize: isUpdate ? 256 : 128,
      environment: {
        STAGE: isUpdate ? 'prod' : 'dev',
      },
    });

    // --- In-place: SecurityGroup ingress rule add ----------------------
    // Use the account's default VPC so the stack provisions no VPC of its
    // own. Ingress starts empty, gains a tcp/443 from-anywhere rule under
    // CDKD_TEST_UPDATE. SecurityGroupIngress is updated in place — the SG
    // keeps its physical id (sg-...).
    const vpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', { isDefault: true });
    const sg = new ec2.SecurityGroup(this, 'WorkerSg', {
      vpc,
      description: 'cdkd update-replace ingress test SG',
      allowAllOutbound: true,
    });
    if (isUpdate) {
      sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'https in (update)');
    }

    // --- Outputs (physical ids the verify.sh queries) ------------------
    new cdk.CfnOutput(this, 'InPlaceBucketName', { value: inPlaceBucket.bucketName });
    new cdk.CfnOutput(this, 'ReplaceBucketName', { value: replaceBucket.bucketName });
    new cdk.CfnOutput(this, 'RoleName', { value: role.roleName });
    new cdk.CfnOutput(this, 'FunctionName', { value: `cdkd-update-replace-${this.region}-fn` });
    new cdk.CfnOutput(this, 'SecurityGroupId', { value: sg.securityGroupId });
  }
}
