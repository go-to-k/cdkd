import type { Subnet } from '@aws-sdk/client-ec2';
import {
  EC2Client,
  GetIpamPoolAllocationsCommand,
  DescribeVpcsCommand,
  DescribeInternetGatewaysCommand,
  DescribeAddressesCommand,
  DescribeSubnetsCommand,
  type AllocateAddressCommandInput,
} from '@aws-sdk/client-ec2';
import { canonicalizeIpv4Cidr } from '../../../utils/ipv4-cidr.js';
import { canonicalizeIpv6Cidr } from '../../../utils/ipv6-cidr.js';
import { type CfnTagEntry } from '../../tag-list.js';
import { withoutServerErrorRetries, type AmbiguousCreateWindow } from '../ambiguous-create.js';
import {
  collectOrphanIds,
  orphanCommandRegionArg,
  reportPossibleOrphans,
  type OrphanIds,
} from '../orphan-report.js';
import { ambientClientDefaults } from '../../../utils/ambient-client-defaults.js';
import { createMaskedLogSinks, type MaskedLogSinks } from '../../masked-retry-logger.js';
import type { CreateContext } from '../../../types/resource.js';
import {
  pasteableAwsCommand,
  type PasteableAwsCommand,
} from '../../replacement-protection-advice.js';
import {
  ORPHAN_LIST_PAGE_SIZE,
  type VpcOrphanMatch,
  ec2IdsCreatedByThisProcess,
  lostCreateNoun,
  mayBeLostCreate,
} from './common.js';
import type { EC2Provider } from '../ec2-provider.js';

/**
 * The client the five tokenless creates go through (issue #2080): SDK
 * retries on, except a 5xx (`withoutServerErrorRetries`). Separate so every
 * other call keeps the full SDK retry, and built in the shared client's
 * REGION (read from it, as `config.region()` resolves it) so the create
 * cannot land in another region than the calls around it. The PROMISE is
 * cached, so two creates on a cold provider build one client; a rejected
 * region read is not cached, so the next create retries it.
 *
 * A shared client that is not an `EC2Client` -- a unit-test double, like
 * the `?? ec2` fallback in the constructor -- is used as is: `AwsClients`
 * always supplies a real one.
 */
export function getCreateClient(this: EC2Provider): Promise<EC2Client> {
  const shared = this.ec2Client;
  if (!(shared instanceof EC2Client)) return Promise.resolve(shared);
  this.createClient ??= shared.config.region().then(
    (region) => withoutServerErrorRetries(new EC2Client({ ...ambientClientDefaults(), region })),
    (error: unknown) => {
      this.createClient = undefined;
      throw error;
    }
  );
  return this.createClient;
}

/**
 * Issue #2080: after an attempt at one of the tokenless creates ended
 * AMBIGUOUS (a 5xx: EC2 may have made the resource and lost the answer),
 * name the resources that could be its orphan: tagged as that attempt could
 * have left them (see {@link mayBeLostCreate}), matching what the create
 * sent, and not created by
 * this process. EC2 reports no creation time for any of the four types, so
 * the report is the undated one -- a read command per candidate, no delete
 * command (`orphan-report.ts`). Never throws.
 */
export async function reportPossibleEc2Orphans(
  this: EC2Provider,
  logicalId: string,
  window: AmbiguousCreateWindow,
  log: MaskedLogSinks,
  lookup: {
    action: string;
    listAction: string;
    subject: string;
    noun: string;
    afterward?: string;
    list: () => Promise<OrphanIds>;
    /** The `aws ec2` read command for one id, ending in `regionArg`. */
    inspect: (
      aws: ReturnType<typeof pasteableAwsCommand>,
      id: string,
      regionArg: PasteableAwsCommand
    ) => string;
  }
): Promise<void> {
  const aws = pasteableAwsCommand(log.mask);
  const regionArg = await orphanCommandRegionArg(this.ec2Client, aws);
  await reportPossibleOrphans(logicalId, window, log, {
    action: lookup.action,
    service: 'EC2',
    listAction: lookup.listAction,
    subject: lookup.subject,
    noun: lookup.noun,
    ...(lookup.afterward !== undefined && { afterward: lookup.afterward }),
    list: lookup.list,
    inspect: (id) => lookup.inspect(aws, id, regionArg),
  });
}

/**
 * VPCs with the same primary CIDR (compared host-bit-cleared, as EC2 may
 * store it), untagged or carrying exactly the tags the create sent
 * (`sent`), not a default VPC. A VPC CIDR can repeat across VPCs, so a
 * replayed `CreateVpc` is a second VPC. An IPAM-allocated VPC
 * (go-to-k/cdkd#5633) declares no CIDR: its candidates are the VPCs the
 * pool itself allocates to (`GetIpamPoolAllocations`), under the same tag
 * and default-VPC filters.
 */
export async function reportPossibleOrphanVpcs(
  this: EC2Provider,
  logicalId: string,
  match: VpcOrphanMatch,
  sent: CfnTagEntry[],
  window: AmbiguousCreateWindow,
  context: CreateContext | undefined
): Promise<void> {
  const log = createMaskedLogSinks(this.logger, context?.maskSecrets);
  const wanted =
    'cidrBlock' in match ? (canonicalizeIpv4Cidr(match.cidrBlock) ?? match.cidrBlock) : undefined;
  // The VPCs one page of DescribeVpcs may name, never more than the pool's
  // own allocations for an IPAM VPC.
  const listVpcs = async (inPool: ReadonlySet<string> | undefined): Promise<OrphanIds> =>
    collectOrphanIds(
      async (token) => {
        const page = await this.ec2Client.send(
          new DescribeVpcsCommand({ MaxResults: ORPHAN_LIST_PAGE_SIZE, NextToken: token })
        );
        return { items: page.Vpcs ?? [], next: page.NextToken };
      },
      (vpc) =>
        vpc.VpcId !== undefined &&
        vpc.IsDefault !== true &&
        mayBeLostCreate(vpc.Tags, sent) &&
        vpc.CidrBlock !== undefined &&
        (inPool !== undefined
          ? inPool.has(vpc.VpcId)
          : (canonicalizeIpv4Cidr(vpc.CidrBlock) ?? vpc.CidrBlock) === wanted) &&
        !ec2IdsCreatedByThisProcess.has(vpc.VpcId)
          ? vpc.VpcId
          : undefined
    );
  await this.reportPossibleEc2Orphans(logicalId, window, log, {
    action: 'CreateVpc',
    listAction: 'cidrBlock' in match ? 'DescribeVpcs' : 'GetIpamPoolAllocations + DescribeVpcs',
    subject:
      'cidrBlock' in match
        ? `a VPC with CIDR ${log.value(match.cidrBlock)}`
        : `a VPC allocated from IPAM pool ${log.value(match.ipamPoolId)}`,
    noun: lostCreateNoun('VPC(s)', sent),
    list: async () => {
      if ('cidrBlock' in match) return listVpcs(undefined);
      const allocated = await collectOrphanIds(
        async (token) => {
          const page = await this.ec2Client.send(
            new GetIpamPoolAllocationsCommand({ IpamPoolId: match.ipamPoolId, NextToken: token })
          );
          return { items: page.IpamPoolAllocations ?? [], next: page.NextToken };
        },
        (allocation) =>
          allocation.ResourceType === 'vpc' && allocation.ResourceId !== undefined
            ? allocation.ResourceId
            : undefined
      );
      const vpcs = await listVpcs(new Set(allocated.ids));
      return { ids: vpcs.ids, truncated: allocated.truncated || vpcs.truncated };
    },
    inspect: (aws, id, regionArg) =>
      aws`aws ec2 describe-vpcs --vpc-ids ${id}${regionArg}`.render(),
  });
}

/**
 * Subnets of the same VPC with the same CIDR, untagged or carrying exactly
 * the tags the create sent. A CIDR cannot repeat in one VPC, so at most one
 * matches, and its existence is what makes the replayed `CreateSubnet` fail
 * with `InvalidSubnet.Conflict`.
 */
export async function reportPossibleOrphanSubnets(
  this: EC2Provider,
  logicalId: string,
  vpcId: string,
  key: { cidr: string; family: 'ipv4' | 'ipv6' },
  sent: CfnTagEntry[],
  window: AmbiguousCreateWindow,
  context: CreateContext | undefined
): Promise<void> {
  const log = createMaskedLogSinks(this.logger, context?.maskSecrets);
  const cidrBlock = key.cidr;
  const canonical = (cidr: string): string =>
    (key.family === 'ipv4' ? canonicalizeIpv4Cidr(cidr) : canonicalizeIpv6Cidr(cidr)) ?? cidr;
  const wanted = canonical(cidrBlock);
  // go-to-k/cdkd#5632: an IPv6-only subnet is keyed on its IPv6 block, held
  // only in the two states a lost create's association can be in.
  const holdsWanted = (subnet: Subnet): boolean =>
    key.family === 'ipv4'
      ? subnet.CidrBlock !== undefined && canonical(subnet.CidrBlock) === wanted
      : (subnet.Ipv6CidrBlockAssociationSet ?? []).some(
          (association) =>
            association.Ipv6CidrBlock !== undefined &&
            ['associating', 'associated'].includes(association.Ipv6CidrBlockState?.State ?? '') &&
            canonical(association.Ipv6CidrBlock) === wanted
        );
  await this.reportPossibleEc2Orphans(logicalId, window, log, {
    action: 'CreateSubnet',
    listAction: 'DescribeSubnets',
    subject: `a subnet with CIDR ${log.value(cidrBlock)} in VPC ${log.value(vpcId)}`,
    noun: lostCreateNoun('subnet(s)', sent),
    afterward:
      'Creating it again, which fails with InvalidSubnet.Conflict while that subnet exists.',
    list: () =>
      collectOrphanIds(
        async (token) => {
          const page = await this.ec2Client.send(
            new DescribeSubnetsCommand({
              Filters: [{ Name: 'vpc-id', Values: [vpcId] }],
              MaxResults: ORPHAN_LIST_PAGE_SIZE,
              NextToken: token,
            })
          );
          return { items: page.Subnets ?? [], next: page.NextToken };
        },
        (subnet) =>
          subnet.SubnetId !== undefined &&
          mayBeLostCreate(subnet.Tags, sent) &&
          holdsWanted(subnet) &&
          !ec2IdsCreatedByThisProcess.has(subnet.SubnetId)
            ? subnet.SubnetId
            : undefined
      ),
    inspect: (aws, id, regionArg) =>
      aws`aws ec2 describe-subnets --subnet-ids ${id}${regionArg}`.render(),
  });
}

/**
 * Internet gateways attached to nothing, untagged or carrying exactly the
 * tags the create sent. `CreateInternetGateway` takes no other input to
 * match on; the attachment is a separate resource
 * (`AWS::EC2::VPCGatewayAttachment`), so an orphan stays detached.
 */
export async function reportPossibleOrphanInternetGateways(
  this: EC2Provider,
  logicalId: string,
  sent: CfnTagEntry[],
  window: AmbiguousCreateWindow,
  context: CreateContext | undefined
): Promise<void> {
  const log = createMaskedLogSinks(this.logger, context?.maskSecrets);
  await this.reportPossibleEc2Orphans(logicalId, window, log, {
    action: 'CreateInternetGateway',
    listAction: 'DescribeInternetGateways',
    subject: 'an internet gateway',
    noun: lostCreateNoun('internet gateway(s)', sent, 'detached'),
    list: () =>
      collectOrphanIds(
        async (token) => {
          const page = await this.ec2Client.send(
            new DescribeInternetGatewaysCommand({
              MaxResults: ORPHAN_LIST_PAGE_SIZE,
              NextToken: token,
            })
          );
          return { items: page.InternetGateways ?? [], next: page.NextToken };
        },
        (igw) =>
          igw.InternetGatewayId !== undefined &&
          (igw.Attachments ?? []).length === 0 &&
          mayBeLostCreate(igw.Tags, sent) &&
          !ec2IdsCreatedByThisProcess.has(igw.InternetGatewayId)
            ? igw.InternetGatewayId
            : undefined
      ),
    inspect: (aws, id, regionArg) =>
      aws`aws ec2 describe-internet-gateways --internet-gateway-ids ${id}${regionArg}`.render(),
  });
}

/**
 * Elastic IPs of the same domain (and the same network border group and
 * pool, when the template names them), associated with nothing, untagged or
 * carrying exactly the tags the create sent. The association is a follow-up
 * call the lost attempt never reached. `DescribeAddresses` is not paginated.
 */
export async function reportPossibleOrphanAddresses(
  this: EC2Provider,
  logicalId: string,
  input: AllocateAddressCommandInput,
  sent: CfnTagEntry[],
  window: AmbiguousCreateWindow,
  context: CreateContext | undefined
): Promise<void> {
  const log = createMaskedLogSinks(this.logger, context?.maskSecrets);
  await this.reportPossibleEc2Orphans(logicalId, window, log, {
    action: 'AllocateAddress',
    listAction: 'DescribeAddresses',
    subject: `an Elastic IP address (domain ${log.value(input.Domain ?? 'vpc')})`,
    noun: lostCreateNoun('Elastic IP address(es)', sent, 'unassociated'),
    list: async () => {
      const response = await this.ec2Client.send(new DescribeAddressesCommand({}));
      const ids: string[] = [];
      for (const address of response.Addresses ?? []) {
        const id = address.AllocationId;
        if (
          id === undefined ||
          (address.Domain ?? 'vpc') !== (input.Domain ?? 'vpc') ||
          address.AssociationId !== undefined ||
          !mayBeLostCreate(address.Tags, sent) ||
          (input.NetworkBorderGroup !== undefined &&
            address.NetworkBorderGroup !== input.NetworkBorderGroup) ||
          (input.PublicIpv4Pool !== undefined && address.PublicIpv4Pool !== input.PublicIpv4Pool) ||
          ec2IdsCreatedByThisProcess.has(id)
        ) {
          continue;
        }
        ids.push(id);
      }
      return { ids, truncated: false };
    },
    inspect: (aws, id, regionArg) =>
      aws`aws ec2 describe-addresses --allocation-ids ${id}${regionArg}`.render(),
  });
}

/** The {@link EC2Provider} methods this module defines. */
export const orphansMethods = {
  getCreateClient,
  reportPossibleEc2Orphans,
  reportPossibleOrphanVpcs,
  reportPossibleOrphanSubnets,
  reportPossibleOrphanInternetGateways,
  reportPossibleOrphanAddresses,
};
