/**
 * go-to-k/cdkd#5975 -- a Cloud-Control-routed `AWS::EC2::IPAMPoolCidr` delete
 * refused with "The CIDR has one or more allocations." waits for the pool to
 * release the allocations of VPCs and subnets that are already DELETED, then
 * sends the same delete again. Any other holder (a live resource, another
 * account's resource) fails at once, as before, and no other type waits.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const mockCloudControlSend = vi.fn();
const mockEc2Send = vi.fn();
let ccRegion = 'us-east-1';
let ec2Region = 'us-east-1';

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudControl: {
      send: mockCloudControlSend,
      config: { region: () => Promise.resolve(ccRegion) },
    },
    ec2: { send: mockEc2Send, config: { region: () => Promise.resolve(ec2Region) } },
  }),
}));

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  getAccountInfo: () =>
    Promise.resolve({ partition: 'aws', region: 'us-east-1', accountId: '123456789012' }),
}));

const log = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ ...log, child: () => ({ ...log, child: () => log }) }),
}));

import { CloudControlProvider } from '../../../src/provisioning/cloud-control-provider.js';
import { ipamPoolCidrReleaseWait } from '../../../src/provisioning/ipam-pool-cidr-release.js';
import {
  clearResolvedResourceTimeouts,
  setResolvedResourceTimeouts,
} from '../../../src/provisioning/resource-timeout-registry.js';

const ACCOUNT = '123456789012';
const POOL = 'ipam-pool-0ddc60dcd6c12d1c9';
const POOL_CIDR_ID = `${POOL}|ipam-pool-cidr-0123456789abcdef0`;
const VPC = 'vpc-0ae749f84181d9ec2';
const SUBNET = 'subnet-0451ea975eb4e809c';
const REFUSAL = "Error occurred during operation 'The CIDR has one or more allocations.'";

const callsOf = (send: ReturnType<typeof vi.fn>, cmdName: string) =>
  send.mock.calls.filter((c) => c[0]?.constructor?.name === cmdName);

/** Cloud Control: each `DeleteResource` takes the next outcome; the last repeats. */
function wireCc(outcomes: Array<'REFUSED' | 'SUCCESS'>): void {
  let deletes = 0;
  let current: 'REFUSED' | 'SUCCESS' = 'SUCCESS';
  mockCloudControlSend.mockImplementation((cmd: { constructor: { name: string } }) => {
    const name = cmd.constructor.name;
    if (name === 'DeleteResourceCommand') {
      current = outcomes[Math.min(deletes++, outcomes.length - 1)]!;
      return Promise.resolve({ ProgressEvent: { RequestToken: `tok-${deletes}` } });
    }
    if (name === 'GetResourceRequestStatusCommand') {
      return Promise.resolve({
        ProgressEvent:
          current === 'SUCCESS'
            ? { OperationStatus: 'SUCCESS' }
            : {
                OperationStatus: 'FAILED',
                TypeName: 'AWS::EC2::IPAMPoolCidr',
                Identifier: POOL_CIDR_ID,
                ErrorCode: 'GeneralServiceException',
                StatusMessage: REFUSAL,
              },
      });
    }
    return Promise.resolve({});
  });
}

type Allocation = {
  ResourceId: string;
  ResourceType: string;
  ResourceOwner?: string;
  ResourceRegion?: string;
};

/**
 * EC2: each `GetIpamPoolAllocations` takes the next allocation list (the last
 * repeats), or `'DENIED'`; `live` names the VPCs and subnets EC2 still lists.
 */
function wireEc2(allocations: Array<Allocation[] | 'DENIED'>, live: string[] = []): void {
  let reads = 0;
  mockEc2Send.mockImplementation(
    (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = cmd.constructor.name;
      if (name === 'GetIpamPoolAllocationsCommand') {
        const next = allocations[Math.min(reads++, allocations.length - 1)]!;
        if (next === 'DENIED') {
          const e = new Error('You are not authorized to perform this operation.');
          e.name = 'UnauthorizedOperation';
          return Promise.reject(e);
        }
        return Promise.resolve({ IpamPoolAllocations: next });
      }
      const ids = (cmd.input['Filters'] as Array<{ Values: string[] }>)[0]!.Values;
      if (name === 'DescribeVpcsCommand') {
        return Promise.resolve({
          Vpcs: ids.filter((id) => live.includes(id)).map((VpcId) => ({ VpcId })),
        });
      }
      if (name === 'DescribeSubnetsCommand') {
        return Promise.resolve({
          Subnets: ids.filter((id) => live.includes(id)).map((SubnetId) => ({ SubnetId })),
        });
      }
      return Promise.reject(new Error(`unexpected EC2 call ${name}`));
    }
  );
}

const vpcAllocation = (over: Partial<Allocation> = {}): Allocation => ({
  ResourceId: VPC,
  ResourceType: 'vpc',
  ResourceOwner: ACCOUNT,
  ResourceRegion: 'us-east-1',
  ...over,
});

describe('CloudControlProvider.delete: AWS::EC2::IPAMPoolCidr waits out the allocation release (#5975)', () => {
  let provider: CloudControlProvider;
  const savedWait = { ...ipamPoolCidrReleaseWait };

  beforeEach(() => {
    vi.clearAllMocks();
    ccRegion = 'us-east-1';
    ec2Region = 'us-east-1';
    // A short real budget, so a regression that waits where it must not
    // ends as a failed assertion rather than a loop.
    ipamPoolCidrReleaseWait.maxWaitMs = 200;
    provider = new CloudControlProvider();
    (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = () =>
      new Promise((r) => setTimeout(r, 1));
  });

  afterEach(() => {
    Object.assign(ipamPoolCidrReleaseWait, savedWait);
    clearResolvedResourceTimeouts();
  });

  it('waits until the deleted VPC allocation is released, then deletes the pool CIDR again', async () => {
    wireCc(['REFUSED', 'SUCCESS']);
    wireEc2([[vpcAllocation()], [vpcAllocation()], []]);

    const result = await provider.delete('PoolCidr', POOL_CIDR_ID, 'AWS::EC2::IPAMPoolCidr');

    expect(result).toBeUndefined();
    const deletes = callsOf(mockCloudControlSend, 'DeleteResourceCommand');
    expect(deletes).toHaveLength(2);
    for (const d of deletes) {
      expect(d[0].input).toEqual({ TypeName: 'AWS::EC2::IPAMPoolCidr', Identifier: POOL_CIDR_ID });
    }
    const reads = callsOf(mockEc2Send, 'GetIpamPoolAllocationsCommand');
    expect(reads).toHaveLength(3);
    expect(reads[0]![0].input).toMatchObject({ IpamPoolId: POOL });
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining(`deleted ${VPC}`));
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('waits for a deleted subnet allocation the same way', async () => {
    wireCc(['REFUSED', 'SUCCESS']);
    wireEc2([[{ ...vpcAllocation(), ResourceId: SUBNET, ResourceType: 'subnet' }], []]);

    await provider.delete('PoolCidr', POOL_CIDR_ID, 'AWS::EC2::IPAMPoolCidr');

    expect(callsOf(mockCloudControlSend, 'DeleteResourceCommand')).toHaveLength(2);
    expect(callsOf(mockEc2Send, 'DescribeSubnetsCommand')).toHaveLength(1);
  });

  it('fails at once when a LIVE VPC holds the allocation', async () => {
    wireCc(['REFUSED', 'SUCCESS']);
    wireEc2([[vpcAllocation()]], [VPC]);

    await expect(
      provider.delete('PoolCidr', POOL_CIDR_ID, 'AWS::EC2::IPAMPoolCidr')
    ).rejects.toThrow('The CIDR has one or more allocations.');
    expect(callsOf(mockCloudControlSend, 'DeleteResourceCommand')).toHaveLength(1);
    expect(callsOf(mockEc2Send, 'GetIpamPoolAllocationsCommand')).toHaveLength(1);
  });

  it.each([
    ['another account', { ResourceOwner: '210987654321' }],
    ['another region', { ResourceRegion: 'eu-west-1' }],
    ['no owner', { ResourceOwner: undefined }],
    ['no region', { ResourceRegion: undefined }],
    ['a non-VPC holder', { ResourceType: 'ipam-pool' }],
  ])('does not wait on an allocation held from %s', async (_label, over) => {
    wireCc(['REFUSED', 'SUCCESS']);
    // EC2 lists none of them, so only the owner / region / type check keeps
    // them from reading as deleted.
    wireEc2([[vpcAllocation(over)]]);

    await expect(
      provider.delete('PoolCidr', POOL_CIDR_ID, 'AWS::EC2::IPAMPoolCidr')
    ).rejects.toThrow('The CIDR has one or more allocations.');
    expect(callsOf(mockCloudControlSend, 'DeleteResourceCommand')).toHaveLength(1);
    expect(callsOf(mockEc2Send, 'DescribeVpcsCommand')).toHaveLength(0);
  });

  it('fails with the refusal, and warns, when the allocations cannot be read', async () => {
    wireCc(['REFUSED', 'SUCCESS']);
    wireEc2(['DENIED']);

    await expect(
      provider.delete('PoolCidr', POOL_CIDR_ID, 'AWS::EC2::IPAMPoolCidr')
    ).rejects.toThrow('The CIDR has one or more allocations.');
    expect(callsOf(mockCloudControlSend, 'DeleteResourceCommand')).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('could not be read'));
  });

  it('stops at its cap, warns, and fails with the refusal', async () => {
    ipamPoolCidrReleaseWait.maxWaitMs = 30;
    (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = (ms) =>
      new Promise((r) => setTimeout(r, Math.min(ms, 10)));
    wireCc(['REFUSED', 'SUCCESS']);
    wireEc2([[vpcAllocation()]]);

    await expect(
      provider.delete('PoolCidr', POOL_CIDR_ID, 'AWS::EC2::IPAMPoolCidr')
    ).rejects.toThrow('The CIDR has one or more allocations.');
    expect(callsOf(mockCloudControlSend, 'DeleteResourceCommand')).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('cdkd stopped waiting for AWS to release them')
    );
    // The pool CIDR's delete was refused, not accepted.
    expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining('ACCEPTED'));
  });

  it('re-sends when the pool lists nothing on the first read', async () => {
    // Released between the refusal and the read.
    wireCc(['REFUSED', 'SUCCESS']);
    wireEc2([[]]);

    const result = await provider.delete('PoolCidr', POOL_CIDR_ID, 'AWS::EC2::IPAMPoolCidr');

    expect(result).toBeUndefined();
    expect(callsOf(mockCloudControlSend, 'DeleteResourceCommand')).toHaveLength(2);
  });

  it('re-sends again when the handler lags the listing after a release', async () => {
    // A live VPC elsewhere in the pool keeps the listing non-empty, so only
    // the earlier release makes the second refusal worth another send.
    const other = vpcAllocation({ ResourceId: 'vpc-0aaaaaaaaaaaaaaaa' });
    wireCc(['REFUSED', 'REFUSED', 'SUCCESS']);
    wireEc2([[vpcAllocation(), other], [other]], ['vpc-0aaaaaaaaaaaaaaaa']);

    const result = await provider.delete('PoolCidr', POOL_CIDR_ID, 'AWS::EC2::IPAMPoolCidr');

    expect(result).toBeUndefined();
    expect(callsOf(mockCloudControlSend, 'DeleteResourceCommand')).toHaveLength(3);
  });

  it('shares one budget across re-sent deletes', async () => {
    ipamPoolCidrReleaseWait.maxWaitMs = 40;
    (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = (ms) =>
      new Promise((r) => setTimeout(r, Math.min(ms, 10)));
    // Every delete is refused and every wait sees the allocation released
    // after one poll: only the shared budget ends the loop.
    wireCc(['REFUSED']);
    let reads = 0;
    mockEc2Send.mockImplementation((cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'GetIpamPoolAllocationsCommand') {
        return Promise.resolve({ IpamPoolAllocations: reads++ % 2 === 0 ? [vpcAllocation()] : [] });
      }
      return Promise.resolve({ Vpcs: [] });
    });

    await expect(
      provider.delete('PoolCidr', POOL_CIDR_ID, 'AWS::EC2::IPAMPoolCidr')
    ).rejects.toThrow('The CIDR has one or more allocations.');
    const deletes = callsOf(mockCloudControlSend, 'DeleteResourceCommand').length;
    expect(deletes).toBeGreaterThan(1);
    expect(deletes).toBeLessThan(20);
  });

  it('stops re-sending after MAX_IPAM_RECHECKS when a live allocation stays beside a released one', async () => {
    const other = vpcAllocation({ ResourceId: 'vpc-0aaaaaaaaaaaaaaaa' });
    wireCc(['REFUSED']);
    wireEc2([[vpcAllocation(), other], [other]], ['vpc-0aaaaaaaaaaaaaaaa']);

    await expect(
      provider.delete('PoolCidr', POOL_CIDR_ID, 'AWS::EC2::IPAMPoolCidr')
    ).rejects.toThrow('The CIDR has one or more allocations.');
    // The first send, the send after the release, then MAX_IPAM_RECHECKS (3).
    expect(callsOf(mockCloudControlSend, 'DeleteResourceCommand')).toHaveLength(5);
  });

  it('caps the shared budget at half an explicit --resource-timeout for the type', async () => {
    // The cap alone would allow 10s; half of the 60ms timeout is 30ms.
    ipamPoolCidrReleaseWait.maxWaitMs = 10_000;
    setResolvedResourceTimeouts({ perTypeMs: { 'AWS::EC2::IPAMPoolCidr': 60 } });
    (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = (ms) =>
      new Promise((r) => setTimeout(r, Math.min(ms, 10)));
    wireCc(['REFUSED']);
    let reads = 0;
    mockEc2Send.mockImplementation((cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'GetIpamPoolAllocationsCommand') {
        return Promise.resolve({ IpamPoolAllocations: reads++ % 2 === 0 ? [vpcAllocation()] : [] });
      }
      return Promise.resolve({ Vpcs: [] });
    });

    const started = Date.now();
    await expect(
      provider.delete('PoolCidr', POOL_CIDR_ID, 'AWS::EC2::IPAMPoolCidr')
    ).rejects.toThrow('The CIDR has one or more allocations.');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(callsOf(mockCloudControlSend, 'DeleteResourceCommand').length).toBeGreaterThan(1);
  });

  it('does not wait when the EC2 client targets another region', async () => {
    ec2Region = 'eu-west-1';
    wireCc(['REFUSED', 'SUCCESS']);
    wireEc2([[vpcAllocation()], []]);

    await expect(
      provider.delete('PoolCidr', POOL_CIDR_ID, 'AWS::EC2::IPAMPoolCidr')
    ).rejects.toThrow('The CIDR has one or more allocations.');
    expect(callsOf(mockCloudControlSend, 'DeleteResourceCommand')).toHaveLength(1);
    expect(mockEc2Send).not.toHaveBeenCalled();
  });

  it('negative control: another type refused with the same text does not wait', async () => {
    wireCc(['REFUSED', 'SUCCESS']);
    wireEc2([[vpcAllocation()], []]);

    // The pool CIDR's identifier shape, so only the type gate stops the wait.
    await expect(
      provider.delete('Pool', POOL_CIDR_ID, 'AWS::EC2::IPAMPool')
    ).rejects.toThrow('The CIDR has one or more allocations.');
    expect(callsOf(mockCloudControlSend, 'DeleteResourceCommand')).toHaveLength(1);
    expect(mockEc2Send).not.toHaveBeenCalled();
  });
});
