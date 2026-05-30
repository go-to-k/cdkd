import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

/**
 * Pure-local fixture for `cdkd local start-alb`.
 *
 * One Application Load Balancer with one HTTP:80 Listener whose default
 * action forwards to one TargetGroup backed by one EC2-launchType ECS
 * Service. The service's TaskDefinition runs a busybox HTTP server on
 * container-port 80 that responds with a fixed banner so the verify.sh
 * can assert the local front-door routed correctly. `cdkd local start-alb`
 * never deploys these to AWS — it only reads the synthesized template +
 * boots the docker container locally + serves an HTTP front-door on the
 * host port (remapped via --lb-port 80=8080 to avoid the privileged-port
 * bind on macOS).
 *
 * Uses L1 `Cfn*` constructs throughout (no VPC L2) so the fixture stays
 * small. Dummy strings are passed where CFn requires resource references
 * (Subnets, VpcId) — they would fail a real deploy but are never reached
 * because the local emulator only reads the listener / TG / service-LB
 * binding shape, not the AWS networking plumbing.
 *
 * covers: AWS::ElasticLoadBalancingV2::LoadBalancer
 * covers: AWS::ElasticLoadBalancingV2::Listener
 * covers: AWS::ElasticLoadBalancingV2::TargetGroup
 * covers: AWS::ECS::Service
 * covers: AWS::ECS::TaskDefinition
 * covers: AWS::ECS::Cluster
 */
export class LocalStartAlbStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Dummy networking refs — never reach AWS because the fixture is
    // pure-local. Real deploys would resolve these via `ec2.Vpc`.
    const vpcId = 'vpc-cdkd-local-start-alb-fixture';
    const subnetIds = ['subnet-cdkd-local-fixture-a', 'subnet-cdkd-local-fixture-b'];

    const alb = new elbv2.CfnLoadBalancer(this, 'Alb', {
      name: 'cdkd-local-start-alb-fixture',
      type: 'application',
      scheme: 'internet-facing',
      subnets: subnetIds,
    });

    const targetGroup = new elbv2.CfnTargetGroup(this, 'TargetGroup', {
      name: 'cdkd-local-start-alb-tg',
      port: 80,
      protocol: 'HTTP',
      targetType: 'ip',
      vpcId,
      healthCheckPath: '/',
      healthCheckProtocol: 'HTTP',
    });

    new elbv2.CfnListener(this, 'Listener', {
      loadBalancerArn: alb.ref,
      port: 80,
      protocol: 'HTTP',
      defaultActions: [
        {
          type: 'forward',
          targetGroupArn: targetGroup.ref,
        },
      ],
    });

    const cluster = new ecs.CfnCluster(this, 'Cluster', {
      clusterName: 'cdkd-local-start-alb-fixture',
    });

    const taskDef = new ecs.CfnTaskDefinition(this, 'WebTask', {
      family: 'cdkd-local-start-alb-web',
      networkMode: 'bridge',
      containerDefinitions: [
        {
          name: 'web',
          image: 'public.ecr.aws/docker/library/busybox:1.36',
          essential: true,
          entryPoint: ['/bin/sh', '-c'],
          // Busybox httpd serves /tmp on container-port 80; the boot
          // line writes a fixed banner so the verify.sh can assert
          // the local front-door routed an inbound request to this
          // service's container (and not the wrong target / the 404
          // path).
          command: [
            'mkdir -p /tmp/www && ' +
              'echo "OK from cdkd-local-start-alb-fixture" > /tmp/www/index.html && ' +
              'busybox httpd -f -p 80 -h /tmp/www',
          ],
          portMappings: [{ containerPort: 80, hostPort: 0, protocol: 'tcp' }],
          memoryReservation: 16,
        },
      ],
    });

    new ecs.CfnService(this, 'WebService', {
      serviceName: 'cdkd-local-start-alb-fixture-web',
      cluster: cluster.ref,
      taskDefinition: taskDef.ref,
      desiredCount: 1,
      launchType: 'EC2',
      loadBalancers: [
        {
          containerName: 'web',
          containerPort: 80,
          targetGroupArn: targetGroup.ref,
        },
      ],
    });
  }
}
