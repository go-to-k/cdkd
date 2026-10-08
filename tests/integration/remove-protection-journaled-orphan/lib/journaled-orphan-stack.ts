import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

/**
 * The network the journaled load balancer sits in, in its OWN stack: while the
 * orphan stands it holds ENIs in these subnets and this security group, so a
 * destroy of a stack that also owned them would retry their deletes until the
 * orphan went. `verify.sh` reads the outputs from state and hands them to
 * {@link JournaledOrphanStack} as `ORPHAN_SUBNETS` / `ORPHAN_SECURITY_GROUP`.
 *
 * covers: AWS::EC2::VPC
 * covers: AWS::EC2::Subnet
 * covers: AWS::EC2::SecurityGroup
 */
export class JournaledOrphanNetStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.CfnVPC(this, 'Vpc', { cidrBlock: '10.46.0.0/16' });
    const subnetA = new ec2.CfnSubnet(this, 'SubnetA', {
      vpcId: vpc.ref,
      cidrBlock: '10.46.0.0/24',
      availabilityZone: cdk.Fn.select(0, cdk.Fn.getAzs()),
    });
    const subnetB = new ec2.CfnSubnet(this, 'SubnetB', {
      vpcId: vpc.ref,
      cidrBlock: '10.46.1.0/24',
      availabilityZone: cdk.Fn.select(1, cdk.Fn.getAzs()),
    });
    const sg = new ec2.CfnSecurityGroup(this, 'Sg', {
      groupDescription: 'cdkd 4678 journaled orphan load balancer',
      vpcId: vpc.ref,
    });

    new cdk.CfnOutput(this, 'SubnetAId', { value: subnetA.ref });
    new cdk.CfnOutput(this, 'SubnetBId', { value: subnetB.ref });
    new cdk.CfnOutput(this, 'SgId', { value: sg.attrGroupId });
  }
}

/**
 * go-to-k/cdkd#4678: a deletion-protected load balancer that only the rollback
 * journal records, which `cdkd destroy --remove-protection` must clear.
 *
 * With `ORPHAN_SUBNETS` set, `OrphanLb`'s CREATE fails AFTER AWS made it and
 * its cleanup cannot delete it: `deletion_protection.enabled` is applied
 * first, then the malformed enforce flag fails `SetSecurityGroups`, and the
 * cleanup's `DeleteLoadBalancer` is refused by that protection. The create
 * journals the ARN as a proven orphan (`physicalIdRecoveredFromError`).
 * `Anchor` is created BEFORE it, so the `--no-rollback` deploy leaves a state
 * record for the destroy to start from.
 *
 * With `COMPLETED_LB=1` as well, the stack instead holds `CompletedLb`, a
 * deletion-protected load balancer whose CREATE COMPLETES, and `FailLater`,
 * which waits on it and is refused by SSM (its value does not match its own
 * `AllowedPattern`). The `--no-rollback` deploy then leaves the load balancer
 * in state as a completed CREATE the rollback journal reverts, the case
 * `cdkd rollback --remove-protection` must delete.
 *
 * covers: AWS::ElasticLoadBalancingV2::LoadBalancer
 * covers: AWS::SSM::Parameter
 */
export class JournaledOrphanStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const anchor = new ssm.CfnParameter(this, 'Anchor', {
      type: 'String',
      value: 'cdkd-4678',
    });

    const subnets = (process.env.ORPHAN_SUBNETS ?? '').split(',').filter((s) => s !== '');
    if (subnets.length === 0) return;
    if (process.env.COMPLETED_LB === '1') {
      const completedLb = new elbv2.CfnLoadBalancer(this, 'CompletedLb', {
        name: 'cdkd-4678-completed',
        type: 'application',
        scheme: 'internal',
        subnets,
        securityGroups: [process.env.ORPHAN_SECURITY_GROUP ?? ''],
        loadBalancerAttributes: [{ key: 'deletion_protection.enabled', value: 'true' }],
      });
      completedLb.node.addDependency(anchor);
      const failLater = new ssm.CfnParameter(this, 'FailLater', {
        type: 'String',
        value: 'not-a-number',
        allowedPattern: '^[0-9]+$',
      });
      failLater.node.addDependency(completedLb);
      return;
    }
    const orphanLb = new elbv2.CfnLoadBalancer(this, 'OrphanLb', {
      name: 'cdkd-4678-orphan',
      type: 'application',
      scheme: 'internal',
      subnets,
      securityGroups: [process.env.ORPHAN_SECURITY_GROUP ?? ''],
      loadBalancerAttributes: [{ key: 'deletion_protection.enabled', value: 'true' }],
    });
    orphanLb.addPropertyOverride(
      'EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic',
      'cdkd-malformed'
    );
    orphanLb.node.addDependency(anchor);
  }
}

/**
 * The nested child of {@link JournaledOrphanNestedStack}. Always `ChildAnchor`;
 * with `NESTED_LB=1` (and `ORPHAN_SUBNETS`) also `NestedLb`, a
 * deletion-protected load balancer whose CREATE completes in the child.
 */
class ProtectedLbChild extends cdk.NestedStack {
  constructor(scope: Construct, id: string, props?: cdk.NestedStackProps) {
    super(scope, id, props);
    // Pin the row's logical id so the child state key is `<Parent>~Child`.
    (this.nestedStackResource as cdk.CfnResource).overrideLogicalId('Child');

    const anchor = new ssm.CfnParameter(this, 'ChildAnchor', {
      type: 'String',
      value: 'cdkd-4703',
    });
    const subnets = (process.env.ORPHAN_SUBNETS ?? '').split(',').filter((s) => s !== '');
    if (process.env.NESTED_LB !== '1' || subnets.length === 0) return;
    const nestedLb = new elbv2.CfnLoadBalancer(this, 'NestedLb', {
      name: 'cdkd-4703-nested',
      type: 'application',
      scheme: 'internal',
      subnets,
      securityGroups: [process.env.ORPHAN_SECURITY_GROUP ?? ''],
      loadBalancerAttributes: [{ key: 'deletion_protection.enabled', value: 'true' }],
    });
    nestedLb.node.addDependency(anchor);
  }
}

/**
 * go-to-k/cdkd#4703: a deletion-protected load balancer the failed deploy
 * created inside an EXISTING nested stack, which `cdkd rollback
 * --remove-protection` must delete when it reverts that child.
 *
 * Deployed first without `NESTED_LB`, so `Child` exists. With `NESTED_LB=1`
 * the child's update creates `NestedLb` and completes, then `FailLater`, which
 * waits on the `Child` row, is refused by SSM (its value does not match its
 * own `AllowedPattern`). The `--no-rollback` deploy leaves the parent's journal
 * holding the row's completed UPDATE and the child's journal holding
 * `NestedLb`'s completed CREATE, which the rollback reverts.
 *
 * covers: AWS::CloudFormation::Stack
 */
export class JournaledOrphanNestedStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const child = new ProtectedLbChild(this, 'Child');
    if (process.env.NESTED_LB !== '1') return;
    const failLater = new ssm.CfnParameter(this, 'FailLater', {
      type: 'String',
      value: 'not-a-number',
      allowedPattern: '^[0-9]+$',
    });
    failLater.node.addDependency(child.nestedStackResource!);
  }
}
