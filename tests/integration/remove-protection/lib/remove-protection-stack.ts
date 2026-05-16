import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';

/**
 * `cdkd destroy --remove-protection` E2E test stack.
 *
 * Deploys one resource per protection mechanism (covering every type
 * supported by PR #205 v0.59.0 except RDS, which is intentionally
 * out-of-scope due to its 10-15 min create / 10-15 min delete round
 * trip). Each resource is created with deletion-protection / api-
 * termination-protection / equivalent ENABLED, so a bare
 * `cdkd destroy --force` MUST fail and a
 * `cdkd destroy --remove-protection --force` MUST succeed.
 *
 * Resources & protection field:
 *  - AWS::Logs::LogGroup       — DeletionProtectionEnabled: true
 *  - AWS::DynamoDB::Table      — DeletionProtectionEnabled: true
 *  - AWS::Cognito::UserPool    — DeletionProtection: 'ACTIVE'
 *  - AWS::EC2::Instance        — DisableApiTermination: true
 *  - AWS::ElasticLoadBalancingV2::LoadBalancer (ALB)
 *                              — LoadBalancerAttributes
 *                                deletion_protection.enabled=true
 *  - AWS::AutoScaling::AutoScalingGroup
 *                              — DeletionProtection: 'prevent-all-deletion'
 *                                (DesiredCapacity: 0 — no instances, so
 *                                ForceDelete=true on the bypass path
 *                                does not need to terminate instances.)
 *
 * The L2 AutoScalingGroup synthesizes a launch-config-attached
 * AWS::IAM::InstanceProfile under the hood (covers that orphan
 * provider transitively).
 *
 * covers: AWS::IAM::InstanceProfile
 *
 * Stack-level `terminationProtection` is intentionally NOT set on this
 * stack. Mixing it with `--remove-protection` would force the integ to
 * use the same flag for two semantically distinct bypasses; covering
 * the resource-level types is the higher-value test (the stack-level
 * bypass path is exercised end-to-end at unit level).
 *
 * VPC layout: 1 VPC + 2 public subnets in 2 AZs (ALB requires 2 subnets
 * in different AZs). Single SG used by EC2 / ALB / ASG. Subnets are
 * public-only with no NAT to keep deploy fast and avoid hyperplane ENI
 * cleanup.
 */
export class RemoveProtectionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VPC: 2 AZs, public-only, no NAT.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ],
    });

    // Single SG shared by EC2 / ALB / ASG. allowAllOutbound is the
    // default; ingress is intentionally empty (these resources never
    // serve traffic in this test).
    const sg = new ec2.SecurityGroup(this, 'Sg', {
      vpc,
      description: 'remove-protection integ shared SG',
      allowAllOutbound: true,
    });

    // ── AWS::Logs::LogGroup with DeletionProtectionEnabled: true ─────
    // L2 logs.LogGroup does not surface DeletionProtectionEnabled;
    // use L1 CfnLogGroup.
    const logGroup = new logs.CfnLogGroup(this, 'ProtectedLogGroup', {
      retentionInDays: 7,
      deletionProtectionEnabled: true,
    });
    logGroup.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // ── AWS::DynamoDB::Table with DeletionProtectionEnabled: true ────
    const table = new dynamodb.Table(this, 'ProtectedTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deletionProtection: true,
    });

    // ── AWS::Cognito::UserPool with DeletionProtection: ACTIVE ───────
    const userPool = new cognito.UserPool(this, 'ProtectedUserPool', {
      userPoolName: 'cdkd-remove-protection-pool',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deletionProtection: true,
    });

    // ── AWS::EC2::Instance with DisableApiTermination: true ──────────
    // Use the smallest instance type (t3.nano) and an Amazon Linux
    // 2023 AMI lookup so the integ does not need a baked AMI ID. The
    // instance is never logged into; it exists solely as a delete-
    // protection target.
    const instance = new ec2.Instance(this, 'ProtectedInstance', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: sg,
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.NANO
      ),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
    });
    // L2 ec2.Instance does not surface disableApiTermination; flip on
    // the L1 child.
    const cfnInstance = instance.node.defaultChild as ec2.CfnInstance;
    cfnInstance.disableApiTermination = true;
    cfnInstance.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // ── AWS::ELBv2::LoadBalancer (ALB) with deletion_protection.enabled=true
    // Uses LoadBalancerAttributes (NOT a top-level CFn property), so
    // PR #205 added a special-case in countProtectedResources for it.
    const alb = new elbv2.ApplicationLoadBalancer(this, 'ProtectedAlb', {
      vpc,
      internetFacing: false,
      ipAddressType: elbv2.IpAddressType.IPV4,
      securityGroup: sg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      deletionProtection: true,
    });
    alb.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // ── AWS::AutoScaling::AutoScalingGroup with DeletionProtection ───
    // L2 AutoScalingGroup in aws-cdk-lib v2.169 does NOT yet expose
    // the `DeletionProtection` property — set via L1
    // addPropertyOverride. DesiredCapacity: 0 keeps the group empty
    // so ForceDelete=true on the bypass path has nothing to terminate.
    //
    // The L2 requires a UserData; provide an empty one. Health check
    // type=EC2 is the default; we leave it unset.
    const launchTemplate = new ec2.LaunchTemplate(this, 'ProtectedAsgLt', {
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.NANO
      ),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: sg,
    });
    const asg = new autoscaling.AutoScalingGroup(this, 'ProtectedAsg', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      launchTemplate,
      minCapacity: 0,
      maxCapacity: 1,
      desiredCapacity: 0,
    });
    const cfnAsg = asg.node.defaultChild as autoscaling.CfnAutoScalingGroup;
    cfnAsg.addPropertyOverride('DeletionProtection', 'prevent-all-deletion');
    cfnAsg.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // Outputs (verify.sh / inject-drift parity — these IDs are
    // consumed only for human-readable debugging, not the assertion
    // logic).
    new cdk.CfnOutput(this, 'LogGroupName', { value: logGroup.ref });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'InstanceId', { value: instance.instanceId });
    new cdk.CfnOutput(this, 'AlbArn', { value: alb.loadBalancerArn });
    new cdk.CfnOutput(this, 'AsgName', { value: asg.autoScalingGroupName });
  }
}
