/**
 * `Fn::GetAtt` on an `AWS::EC2::NatGateway` whose record lacks the attribute
 * (go-to-k/cdkd#2762): a `--no-wait` create records only what
 * `CreateNatGateway` answers, and `RouteTableId` / `EniId` appear only once the
 * gateway is available. The resolver reads the gateway live, like the
 * `AWS::EC2::Instance` arm: it serves a value AWS reports, WAITS for a gateway
 * still `pending` (on demand, so only a referenced attribute pays for it), and
 * REFUSES with the cause when no value comes, instead of handing the gateway
 * id to the consumer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { DescribeNatGatewaysCommand } from '@aws-sdk/client-ec2';

const mockEc2Send = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => {
  const l = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { getLogger: () => ({ ...l, child: () => l }) };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    ec2: { send: mockEc2Send },
  }),
}));

import { IntrinsicFunctionResolver } from '../../../src/deployment/intrinsic-function-resolver.js';
import { natGatewayAttributeWait } from '../../../src/deployment/intrinsic-resolver/getatt-construct-compute.js';
import {
  disarmInterruptWatchForTests,
  interruptWatchTestSeam,
  isInterruptedWaitError,
} from '../../../src/provisioning/interrupt-watch.js';
import type { ResolverContext } from '../../../src/deployment/intrinsic-resolver/support.js';
import { IntrinsicResolutionRefusalError } from '../../../src/utils/error-handler.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';

const NAT = 'nat-0123456789abcdef0';

function context(): ResolverContext {
  return {
    template: { Resources: { Nat: { Type: 'AWS::EC2::NatGateway', Properties: {} } } },
    resources: {
      Nat: {
        physicalId: NAT,
        resourceType: 'AWS::EC2::NatGateway',
        properties: {},
        // What a `--no-wait` create records.
        attributes: { NatGatewayId: NAT, AutoProvisionZones: 'disabled' },
        dependencies: [],
      },
    },
  };
}

function gateway(fields: Record<string, unknown>): Record<string, unknown> {
  return { NatGateways: [{ NatGatewayId: NAT, ...fields }] };
}

describe('Fn::GetAtt AWS::EC2::NatGateway live arm (#2762)', () => {
  const realWait = { ...natGatewayAttributeWait };
  const sleep = vi.fn((_ms: number) => Promise.resolve());
  beforeEach(() => {
    mockEc2Send.mockReset();
    sleep.mockClear();
    Object.assign(natGatewayAttributeWait, { polls: 3, delayMs: 10_000, sleep });
  });
  afterEach(() => {
    Object.assign(natGatewayAttributeWait, realWait);
  });

  it('serves RouteTableId from a live read once the gateway reports it', async () => {
    mockEc2Send.mockResolvedValue(
      gateway({ State: 'available', AvailabilityMode: 'regional', RouteTableId: 'rtb-nat' })
    );
    const resolver = new IntrinsicFunctionResolver();
    expect(await resolver.resolve({ 'Fn::GetAtt': ['Nat', 'RouteTableId'] }, context())).toBe(
      'rtb-nat'
    );
    expect(mockEc2Send.mock.calls[0]![0]).toBeInstanceOf(DescribeNatGatewaysCommand);
  });

  it('serves a recorded attribute without a read', async () => {
    const resolver = new IntrinsicFunctionResolver();
    expect(await resolver.resolve({ 'Fn::GetAtt': ['Nat', 'AutoProvisionZones'] }, context())).toBe(
      'disabled'
    );
    expect(mockEc2Send).not.toHaveBeenCalled();
  });

  it("serves a zonal gateway's EniId off its primary address", async () => {
    mockEc2Send.mockResolvedValue(
      gateway({
        State: 'available',
        AvailabilityMode: 'zonal',
        NatGatewayAddresses: [
          { NetworkInterfaceId: 'eni-secondary', IsPrimary: false },
          { NetworkInterfaceId: 'eni-primary', IsPrimary: true },
        ],
      })
    );
    const resolver = new IntrinsicFunctionResolver();
    expect(await resolver.resolve({ 'Fn::GetAtt': ['Nat', 'EniId'] }, context())).toBe(
      'eni-primary'
    );
  });

  it('waits for a pending gateway (a --no-wait create) and then serves the value', async () => {
    mockEc2Send
      .mockResolvedValueOnce(gateway({ State: 'pending', AvailabilityMode: 'regional' }))
      .mockResolvedValueOnce(gateway({ State: 'pending', AvailabilityMode: 'regional' }))
      .mockResolvedValueOnce(
        gateway({ State: 'available', AvailabilityMode: 'regional', RouteTableId: 'rtb-late' })
      );
    const resolver = new IntrinsicFunctionResolver();
    expect(await resolver.resolve({ 'Fn::GetAtt': ['Nat', 'RouteTableId'] }, context())).toBe(
      'rtb-late'
    );
    expect(mockEc2Send).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('refuses, naming the wait, when the gateway stays pending past the bound', async () => {
    mockEc2Send.mockResolvedValue(gateway({ State: 'pending', AvailabilityMode: 'regional' }));
    const resolver = new IntrinsicFunctionResolver();
    const refusal = await resolver
      .resolve({ 'Fn::GetAtt': ['Nat', 'RouteTableId'] }, context())
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(refusal).toBeInstanceOf(IntrinsicResolutionRefusalError);
    expect((refusal as Error).message).toContain('Cannot resolve Fn::GetAtt [Nat, RouteTableId]');
    expect((refusal as Error).message).toContain('still pending when the attribute wait ran out');
    // 1 read + 3 polls.
    expect(mockEc2Send).toHaveBeenCalledTimes(4);
  });

  it.each([
    ['failed', /The gateway is failed/],
    ['deleted', /The gateway is deleted/],
  ])('refuses a %s gateway at once, without waiting', async (state, message) => {
    mockEc2Send.mockResolvedValue(gateway({ State: state, AvailabilityMode: 'regional' }));
    const resolver = new IntrinsicFunctionResolver();
    await expect(
      resolver.resolve({ 'Fn::GetAtt': ['Nat', 'RouteTableId'] }, context())
    ).rejects.toThrow(message);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("refuses an available gateway's missing value instead of answering the gateway id (a regional EniId)", async () => {
    mockEc2Send.mockResolvedValue(
      gateway({
        State: 'available',
        AvailabilityMode: 'regional',
        NatGatewayAddresses: [{ NetworkInterfaceId: 'eni-zone', IsPrimary: true }],
      })
    );
    const resolver = new IntrinsicFunctionResolver();
    const refusal = await resolver.resolve({ 'Fn::GetAtt': ['Nat', 'EniId'] }, context()).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(refusal).toBeInstanceOf(IntrinsicResolutionRefusalError);
    expect((refusal as Error).message).toContain('The gateway is available and has no such value');
    expect((refusal as Error).message).toContain('regional NAT gateway reports no single EniId');
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([
    ['AutoScalingIps', 'enabled'],
    ['AutoProvisionZones', 'disabled'],
  ])('reads %s live when the record lacks it', async (attribute, expected) => {
    // Distinct values, so swapping the two reads fails.
    mockEc2Send.mockResolvedValue(
      gateway({
        State: 'available',
        AvailabilityMode: 'regional',
        AutoScalingIps: 'enabled',
        AutoProvisionZones: 'disabled',
      })
    );
    const ctx = context();
    ctx.resources['Nat']!.attributes = { NatGatewayId: NAT };
    const resolver = new IntrinsicFunctionResolver();
    expect(await resolver.resolve({ 'Fn::GetAtt': ['Nat', attribute] }, ctx)).toBe(expected);
    expect(mockEc2Send).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['EniId', 'regional', 'regional NAT gateway reports no single EniId'],
    ['RouteTableId', 'zonal', 'no such value for this zonal gateway'],
    ['AutoScalingIps', 'zonal', 'no such value for this zonal gateway'],
    ['RouteTableId', 'regional', 'check it with `aws ec2 describe-nat-gateways`'],
    ['EniId', 'zonal', 'check it with `aws ec2 describe-nat-gateways`'],
  ])(
    'names the right cause when an available %s (%s) gateway reports no value',
    async (attribute, mode, cause) => {
      mockEc2Send.mockResolvedValue(gateway({ State: 'available', AvailabilityMode: mode }));
      const ctx = context();
      ctx.resources['Nat']!.attributes = { NatGatewayId: NAT };
      const refusal = await new IntrinsicFunctionResolver()
        .resolve({ 'Fn::GetAtt': ['Nat', attribute] }, ctx)
        .then(
          () => undefined,
          (e: unknown) => e
        );
      expect(refusal).toBeInstanceOf(IntrinsicResolutionRefusalError);
      expect((refusal as Error).message).toContain(cause);
    }
  );

  it('refuses with the cause when DescribeNatGateways no longer returns the gateway', async () => {
    mockEc2Send.mockResolvedValue({ NatGateways: [] });
    await expect(
      new IntrinsicFunctionResolver().resolve({ 'Fn::GetAtt': ['Nat', 'RouteTableId'] }, context())
    ).rejects.toThrow(/DescribeNatGateways no longer returns the gateway/);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('stops on Ctrl-C during the wait', async () => {
    disarmInterruptWatchForTests();
    interruptWatchTestSeam.commandOwnsInterrupts = () => true;
    try {
      const baseline = process.listeners('SIGINT');
      sleep.mockImplementation(() => {
        for (const l of process.listeners('SIGINT').filter((x) => !baseline.includes(x))) {
          (l as unknown as () => void)();
        }
        return Promise.resolve();
      });
      mockEc2Send.mockResolvedValue(gateway({ State: 'pending', AvailabilityMode: 'regional' }));
      const err = await new IntrinsicFunctionResolver()
        .resolve({ 'Fn::GetAtt': ['Nat', 'RouteTableId'] }, context())
        .catch((e: unknown) => e);
      expect(isInterruptedWaitError(err)).toBe(true);
      // 1 read before the wait + 1 poll before the interrupt is seen.
      expect(mockEc2Send).toHaveBeenCalledTimes(2);
    } finally {
      sleep.mockImplementation((_ms: number) => Promise.resolve());
      disarmInterruptWatchForTests();
      interruptWatchTestSeam.commandOwnsInterrupts = undefined;
    }
  });

  it('refuses when the live read fails, never answering the gateway id', async () => {
    mockEc2Send.mockRejectedValue(Object.assign(new Error('denied'), { name: 'UnauthorizedOperation' }));
    const resolver = new IntrinsicFunctionResolver();
    await expect(
      resolver.resolve({ 'Fn::GetAtt': ['Nat', 'RouteTableId'] }, context())
    ).rejects.toBeInstanceOf(IntrinsicResolutionRefusalError);
  });
});
