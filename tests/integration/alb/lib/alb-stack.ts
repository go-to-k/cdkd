import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';

/**
 * covers: AWS::ElasticLoadBalancingV2::LoadBalancer
 * covers: AWS::ElasticLoadBalancingV2::Listener
 * covers: AWS::ElasticLoadBalancingV2::ListenerRule
 * covers: AWS::ElasticLoadBalancingV2::TargetGroup
 * covers: AWS::EC2::SecurityGroupIngress
 */
export class AlbStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Two AZs, public subnets only. Dual-stack so the ALB can hold
    // `IpAddressType: dualstack` until the removal phase drops it (issue #1160).
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      ipProtocol: ec2.IpProtocol.DUAL_STACK,
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

    // Phase selectors. Declared before the ALB because the #1609 item 1
    // LoadBalancerAttributes coverage below is phase-gated too.
    const removal = process.env.CDKD_TEST_REMOVAL === 'true';
    const update = process.env.CDKD_TEST_UPDATE === 'true';

    // Application Load Balancer
    //
    // CDKD_TEST_REMOVAL (issue #1160): the removal phase drops `dualstack`.
    // SetIpAddressType is never called for an absent value, so the provider
    // resets it to `ipv4`, which is what a CloudFormation update does (CFn
    // A/B us-east-1 2026-10-17).
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
      securityGroup: sg,
      ...(removal ? {} : { ipAddressType: elbv2.IpAddressType.DUAL_STACK }),
    });

    // LoadBalancerAttributes (issue #1609 item 1, #1160). The removal phase
    // drops idle_timeout, and the provider leaves it at its live value (180),
    // as a CloudFormation update leaves a removed attribute key (CFn A/B
    // us-east-1 2026-10-17).
    //
    // The two keys restated in EVERY phase each do a different job:
    //
    // - `routing.http2.enabled: 'false'` is the ASSERTABLE retained sibling.
    //   AWS defaults it to 'true', so asserting it is still 'false' after the
    //   removal deploy shows the update did not reset the whole list. A
    //   sibling whose templated value EQUALS its default cannot do that —
    //   the readback is identical either way.
    // - `deletion_protection.enabled: 'false'` pins the CDK-L2 trap this
    //   fixture hit on its first run. The L2 ApplicationLoadBalancer emits
    //   its own entry for this key and a property override replaces the whole
    //   array, so a removal phase that merely DROPPED the override let the L2
    //   default reappear — a value CHANGE plus an unintended re-add, not the
    //   clean single-key removal it read as. Restating it keeps idle_timeout
    //   the ONLY key the removal phase drops.
    //   (It is deliberately 'false': 'true' would block the destroy phase.)
    const cfnAlb = alb.node.defaultChild as elbv2.CfnLoadBalancer;
    cfnAlb.addPropertyOverride('LoadBalancerAttributes', [
      { Key: 'deletion_protection.enabled', Value: 'false' },
      { Key: 'routing.http2.enabled', Value: 'false' },
      ...(removal ? [] : [{ Key: 'idle_timeout.timeout_seconds', Value: update ? '180' : '120' }]),
    ]);

    // Target Group (IP target for simplicity - no instances needed)
    //
    // CDKD_TEST_REMOVAL (issue #1160, elbv2 batch): the baseline template
    // sets a custom health-check port; the removal phase drops it.
    // ModifyTargetGroup merges (absent = "no change"), so pre-fix the live
    // TG silently kept port 8080; the provider must reset it to the
    // CFn-parity default `traffic-port` (live CFn A/B 2026-08-10 — the ONE
    // health-check field CloudFormation resets on removal; the others are
    // retained by CFn itself and stay pass-through).
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      vpc,
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/',
        interval: cdk.Duration.seconds(30),
        ...(removal ? {} : { port: '8080' }),
      },
    });

    // #609 LoadBalancer + TargetGroup silent-drop batch coverage. Raw
    // property overrides (not L2 props) so the fixture does not depend on the
    // pinned aws-cdk-lib having codegen'd the newest CFn properties.
    const cfnTargetGroup = targetGroup.node.defaultChild as elbv2.CfnTargetGroup;
    // IpAddressType is createOnly — exercises the CreateTargetGroup wiring.
    cfnTargetGroup.addPropertyOverride('IpAddressType', 'ipv4');
    // TargetGroupAttributes: baseline 45s -> update 60s (ModifyTargetGroupAttributes
    // diff); the removal phase drops the whole list, which leaves the
    // attribute at 60, as a CloudFormation update does (issue #1160).
    if (!removal) {
      cfnTargetGroup.addPropertyOverride('TargetGroupAttributes', [
        { Key: 'deregistration_delay.timeout_seconds', Value: update ? '60' : '45' },
      ]);
    }
    // Targets (IP targets inside the VPC CIDR; nothing listens on them —
    // registration is what is under test, not health). The update phase swaps
    // the IP, exercising RegisterTargets + DeregisterTargets on update.
    //
    // NOTE the REMOVAL phase does not set CDKD_TEST_UPDATE, so `update` is
    // false there and the registered target flips BACK to 10.0.0.100 — a
    // second, deliberate Register+Deregister round, not a leftover from the
    // update phase. That churn is incidental to what the removal phase is
    // testing (removal semantics); it is called out because the reverse swap
    // otherwise reads as an accident worth chasing (issue #1609 item 5).
    cfnTargetGroup.addPropertyOverride('Targets', [
      { Id: update ? '10.0.0.101' : '10.0.0.100', Port: 80 },
    ]);
    // An IP target must sit inside a SUBNET, not just the VPC, when it is
    // registered, but the group only references the VPC. With the dual-stack
    // VPC the subnets also wait on the IPv6 CIDR block, so without this edge
    // the group can be created first, in CloudFormation as in cdkd ("is within
    // the VPC, but is not within a VPC subnet"). 10.0.0.100 / .101 are in the
    // first public subnet (10.0.0.0/24).
    targetGroup.node.addDependency(vpc.publicSubnets[0]!);

    // GENEVE target group (issue #1160): CloudFormation resets a removed
    // HealthCheckPort to `traffic-port` on a GENEVE group too, although that
    // protocol's create default is port 80 (CFn A/B us-east-1 2026-10-17).
    // No Gateway Load Balancer is needed for the group to exist.
    new elbv2.CfnTargetGroup(this, 'GeneveTargetGroup', {
      protocol: 'GENEVE',
      port: 6081,
      vpcId: vpc.vpcId,
      targetType: 'ip',
      healthCheckProtocol: 'HTTP',
      healthCheckPath: '/',
      ...(removal ? {} : { healthCheckPort: '8080' }),
    });

    // MinimumLoadBalancerCapacity is deliberately NOT exercised here: the
    // integ account lacks the LCU capacity-reservation entitlement —
    // ModifyCapacityReservation is rejected with "This AWS account does not
    // support configuring minimum load balancer capacity reservation"
    // (live-verified 2026-08-11; the request shape reached the API and was
    // refused on the account, not the payload). The capacity /
    // stabilize-wait paths are covered by unit tests
    // (tests/unit/provisioning/elbv2-lb-targetgroup-props.test.ts).

    // Listener
    const listener = alb.addListener('Listener', {
      port: 80,
      defaultTargetGroups: [targetGroup],
    });

    // ListenerAttributes (#609 backfill coverage). The L2 ApplicationListener
    // does not surface listener attributes, so set them via the L1 escape
    // hatch on the underlying CfnListener. `routing.http.response.server.enabled`
    // is a valid attribute key for an HTTP/HTTPS ApplicationLoadBalancer
    // listener (NLB-only keys like `tcp.idle_timeout.seconds` would be rejected
    // on an Application listener). cdkd applies it via a post-create
    // ModifyListenerAttributes call.
    //
    // The REMOVAL phase drops the list entirely. The provider leaves the key
    // at its live `false`, as a CloudFormation update does (issue #1160, CFn
    // A/B us-east-1 2026-10-17).
    const cfnListener = listener.node.defaultChild as elbv2.CfnListener;
    if (!removal) {
      cfnListener.listenerAttributes = [
        { key: 'routing.http.response.server.enabled', value: 'false' },
      ];
    }
    // CDKD_TEST_LISTENER_REMOVAL (issue #1160, verify.sh Phase 3.5): drop the
    // listener's Port and Protocol. A CloudFormation update keeps both live
    // values (CFn A/B us-east-1 2026-10-20), and cdkd does too, warning that
    // it matches CloudFormation. Its own variable, not CDKD_TEST_REMOVAL:
    // Phase 5 recreates the listener, and an ALB listener cannot be created
    // without them.
    if (process.env.CDKD_TEST_LISTENER_REMOVAL === 'true') {
      cfnListener.addPropertyDeletionOverride('Port');
      cfnListener.addPropertyDeletionOverride('Protocol');
    }

    // ListenerRule (path-based routing)
    // go-to-k/cdkd#4690 (Phase 6 of `verify.sh`): `ALB_RULE_BAD_PRIORITY`
    // puts the rule out of ELBv2's 1-50000 range, so its replacement onto a
    // recreated listener fails AFTER the listener recreate completed, and the
    // automatic rollback must reverse that delete-first recreate.
    new elbv2.CfnListenerRule(this, 'HealthRule', {
      listenerArn: listener.listenerArn,
      priority: process.env.ALB_RULE_BAD_PRIORITY === 'true' ? 50001 : 1,
      conditions: [{ field: 'path-pattern', values: ['/health'] }],
      actions: [{ type: 'fixed-response', fixedResponseConfig: { statusCode: '200', contentType: 'text/plain', messageBody: 'OK' } }],
    });

    // go-to-k/cdkd#4606: the fix-forward arm (Phase 4 of `verify.sh`). The
    // first deploy's CREATE fails AFTER AWS made the load balancer and its
    // wiring-failure cleanup cannot delete it, so the journal holds it as a
    // proven orphan: `deletion_protection.enabled` is applied first, then the
    // malformed enforce flag fails `SetSecurityGroups`, and the cleanup's
    // DeleteLoadBalancer is refused by that protection. The `LB_FIX_FORWARD`
    // redeploy keeps the logical id with a valid shape under ANOTHER name (the
    // same name and settings would hand back the earlier load balancer), the
    // CREATE succeeds, and that successful deploy must delete the earlier one.
    if (process.env.INJECT_LB_ORPHAN === 'true') {
      const fixForward = process.env.LB_FIX_FORWARD === 'true';
      const orphanLb = new elbv2.CfnLoadBalancer(this, 'OrphanLb', {
        name: fixForward ? 'cdkd-alb-orphan-ff' : 'cdkd-alb-orphan',
        type: 'application',
        scheme: 'internal',
        subnets: vpc.publicSubnets.map((subnet) => subnet.subnetId),
        securityGroups: [sg.securityGroupId],
      });
      if (!fixForward) {
        orphanLb.loadBalancerAttributes = [{ key: 'deletion_protection.enabled', value: 'true' }];
        orphanLb.addPropertyOverride(
          'EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic',
          'cdkd-malformed'
        );
      }
    }

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
