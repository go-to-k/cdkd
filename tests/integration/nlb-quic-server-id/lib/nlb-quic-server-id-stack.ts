import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';

/**
 * covers: AWS::ElasticLoadBalancingV2::LoadBalancer, AWS::ElasticLoadBalancingV2::TargetGroup, AWS::ElasticLoadBalancingV2::Listener
 *
 * Issue #5394: `Targets[].QuicServerId` of a QUIC target group never reached
 * RegisterTargets / DeregisterTargets, and a change to it alone was never sent.
 *
 * Measured with a raw CloudFormation A/B (us-east-1): a QUIC target group
 * REQUIRES a QuicServerId on every target (a target without one is refused
 * with "QUIC server IDs must be specified for each target"), a server id
 * change on the same Id is accepted (the target ends up registered once, with
 * the new id), and `deregistration_delay.timeout_seconds` cannot be set on a
 * QUIC target group (so a removed target sits in `draining`, which verify.sh
 * filters out).
 *
 * Phases (the target is an `ip` target inside the VPC):
 *
 * - baseline: 10.0.0.10 with server id A.
 * - CDKD_TEST_UPDATE=true: the SAME target with server id B. cdkd must
 *   deregister A and then register B (AWS cannot modify a registered target's
 *   server id).
 * - CDKD_TEST_REMOVAL=true: a DIFFERENT target (10.0.0.11, server id A) replaces
 *   the old one, whose registration must go away (a server id cannot simply be
 *   dropped from a QUIC target).
 *
 * Names are fixed so verify.sh can sweep leftovers by name.
 */
export class CdkdNlbQuicServerIdStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const update = process.env.CDKD_TEST_UPDATE === 'true';
    const removal = process.env.CDKD_TEST_REMOVAL === 'true';

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ cidrMask: 24, name: 'Public', subnetType: ec2.SubnetType.PUBLIC }],
    });

    // verify.sh sweeps leftover VPCs by exactly this tag.
    cdk.Tags.of(vpc).add('cdkd-integ', '5394');

    const nlb = new elbv2.CfnLoadBalancer(this, 'Nlb', {
      name: 'cdkd-5394-quic-nlb',
      type: 'network',
      scheme: 'internal',
      subnets: vpc.publicSubnets.map((s) => s.subnetId),
    });

    const quicServerId = update ? '0xfedcba9876543210' : '0x0123456789abcdef';
    const tg = new elbv2.CfnTargetGroup(this, 'Tg', {
      name: 'cdkd-5394-quic-tg',
      protocol: 'QUIC',
      port: 443,
      targetType: 'ip',
      vpcId: vpc.vpcId,
      targets: [{ id: removal ? '10.0.0.11' : '10.0.0.10', quicServerId }],
    });

    new elbv2.CfnListener(this, 'Listener', {
      loadBalancerArn: nlb.ref,
      protocol: 'QUIC',
      port: 443,
      defaultActions: [{ type: 'forward', targetGroupArn: tg.ref }],
    });
  }
}
