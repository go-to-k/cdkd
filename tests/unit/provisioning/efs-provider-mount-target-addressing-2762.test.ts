/**
 * go-to-k/cdkd#2762: `AWS::EFS::MountTarget` `IpAddress` / `IpAddressType` /
 * `Ipv6Address` are create-only. The SDK provider did not handle them, so
 * declaring any routed the mount target through Cloud Control; they now ride
 * on CreateMountTarget. Also pins the readback (IpAddressType derived from
 * which addresses AWS reports) and `Fn::GetAtt IpAddress` recording.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateMountTargetCommand,
  DescribeMountTargetsCommand,
  MountTargetNotFound,
} from '@aws-sdk/client-efs';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-efs', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-efs')>(
    '@aws-sdk/client-efs'
  );
  return {
    ...actual,
    EFSClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

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

import { EFSProvider } from '../../../src/provisioning/providers/efs-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

const TYPE = 'AWS::EFS::MountTarget';

function createInput(): Record<string, unknown> {
  const call = mockSend.mock.calls.find((c) => c[0] instanceof CreateMountTargetCommand);
  if (!call) throw new Error('CreateMountTarget was not sent');
  return (call[0] as CreateMountTargetCommand).input as unknown as Record<string, unknown>;
}

describe('EFS MountTarget create-only addressing (#2762)', () => {
  let provider: EFSProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new EFSProvider();
  });

  function answerCreate(created: Record<string, unknown>): void {
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof CreateMountTargetCommand) {
        return Promise.resolve({ MountTargetId: 'fsmt-1', ...created });
      }
      if (cmd instanceof DescribeMountTargetsCommand) {
        return Promise.resolve({
          MountTargets: [{ MountTargetId: 'fsmt-1', LifeCycleState: 'available' }],
        });
      }
      return Promise.reject(new Error(`unexpected ${String(cmd)}`));
    });
  }

  it('sends declared IpAddress / IpAddressType / Ipv6Address to CreateMountTarget', async () => {
    answerCreate({ IpAddress: '10.0.1.50', Ipv6Address: '2600:1f10::50' });

    const result = await provider.create('MT', TYPE, {
      FileSystemId: 'fs-1',
      SubnetId: 'subnet-1',
      IpAddress: '10.0.1.50',
      IpAddressType: 'DUAL_STACK',
      Ipv6Address: '2600:1f10::50',
    });

    expect(createInput()).toEqual({
      FileSystemId: 'fs-1',
      SubnetId: 'subnet-1',
      SecurityGroups: undefined,
      IpAddress: '10.0.1.50',
      IpAddressType: 'DUAL_STACK',
      Ipv6Address: '2600:1f10::50',
    });
    expect(result).toEqual({ physicalId: 'fsmt-1', attributes: { IpAddress: '10.0.1.50' } });
  });

  it('sends none of the three when undeclared, and records the AWS-picked IpAddress', async () => {
    answerCreate({ IpAddress: '10.0.2.214' });

    const result = await provider.create('MT', TYPE, { FileSystemId: 'fs-1', SubnetId: 'subnet-1' });

    const input = createInput();
    expect(Object.keys(input).sort()).toEqual(['FileSystemId', 'SecurityGroups', 'SubnetId']);
    expect(result.attributes).toEqual({ IpAddress: '10.0.2.214' });
  });

  it('records no IpAddress attribute for an IPv6-only mount target', async () => {
    answerCreate({ Ipv6Address: '2600:1f10::3150' });

    const result = await provider.create('MT', TYPE, {
      FileSystemId: 'fs-1',
      SubnetId: 'subnet-1',
      IpAddressType: 'IPV6_ONLY',
    });

    expect(createInput()['IpAddressType']).toBe('IPV6_ONLY');
    expect(result.attributes).toEqual({});
  });

  it.each(['IpAddress', 'IpAddressType', 'Ipv6Address'])(
    'refuses a non-string %s before any AWS call',
    async (key) => {
      await expect(
        provider.create('MT', TYPE, {
          FileSystemId: 'fs-1',
          SubnetId: 'subnet-1',
          [key]: { 'Fn::GetAtt': ['X', 'Y'] },
        })
      ).rejects.toThrow(ProvisioningError);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it('only warns about a non-string address when replaying a state record', async () => {
    answerCreate({ IpAddress: '10.0.2.214' });
    await provider.create(
      'MT',
      TYPE,
      { FileSystemId: 'fs-1', SubnetId: 'subnet-1', IpAddress: 42 },
      { replayingState: true }
    );
    expect(Object.keys(createInput())).not.toContain('IpAddress');
  });

  describe('readCurrentState', () => {
    function answerDescribe(mt: Record<string, unknown>): void {
      mockSend
        .mockResolvedValueOnce({
          MountTargets: [{ MountTargetId: 'fsmt-1', FileSystemId: 'fs-1', SubnetId: 's-1', ...mt }],
        })
        .mockResolvedValueOnce({ SecurityGroups: [] });
    }

    it.each([
      [{ IpAddress: '10.0.1.50' }, 'IPV4_ONLY'],
      [{ IpAddress: '10.0.1.50', Ipv6Address: '2600::50' }, 'DUAL_STACK'],
      [{ Ipv6Address: '2600::50' }, 'IPV6_ONLY'],
    ])('reads %j back with IpAddressType %s', async (addresses, expectedType) => {
      answerDescribe(addresses);
      const result = await provider.readCurrentState('fsmt-1', 'MT', TYPE);
      expect(result).toEqual({
        FileSystemId: 'fs-1',
        SubnetId: 's-1',
        SecurityGroups: [],
        ...addresses,
        IpAddressType: expectedType,
      });
    });

    it('emits none of the three when AWS reports no address', async () => {
      answerDescribe({});
      const result = (await provider.readCurrentState('fsmt-1', 'MT', TYPE)) as Record<
        string,
        unknown
      >;
      expect(Object.keys(result).sort()).toEqual(['FileSystemId', 'SecurityGroups', 'SubnetId']);
    });
  });

  describe('import', () => {
    it('reads IpAddress so Fn::GetAtt IpAddress resolves on an imported record', async () => {
      mockSend.mockResolvedValueOnce({
        MountTargets: [{ MountTargetId: 'fsmt-1', IpAddress: '10.0.1.50' }],
      });
      const result = await provider.import({
        logicalId: 'MT',
        resourceType: TYPE,
        stackName: 'S',
        region: 'us-east-1',
        properties: {},
        knownPhysicalId: 'fsmt-1',
      });
      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeMountTargetsCommand);
      expect(result).toEqual({ physicalId: 'fsmt-1', attributes: { IpAddress: '10.0.1.50' } });
    });

    it('returns null for a mount target that is gone', async () => {
      mockSend.mockRejectedValueOnce(
        new MountTargetNotFound({ message: 'gone', $metadata: {}, ErrorCode: 'MountTargetNotFound' })
      );
      const result = await provider.import({
        logicalId: 'MT',
        resourceType: TYPE,
        stackName: 'S',
        region: 'us-east-1',
        properties: {},
        knownPhysicalId: 'fsmt-1',
      });
      expect(result).toBeNull();
    });
  });
});
