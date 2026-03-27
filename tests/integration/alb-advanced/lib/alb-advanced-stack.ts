import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';

export class AlbAdvancedStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VPC with 2 AZs, public subnets only
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

    // Security Group
    const sg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc,
      description: 'ALB Advanced Security Group',
      allowAllOutbound: true,
    });
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP');

    // Application Load Balancer
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
      securityGroup: sg,
    });

    // Target Group 1: API traffic (port 8080)
    const tg1 = new elbv2.ApplicationTargetGroup(this, 'ApiTargetGroup', {
      vpc,
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/health',
        interval: cdk.Duration.seconds(30),
      },
    });

    // Target Group 2: Default traffic (port 8081)
    const tg2 = new elbv2.ApplicationTargetGroup(this, 'DefaultTargetGroup', {
      vpc,
      port: 8081,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/',
        interval: cdk.Duration.seconds(30),
      },
    });

    // Listener on port 80 with default action forwarding to tg2
    const listener = alb.addListener('Listener', {
      port: 80,
    });

    listener.addAction('DefaultAction', {
      action: elbv2.ListenerAction.forward([tg2]),
    });

    // ListenerRule: path-based routing /api/* → tg1
    new elbv2.ApplicationListenerRule(this, 'ApiRule', {
      listener,
      priority: 1,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/api/*'])],
      action: elbv2.ListenerAction.forward([tg1]),
    });

    // Outputs
    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: alb.loadBalancerDnsName,
    });

    new cdk.CfnOutput(this, 'ApiTargetGroupArn', {
      value: tg1.targetGroupArn,
    });

    new cdk.CfnOutput(this, 'DefaultTargetGroupArn', {
      value: tg2.targetGroupArn,
    });

    // Tags
    cdk.Tags.of(this).add('Project', 'cdkd');
    cdk.Tags.of(this).add('Example', 'alb-advanced');
  }
}
