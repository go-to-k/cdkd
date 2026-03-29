import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';

export class AlbStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VPC with 1 AZ to minimize resources
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
      description: 'ALB Security Group',
      allowAllOutbound: true,
    });
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP');

    // Application Load Balancer
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
      securityGroup: sg,
    });

    // Target Group (IP target for simplicity - no instances needed)
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      vpc,
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/',
        interval: cdk.Duration.seconds(30),
      },
    });

    // Listener
    const listener = alb.addListener('Listener', {
      port: 80,
      defaultTargetGroups: [targetGroup],
    });

    // ListenerRule (path-based routing)
    new elbv2.CfnListenerRule(this, 'HealthRule', {
      listenerArn: listener.listenerArn,
      priority: 1,
      conditions: [{ field: 'path-pattern', values: ['/health'] }],
      actions: [{ type: 'fixed-response', fixedResponseConfig: { statusCode: '200', contentType: 'text/plain', messageBody: 'OK' } }],
    });

    // Outputs
    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: alb.loadBalancerDnsName,
    });

    new cdk.CfnOutput(this, 'AlbArn', {
      value: alb.loadBalancerArn,
    });

    // Tags
    cdk.Tags.of(this).add('Project', 'cdkd');
    cdk.Tags.of(this).add('Example', 'alb');
  }
}
