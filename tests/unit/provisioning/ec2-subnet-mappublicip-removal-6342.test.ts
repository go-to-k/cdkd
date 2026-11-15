import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateSubnetCommand,
  DescribeSubnetsCommand,
  ModifySubnetAttributeCommand,
} from '@aws-sdk/client-ec2';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

const childLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
}));
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    child: () => childLogger,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

/**
 * go-to-k/cdkd#6342: CloudFormation KEEPS a subnet's live
 * `MapPublicIpOnLaunch` when the property is removed from the template
 * (measured A/B, us-east-1), so an absent desired value sends no
 * ModifySubnetAttribute, as for EnableDns64 (#5632). A declared value is
 * still applied, including one declared over an absent previous value.
 */
describe('AWS::EC2::Subnet MapPublicIpOnLaunch removal keeps the live value (#6342)', () => {
  let provider: EC2Provider;
  let live: boolean;
  const base = { VpcId: 'vpc-1', CidrBlock: '10.0.0.0/24', AvailabilityZone: 'us-east-1a' };

  const modifies = () =>
    mockSend.mock.calls
      .filter((c) => c[0] instanceof ModifySubnetAttributeCommand)
      .map((c) => (c[0] as ModifySubnetAttributeCommand).input);

  beforeEach(() => {
    vi.clearAllMocks();
    live = true;
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof CreateSubnetCommand) {
        return Promise.resolve({
          Subnet: { SubnetId: 'subnet-1', AvailabilityZone: 'us-east-1a' },
        });
      }
      if (cmd instanceof ModifySubnetAttributeCommand) {
        const value = cmd.input.MapPublicIpOnLaunch?.Value;
        if (value !== undefined) live = value;
        return Promise.resolve({});
      }
      if (cmd instanceof DescribeSubnetsCommand) {
        return Promise.resolve({
          Subnets: [{ SubnetId: 'subnet-1', MapPublicIpOnLaunch: live }],
        });
      }
      return Promise.resolve({});
    });
    provider = new EC2Provider();
  });

  const update = (
    desired: Record<string, unknown>,
    previous: Record<string, unknown>,
    context?: Parameters<EC2Provider['update']>[5]
  ) =>
    provider.update(
      'Sub',
      'subnet-1',
      'AWS::EC2::Subnet',
      { ...base, ...desired },
      { ...base, ...previous },
      context
    );

  it.each([true, 'true', false, 'false'])(
    'a removal of MapPublicIpOnLaunch: %j sends nothing and records the template',
    async (previous) => {
      const result = await update({}, { MapPublicIpOnLaunch: previous });
      expect(modifies()).toEqual([]);
      expect(live).toBe(true);
      // The recorded bag is the template's, so the next diff is NO_CHANGE.
      expect(result.effectiveProperties).toBeUndefined();
    }
  );

  it.each([
    { replayingState: true },
    { desiredFromAwsReadback: true },
  ] as const)('a removal sends nothing on the state-borne path %j too', async (context) => {
    await update({}, { MapPublicIpOnLaunch: true }, context);
    expect(modifies()).toEqual([]);
  });

  it.each([
    [true, false],
    [false, true],
    ['true', 'false'],
    ['False', 'TRUE'],
  ])('a declared change %j -> %j is applied', async (previous, next) => {
    live = previous === true || String(previous).toLowerCase() === 'true';
    const expected = String(next).toLowerCase() === 'true';
    await update({ MapPublicIpOnLaunch: next }, { MapPublicIpOnLaunch: previous });
    expect(modifies()).toEqual([{ SubnetId: 'subnet-1', MapPublicIpOnLaunch: { Value: expected } }]);
    expect(live).toBe(expected);
  });

  it.each([
    [true, 'true'],
    ['FALSE', false],
  ])('an equal value in another spelling (%j vs %j) sends nothing', async (previous, next) => {
    await update({ MapPublicIpOnLaunch: next }, { MapPublicIpOnLaunch: previous });
    expect(modifies()).toEqual([]);
  });

  it('a re-added false over an absent previous value turns a kept true off', async () => {
    // The removal kept `true`; the record has no value to diff against.
    await update({ MapPublicIpOnLaunch: false }, {});
    expect(modifies()).toEqual([{ SubnetId: 'subnet-1', MapPublicIpOnLaunch: { Value: false } }]);
    expect(live).toBe(false);
  });

  it('a re-added true over an absent previous value is sent and converges', async () => {
    live = false;
    await update({ MapPublicIpOnLaunch: true }, {});
    expect(modifies()).toEqual([{ SubnetId: 'subnet-1', MapPublicIpOnLaunch: { Value: true } }]);
    expect(live).toBe(true);
  });

  it('a malformed desired value is refused before any call', async () => {
    await expect(update({ MapPublicIpOnLaunch: 'yes' }, { MapPublicIpOnLaunch: true })).rejects.toThrow(
      /Subnet\.MapPublicIpOnLaunch must be a boolean/
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('a malformed value on a state replay keeps and records the previous value', async () => {
    const result = await update(
      { MapPublicIpOnLaunch: 'yes' },
      { MapPublicIpOnLaunch: true },
      { replayingState: true }
    );
    expect(modifies()).toEqual([]);
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('leaving MapPublicIpOnLaunch unchanged during state replay')
    );
    expect(result.effectiveProperties).toEqual({ ...base, MapPublicIpOnLaunch: true });
  });

  it('a malformed value on a state replay with no previous value sends and records nothing', async () => {
    const result = await update({ MapPublicIpOnLaunch: 'yes' }, {}, { replayingState: true });
    expect(modifies()).toEqual([]);
    expect(result.effectiveProperties).toEqual(base);
  });

  it('a rollback replay restoring a record without the property keeps true and warns', async () => {
    await update({}, { MapPublicIpOnLaunch: true }, { replayingState: true });
    expect(modifies()).toEqual([]);
    expect(live).toBe(true);
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('MapPublicIpOnLaunch may stay true after the rollback')
    );
  });

  it.each([{}, { desiredFromAwsReadback: true }] as const)(
    'a template or revert removal (%j) does not warn',
    async (context) => {
      await update({}, { MapPublicIpOnLaunch: true }, context);
      expect(childLogger.warn).not.toHaveBeenCalled();
    }
  );

  it('create refuses a malformed value before CreateSubnet', async () => {
    await expect(
      provider.create('Sub', 'AWS::EC2::Subnet', { ...base, MapPublicIpOnLaunch: 'yes' })
    ).rejects.toBeInstanceOf(ProvisioningError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("create coerces the 'True' spelling and turns auto-assign on", async () => {
    live = false;
    await provider.create('Sub', 'AWS::EC2::Subnet', { ...base, MapPublicIpOnLaunch: 'True' });
    expect(modifies()).toEqual([{ SubnetId: 'subnet-1', MapPublicIpOnLaunch: { Value: true } }]);
  });
});
