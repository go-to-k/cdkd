import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

/**
 * Integration test for a CIRCULAR Security Group reference.
 *
 * The classic CloudFormation cycle: SG-A allows ingress from SG-B AND
 * SG-B allows ingress from SG-A. If both ingress rules were declared
 * INLINE (inside each SG's `SecurityGroupIngress` property), the two SG
 * resources would reference each other and form a genuine dependency
 * cycle that CloudFormation (and cdkd's DAG builder) cannot order.
 *
 * CDK breaks the cycle the same way CloudFormation docs recommend: when
 * `sgA.addIngressRule(sgB, ...)` would create a cross-reference, CDK
 * emits the rule as a STANDALONE `AWS::EC2::SecurityGroupIngress`
 * resource (not inline). Each standalone ingress resource Refs both SGs,
 * but the two SGs themselves no longer reference each other — so the
 * graph is:
 *
 *     VPC ─┬─> SgA ─┐
 *          │        ├─> SgAfromB  (ingress on SgA, source SgB)
 *          └─> SgB ─┤
 *                   └─> SgBfromA  (ingress on SgB, source SgA)
 *
 * which is acyclic. This is exactly the shape the verify.sh confirms via
 * `cdkd synth` (two `AWS::EC2::SecurityGroupIngress` resources, zero
 * inline `SecurityGroupIngress` entries on either SG).
 *
 * What this stresses in cdkd:
 *   1. The DAG builder must NOT raise a false `DependencyError` —
 *      the standalone ingress resources break what would otherwise look
 *      like a cycle.
 *   2. On DESTROY the ingress rules must be revoked BEFORE the SGs are
 *      deleted. An SG that is still referenced by a live cross-SG ingress
 *      rule cannot be deleted — AWS rejects `DeleteSecurityGroup` with
 *      `DependencyViolation: resource sg-xxx has a dependent object`.
 *      cdkd's reversed-traversal delete order plus the
 *      `AWS::EC2::SecurityGroup -> AWS::EC2::SecurityGroupIngress`
 *      implicit-delete-dep edge must put both ingress deletes before both
 *      SG deletes.
 *
 * Why a VPC with `natGateways: 0`: a Security Group must live in a VPC,
 * and we want the cheapest possible VPC (no NAT, no instances). No EC2
 * instances are launched — the cross-SG reference alone is enough to
 * exercise the create/destroy ordering.
 */
export class SgCircularDependencyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Tag every resource so the verify.sh can find the SGs / VPC by the
    // fixture tag (NOT aws:cdk:path, which AWS reserves and cdkd cannot set).
    cdk.Tags.of(this).add('cdkd:integ-fixture', 'sg-circular-dependency');

    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.60.0.0/16'),
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });

    // Two security groups. allowAllOutbound:false keeps the synthesized
    // template tight (no implicit egress rule noise) and focuses the test
    // on the ingress cross-references.
    const sgA = new ec2.SecurityGroup(this, 'SgA', {
      vpc,
      description: 'SG-A — allows ingress from SG-B (circular ref test)',
      allowAllOutbound: false,
    });

    const sgB = new ec2.SecurityGroup(this, 'SgB', {
      vpc,
      description: 'SG-B — allows ingress from SG-A (circular ref test)',
      allowAllOutbound: false,
    });

    // The circular references. Because each rule's source is a DIFFERENT
    // SG construct than the one it is attached to, CDK emits each as a
    // standalone AWS::EC2::SecurityGroupIngress resource (breaking the
    // would-be cycle) rather than an inline ingress on the SG.
    //   - SgA ingress FROM SgB on tcp/443
    //   - SgB ingress FROM SgA on tcp/443
    sgA.addIngressRule(sgB, ec2.Port.tcp(443), 'Allow HTTPS from SG-B');
    sgB.addIngressRule(sgA, ec2.Port.tcp(443), 'Allow HTTPS from SG-A');

    new cdk.CfnOutput(this, 'VpcId', {
      value: vpc.vpcId,
      description: 'VPC ID (both SGs live in this VPC)',
    });

    new cdk.CfnOutput(this, 'SgAId', {
      value: sgA.securityGroupId,
      description: 'SG-A id (allows ingress from SG-B)',
    });

    new cdk.CfnOutput(this, 'SgBId', {
      value: sgB.securityGroupId,
      description: 'SG-B id (allows ingress from SG-A)',
    });
  }
}
