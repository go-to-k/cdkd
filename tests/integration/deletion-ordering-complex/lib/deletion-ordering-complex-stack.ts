import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';

/**
 * Failure-seeking integ for cdkd's destroy-ordering on the ELBv2 family.
 *
 * Topology (a single AZ-spanning minimal VPC, natGateways:0 — no NAT cost):
 *
 *   VPC (10.60.0.0/16, 2 public subnets — ALB needs >=2 AZs)
 *   ├─ InternetGateway + VPCGatewayAttachment
 *   ├─ SecurityGroup (HTTP :80 ingress)
 *   ├─ ApplicationLoadBalancer  (internet-facing, in the 2 public subnets)
 *   ├─ TargetGroup              (TargetType: IP — one private IP target)
 *   │    └─ a single t3.nano EC2 Instance registered as the IP target
 *   ├─ Listener (:80 → default-forward → TargetGroup)
 *   └─ ListenerRule (path /app/* → forward to TargetGroup)
 *
 * covers: AWS::ElasticLoadBalancingV2::LoadBalancer
 * covers: AWS::ElasticLoadBalancingV2::TargetGroup
 * covers: AWS::ElasticLoadBalancingV2::Listener
 * covers: AWS::ElasticLoadBalancingV2::ListenerRule
 *
 * Why this is a destroy-ordering torture test (each constraint is a
 * distinct edge AWS enforces but that is NOT trivially visible as a
 * forward Ref / DependsOn):
 *
 *   1. Listener BEFORE TargetGroup — AWS rejects DeleteTargetGroup with
 *      `ResourceInUse` while a Listener (or ListenerRule) still forwards
 *      to it. cdkd should get this for free: the Listener's
 *      DefaultActions[].TargetGroupArn (and the rule's) Ref the TG, so
 *      the reverse-DAG deletes the Listener/rule first.
 *   2. ListenerRule BEFORE Listener — a rule belongs to its listener;
 *      the rule Refs the Listener's ARN, so reverse-DAG handles it.
 *   3. TargetGroup + Listener BEFORE the LoadBalancer — the Listener
 *      Refs the LB (LoadBalancerArn), so reverse-DAG deletes the Listener
 *      first; the TG, however, does NOT Ref the LB (it only Refs the VPC),
 *      so the TG-vs-LB ordering rides on the Listener-vs-TG edge alone.
 *   4. LoadBalancer ENI release BEFORE Subnet / SecurityGroup delete —
 *      THE hard one. `DeleteLoadBalancer` returns immediately but AWS
 *      tears the LB's hyperplane ENIs out of the subnets asynchronously.
 *      Deleting the Subnet / SecurityGroup before that finishes yields
 *      `DependencyViolation` (mirrors the Lambda-ENI race the
 *      `lambda-vpc-subnet-sg-deletion-order` rule already guards — but
 *      there is currently NO implicit-delete-deps edge for ELBv2).
 *   5. The registered EC2 target also holds an ENI in the subnet + is
 *      bound to the SG, so the Subnet / SG delete must additionally wait
 *      for the instance teardown.
 *
 * If any of these orderings is wrong, `cdkd destroy` fails with a
 * dependency / ResourceInUse error and orphans the LB / subnets / VPC —
 * which the verify.sh DESTROY step is built to catch.
 */
export class DeletionOrderingComplexStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Minimal VPC: 2 public subnets (ALB requires >=2 AZs), no NAT.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.60.0.0/16'),
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

    // Shared SG: HTTP ingress for the ALB; the EC2 target lives in it too,
    // so the SG can only be deleted after BOTH the ALB ENIs and the
    // instance ENI are gone.
    const sg = new ec2.SecurityGroup(this, 'WebSg', {
      vpc,
      description: 'cdkd deletion-ordering-complex shared SG',
      allowAllOutbound: true,
    });
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP');

    // A real registered target so the TargetGroup is non-empty — makes the
    // Listener -> TG -> LB delete chain meaningful (an empty TG would still
    // exercise the API ordering, but a registered IP target also pins an
    // ENI in the subnet, broadening the LB/instance ENI-release race).
    const target = new ec2.Instance(this, 'TargetInstance', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.NANO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: sg,
    });

    // Application Load Balancer in the 2 public subnets.
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
      securityGroup: sg,
    });

    // TargetGroup with TargetType: IP, registering the instance's private IP.
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      vpc,
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      targets: [new elbv2.IpTarget(target.instancePrivateIp, 80)],
      healthCheck: {
        path: '/',
        interval: cdk.Duration.seconds(30),
      },
    });

    // Listener forwarding to the TargetGroup.
    const listener = alb.addListener('Listener', {
      port: 80,
      defaultTargetGroups: [targetGroup],
    });

    // ListenerRule — a second consumer of the same TargetGroup, deepening
    // the Listener/rule -> TG -> LB chain. It forwards /app/* to the TG.
    new elbv2.ApplicationListenerRule(this, 'AppRule', {
      listener,
      priority: 10,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/app/*'])],
      targetGroups: [targetGroup],
    });

    new cdk.CfnOutput(this, 'AlbDnsName', { value: alb.loadBalancerDnsName });
    new cdk.CfnOutput(this, 'AlbArn', { value: alb.loadBalancerArn });
    new cdk.CfnOutput(this, 'TargetGroupArn', { value: targetGroup.targetGroupArn });

    // Own tag for resource location in verify.sh (NOT aws:cdk:path — AWS
    // reserves the aws: prefix and cdkd cannot set it).
    cdk.Tags.of(this).add('cdkd:integ-fixture', 'deletion-ordering-complex');
  }
}
