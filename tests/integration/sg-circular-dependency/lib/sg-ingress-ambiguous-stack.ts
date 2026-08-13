import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

/**
 * Ambiguity arm for issue #1791 — the smallest stack whose
 * `AWS::EC2::SecurityGroupIngress` row cdkd can NEVER resolve a rule id for,
 * from state OR from a live read.
 *
 * ## What makes the row ambiguous
 *
 * ONE resource declaring BOTH `CidrIp` and `CidrIpv6` sends ONE
 * `AuthorizeSecurityGroupIngress` carrying an `IpRanges` entry AND an
 * `Ipv6Ranges` entry, and AWS mints one rule PER SOURCE — two `sgr-...` rules
 * sharing the group, the protocol and the port range, which is the ENTIRE
 * tuple cdkd's composite physicalId
 * (`<groupId>|<ipProtocol>|<fromPort>|<toPort>`) carries.
 *
 * Two consequences, and the arm asserts both rather than assuming them:
 *
 * 1. The DEPLOY records `attributes: {}` — `EC2Provider` adopts the id from
 *    the Authorize response only when the response names exactly one rule, so
 *    this row reaches state in the same shape every pre-#1761 row has. No
 *    state mutation is needed to reach the backfill here; the healing arm on
 *    the sibling stack is the one that has to fabricate that shape.
 * 2. The EXPORT backfill's `DescribeSecurityGroupRules` lookup finds TWO
 *    matching rules and must REFUSE naming both ids, rather than adopting
 *    either — cdkd's physical id cannot say which rule this row is, and
 *    `cdkd destroy` revokes BOTH, so an adopted id would hand CloudFormation
 *    an identifier for a rule cdkd does not exclusively own.
 *
 * ## Why this is a THIRD stack rather than another row on the export-arm stack
 *
 * `cdkd export` is all-or-nothing: one unresolvable row aborts the whole run,
 * under `--dry-run` too. An ambiguous row anywhere in `SgIngressExportStack`
 * would therefore abort the export that stack's arms assert SUCCEEDS, so the
 * refusal has to live in a stack of its own.
 *
 * Same minimal shape as its sibling for the same reason: an L1 VPC with no
 * subnets, no internet gateway and no route table entries, so no unrelated
 * unregistered type can abort the export before the ingress row is reached —
 * which here would produce a non-zero exit for the WRONG reason and pass an
 * exit-code-only assertion. (The refusal assertions name the row and both rule
 * ids precisely so that cannot happen.)
 */
export class SgIngressAmbiguousStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add('cdkd:integ-fixture', 'sg-circular-dependency');

    // L1 on purpose, same as the export-arm stack: `ec2.Vpc` (the L2) always
    // synthesizes at least one subnet with a route table and a route.
    const vpc = new ec2.CfnVPC(this, 'AmbiguousVpc', {
      cidrBlock: '10.62.0.0/16',
    });

    const sg = new ec2.CfnSecurityGroup(this, 'AmbiguousSg', {
      groupDescription: 'Ambiguity arm SG - carries one dual-source ingress rule (issue #1791)',
      vpcId: vpc.ref,
    });

    // The whole point of the fixture: BOTH source families on ONE resource.
    // The IPv6 range does not need the VPC to carry an IPv6 CIDR association —
    // a security-group rule is a filter, and AWS accepts any well-formed CIDR.
    // 2001:db8::/32 is the IETF documentation range, so the rule can never
    // admit real traffic even if the group were ever attached to an ENI.
    new ec2.CfnSecurityGroupIngress(this, 'AmbiguousDualSourceIngress', {
      groupId: sg.attrGroupId,
      ipProtocol: 'tcp',
      fromPort: 8443,
      toPort: 8443,
      cidrIp: '10.62.0.0/16',
      cidrIpv6: '2001:db8::/32',
      description: 'Dual-source rule - AWS mints one sgr- rule per source (issue #1791)',
    });

    new cdk.CfnOutput(this, 'AmbiguousVpcId', {
      value: vpc.ref,
      description: 'VPC ID (the ambiguity-arm SG lives in this VPC)',
    });
  }
}
