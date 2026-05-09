import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';

/**
 * VPC drift-revert E2E test stack.
 *
 * Companion to `tests/integration/drift-revert/` (which covers the
 * non-VPC types). Exercises providers that landed in this session's PR
 * series (#185-#200) for VPC-requiring resource types where update +
 * readCurrentState round-trips are now first-class:
 *
 *  - AWS::EFS::FileSystem with `ThroughputMode: 'elastic'`. inject-drift.ts
 *    flips it to `'bursting'` via `UpdateFileSystem`. Reverts via cdkd's
 *    `UpdateFileSystem` extension.
 *  - AWS::EFS::MountTarget with `SecurityGroups: [<sg1>]`.
 *    inject-drift.ts swaps to `[<sg2>]` via
 *    `ModifyMountTargetSecurityGroups`. Reverts via cdkd's
 *    `ModifyMountTargetSecurityGroups` extension.
 *  - AWS::ServiceDiscovery::PrivateDnsNamespace with a templated
 *    `Description` and `Properties.DnsProperties.SOA.TTL`.
 *    inject-drift.ts mutates both via `UpdatePrivateDnsNamespace`.
 *    Reverts via cdkd's `UpdatePrivateDnsNamespace` extension.
 *  - AWS::ElasticLoadBalancingV2::LoadBalancer (Application LB) with
 *    `SecurityGroups: [<sg1>]`. inject-drift.ts swaps to `[<sg2>]` via
 *    `SetSecurityGroups`. Reverts via cdkd's `SetSecurityGroups`
 *    extension.
 *
 *    Subnets / IpAddressType mutations are intentionally NOT exercised:
 *    SubnetMappings / IpAddressType=dualstack require additional infra
 *    (more AZs / IPv6 prerequisites) that bloat this integ stack and
 *    are not on the PR series under test.
 *
 * VPC layout: 2 AZs (ALB requires 2+ subnets in different AZs even for
 * a single-AZ test), public-only, no NAT (cuts cost and avoids the
 * Lambda hyperplane ENI cleanup that the no-VPC integ doesn't need).
 *
 * Every resource carries `removalPolicy: DESTROY` so a botched destroy
 * does not orphan VPC / ENIs / NAT — see `verify.sh`'s cleanup trap.
 */
export class DriftRevertVpcStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VPC: 2 AZs (ALB requirement), public-only, no NAT.
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

    // Two security groups: one for the templated initial value, one as
    // the "swap target" inject-drift.ts mutates to. Both are unused on
    // the AWS side — they only exist to give the drift mutations a
    // second valid SG ID to point at.
    const sg1 = new ec2.SecurityGroup(this, 'Sg1', {
      vpc,
      description: 'drift-revert-vpc primary SG (templated initial value)',
      allowAllOutbound: true,
    });

    const sg2 = new ec2.SecurityGroup(this, 'Sg2', {
      vpc,
      description: 'drift-revert-vpc secondary SG (swap target for inject-drift.ts)',
      allowAllOutbound: true,
    });

    // EFS FileSystem (L1 CfnFileSystem) — `ThroughputMode: elastic` is
    // the templated initial value; inject-drift.ts flips to 'bursting'.
    // Using L1 instead of L2 so we get exactly ONE MountTarget that we
    // can target unambiguously by physical id (the L2 auto-creates one
    // MT per AZ).
    const fileSystem = new efs.CfnFileSystem(this, 'DriftFileSystem', {
      throughputMode: 'elastic',
      encrypted: true,
    });
    fileSystem.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // Single CfnMountTarget so inject-drift.ts can target it
    // unambiguously by physical id. Attached to a known subnet/SG pair.
    const mountTarget = new efs.CfnMountTarget(this, 'DriftMountTarget', {
      fileSystemId: fileSystem.ref,
      subnetId: vpc.publicSubnets[0].subnetId,
      securityGroups: [sg1.securityGroupId],
    });
    mountTarget.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // ServiceDiscovery PrivateDnsNamespace — both Description and
    // SOA.TTL are templated; inject-drift.ts mutates both.
    const namespace = new servicediscovery.PrivateDnsNamespace(this, 'DriftNamespace', {
      vpc,
      name: 'cdkd-drift-revert-vpc.local',
      description: 'integ-original',
    });
    // CDK's L2 PrivateDnsNamespace doesn't surface the SOA.TTL prop;
    // reach down to the underlying CfnPrivateDnsNamespace.
    const cfnNamespace = namespace.node.defaultChild as servicediscovery.CfnPrivateDnsNamespace;
    cfnNamespace.addPropertyOverride('Properties.DnsProperties.SOA.TTL', 60);
    cfnNamespace.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // Application LoadBalancer — internet-facing, IPv4. Templated
    // SecurityGroups=[sg1.id]; inject-drift.ts swaps to [sg2.id].
    const lb = new elbv2.ApplicationLoadBalancer(this, 'DriftLoadBalancer', {
      vpc,
      internetFacing: true,
      ipAddressType: elbv2.IpAddressType.IPV4,
      securityGroup: sg1,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });
    lb.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // Outputs — inject-drift.ts and verify.sh read these via
    // `cdkd state show <stack> --json`.
    new cdk.CfnOutput(this, 'FileSystemId', {
      value: fileSystem.ref,
      description: 'EFS FileSystem ID targeted by inject-drift.ts',
    });

    new cdk.CfnOutput(this, 'MountTargetId', {
      value: mountTarget.ref,
      description: 'EFS MountTarget ID targeted by inject-drift.ts',
    });

    new cdk.CfnOutput(this, 'NamespaceId', {
      value: namespace.namespaceId,
      description: 'ServiceDiscovery PrivateDnsNamespace ID targeted by inject-drift.ts',
    });

    new cdk.CfnOutput(this, 'LoadBalancerArn', {
      value: lb.loadBalancerArn,
      description: 'ALB ARN targeted by inject-drift.ts',
    });

    new cdk.CfnOutput(this, 'Sg1Id', {
      value: sg1.securityGroupId,
      description: 'Primary SG ID (templated value)',
    });

    new cdk.CfnOutput(this, 'Sg2Id', {
      value: sg2.securityGroupId,
      description: 'Secondary SG ID (drift swap target)',
    });
  }
}
