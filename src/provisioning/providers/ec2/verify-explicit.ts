import {
  DescribeVpcsCommand,
  DescribeInternetGatewaysCommand,
  DescribeRouteTablesCommand,
  DescribeVpnGatewaysCommand,
  DescribeNatGatewaysCommand,
  DescribeAddressesCommand,
  DescribeSubnetsCommand,
  DescribeSecurityGroupsCommand,
  DescribeSecurityGroupRulesCommand,
  DescribeInstancesCommand,
  DescribeNetworkAclsCommand,
} from '@aws-sdk/client-ec2';
import { canonicalizeIpv4Cidr } from '../../../utils/ipv4-cidr.js';
import { compositeIdSeparatorRefusal, packCompositeId } from '../../composite-id.js';
import { definedAttributes } from '../../attribute-map.js';
import type { ResourceImportResult } from '../../../types/resource.js';
import { describedInstanceAttributes } from './instance-support.js';
import { natGatewayAttributes } from './nat-support.js';
import { SG_RULE_ID_PATTERN } from './sg-support.js';
import type { EC2Provider } from '../ec2-provider.js';

export async function verifyExplicit(
  this: EC2Provider,
  logicalId: string,
  resourceType: string,
  physicalId: string,
  properties: Record<string, unknown>
): Promise<ResourceImportResult | null> {
  try {
    switch (resourceType) {
      case 'AWS::EC2::VPC': {
        const resp = await this.ec2Client.send(new DescribeVpcsCommand({ VpcIds: [physicalId] }));
        const vpc = resp.Vpcs?.[0];
        // go-to-k/cdkd#5633: the CIDR the record carries for
        // `Fn::GetAtt Vpc.CidrBlock`, which an IPAM-allocated VPC's template
        // does not declare.
        return vpc
          ? {
              physicalId,
              attributes: definedAttributes({ VpcId: physicalId, CidrBlock: vpc.CidrBlock }),
            }
          : null;
      }
      case 'AWS::EC2::Subnet': {
        const resp = await this.ec2Client.send(
          new DescribeSubnetsCommand({ SubnetIds: [physicalId] })
        );
        // Issue #3627: the same map `create()` records; the resolver's
        // Subnet arm builds only `SubnetId`, so `AvailabilityZone` resolved
        // to the subnet id.
        const subnet = resp.Subnets?.[0];
        return subnet
          ? {
              physicalId,
              attributes: definedAttributes({
                SubnetId: physicalId,
                AvailabilityZone: subnet.AvailabilityZone,
                // go-to-k/cdkd#5632: the rest of what create() records, which
                // also heals a record written before it did.
                AvailabilityZoneId: subnet.AvailabilityZoneId,
                CidrBlock: subnet.CidrBlock,
                VpcId: subnet.VpcId,
              }),
            }
          : null;
      }
      case 'AWS::EC2::SecurityGroup': {
        const resp = await this.ec2Client.send(
          new DescribeSecurityGroupsCommand({ GroupIds: [physicalId] })
        );
        const group = resp.SecurityGroups?.[0];
        if (!group) return null;
        // The same two members create / update record (issue #3097), off
        // the describe already in hand: an adopted group's `VpcId` is then
        // served from state like a created one's, and an unreported one is
        // ABSENT rather than the live arm's problem on every resolution.
        return {
          physicalId,
          attributes: definedAttributes({ GroupId: physicalId, VpcId: group.VpcId }),
        };
      }
      case 'AWS::EC2::SecurityGroupIngress': {
        // Only the `sgr-...` rule id is accepted: it is CloudFormation's own
        // `primaryIdentifier` for the type and the id the EC2 console shows,
        // while cdkd's composite `<groupId>|<ipProtocol>|<fromPort>|<toPort>`
        // is an internal shape a user cannot read off AWS (and one the same
        // tuple can share with several rules). The composite is still what
        // gets RECORDED — the revoke path needs the tuple — alongside the
        // `Id` attribute `cdkd export` resolves from (issue #1761).
        //
        // ANCHORED, not `startsWith('sgr-')`: the prefix test also admits
        // `sgr-0abc|tcp|443|443`, which AWS rejects with
        // `InvalidSecurityGroupRuleId.Malformed` — an error `isNotFoundError`
        // does NOT match, so the throw escapes `verifyExplicit` and aborts the
        // whole `cdkd import` run rather than declining this one row.
        if (!SG_RULE_ID_PATTERN.test(physicalId)) return null;
        const resp = await this.ec2Client.send(
          new DescribeSecurityGroupRulesCommand({ SecurityGroupRuleIds: [physicalId] })
        );
        const rule = resp.SecurityGroupRules?.[0];
        // An EGRESS rule id is a different CFn type
        // (`AWS::EC2::SecurityGroupEgress`); adopting it here would record a
        // row whose delete calls `RevokeSecurityGroupIngress` and silently
        // does nothing.
        if (!rule || rule.IsEgress === true) return null;
        if (!rule.GroupId || !rule.IpProtocol || !rule.SecurityGroupRuleId) return null;
        const segments = [
          { name: 'groupId', value: rule.GroupId },
          { name: 'ipProtocol', value: rule.IpProtocol },
          { name: 'fromPort', value: rule.FromPort ?? '-1' },
          { name: 'toPort', value: rule.ToPort ?? '-1' },
        ];
        // Warn-and-SKIP, matching the `AWS::EC2::EIP` arm below: an
        // `import()` may decline a row, but it must never ADOPT an id it
        // knows decodes ambiguously (#1658). Unreachable in practice — every
        // segment comes from `DescribeSecurityGroupRules`.
        const refusal = compositeIdSeparatorRefusal(
          'AWS::EC2::SecurityGroupIngress',
          logicalId,
          segments
        );
        if (refusal !== undefined) {
          this.logger.warn(`${refusal} Skipping import.`);
          return null;
        }
        return {
          physicalId: packCompositeId('AWS::EC2::SecurityGroupIngress', logicalId, segments),
          attributes: { Id: rule.SecurityGroupRuleId },
        };
      }
      case 'AWS::EC2::NatGateway': {
        const resp = await this.ec2Client.send(
          new DescribeNatGatewaysCommand({ NatGatewayIds: [physicalId] })
        );
        const gw = resp.NatGateways?.find((g) => g.State !== 'deleted' && g.State !== 'deleting');
        return gw ? { physicalId, attributes: natGatewayAttributes(gw) } : null;
      }
      case 'AWS::EC2::EIP': {
        // Accept an allocation id, a public IP, or the composite `IP|alloc`.
        const { allocationId, publicIp } = this.parseEipPhysicalId(physicalId);
        const filter = allocationId
          ? { AllocationIds: [allocationId] }
          : { PublicIps: publicIp ? [publicIp] : [] };
        const resp = await this.ec2Client.send(new DescribeAddressesCommand(filter));
        const addr = resp.Addresses?.[0];
        if (!addr?.AllocationId || !addr.PublicIp) return null;
        // Warn-and-SKIP, matching the `AWS::S3Tables::*` import arms: an
        // `import()` never throws over one row where it can decline, but it
        // must not ADOPT an id it knows to be ambiguous either — recording
        // one is the #1658 failure mode (a state row that looks adopted and
        // makes the stack undestroyable), which is strictly worse than the
        // loud not-found a skip produces. Unreachable in practice (both
        // segments come from `DescribeAddresses`); see `eipPhysicalId`.
        const eipRefusal = compositeIdSeparatorRefusal('AWS::EC2::EIP', logicalId, [
          { name: 'publicIp', value: addr.PublicIp },
          { name: 'allocationId', value: addr.AllocationId },
        ]);
        if (eipRefusal !== undefined) {
          this.logger.warn(`${eipRefusal} Skipping import.`);
          return null;
        }
        return {
          physicalId: this.eipPhysicalId(logicalId, addr.PublicIp, addr.AllocationId),
          attributes: { AllocationId: addr.AllocationId, PublicIp: addr.PublicIp },
        };
      }
      // Issue #3661: the VPC plumbing a CDK `ec2.Vpc` synthesizes. These
      // returned `null`, so `--migrate-from-cloudformation` retired the
      // CloudFormation stack with them orphaned and the next deploy
      // re-created them (a duplicate route table, a conflicting
      // association). Each arm accepts CloudFormation's physical id (measured
      // on a CloudFormation-created stack, see the issue) AND cdkd's own form
      // (the #1852 heal re-reads through here with it), verifies against
      // AWS, and records cdkd's form plus the attributes `create()` records.
      // Every id is shape-checked BEFORE the call: a malformed id makes EC2
      // throw `*.Malformed`, which `isNotFoundError` does not match, so it
      // would abort the whole import rather than decline this row.
      case 'AWS::EC2::RouteTable': {
        if (!/^rtb-[0-9a-f]+$/.test(physicalId)) return null;
        const resp = await this.ec2Client.send(
          new DescribeRouteTablesCommand({ RouteTableIds: [physicalId] })
        );
        return resp.RouteTables?.[0]
          ? { physicalId, attributes: { RouteTableId: physicalId } }
          : null;
      }
      case 'AWS::EC2::InternetGateway': {
        if (!/^igw-[0-9a-f]+$/.test(physicalId)) return null;
        const resp = await this.ec2Client.send(
          new DescribeInternetGatewaysCommand({ InternetGatewayIds: [physicalId] })
        );
        return resp.InternetGateways?.[0]
          ? { physicalId, attributes: { InternetGatewayId: physicalId } }
          : null;
      }
      case 'AWS::EC2::NetworkAcl': {
        if (!/^acl-[0-9a-f]+$/.test(physicalId)) return null;
        const resp = await this.ec2Client.send(
          new DescribeNetworkAclsCommand({ NetworkAclIds: [physicalId] })
        );
        return resp.NetworkAcls?.[0] ? { physicalId, attributes: { Id: physicalId } } : null;
      }
      case 'AWS::EC2::Route': {
        // CloudFormation's id and cdkd's share one shape: `<rtb>|<destination>`.
        const [routeTableId, destination, ...rest] = physicalId.split('|');
        if (rest.length > 0 || !routeTableId || !destination) return null;
        if (!/^rtb-[0-9a-f]+$/.test(routeTableId)) return null;
        const resp = await this.ec2Client.send(
          new DescribeRouteTablesCommand({ RouteTableIds: [routeTableId] })
        );
        // AWS stores an IPv4 destination host-bit-cleared, while an id can
        // spell the template's non-canonical CIDR (issue #1771), so IPv4 is
        // compared canonically; the id is recorded as it came in.
        const wanted = canonicalizeIpv4Cidr(destination) ?? destination;
        const found = resp.RouteTables?.[0]?.Routes?.some(
          (r) =>
            (r.DestinationCidrBlock !== undefined &&
              (canonicalizeIpv4Cidr(r.DestinationCidrBlock) ?? r.DestinationCidrBlock) ===
                wanted) ||
            r.DestinationIpv6CidrBlock === destination ||
            r.DestinationPrefixListId === destination
        );
        return found ? { physicalId, attributes: {} } : null;
      }
      case 'AWS::EC2::VPCGatewayAttachment': {
        // CloudFormation records `IGW|<vpcId>` / `VGW|<vpcId>` (a CloudFormation
        // IMPORT `<vpcId>|IGW`); cdkd records `<gatewayId>|<vpcId>`. Only the
        // VPC is in CloudFormation's id, so the gateway comes from the template
        // (`InternetGatewayId` / `VpnGatewayId`, Ref-substituted to the
        // gateway's id) or, failing that, from the one gateway of that kind AWS
        // allows attached to the VPC.
        const segments = physicalId.split('|');
        if (segments.length !== 2) return null;
        const vpcId =
          segments.find((seg) => /^vpc-[0-9a-f]+$/.test(seg)) ??
          (typeof properties['VpcId'] === 'string' ? properties['VpcId'] : undefined);
        if (!vpcId || !/^vpc-[0-9a-f]+$/.test(vpcId)) return null;
        const isVpn =
          segments.includes('VGW') ||
          segments.some((seg) => seg.startsWith('vgw-')) ||
          properties['VpnGatewayId'] !== undefined;
        // An `IGW` id beside a VPN signal is contradictory: adopt neither.
        if (isVpn && segments.some((seg) => seg === 'IGW' || seg.startsWith('igw-'))) {
          return null;
        }
        let gatewayId: string | undefined;
        if (isVpn) {
          // Issue #2762: a VPN gateway attachment is this provider's too.
          const declared =
            segments.find((seg) => /^vgw-[0-9a-f]+$/.test(seg)) ??
            (typeof properties['VpnGatewayId'] === 'string'
              ? properties['VpnGatewayId']
              : undefined);
          if (declared !== undefined && !/^vgw-[0-9a-f]+$/.test(declared)) return null;
          const resp = await this.ec2Client.send(
            new DescribeVpnGatewaysCommand(
              declared
                ? { VpnGatewayIds: [declared] }
                : { Filters: [{ Name: 'attachment.vpc-id', Values: [vpcId] }] }
            )
          );
          gatewayId = resp.VpnGateways?.find(
            (g) =>
              g.State !== 'deleted' &&
              g.VpcAttachments?.some((a) => a.VpcId === vpcId && a.State === 'attached')
          )?.VpnGatewayId;
        } else {
          const declared =
            segments.find((seg) => /^igw-[0-9a-f]+$/.test(seg)) ??
            (typeof properties['InternetGatewayId'] === 'string'
              ? properties['InternetGatewayId']
              : undefined);
          if (declared !== undefined && !/^igw-[0-9a-f]+$/.test(declared)) return null;
          const resp = await this.ec2Client.send(
            new DescribeInternetGatewaysCommand(
              declared
                ? { InternetGatewayIds: [declared] }
                : { Filters: [{ Name: 'attachment.vpc-id', Values: [vpcId] }] }
            )
          );
          gatewayId = resp.InternetGateways?.find((g) =>
            g.Attachments?.some(
              // IGW attachments report `available` although the SDK types the
              // field as `AttachmentStatus`, so compare it as a string.
              (a) => a.VpcId === vpcId && ['available', 'attached'].includes(String(a.State))
            )
          )?.InternetGatewayId;
        }
        if (!gatewayId) return null;
        const attachmentSegments = [
          { name: isVpn ? 'vpnGatewayId' : 'internetGatewayId', value: gatewayId },
          { name: 'vpcId', value: vpcId },
        ];
        // Defense-in-depth, unreachable in practice: the VPC segment passed an
        // anchored id pattern above and the gateway id is AWS's own answer.
        const refusal = compositeIdSeparatorRefusal(resourceType, logicalId, attachmentSegments);
        if (refusal !== undefined) {
          this.logger.warn(`${refusal} Skipping import.`);
          return null;
        }
        return {
          physicalId: packCompositeId(resourceType, logicalId, attachmentSegments),
          attributes: {},
        };
      }
      case 'AWS::EC2::NetworkAclEntry': {
        // CloudFormation's id is a generated name with no AWS information
        // (e.g. `Stack-AclEn-aRdUO3zKO34t`), so the entry is located from the
        // template: cdkd's own `<aclId>|<ruleNumber>|<egress>` when that is
        // what came in, else `NetworkAclId` / `RuleNumber` / `Egress`.
        const own = /^(acl-[0-9a-f]+)\|(\d+)\|(true|false)$/.exec(physicalId);
        const networkAclId = own
          ? own[1]
          : typeof properties['NetworkAclId'] === 'string'
            ? properties['NetworkAclId']
            : undefined;
        const ruleNumber = own ? Number(own[2]) : Number(properties['RuleNumber']);
        const egress = own
          ? own[3] === 'true'
          : properties['Egress'] === true || properties['Egress'] === 'true';
        if (!networkAclId || !/^acl-[0-9a-f]+$/.test(networkAclId)) return null;
        if (!Number.isInteger(ruleNumber)) return null;
        const resp = await this.ec2Client.send(
          new DescribeNetworkAclsCommand({ NetworkAclIds: [networkAclId] })
        );
        const entry = resp.NetworkAcls?.[0]?.Entries?.find(
          (e) => e.RuleNumber === ruleNumber && (e.Egress ?? false) === egress
        );
        if (!entry) return null;
        const entrySegments = [
          { name: 'networkAclId', value: networkAclId },
          { name: 'ruleNumber', value: ruleNumber },
          { name: 'egress', value: egress },
        ];
        // Defense-in-depth, unreachable in practice: an anchored `acl-` id,
        // an integer and a boolean cannot hold the separator.
        const refusal = compositeIdSeparatorRefusal(resourceType, logicalId, entrySegments);
        if (refusal !== undefined) {
          this.logger.warn(`${refusal} Skipping import.`);
          return null;
        }
        return {
          physicalId: packCompositeId(resourceType, logicalId, entrySegments),
          attributes: {},
        };
      }
      case 'AWS::EC2::SubnetRouteTableAssociation': {
        if (!/^rtbassoc-[0-9a-f]+$/.test(physicalId)) return null;
        const resp = await this.ec2Client.send(
          new DescribeRouteTablesCommand({
            Filters: [{ Name: 'association.route-table-association-id', Values: [physicalId] }],
          })
        );
        return resp.RouteTables?.[0] ? { physicalId, attributes: {} } : null;
      }
      case 'AWS::EC2::SubnetNetworkAclAssociation': {
        if (!/^aclassoc-[0-9a-f]+$/.test(physicalId)) return null;
        const resp = await this.ec2Client.send(
          new DescribeNetworkAclsCommand({
            Filters: [{ Name: 'association.association-id', Values: [physicalId] }],
          })
        );
        return resp.NetworkAcls?.[0]
          ? { physicalId, attributes: { AssociationId: physicalId } }
          : null;
      }
      case 'AWS::EC2::Instance': {
        if (!/^i-[0-9a-f]+$/.test(physicalId)) return null;
        const resp = await this.ec2Client.send(
          new DescribeInstancesCommand({ InstanceIds: [physicalId] })
        );
        const instance = resp.Reservations?.[0]?.Instances?.[0];
        const state = instance?.State?.Name;
        if (!instance || state === 'terminated' || state === 'shutting-down') return null;
        return { physicalId, attributes: describedInstanceAttributes(physicalId, instance) };
      }
      default:
        return null;
    }
  } catch (error) {
    if (this.isNotFoundError(error)) return null;
    throw error;
  }
}

/** The {@link EC2Provider} methods this module defines. */
export const verifyExplicitMethods = { verifyExplicit };
