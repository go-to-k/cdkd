import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

/**
 * The `MaxDrainDurationSeconds` value under test. Exported so `verify.sh` and
 * this stack cannot drift: the fixture greps this literal rather than
 * re-typing it.
 *
 * NOTE for anyone extending the assertion: the value is NOT readable back from
 * AWS. The CloudFormation registry schema lists
 * `/properties/MaxDrainDurationSeconds` under `writeOnlyProperties`, and no EC2
 * API (`DescribeNatGateways` included) returns it — so `verify.sh` asserts the
 * ROUTING consequence (`provisionedBy == 'cc-api'`) plus a live, available NAT
 * gateway, which is the strongest observable evidence that the value reached
 * AWS's own resource handler instead of being dropped.
 */
export const DRAIN_DURATION_SECONDS = 120;

/**
 * Integration test for the `AWS::EC2::NatGateway` SDK provider.
 *
 * The stack is the smallest shape that exercises every code path in
 * the new provider:
 *   - `CreateNatGateway` (via the public-subnet NAT) + `applyTags`
 *   - `waitUntilNatGatewayAvailable` (default behavior, skipped under
 *     `--no-wait`)
 *   - Routes referencing the NAT (default route from the private
 *     subnet, automatically added by the L2 VPC construct)
 *   - `DeleteNatGateway` + `waitUntilNatGatewayDeleted` on destroy
 *
 * Why two AZs but `natGateways: 1`: forces the second AZ's PrivateEgress
 * subnet to share the single NAT, which exercises the multi-route /
 * shared-NAT path that real-world stacks usually take. Two AZs do not
 * meaningfully add to deploy time (NAT itself is the dominant cost).
 *
 * Why no Lambda / EC2 instance: keeps the test focused on the NAT
 * provider and avoids the ENI-attach / IAM-propagation overhead that
 * `vpc-lambda-cr-race` already covers. A misbehaving NAT delete
 * (DependencyViolation) still surfaces here because the VPC and
 * Subnets that depend on it have to come down too.
 *
 * A SECOND, L1-only NAT gateway (`DrainNatGateway`) covers issue #1411:
 * `MaxDrainDurationSeconds` is declared `unhandledByDesign`, so a NAT
 * gateway whose template sets it must auto-route via Cloud Control API
 * (#614) instead of being silently dropped by the SDK provider. It is a
 * separate resource on purpose — the L2 gateway above must stay on the
 * SDK path so this fixture keeps covering `CreateNatGateway` /
 * `waitUntilNatGatewayAvailable` / `DeleteNatGateway`, and the two
 * together assert heterogeneous routing inside one stack.
 */
export class VpcNatGatewayStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.50.0.0/16'),
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'PrivateEgress',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    // Issue #1411 coverage. `MaxDrainDurationSeconds` is not exposed by any
    // CDK L2 (`ec2.Vpc` / `NatProvider.gateway()` have no such prop), so this
    // is an L1 `CfnNatGateway` rather than an L2 escape hatch — per the repo's
    // "L1 over L2 override for a backfill fixture" convention, the L1 shows the
    // exact CFn shape under test with nothing synthesized around it.
    //
    // `connectivityType: 'private'` keeps it EIP-free (a public NAT would need
    // a second Elastic IP allocation for no added coverage). It is deliberately
    // NOT wired into any route table: the assertion is about ROUTING OF THE
    // PROVISIONING CALL (SDK vs Cloud Control), not about NAT data-plane
    // behavior, and an unused private NAT still exercises the full CC
    // create/delete round trip.
    const drainNat = new ec2.CfnNatGateway(this, 'DrainNatGateway', {
      subnetId: vpc.privateSubnets[0]!.subnetId,
      connectivityType: 'private',
      maxDrainDurationSeconds: DRAIN_DURATION_SECONDS,
      tags: [{ key: 'Name', value: 'cdkd-vpc-nat-gateway-drain' }],
    });

    new cdk.CfnOutput(this, 'VpcId', {
      value: vpc.vpcId,
      description: 'VPC ID (NAT Gateway lives in the public subnet of this VPC)',
    });

    new cdk.CfnOutput(this, 'DrainNatGatewayId', {
      value: drainNat.ref,
      description:
        'NAT Gateway ID of the MaxDrainDurationSeconds gateway (issue #1411 — must be provisioned via Cloud Control API)',
    });
  }
}

