import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

/**
 * Real-AWS integ fixture for `cdkd local start-alb --from-state`.
 *
 * Topology (single stack to keep deploy/destroy cost bounded):
 *
 *   VPC (2 AZ, public subnets only, no NAT)
 *   └── ALB (internet-facing, HTTP listener on :80)
 *       └── Listener
 *           ├── default action  → forward → WebTargetGroup
 *           └── rule path=/orders/* → forward → OrdersTargetGroup
 *   ECS Fargate Cluster
 *   ├── WebService (desiredCount: 0, attached to WebTargetGroup)
 *   │   └── TaskDefinition: busybox httpd on container-port 80
 *   │       env: ALB_DNS_NAME = Fn::GetAtt(Alb, DNSName)
 *   └── OrdersService (desiredCount: 0, attached to OrdersTargetGroup)
 *       └── TaskDefinition: busybox httpd on container-port 80
 *           env: ALB_DNS_NAME = Fn::GetAtt(Alb, DNSName)
 *
 * desiredCount: 0 — the services are CREATED in AWS so cdkd's state file
 * carries every resolved Ref / Fn::GetAtt value (ALB DNS name, target group
 * ARNs, service names), but no actual containers run in AWS (~zero compute
 * cost). The local emulator boots the containers locally + reads the
 * SAME state to substitute every intrinsic into env vars before each
 * container starts.
 *
 * Why this fixture exists: the engine's `--from-state` substitution path
 * for ALB-fronted ECS services is uniquely exercised end-to-end here. The
 * pure-local `local-start-alb` fixture (sibling, no AWS) cannot test
 * substitution because there is no deployed state to read. The
 * `local-invoke-from-state` fixture only covers Lambda. The
 * `local-invoke-agentcore-from-state` fixture only covers
 * AgentCore Runtime. Without this integ, the ALB front-door + ECS service
 * intrinsic substitution path ships unverified against real AWS — exactly
 * the gap that motivated this PR.
 *
 * covers: AWS::EC2::VPC
 * covers: AWS::EC2::Subnet
 * covers: AWS::EC2::InternetGateway
 * covers: AWS::EC2::VPCGatewayAttachment
 * covers: AWS::EC2::RouteTable
 * covers: AWS::EC2::Route
 * covers: AWS::EC2::SubnetRouteTableAssociation
 * covers: AWS::EC2::SecurityGroup
 * covers: AWS::ElasticLoadBalancingV2::LoadBalancer
 * covers: AWS::ElasticLoadBalancingV2::Listener
 * covers: AWS::ElasticLoadBalancingV2::TargetGroup
 * covers: AWS::ElasticLoadBalancingV2::ListenerRule
 * covers: AWS::ECS::Cluster
 * covers: AWS::ECS::TaskDefinition
 * covers: AWS::ECS::Service
 * covers: AWS::IAM::Role
 * covers: AWS::Logs::LogGroup
 */
export class LocalStartAlbFromStateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ALB requires >= 2 subnets across >= 2 AZs by AWS rules. No NAT
    // (public-only) keeps deploy time + cost bounded.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      ],
    });

    const logGroup = new logs.LogGroup(this, 'TaskLogGroup', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      retention: logs.RetentionDays.ONE_DAY,
    });

    const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc,
      allowAllOutbound: true,
      description: 'Allows :80 inbound to the ALB.',
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP from anywhere');

    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
      loadBalancerName: 'cdkd-local-alb-from-state',
    });

    const webTg = new elbv2.ApplicationTargetGroup(this, 'WebTargetGroup', {
      vpc,
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      targetGroupName: 'cdkd-local-alb-web-tg',
      healthCheck: { path: '/' },
    });
    const ordersTg = new elbv2.ApplicationTargetGroup(this, 'OrdersTargetGroup', {
      vpc,
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      targetGroupName: 'cdkd-local-alb-orders-tg',
      healthCheck: { path: '/orders/' },
    });

    const listener = alb.addListener('Listener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.forward([webTg]),
    });

    new elbv2.ApplicationListenerRule(this, 'OrdersRule', {
      listener,
      priority: 1,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/orders/*'])],
      action: elbv2.ListenerAction.forward([ordersTg]),
    });

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName: 'cdkd-local-alb-from-state',
    });

    const executionRole = new iam.Role(this, 'TaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    const webTaskDef = new ecs.FargateTaskDefinition(this, 'WebTaskDef', {
      family: 'cdkd-local-alb-web',
      cpu: 256,
      memoryLimitMiB: 512,
      executionRole,
    });
    const ordersTaskDef = new ecs.FargateTaskDefinition(this, 'OrdersTaskDef', {
      family: 'cdkd-local-alb-orders',
      cpu: 256,
      memoryLimitMiB: 512,
      executionRole,
    });

    // Each container's `ALB_DNS_NAME` env var carries the
    // `Fn::GetAtt(Alb, DNSName)` intrinsic verbatim into the
    // synthesized template (CDK token → Fn::GetAtt on synth). When
    // `cdkd local start-alb --from-state` boots these locally, the
    // engine's state-source dispatcher must substitute the resolved
    // DNS name (read from cdkd's S3 state for this stack) into the
    // env var before the container starts — verify.sh greps the
    // emitted HTML body for that resolved string to prove the
    // substitution reached the container.
    webTaskDef.addContainer('web', {
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/busybox:1.36'),
      essential: true,
      entryPoint: ['/bin/sh', '-c'],
      command: [
        'mkdir -p /tmp/www && ' +
          'printf "service=web alb=%s\\n" "${ALB_DNS_NAME}" > /tmp/www/index.html && ' +
          'busybox httpd -f -p 80 -h /tmp/www',
      ],
      environment: { ALB_DNS_NAME: alb.loadBalancerDnsName },
      portMappings: [{ containerPort: 80, name: 'http' }],
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'web' }),
    });
    ordersTaskDef.addContainer('orders', {
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/busybox:1.36'),
      essential: true,
      entryPoint: ['/bin/sh', '-c'],
      command: [
        'mkdir -p /tmp/www/orders && ' +
          'printf "service=orders alb=%s\\n" "${ALB_DNS_NAME}" > /tmp/www/orders/index.html && ' +
          'busybox httpd -f -p 80 -h /tmp/www',
      ],
      environment: { ALB_DNS_NAME: alb.loadBalancerDnsName },
      portMappings: [{ containerPort: 80, name: 'http' }],
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'orders' }),
    });

    const serviceSg = new ec2.SecurityGroup(this, 'ServiceSg', {
      vpc,
      allowAllOutbound: true,
      description: 'Allows ALB SG inbound on container port.',
    });
    serviceSg.addIngressRule(albSg, ec2.Port.tcp(80), 'ALB to container port 80');

    const webService = new ecs.FargateService(this, 'WebService', {
      cluster,
      taskDefinition: webTaskDef,
      desiredCount: 0,
      serviceName: 'cdkd-local-alb-web-svc',
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [serviceSg],
    });
    const ordersService = new ecs.FargateService(this, 'OrdersService', {
      cluster,
      taskDefinition: ordersTaskDef,
      desiredCount: 0,
      serviceName: 'cdkd-local-alb-orders-svc',
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [serviceSg],
    });

    webService.attachToApplicationTargetGroup(webTg);
    ordersService.attachToApplicationTargetGroup(ordersTg);

    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: alb.loadBalancerDnsName,
      description: 'Deployed ALB DNS name (substituted into the ALB_DNS_NAME env var).',
    });
    new cdk.CfnOutput(this, 'WebServiceName', {
      value: webService.serviceName,
      description: 'Deployed Web ECS Service name.',
    });
    new cdk.CfnOutput(this, 'OrdersServiceName', {
      value: ordersService.serviceName,
      description: 'Deployed Orders ECS Service name.',
    });
  }
}
