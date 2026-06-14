import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';

/**
 * Propagation-races-2 integ stack.
 *
 * A second fresh-principal / propagation-race stress fixture, distinct from
 * the edges the original IAM-propagation stress integ exercised (Lambda exec
 * role / SFN role / EventBridge target / SQS+SNS resource policy — which
 * surfaced bug #839). Every resource in THIS stack is a NEW consumer of a
 * resource created moments earlier in the SAME deploy, so each is its own
 * propagation-race edge that cdkd must survive without the user re-running:
 *
 *   1. IAM InstanceProfile -> EC2 Instance
 *      `RunInstances` validates the instance profile at launch time.
 *      InstanceProfile propagation is notoriously the SLOWEST IAM surface
 *      (often 5-10s+), so this is the highest-probability race here. AWS
 *      rejects with `Invalid IAM Instance Profile ...` / `... does not exist`
 *      until the profile (and its role attachment) propagate.
 *
 *   2. AWS::Lambda::Permission granting a FRESH source (S3 bucket)
 *      `AddPermission` validates the SourceArn/SourceAccount and the just-
 *      created function. A permission PUT against a function whose role/policy
 *      has not settled, or a source the auth layer has not seen, can 400.
 *
 *   3. S3 BucketPolicy referencing a FRESH IAM role principal
 *      `PutBucketPolicy` validates every principal in the document; a role ARN
 *      created in the same deploy is rejected with `Invalid principal in
 *      policy` until IAM propagates it (the classic S3-policy race).
 *
 *   4. KMS Key policy referencing a FRESH IAM role principal
 *      `CreateKey` (or `PutKeyPolicy`) validates principals in the key policy
 *      the same way; a fresh role ARN can be rejected with
 *      `MalformedPolicyDocumentException` / `... is not valid` until it
 *      propagates.
 *
 * Cost: one t3.micro in a single-AZ no-NAT VPC, one tiny inline Lambda, one
 * S3 bucket, one KMS key, three IAM roles, one instance profile. All cheap;
 * all destroyable. Every named resource carries the `cdkd:integ-fixture` tag
 * so verify.sh can assert it is gone post-destroy by a fixture-owned tag (NOT
 * the `aws:cdk:path` tag, which AWS reserves and cdkd cannot set).
 *
 * The instance / bucket / KMS key are authored as RAW L1 constructs so the
 * fixture controls the exact property set and the consumer-references-fresh-
 * producer wiring without L2 sugar inserting extra resources.
 */
export class PropagationRaces2Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const FIXTURE_TAG_KEY = 'cdkd:integ-fixture';
    const FIXTURE_TAG_VALUE = 'propagation-races-2';
    cdk.Tags.of(this).add(FIXTURE_TAG_KEY, FIXTURE_TAG_VALUE);

    // ---- Edge 1: IAM InstanceProfile -> EC2 Instance -----------------
    // A fresh role + instance profile that the EC2 instance consumes at
    // launch. Instance-profile propagation is the slowest IAM surface, so
    // this is the most likely edge to race.
    const instanceRole = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Fresh role consumed by a same-deploy EC2 instance profile',
    });

    const instanceProfile = new iam.CfnInstanceProfile(this, 'InstanceProfile', {
      roles: [instanceRole.roleName],
    });

    // Minimal VPC: single AZ, no NAT gateways (cost), public subnet only.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ],
    });

    const sg = new ec2.SecurityGroup(this, 'InstanceSG', {
      vpc,
      description: 'SG for the propagation-race EC2 instance',
      allowAllOutbound: true,
    });

    const ami = ec2.MachineImage.latestAmazonLinux2023().getImage(this).imageId;

    // RAW L1 instance. Emit only cdkd-handled top-level props so the instance
    // stays on the SDK provider path (an L2 instance emits AvailabilityZone, a
    // silent-drop that flips the whole resource onto Cloud Control). The
    // IamInstanceProfile reference to the fresh profile is the race edge.
    const instance = new ec2.CfnInstance(this, 'Instance', {
      imageId: ami,
      instanceType: 't3.micro',
      subnetId: vpc.publicSubnets[0].subnetId,
      securityGroupIds: [sg.securityGroupId],
      iamInstanceProfile: instanceProfile.ref,
      // NOT termination-protected: keep destroy a plain terminate so the
      // fixture stays focused on the create-time propagation race.
      tags: [{ key: FIXTURE_TAG_KEY, value: FIXTURE_TAG_VALUE }],
    });
    instance.addDependency(instanceProfile);

    // ---- Edge 2: Lambda::Permission granting a fresh S3 bucket -------
    // A fresh Lambda + a fresh S3 bucket; the permission PUT validates the
    // just-created function AND the just-created source bucket.
    const fn = new lambda.Function(this, 'NotifiedFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(
        'exports.handler = async (e) => ({ statusCode: 200, body: "ok" });'
      ),
      timeout: cdk.Duration.seconds(10),
    });

    const notifyBucket = new s3.Bucket(this, 'NotifyBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: false,
    });

    // RAW L1 permission: grant the fresh bucket permission to invoke the fresh
    // function. AddPermission validates SourceArn + the function in one call.
    const permission = new lambda.CfnPermission(this, 'BucketInvokePermission', {
      action: 'lambda:InvokeFunction',
      functionName: fn.functionName,
      principal: 's3.amazonaws.com',
      sourceArn: notifyBucket.bucketArn,
      sourceAccount: this.account,
    });
    permission.addDependency(fn.node.defaultChild as cdk.CfnResource);
    permission.node.addDependency(notifyBucket);

    // ---- Edge 3: S3 BucketPolicy referencing a fresh role -----------
    // A fresh role + a fresh bucket; PutBucketPolicy validates the role
    // principal in the document (the classic "Invalid principal in policy"
    // S3 race).
    const policyRole = new iam.Role(this, 'BucketReaderRole', {
      assumedBy: new iam.AccountRootPrincipal(),
      description: 'Fresh role referenced by a same-deploy S3 bucket policy',
    });

    const policedBucket = new s3.Bucket(this, 'PolicedBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: false,
    });

    const bucketPolicy = new s3.CfnBucketPolicy(this, 'PolicedBucketPolicy', {
      bucket: policedBucket.bucketName,
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'AllowFreshRoleRead',
            Effect: 'Allow',
            Principal: { AWS: policyRole.roleArn },
            Action: ['s3:GetObject'],
            Resource: `${policedBucket.bucketArn}/*`,
          },
        ],
      },
    });
    bucketPolicy.node.addDependency(policyRole);
    bucketPolicy.node.addDependency(policedBucket);

    // ---- Edge 4: KMS Key policy referencing a fresh role ------------
    // A fresh role + a fresh KMS key whose key policy names the role principal.
    // CreateKey validates every principal in the key policy.
    const kmsRole = new iam.Role(this, 'KmsUserRole', {
      assumedBy: new iam.AccountRootPrincipal(),
      description: 'Fresh role referenced by a same-deploy KMS key policy',
    });

    const key = new kms.CfnKey(this, 'EncryptionKey', {
      description: 'Key whose policy references a same-deploy fresh role',
      keyPolicy: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'AllowRootAdmin',
            Effect: 'Allow',
            Principal: { AWS: `arn:aws:iam::${this.account}:root` },
            Action: 'kms:*',
            Resource: '*',
          },
          {
            Sid: 'AllowFreshRoleUse',
            Effect: 'Allow',
            Principal: { AWS: kmsRole.roleArn },
            Action: ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey'],
            Resource: '*',
          },
        ],
      },
      tags: [{ key: FIXTURE_TAG_KEY, value: FIXTURE_TAG_VALUE }],
    });
    key.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    key.node.addDependency(kmsRole);

    // ---- Outputs -----------------------------------------------------
    new cdk.CfnOutput(this, 'InstanceId', { value: instance.ref });
    new cdk.CfnOutput(this, 'InstanceProfileName', { value: instanceProfile.ref });
    new cdk.CfnOutput(this, 'FunctionName', { value: fn.functionName });
    new cdk.CfnOutput(this, 'NotifyBucketName', { value: notifyBucket.bucketName });
    new cdk.CfnOutput(this, 'PolicedBucketName', { value: policedBucket.bucketName });
    new cdk.CfnOutput(this, 'KeyId', { value: key.ref });
  }
}
