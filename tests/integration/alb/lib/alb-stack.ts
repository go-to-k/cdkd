import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';

/**
 * covers: AWS::ElasticLoadBalancingV2::LoadBalancer
 * covers: AWS::ElasticLoadBalancingV2::Listener
 * covers: AWS::ElasticLoadBalancingV2::TargetGroup
 * covers: AWS::EC2::SecurityGroupIngress
 */
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

    // Phase selectors. Declared before the ALB because the #1609 item 1
    // LoadBalancerAttributes coverage below is phase-gated too.
    const removal = process.env.CDKD_TEST_REMOVAL === 'true';
    const update = process.env.CDKD_TEST_UPDATE === 'true';

    // Application Load Balancer
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
      securityGroup: sg,
    });

    // LoadBalancerAttributes (issue #1609 item 1). The LB and Listener
    // attribute diff arms have pushed a removed key back as `Value: ''`
    // since they were written, and NO integ had ever exercised either
    // removal — while the sibling ModifyTargetGroupAttributes arm was
    // live-proven (2026-08-11) to REJECT the empty string outright.
    // Live A/B 2026-08-11 settled it per VALUE KIND: the empty string is
    // accepted for the NUMERIC idle_timeout but REJECTED for the BOOLEAN
    // deletion_protection.enabled ("must be 'true' or 'false', but was ''"),
    // on this API and on ModifyListenerAttributes alike.
    //
    // `deletion_protection.enabled` is listed in EVERY phase on purpose, and
    // it is doing two jobs. It is the RETAINED SIBLING the removal-testing
    // convention wants for a collection-valued property (without one, a reset
    // that wiped the whole list would also pass). And it pins the CDK-L2
    // trap this fixture hit on its first run: the L2 ApplicationLoadBalancer
    // emits its own `deletion_protection.enabled` entry, so a removal phase
    // that merely DROPPED the override let the L2 default reappear — making
    // the phase a value CHANGE plus an unintended removal of that key, not
    // the clean single-key removal it reads as. Restating it keeps
    // idle_timeout the ONLY key the removal phase drops.
    // `routing.http2.enabled: 'false'` is the ASSERTABLE retained sibling.
    // deletion_protection.enabled alone could not do that job: it is templated
    // to 'false', which IS AWS's default, so a bug that reset EVERY attribute
    // would produce a byte-identical readback and the removal phase could not
    // tell an over-broad reset from a correct one — which is the whole point
    // of keeping a sibling. HTTP/2 defaults to 'true', so templating 'false'
    // and asserting it survives the removal deploy detects that class. (It is
    // also safe to leave off: unlike deletion protection, it cannot block the
    // destroy phase.)
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
    // diff); the removal phase drops the whole list, which must reset the
    // attribute to AWS's default 300 via the Value:'' push-back.
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
    // testing (attribute reset); it is called out because the reverse swap
    // otherwise reads as an accident worth chasing (issue #1609 item 5).
    cfnTargetGroup.addPropertyOverride('Targets', [
      { Id: update ? '10.0.0.101' : '10.0.0.100', Port: 80 },
    ]);

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
    // The REMOVAL phase drops the list entirely (issue #1609 item 1): the
    // ModifyListenerAttributes removal arm pushes the dropped key back as
    // `Value: ''` and had never been exercised against real AWS, so this is
    // the A/B that proves the API accepts it. AWS's documented default for
    // this key is `true`, so the post-removal readback must flip back.
    const cfnListener = listener.node.defaultChild as elbv2.CfnListener;
    if (!removal) {
      cfnListener.listenerAttributes = [
        { key: 'routing.http.response.server.enabled', value: 'false' },
      ];
    }

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
