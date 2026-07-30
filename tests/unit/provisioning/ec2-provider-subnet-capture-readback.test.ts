import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateSubnetCommand,
  CreateTagsCommand,
  DescribeSubnetsCommand,
  ModifySubnetAttributeCommand,
} from '@aws-sdk/client-ec2';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';

/**
 * Issue #1299: `createSubnet` must not return until the
 * `ModifySubnetAttribute(MapPublicIpOnLaunch)` write is READABLE via
 * `DescribeSubnets`. The deploy engine's async observed-state capture
 * fires immediately after `create()` resolves, and EC2 `Describe*` is
 * eventually consistent — without the read-back, the capture could
 * persist the stale pre-modify `false` as the drift baseline and every
 * later `cdkd drift` reported phantom `MapPublicIpOnLaunch` drift.
 */
describe('EC2Provider createSubnet MapPublicIpOnLaunch read-back (issue #1299)', () => {
  let provider: EC2Provider;

  const subnetProps = {
    VpcId: 'vpc-1',
    CidrBlock: '10.0.0.0/24',
    MapPublicIpOnLaunch: true,
  };

  const wire = (describeResults: Array<boolean>) => {
    let describeCall = 0;
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof CreateSubnetCommand) {
        return Promise.resolve({
          Subnet: { SubnetId: 'subnet-1', AvailabilityZone: 'us-east-1a' },
        });
      }
      if (cmd instanceof DescribeSubnetsCommand) {
        const value = describeResults[Math.min(describeCall, describeResults.length - 1)];
        describeCall++;
        return Promise.resolve({ Subnets: [{ MapPublicIpOnLaunch: value }] });
      }
      return Promise.resolve({});
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new EC2Provider();
  });

  it('returns after ONE read when the write is already visible', async () => {
    wire([true]);
    const result = await provider.create('Sub', 'AWS::EC2::Subnet', subnetProps);
    expect(result.physicalId).toBe('subnet-1');
    const reads = mockSend.mock.calls.filter((c) => c[0] instanceof DescribeSubnetsCommand);
    expect(reads.length).toBe(1);
  });

  it('re-reads until the eventually-consistent value reflects the write', async () => {
    wire([false, false, true]);
    const result = await provider.create('Sub', 'AWS::EC2::Subnet', subnetProps);
    expect(result.physicalId).toBe('subnet-1');
    const reads = mockSend.mock.calls.filter((c) => c[0] instanceof DescribeSubnetsCommand);
    expect(reads.length).toBe(3);
    // Ordering: the modify strictly precedes every read-back.
    const modifyIdx = mockSend.mock.calls.findIndex(
      (c) => c[0] instanceof ModifySubnetAttributeCommand
    );
    const firstReadIdx = mockSend.mock.calls.findIndex(
      (c) => c[0] instanceof DescribeSubnetsCommand
    );
    expect(modifyIdx).toBeGreaterThanOrEqual(0);
    expect(firstReadIdx).toBeGreaterThan(modifyIdx);
  });

  it('read-back failure is best-effort — create still succeeds without retrying', async () => {
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof CreateSubnetCommand) {
        return Promise.resolve({
          Subnet: { SubnetId: 'subnet-1', AvailabilityZone: 'us-east-1a' },
        });
      }
      if (cmd instanceof DescribeSubnetsCommand) {
        return Promise.reject(new Error('throttled'));
      }
      return Promise.resolve({});
    });
    const result = await provider.create('Sub', 'AWS::EC2::Subnet', subnetProps);
    expect(result.physicalId).toBe('subnet-1');
    const reads = mockSend.mock.calls.filter((c) => c[0] instanceof DescribeSubnetsCommand);
    expect(reads.length).toBe(1);
  });

  it('no read-back when MapPublicIpOnLaunch is absent (no modify happened)', async () => {
    wire([true]);
    await provider.create('Sub', 'AWS::EC2::Subnet', {
      VpcId: 'vpc-1',
      CidrBlock: '10.0.0.0/24',
    });
    const modifies = mockSend.mock.calls.filter(
      (c) => c[0] instanceof ModifySubnetAttributeCommand
    );
    const reads = mockSend.mock.calls.filter((c) => c[0] instanceof DescribeSubnetsCommand);
    expect(modifies.length).toBe(0);
    expect(reads.length).toBe(0);
  });

  it('tags still applied before the modify (CreateTags call ordering preserved)', async () => {
    wire([true]);
    await provider.create('Sub', 'AWS::EC2::Subnet', {
      ...subnetProps,
      Tags: [{ Key: 'Name', Value: 'my-subnet' }],
    });
    const tagIdx = mockSend.mock.calls.findIndex((c) => c[0] instanceof CreateTagsCommand);
    const modifyIdx = mockSend.mock.calls.findIndex(
      (c) => c[0] instanceof ModifySubnetAttributeCommand
    );
    expect(tagIdx).toBeGreaterThanOrEqual(0);
    expect(modifyIdx).toBeGreaterThan(tagIdx);
  });
});
