import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';

/**
 * covers: AWS::ElasticLoadBalancingV2::LoadBalancer
 *
 * Issue #1619: A/B the OMISSION semantics of the two NLB-only flags that have
 * no API of their own and ride on `SetSubnets` / `SetSecurityGroups`:
 *
 * - `EnablePrefixForIpv6SourceNat` rides on SetSubnets
 * - `EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic` rides on
 *   SetSecurityGroups
 *
 * When ONLY the flag is removed, cdkd issues no call at all and the live value
 * is retained — that arm was already settled. The case this fixture pins is the
 * COMBINED one: the flag is removed in the SAME deploy that changes
 * `Subnets` / `SecurityGroups`, so the Set* call IS issued and is issued
 * WITHOUT the flag member. AWS RETAINS the live value there (measured
 * us-east-1 2026-08-12; see the provider comments), so cdkd omitting the
 * member is correct — but "AWS retains on omission" is a SERVICE behavior, not
 * a cdkd one, so it needs a live fixture to stay honest.
 *
 * Both flags are NLB-only, which is why the `alb` fixture cannot cover them:
 * `EnablePrefixForIpv6SourceNat` needs a dualstack NLB with IPv6 subnets, and
 * the enforce flag needs an NLB carrying security groups.
 *
 * Each flag gets its OWN load balancer. They ride on different API calls, so
 * one LB would arguably still attribute — but two rules out any cross-talk
 * between the calls, which is exactly what an A/B is for (the issue calls this
 * out explicitly: a combined probe cannot attribute the result).
 *
 * NOT needed, contrary to the issue's initial scoping: a PrivateLink endpoint
 * service. The enforce flag is settable and readable on ANY SG-bearing NLB
 * (measured alongside the A/B), so the fixture skips that whole apparatus.
 *
 * Phases:
 *
 * - baseline: NlbSourceNat holds the non-default `on`; NlbEnforce holds the
 *   non-default `off`. Both non-default ON PURPOSE — a flag whose templated
 *   value equals its AWS default cannot distinguish "retained" from "reset",
 *   because the readback is identical either way.
 * - CDKD_TEST_REMOVAL=true: each flag is DROPPED while its companion property
 *   changes (a third subnet is added / a second security group is added), so
 *   the Set* call fires with the member omitted. verify.sh then asserts each
 *   flag still holds its non-default value.
 */
export class NlbSourceNatStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // The combined removal-plus-change phase. Declared first because both
    // load balancers below are phase-gated on it.
    const removal = process.env.CDKD_TEST_REMOVAL === 'true';

    // Dual-stack VPC. `EnablePrefixForIpv6SourceNat` requires a dualstack NLB
    // whose subnets carry IPv6 CIDRs, so IPv4-only will not do. Three AZs
    // because the removal phase ADDS a subnet: an NLB cannot have a subnet
    // REMOVED, so "changing Subnets" for an NLB means growing the set.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 3,
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

    const subnetIds = vpc.publicSubnets.map((s) => s.subnetId);
    // Baseline attaches two subnets; the removal phase adds the third.
    const attachedSubnetIds = removal ? subnetIds.slice(0, 3) : subnetIds.slice(0, 2);

    // ── Flag 1: EnablePrefixForIpv6SourceNat (rides on SetSubnets) ─────────
    //
    // L1 throughout: the NetworkLoadBalancer L2 exposes neither
    // SubnetMappings' SourceNatIpv6Prefix nor the flag itself, and the raw
    // property IS what this fixture is A/B-ing.
    //
    // `SourceNatIpv6Prefix: auto_assigned` per mapping is required while the
    // flag is on. On the removal deploy the mappings are re-sent WITHOUT the
    // prefixes (cdkd forwards whatever the template declares) and AWS keeps
    // both the flag and the per-subnet prefixes — including auto-assigning one
    // to the newly added subnet.
    new elbv2.CfnLoadBalancer(this, 'NlbSourceNat', {
      type: 'network',
      scheme: 'internal',
      ipAddressType: 'dualstack',
      subnetMappings: attachedSubnetIds.map((subnetId) =>
        removal ? { subnetId } : { subnetId, sourceNatIpv6Prefix: 'auto_assigned' }
      ),
      // DROPPED in the removal phase, alongside the subnet-set change above.
      ...(removal ? {} : { enablePrefixForIpv6SourceNat: 'on' }),
    });

    // ── Flag 2: EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic ───────
    //                                        (rides on SetSecurityGroups)
    const sg1 = new ec2.SecurityGroup(this, 'NlbSg1', {
      vpc,
      description: 'NLB SG 1 (baseline)',
      allowAllOutbound: true,
    });
    const sg2 = new ec2.SecurityGroup(this, 'NlbSg2', {
      vpc,
      description: 'NLB SG 2 (added by the removal phase)',
      allowAllOutbound: true,
    });

    // The removal phase adds the second SG so SetSecurityGroups actually
    // fires; without a companion change cdkd would issue no call at all and
    // the omission arm would never be exercised.
    const attachedSgs = removal
      ? [sg1.securityGroupId, sg2.securityGroupId]
      : [sg1.securityGroupId];

    new elbv2.CfnLoadBalancer(this, 'NlbEnforce', {
      type: 'network',
      scheme: 'internal',
      subnets: subnetIds.slice(0, 2),
      securityGroups: attachedSgs,
      // `off` is the NON-default (AWS defaults this to `on`), which is what
      // makes the retained-vs-reset readback decisive. DROPPED in the removal
      // phase, alongside the security-group set change above.
      ...(removal ? {} : { enforceSecurityGroupInboundRulesOnPrivateLinkTraffic: 'off' }),
    });
  }
}
