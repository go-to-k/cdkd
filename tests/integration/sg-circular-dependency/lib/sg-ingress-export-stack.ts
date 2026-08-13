import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

/**
 * Export-arm companion stack for issue #1761.
 *
 * `cdkd export` builds a CloudFormation IMPORT changeset, and CFn identifies an
 * `AWS::EC2::SecurityGroupIngress` by the `sgr-...` rule id AWS mints
 * (`primaryIdentifier` is exactly `["/properties/Id"]`, live `describe-type`
 * us-east-1 2026-08-13). cdkd's physical id for the type is the composite
 * `<groupId>|<ipProtocol>|<fromPort>|<toPort>` its own revoke call needs, so the
 * identifier can only come from a RECORDED attribute — which is what #1761 adds.
 *
 * ## Why this is a SECOND stack rather than an arm of the circular-ref stack
 *
 * `cdkd export` is all-or-nothing: `buildImportPlan` collects every resource it
 * cannot resolve into `blocked` and aborts the whole run before it prints the
 * plan — under `--dry-run` too. So ONE unrelated unresolvable type anywhere in
 * the stack hides this assertion.
 *
 * That was originally a hard blocker: the circular-ref stack's `ec2.Vpc` emits
 * an `AWS::EC2::Route`, which had no composite-id splitter. Issue #1771 has
 * since registered one, so the circular-ref stack probably exports cleanly
 * today — but "probably" is the point. Its `ec2.Vpc` will keep acquiring types
 * as CDK evolves (an IPv6 CIDR would pull in `AWS::EC2::VPCCidrBlock`, still
 * unregistered — issue #1788), and each one can abort this assertion for
 * reasons that have nothing to do with the rule id. Narrowing that fixture's
 * VPC instead would quietly drop the IGW / route destroy ordering it already
 * covers.
 *
 * So this stack stays deliberately the SMALLEST shape that reaches the ingress
 * rows: an L1 VPC with no subnets, no internet gateway and no route table
 * entries, plus the same SG-to-SG circular pair. Every type in it resolves to a
 * single-field CFn identifier that cdkd's physical id already IS
 * (`AWS::EC2::VPC` -> `VpcId`, `AWS::EC2::SecurityGroup` -> `Id`), leaving
 * `AWS::EC2::SecurityGroupIngress` as the only row whose identifier has to come
 * from the recorded attribute.
 *
 * ## What this does NOT prove
 *
 * `--dry-run` prints the plan and stops, so this arm proves cdkd RESOLVES the
 * identifier — not that CloudFormation ACCEPTS it. That second half is covered
 * by `tests/integration/export`, whose fixture gained a standalone ingress rule
 * and executes a real IMPORT changeset, then asserts CFn's own
 * `PhysicalResourceId` for it (`^sgr-[0-9a-f]+$`).
 */
export class SgIngressExportStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add('cdkd:integ-fixture', 'sg-circular-dependency');

    // L1 on purpose: `ec2.Vpc` (the L2) always synthesizes at least one subnet
    // with a route table and a route, which is exactly what this stack exists
    // to avoid. A bare VPC needs no subnets to host a security group.
    const vpc = new ec2.CfnVPC(this, 'ExportVpc', {
      cidrBlock: '10.61.0.0/16',
    });

    const sgA = new ec2.CfnSecurityGroup(this, 'ExportSgA', {
      groupDescription: 'Export SG-A - allows ingress from Export SG-B (issue #1761)',
      vpcId: vpc.ref,
    });

    const sgB = new ec2.CfnSecurityGroup(this, 'ExportSgB', {
      groupDescription: 'Export SG-B - allows ingress from Export SG-A (issue #1761)',
      vpcId: vpc.ref,
    });

    // Standalone ingress resources, same shape the L2 `addIngressRule`
    // cross-reference emits: each rule Refs both SGs, and the SGs do not
    // reference each other.
    new ec2.CfnSecurityGroupIngress(this, 'ExportSgAfromB', {
      groupId: sgA.attrGroupId,
      sourceSecurityGroupId: sgB.attrGroupId,
      ipProtocol: 'tcp',
      fromPort: 443,
      toPort: 443,
      description: 'Allow HTTPS from Export SG-B',
    });

    new ec2.CfnSecurityGroupIngress(this, 'ExportSgBfromA', {
      groupId: sgB.attrGroupId,
      sourceSecurityGroupId: sgA.attrGroupId,
      ipProtocol: 'tcp',
      fromPort: 443,
      toPort: 443,
      description: 'Allow HTTPS from Export SG-A',
    });

    new cdk.CfnOutput(this, 'ExportVpcId', {
      value: vpc.ref,
      description: 'VPC ID (both export-arm SGs live in this VPC)',
    });
  }
}
