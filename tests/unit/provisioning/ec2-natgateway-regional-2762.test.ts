/**
 * `AWS::EC2::NatGateway` regional NAT gateways on the SDK path
 * (go-to-k/cdkd#2762): `AvailabilityMode`, `VpcId` and
 * `AvailabilityZoneAddresses` are wired into `CreateNatGateway`, a change to
 * `AvailabilityZoneAddresses` (or `Tags`) is applied in place the way
 * CloudFormation applies it, and the readback reports all three.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  AssociateNatGatewayAddressCommand,
  CreateNatGatewayCommand,
  CreateTagsCommand,
  DeleteTagsCommand,
  DescribeNatGatewaysCommand,
  DisassociateNatGatewayAddressCommand,
  type NatGatewayAddress,
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

import {
  EC2Provider,
  natGatewayAttributes,
  planNatZoneAddressUpdate,
  readNatZoneAddresses,
  readbackNatZoneAddresses,
} from '../../../src/provisioning/providers/ec2-provider.js';
import { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import {
  disarmInterruptWatchForTests,
  interruptWatchTestSeam,
  isInterruptedWaitError,
} from '../../../src/provisioning/interrupt-watch.js';
import { findSilentDropProperties } from '../../../src/provisioning/property-coverage.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors/marks.js';

const TYPE = 'AWS::EC2::NatGateway';
const NAT = 'nat-0123456789abcdef0';

/** A regional NAT gateway in manual mode, holding one address in us-east-1a. */
function liveGateway(addresses: NatGatewayAddress[]): Record<string, unknown> {
  return {
    NatGateways: [
      {
        NatGatewayId: NAT,
        State: 'available',
        VpcId: 'vpc-1',
        AvailabilityMode: 'regional',
        AutoProvisionZones: 'disabled',
        AutoScalingIps: 'disabled',
        ConnectivityType: 'public',
        NatGatewayAddresses: addresses,
      },
    ],
  };
}

const ADDR_1A: NatGatewayAddress = {
  AllocationId: 'eipalloc-1a',
  AssociationId: 'eipassoc-1a',
  AvailabilityZone: 'us-east-1a',
  AvailabilityZoneId: 'use1-az1',
  Status: 'succeeded',
};
const ADDR_1B: NatGatewayAddress = {
  AllocationId: 'eipalloc-1b',
  AssociationId: 'eipassoc-1b',
  AvailabilityZone: 'us-east-1b',
  AvailabilityZoneId: 'use1-az2',
  Status: 'succeeded',
};

const ZONE_1A = [{ AvailabilityZone: 'us-east-1a', AllocationIds: ['eipalloc-1a'] }];
const ZONES_1A_1B = [...ZONE_1A, { AvailabilityZone: 'us-east-1b', AllocationIds: ['eipalloc-1b'] }];

function sent<T>(ctor: new (...args: never[]) => T): T[] {
  return mockSend.mock.calls.map(([c]) => c as unknown).filter((c): c is T => c instanceof ctor);
}

let previousNoWait: string | undefined;
beforeEach(() => {
  mockSend.mockReset();
  previousNoWait = process.env['CDKD_NO_WAIT'];
  process.env['CDKD_NO_WAIT'] = 'true';
});
afterEach(() => {
  vi.restoreAllMocks();
  if (previousNoWait === undefined) delete process.env['CDKD_NO_WAIT'];
  else process.env['CDKD_NO_WAIT'] = previousNoWait;
});

describe('AWS::EC2::NatGateway regional properties are handled (#2762)', () => {
  it('declares AvailabilityMode / VpcId / AvailabilityZoneAddresses handled, not by-design', () => {
    const provider = new EC2Provider();
    const handled = [...provider.handledProperties.get(TYPE)!];
    expect(handled).toEqual(
      expect.arrayContaining(['AvailabilityMode', 'VpcId', 'AvailabilityZoneAddresses'])
    );
    expect([...(provider.unhandledByDesign?.get(TYPE)?.keys() ?? [])]).toEqual([
      'MaxDrainDurationSeconds',
    ]);
  });

  it('routes a regional NAT gateway through the SDK provider, not Cloud Control', () => {
    const properties = { AvailabilityMode: 'regional', VpcId: 'vpc-1', AvailabilityZoneAddresses: ZONE_1A };
    expect(findSilentDropProperties(TYPE, properties)).toEqual([]);
    const registry = new ProviderRegistry();
    registry.register(TYPE, new EC2Provider());
    expect(registry.getProviderFor({ resourceType: TYPE, properties }).provisionedBy).toBe('sdk');
  });
});

describe('createNatGateway', () => {
  it('sends a regional gateway with VpcId and its zone addresses, and no SubnetId', async () => {
    mockSend.mockResolvedValue({ NatGateway: { NatGatewayId: NAT } });
    await new EC2Provider().create('Nat', TYPE, {
      AvailabilityMode: 'regional',
      VpcId: 'vpc-1',
      AvailabilityZoneAddresses: [
        { AvailabilityZone: 'us-east-1a', AllocationIds: ['eipalloc-1a'] },
        { AvailabilityZoneId: 'use1-az2', AllocationIds: ['eipalloc-1b', 'eipalloc-1c'] },
      ],
    });
    const [create] = sent(CreateNatGatewayCommand);
    expect(create!.input).toMatchObject({
      AvailabilityMode: 'regional',
      VpcId: 'vpc-1',
      AvailabilityZoneAddresses: [
        { AvailabilityZone: 'us-east-1a', AllocationIds: ['eipalloc-1a'] },
        { AvailabilityZoneId: 'use1-az2', AllocationIds: ['eipalloc-1b', 'eipalloc-1c'] },
      ],
    });
    expect(create!.input.SubnetId).toBeUndefined();
  });

  it('sends no AvailabilityZoneAddresses for an automatic-mode regional gateway', async () => {
    mockSend.mockResolvedValue({ NatGateway: { NatGatewayId: NAT } });
    await new EC2Provider().create('Nat', TYPE, { AvailabilityMode: 'regional', VpcId: 'vpc-1' });
    const [create] = sent(CreateNatGatewayCommand);
    expect(create!.input).not.toHaveProperty('AvailabilityZoneAddresses');
    expect(create!.input).toMatchObject({ AvailabilityMode: 'regional', VpcId: 'vpc-1' });
  });

  it('forwards VpcId on a zonal gateway too, as CloudFormation does (AWS refuses it there)', async () => {
    mockSend.mockResolvedValue({ NatGateway: { NatGatewayId: NAT } });
    await new EC2Provider().create('Nat', TYPE, { SubnetId: 'subnet-1', VpcId: 'vpc-1' });
    const [create] = sent(CreateNatGatewayCommand);
    expect(create!.input).toMatchObject({ SubnetId: 'subnet-1', VpcId: 'vpc-1' });
  });

  it('still refuses a zonal gateway without SubnetId, naming the regional alternative', async () => {
    await expect(new EC2Provider().create('Nat', TYPE, { VpcId: 'vpc-1' })).rejects.toThrow(
      /SubnetId is required for NatGateway Nat \(a regional NAT gateway/
    );
    await expect(
      new EC2Provider().create('Nat', TYPE, { AvailabilityMode: 'zonal', VpcId: 'vpc-1' })
    ).rejects.toThrow(/SubnetId is required/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-list', { AvailabilityZone: 'us-east-1a', AllocationIds: ['eipalloc-1a'] }, /is not a list/],
    ['an empty list', [], /is an empty list/],
    ['an entry naming no zone', [{ AllocationIds: ['eipalloc-1a'] }], /names neither/],
    ['an empty AllocationIds', [{ AvailabilityZone: 'us-east-1a', AllocationIds: [] }], /AllocationIds/],
  ])('refuses %s AvailabilityZoneAddresses before any call', async (_label, value, message) => {
    await expect(
      new EC2Provider().create('Nat', TYPE, {
        AvailabilityMode: 'regional',
        VpcId: 'vpc-1',
        AvailabilityZoneAddresses: value,
      })
    ).rejects.toThrow(message);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('updateNatGateway', () => {
  const base = { AvailabilityMode: 'regional', VpcId: 'vpc-1' };

  it('associates an added zone, naming the declared zone and allocation ids', async () => {
    mockSend.mockImplementation((c: unknown) =>
      Promise.resolve(c instanceof DescribeNatGatewaysCommand ? liveGateway([ADDR_1A]) : {})
    );
    const result = await new EC2Provider().update(
      'Nat',
      NAT,
      TYPE,
      { ...base, AvailabilityZoneAddresses: ZONES_1A_1B },
      { ...base, AvailabilityZoneAddresses: ZONE_1A }
    );
    expect(result.wasReplaced).toBe(false);
    expect(sent(AssociateNatGatewayAddressCommand).map((c) => c.input)).toEqual([
      {
        NatGatewayId: NAT,
        AllocationIds: ['eipalloc-1b'],
        AvailabilityZone: 'us-east-1b',
        AvailabilityZoneId: undefined,
      },
    ]);
    expect(sent(DisassociateNatGatewayAddressCommand)).toEqual([]);
  });

  it('releases a removed zone by its live association id', async () => {
    mockSend.mockImplementation((c: unknown) =>
      Promise.resolve(c instanceof DescribeNatGatewaysCommand ? liveGateway([ADDR_1A, ADDR_1B]) : {})
    );
    await new EC2Provider().update(
      'Nat',
      NAT,
      TYPE,
      { ...base, AvailabilityZoneAddresses: ZONE_1A },
      { ...base, AvailabilityZoneAddresses: ZONES_1A_1B }
    );
    expect(sent(AssociateNatGatewayAddressCommand)).toEqual([]);
    expect(sent(DisassociateNatGatewayAddressCommand).map((c) => c.input)).toEqual([
      { NatGatewayId: NAT, AssociationIds: ['eipassoc-1b'] },
    ]);
  });

  it('swapping the only address waits for the added one to associate, then releases', async () => {
    // AWS refuses a release leaving no ASSOCIATED address, and one still being
    // associated does not count (measured on #2762).
    vi.spyOn(EC2Provider.prototype as unknown as { sleep: () => Promise<void> }, 'sleep').mockResolvedValue();
    let describes = 0;
    mockSend.mockImplementation((c: unknown) => {
      if (!(c instanceof DescribeNatGatewaysCommand)) return Promise.resolve({});
      describes++;
      const added = { ...ADDR_1B, AssociationId: undefined, Status: describes < 3 ? 'associating' : 'succeeded' };
      return Promise.resolve(liveGateway(describes === 1 ? [ADDR_1A] : [ADDR_1A, added as NatGatewayAddress]));
    });
    await new EC2Provider().update(
      'Nat',
      NAT,
      TYPE,
      { ...base, AvailabilityZoneAddresses: [{ AvailabilityZone: 'us-east-1b', AllocationIds: ['eipalloc-1b'] }] },
      { ...base, AvailabilityZoneAddresses: ZONE_1A }
    );
    expect(mockSend.mock.calls.map(([c]) => (c as object).constructor.name)).toEqual([
      'DescribeNatGatewaysCommand',
      'AssociateNatGatewayAddressCommand',
      'DescribeNatGatewaysCommand',
      'DescribeNatGatewaysCommand',
      'DisassociateNatGatewayAddressCommand',
    ]);
  });

  it('does not wait when a kept address is already associated', async () => {
    mockSend.mockImplementation((c: unknown) =>
      Promise.resolve(c instanceof DescribeNatGatewaysCommand ? liveGateway([ADDR_1A, ADDR_1B]) : {})
    );
    await new EC2Provider().update(
      'Nat',
      NAT,
      TYPE,
      { ...base, AvailabilityZoneAddresses: [{ AvailabilityZone: 'us-east-1c', AllocationIds: ['eipalloc-1c'] }, ...ZONE_1A] },
      { ...base, AvailabilityZoneAddresses: ZONES_1A_1B }
    );
    expect(mockSend.mock.calls.map(([c]) => (c as object).constructor.name)).toEqual([
      'DescribeNatGatewaysCommand',
      'AssociateNatGatewayAddressCommand',
      'DisassociateNatGatewayAddressCommand',
    ]);
  });

  it('waits when the only kept address is still associating (an earlier deploy added it)', async () => {
    vi.spyOn(EC2Provider.prototype as unknown as { sleep: () => Promise<void> }, 'sleep').mockResolvedValue();
    let describes = 0;
    mockSend.mockImplementation((c: unknown) => {
      if (!(c instanceof DescribeNatGatewaysCommand)) return Promise.resolve({});
      describes++;
      const added = { ...ADDR_1B, Status: describes < 3 ? 'associating' : 'succeeded' };
      return Promise.resolve(liveGateway([ADDR_1A, added as NatGatewayAddress]));
    });
    await new EC2Provider().update(
      'Nat',
      NAT,
      TYPE,
      { ...base, AvailabilityZoneAddresses: [{ AvailabilityZone: 'us-east-1b', AllocationIds: ['eipalloc-1b'] }] },
      { ...base, AvailabilityZoneAddresses: ZONES_1A_1B }
    );
    expect(mockSend.mock.calls.map(([c]) => (c as object).constructor.name)).toEqual([
      'DescribeNatGatewaysCommand',
      'DescribeNatGatewaysCommand',
      'DescribeNatGatewaysCommand',
      'DisassociateNatGatewayAddressCommand',
    ]);
    expect(sent(DisassociateNatGatewayAddressCommand)[0]!.input.AssociationIds).toEqual(['eipassoc-1a']);
  });

  it('stops at once, releasing nothing, when the added address FAILED to associate', async () => {
    const sleep = vi
      .spyOn(EC2Provider.prototype as unknown as { sleep: () => Promise<void> }, 'sleep')
      .mockResolvedValue();
    let describes = 0;
    mockSend.mockImplementation((c: unknown) => {
      if (!(c instanceof DescribeNatGatewaysCommand)) return Promise.resolve({});
      describes++;
      const added = { ...ADDR_1B, AssociationId: undefined, Status: 'failed' };
      return Promise.resolve(liveGateway(describes === 1 ? [ADDR_1A] : [ADDR_1A, added as NatGatewayAddress]));
    });
    const failedErr = await new EC2Provider()
      .update(
        'Nat',
        NAT,
        TYPE,
        { ...base, AvailabilityZoneAddresses: [{ AvailabilityZone: 'us-east-1b', AllocationIds: ['eipalloc-1b'] }] },
        { ...base, AvailabilityZoneAddresses: ZONE_1A }
      )
      .catch((e: unknown) => e);
    expect((failedErr as Error).message).toMatch(
      /could not associate eipalloc-1b, so its last associated address was not released/
    );
    // A re-run would associate the same address the same way.
    expect(isMarkedNonRetryable(failedErr)).toBe(true);
    expect(sent(DisassociateNatGatewayAddressCommand)).toEqual([]);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('keeps waiting while one added address failed but another is still associating', async () => {
    vi.spyOn(EC2Provider.prototype as unknown as { sleep: () => Promise<void> }, 'sleep').mockResolvedValue();
    const ADDR_1C: NatGatewayAddress = {
      AllocationId: 'eipalloc-1c',
      AvailabilityZone: 'us-east-1c',
      AvailabilityZoneId: 'use1-az4',
    };
    let describes = 0;
    mockSend.mockImplementation((c: unknown) => {
      if (!(c instanceof DescribeNatGatewaysCommand)) return Promise.resolve({});
      describes++;
      if (describes === 1) return Promise.resolve(liveGateway([ADDR_1A]));
      const failed = { ...ADDR_1B, AssociationId: undefined, Status: 'failed' as const };
      const other = {
        ...ADDR_1C,
        Status: describes < 4 ? ('associating' as const) : ('succeeded' as const),
      };
      return Promise.resolve(liveGateway([ADDR_1A, failed, other]));
    });
    await new EC2Provider().update(
      'Nat',
      NAT,
      TYPE,
      {
        ...base,
        AvailabilityZoneAddresses: [
          { AvailabilityZone: 'us-east-1b', AllocationIds: ['eipalloc-1b'] },
          { AvailabilityZone: 'us-east-1c', AllocationIds: ['eipalloc-1c'] },
        ],
      },
      { ...base, AvailabilityZoneAddresses: ZONE_1A }
    );
    expect(describes).toBe(4);
    expect(sent(DisassociateNatGatewayAddressCommand).map((c) => c.input.AssociationIds)).toEqual([
      ['eipassoc-1a'],
    ]);
  });

  it('stops on Ctrl-C during the wait, releasing nothing', async () => {
    disarmInterruptWatchForTests();
    interruptWatchTestSeam.commandOwnsInterrupts = () => true;
    try {
      const baseline = process.listeners('SIGINT');
      vi.spyOn(EC2Provider.prototype as unknown as { sleep: () => Promise<void> }, 'sleep').mockImplementation(
        () => {
          for (const l of process.listeners('SIGINT').filter((x) => !baseline.includes(x))) {
            (l as unknown as () => void)();
          }
          return Promise.resolve();
        }
      );
      mockSend.mockImplementation((c: unknown) =>
        Promise.resolve(c instanceof DescribeNatGatewaysCommand ? liveGateway([ADDR_1A]) : {})
      );
      const err = await new EC2Provider()
        .update(
          'Nat',
          NAT,
          TYPE,
          { ...base, AvailabilityZoneAddresses: [{ AvailabilityZone: 'us-east-1b', AllocationIds: ['eipalloc-1b'] }] },
          { ...base, AvailabilityZoneAddresses: ZONE_1A }
        )
        .catch((e: unknown) => e);
      expect(isInterruptedWaitError(err)).toBe(true);
      expect(sent(DisassociateNatGatewayAddressCommand)).toEqual([]);
    } finally {
      disarmInterruptWatchForTests();
      interruptWatchTestSeam.commandOwnsInterrupts = undefined;
    }
  });

  it('gives up without releasing when the added address never associates', async () => {
    vi.spyOn(EC2Provider.prototype as unknown as { sleep: () => Promise<void> }, 'sleep').mockResolvedValue();
    let describes = 0;
    mockSend.mockImplementation((c: unknown) => {
      if (!(c instanceof DescribeNatGatewaysCommand)) return Promise.resolve({});
      describes++;
      const stuck = { ...ADDR_1B, AssociationId: undefined, Status: 'associating' as const };
      return Promise.resolve(liveGateway(describes === 1 ? [ADDR_1A] : [ADDR_1A, stuck]));
    });
    const timeoutErr = await new EC2Provider()
      .update(
        'Nat',
        NAT,
        TYPE,
        { ...base, AvailabilityZoneAddresses: [{ AvailabilityZone: 'us-east-1b', AllocationIds: ['eipalloc-1b'] }] },
        { ...base, AvailabilityZoneAddresses: ZONE_1A }
      )
      .catch((e: unknown) => e);
    expect((timeoutErr as Error).message).toMatch(
      /ran out of its 15-minute address wait while waiting for an address the template keeps to associate .*; the release was not sent/
    );
    // A retry would sit through the same 15 minutes again.
    expect(isMarkedNonRetryable(timeoutErr)).toBe(true);
    expect(sent(DisassociateNatGatewayAddressCommand)).toEqual([]);
    // 1 plan read + the whole 90-poll budget.
    expect(describes).toBe(91);
  });

  it('shares ONE wait budget across the waits of an update', async () => {
    // The release wait uses 30 polls; the association wait then has only the
    // remaining 60, not a fresh 90.
    vi.spyOn(EC2Provider.prototype as unknown as { sleep: () => Promise<void> }, 'sleep').mockResolvedValue();
    let describes = 0;
    mockSend.mockImplementation((c: unknown) => {
      if (!(c instanceof DescribeNatGatewaysCommand)) return Promise.resolve({});
      describes++;
      if (describes <= 30) {
        return Promise.resolve(liveGateway([ADDR_1A, { ...ADDR_1B, Status: 'disassociating' }]));
      }
      const stuck = { ...ADDR_1B, AssociationId: undefined, Status: 'associating' as const };
      return Promise.resolve(liveGateway([ADDR_1A, stuck]));
    });
    const err = await new EC2Provider()
      .update(
        'Nat',
        NAT,
        TYPE,
        { ...base, AvailabilityZoneAddresses: [{ AvailabilityZone: 'us-east-1b', AllocationIds: ['eipalloc-1b'] }] },
        { ...base, AvailabilityZoneAddresses: ZONE_1A }
      )
      .catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/ran out of its 15-minute address wait/);
    expect(describes).toBe(91);
  });

  it('names what the release-wait timeout left undone: nothing was associated', async () => {
    vi.spyOn(EC2Provider.prototype as unknown as { sleep: () => Promise<void> }, 'sleep').mockResolvedValue();
    mockSend.mockImplementation((c: unknown) =>
      Promise.resolve(
        c instanceof DescribeNatGatewaysCommand
          ? liveGateway([ADDR_1A, { ...ADDR_1B, Status: 'disassociating' }])
          : {}
      )
    );
    const err = await new EC2Provider()
      .update(
        'Nat',
        NAT,
        TYPE,
        { ...base, AvailabilityZoneAddresses: ZONES_1A_1B },
        { ...base, AvailabilityZoneAddresses: ZONE_1A }
      )
      .catch((e: unknown) => e);
    expect((err as Error).message).toMatch(
      /while waiting for the release of eipalloc-1b; nothing was associated or released/
    );
    expect(sent(AssociateNatGatewayAddressCommand)).toEqual([]);
  });

  it('stops after a minute when DescribeNatGateways never lists the address it just associated', async () => {
    vi.spyOn(EC2Provider.prototype as unknown as { sleep: () => Promise<void> }, 'sleep').mockResolvedValue();
    let describes = 0;
    mockSend.mockImplementation((c: unknown) => {
      if (!(c instanceof DescribeNatGatewaysCommand)) return Promise.resolve({});
      describes++;
      return Promise.resolve(liveGateway([ADDR_1A]));
    });
    const err = await new EC2Provider()
      .update(
        'Nat',
        NAT,
        TYPE,
        { ...base, AvailabilityZoneAddresses: [{ AvailabilityZone: 'us-east-1b', AllocationIds: ['eipalloc-1b'] }] },
        { ...base, AvailabilityZoneAddresses: ZONE_1A }
      )
      .catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/does not list eipalloc-1b after associating it/);
    expect(isMarkedNonRetryable(err)).toBe(true);
    expect(describes).toBe(1 + 7);
    expect(sent(DisassociateNatGatewayAddressCommand)).toEqual([]);
  });

  it('names the re-associated address when its association fails again while every other address is being released', async () => {
    // The only kept address failed in an EARLIER deploy; this update adds
    // nothing, so there is no association of its own to wait for.
    vi.spyOn(EC2Provider.prototype as unknown as { sleep: () => Promise<void> }, 'sleep').mockResolvedValue();
    mockSend.mockImplementation((c: unknown) =>
      Promise.resolve(
        c instanceof DescribeNatGatewaysCommand
          ? liveGateway([
              ADDR_1A,
              { ...ADDR_1B, AssociationId: 'eipassoc-1b', Status: 'succeeded' },
              { AllocationId: 'eipalloc-1c', AvailabilityZone: 'us-east-1c', Status: 'failed' },
            ])
          : {}
      )
    );
    // Release both settled addresses, keep only the failed 1c.
    const err = await new EC2Provider()
      .update(
        'Nat',
        NAT,
        TYPE,
        { ...base, AvailabilityZoneAddresses: [{ AvailabilityZone: 'us-east-1c', AllocationIds: ['eipalloc-1c'] }] },
        { ...base, AvailabilityZoneAddresses: ZONES_1A_1B }
      )
      .catch((e: unknown) => e);
    // 1c is not held (failed), so the plan associates it again; the wait then
    // finds it failed and names it.
    expect((err as Error).message).toMatch(/could not associate eipalloc-1c/);
    expect(isMarkedNonRetryable(err)).toBe(true);
    expect(sent(DisassociateNatGatewayAddressCommand)).toEqual([]);
  });

  it('fails with the generic cause when the added address neither associates nor fails', async () => {
    // Listed, but already being released again (someone else's call): it is
    // neither associated, associating nor failed.
    vi.spyOn(EC2Provider.prototype as unknown as { sleep: () => Promise<void> }, 'sleep').mockResolvedValue();
    let describes = 0;
    mockSend.mockImplementation((c: unknown) => {
      if (!(c instanceof DescribeNatGatewaysCommand)) return Promise.resolve({});
      describes++;
      const gone = { ...ADDR_1B, AssociationId: undefined, Status: 'disassociating' as const };
      return Promise.resolve(liveGateway(describes === 1 ? [ADDR_1A] : [ADDR_1A, gone]));
    });
    const err = await new EC2Provider()
      .update(
        'Nat',
        NAT,
        TYPE,
        { ...base, AvailabilityZoneAddresses: [{ AvailabilityZone: 'us-east-1b', AllocationIds: ['eipalloc-1b'] }] },
        { ...base, AvailabilityZoneAddresses: ZONE_1A }
      )
      .catch((e: unknown) => e);
    expect((err as Error).message).toMatch(
      /has no other associated or associating address, so its last associated address was not released/
    );
    expect(isMarkedNonRetryable(err)).toBe(true);
    expect(sent(DisassociateNatGatewayAddressCommand)).toEqual([]);
  });

  it.each([
    ['missing from DescribeNatGateways', undefined, /no longer returned by DescribeNatGateways/],
    ['deleted', 'deleted', /is deleted, so cdkd stopped waiting/],
    ['failed', 'failed', /is failed, so cdkd stopped waiting/],
  ])('stops at once when the gateway is %s during a wait', async (_label, state, message) => {
    const sleep = vi
      .spyOn(EC2Provider.prototype as unknown as { sleep: () => Promise<void> }, 'sleep')
      .mockResolvedValue();
    let describes = 0;
    mockSend.mockImplementation((c: unknown) => {
      if (!(c instanceof DescribeNatGatewaysCommand)) return Promise.resolve({});
      describes++;
      if (describes === 1) return Promise.resolve(liveGateway([ADDR_1A]));
      if (state === undefined) return Promise.resolve({ NatGateways: [] });
      const live = liveGateway([ADDR_1A]);
      (live['NatGateways'] as Record<string, unknown>[])[0]!['State'] = state;
      return Promise.resolve(live);
    });
    const err = await new EC2Provider()
      .update(
        'Nat',
        NAT,
        TYPE,
        { ...base, AvailabilityZoneAddresses: [{ AvailabilityZone: 'us-east-1b', AllocationIds: ['eipalloc-1b'] }] },
        { ...base, AvailabilityZoneAddresses: ZONE_1A }
      )
      .catch((e: unknown) => e);
    expect((err as Error).message).toMatch(message);
    expect(isMarkedNonRetryable(err)).toBe(true);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('sends nothing when the declared zones are only reordered', async () => {
    mockSend.mockImplementation((c: unknown) =>
      Promise.resolve(c instanceof DescribeNatGatewaysCommand ? liveGateway([ADDR_1A, ADDR_1B]) : {})
    );
    await new EC2Provider().update(
      'Nat',
      NAT,
      TYPE,
      { ...base, AvailabilityZoneAddresses: [...ZONES_1A_1B].reverse() },
      { ...base, AvailabilityZoneAddresses: ZONES_1A_1B }
    );
    expect(sent(AssociateNatGatewayAddressCommand)).toEqual([]);
    expect(sent(DisassociateNatGatewayAddressCommand)).toEqual([]);
  });

  it('refuses an allocation id moved to another zone, before any mutating call', async () => {
    mockSend.mockImplementation((c: unknown) =>
      Promise.resolve(c instanceof DescribeNatGatewaysCommand ? liveGateway([ADDR_1A, ADDR_1B]) : {})
    );
    await expect(
      new EC2Provider().update(
        'Nat',
        NAT,
        TYPE,
        {
          ...base,
          AvailabilityZoneAddresses: [
            { AvailabilityZone: 'us-east-1a', AllocationIds: ['eipalloc-1a', 'eipalloc-1b'] },
          ],
        },
        { ...base, AvailabilityZoneAddresses: ZONES_1A_1B }
      )
    ).rejects.toSatisfy(
      (e: unknown) =>
        /eipalloc-1b in a different zone/.test((e as Error).message) && isMarkedNonRetryable(e)
    );
    expect(sent(AssociateNatGatewayAddressCommand)).toEqual([]);
    expect(sent(DisassociateNatGatewayAddressCommand)).toEqual([]);
  });

  it('waits for an address still being associated, then releases it (a rollback right after the add)', async () => {
    // CloudFormation's own update waits for the association, so its rollback
    // can release the address at once; cdkd's returns earlier, so the revert
    // must wait for the association id before it can release.
    const sleep = vi
      .spyOn(EC2Provider.prototype as unknown as { sleep: () => Promise<void> }, 'sleep')
      .mockResolvedValue();
    let describes = 0;
    mockSend.mockImplementation((c: unknown) => {
      if (!(c instanceof DescribeNatGatewaysCommand)) return Promise.resolve({});
      describes++;
      const added =
        describes < 3
          ? { ...ADDR_1B, AssociationId: undefined, Status: 'associating' as const }
          : ADDR_1B;
      return Promise.resolve(liveGateway([ADDR_1A, added]));
    });
    await new EC2Provider().update(
      'Nat',
      NAT,
      TYPE,
      { ...base, AvailabilityZoneAddresses: ZONE_1A },
      { ...base, AvailabilityZoneAddresses: ZONES_1A_1B }
    );
    expect(mockSend.mock.calls.map(([c]) => (c as object).constructor.name)).toEqual([
      'DescribeNatGatewaysCommand',
      'DescribeNatGatewaysCommand',
      'DescribeNatGatewaysCommand',
      'DisassociateNatGatewayAddressCommand',
    ]);
    expect(sent(DisassociateNatGatewayAddressCommand)[0]!.input.AssociationIds).toEqual(['eipassoc-1b']);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('releases nothing for an address whose association failed while it waited', async () => {
    vi.spyOn(EC2Provider.prototype as unknown as { sleep: () => Promise<void> }, 'sleep').mockResolvedValue();
    let describes = 0;
    mockSend.mockImplementation((c: unknown) => {
      if (!(c instanceof DescribeNatGatewaysCommand)) return Promise.resolve({});
      describes++;
      const added = {
        ...ADDR_1B,
        AssociationId: undefined,
        Status: describes < 2 ? ('associating' as const) : ('failed' as const),
      };
      return Promise.resolve(liveGateway([ADDR_1A, added]));
    });
    await new EC2Provider().update(
      'Nat',
      NAT,
      TYPE,
      { ...base, AvailabilityZoneAddresses: ZONE_1A },
      { ...base, AvailabilityZoneAddresses: ZONES_1A_1B }
    );
    expect(sent(DisassociateNatGatewayAddressCommand)).toEqual([]);
  });

  it('waits for an address AWS is still releasing before associating it again', async () => {
    vi.spyOn(EC2Provider.prototype as unknown as { sleep: () => Promise<void> }, 'sleep').mockResolvedValue();
    let describes = 0;
    mockSend.mockImplementation((c: unknown) => {
      if (!(c instanceof DescribeNatGatewaysCommand)) return Promise.resolve({});
      describes++;
      return Promise.resolve(
        liveGateway(describes < 3 ? [ADDR_1A, { ...ADDR_1B, Status: 'disassociating' }] : [ADDR_1A])
      );
    });
    await new EC2Provider().update(
      'Nat',
      NAT,
      TYPE,
      { ...base, AvailabilityZoneAddresses: ZONES_1A_1B },
      { ...base, AvailabilityZoneAddresses: ZONE_1A }
    );
    expect(mockSend.mock.calls.map(([c]) => (c as object).constructor.name)).toEqual([
      'DescribeNatGatewaysCommand',
      'DescribeNatGatewaysCommand',
      'DescribeNatGatewaysCommand',
      'AssociateNatGatewayAddressCommand',
    ]);
  });

  it('ignores an older failed address and waits until its own association shows up', async () => {
    // Eventual consistency: the address this update associated is not in the
    // first read; an unrelated failed address must not end the wait.
    vi.spyOn(EC2Provider.prototype as unknown as { sleep: () => Promise<void> }, 'sleep').mockResolvedValue();
    const STALE: NatGatewayAddress = {
      AllocationId: 'eipalloc-old',
      AvailabilityZone: 'us-east-1c',
      Status: 'failed',
    };
    let describes = 0;
    mockSend.mockImplementation((c: unknown) => {
      if (!(c instanceof DescribeNatGatewaysCommand)) return Promise.resolve({});
      describes++;
      if (describes === 1) return Promise.resolve(liveGateway([ADDR_1A, STALE]));
      if (describes === 2) return Promise.resolve(liveGateway([ADDR_1A, STALE]));
      return Promise.resolve(liveGateway([ADDR_1A, STALE, ADDR_1B]));
    });
    await new EC2Provider().update(
      'Nat',
      NAT,
      TYPE,
      { ...base, AvailabilityZoneAddresses: [{ AvailabilityZone: 'us-east-1b', AllocationIds: ['eipalloc-1b'] }] },
      { ...base, AvailabilityZoneAddresses: ZONE_1A }
    );
    expect(sent(DisassociateNatGatewayAddressCommand).map((c) => c.input.AssociationIds)).toEqual([
      ['eipassoc-1a'],
    ]);
  });

  it('stops at once, non-retryably, when the gateway is deleting during a wait', async () => {
    const sleep = vi
      .spyOn(EC2Provider.prototype as unknown as { sleep: () => Promise<void> }, 'sleep')
      .mockResolvedValue();
    let describes = 0;
    mockSend.mockImplementation((c: unknown) => {
      if (!(c instanceof DescribeNatGatewaysCommand)) return Promise.resolve({});
      describes++;
      const live = liveGateway([ADDR_1A]);
      if (describes > 1) (live['NatGateways'] as Record<string, unknown>[])[0]!['State'] = 'deleting';
      return Promise.resolve(live);
    });
    const err = await new EC2Provider()
      .update(
        'Nat',
        NAT,
        TYPE,
        { ...base, AvailabilityZoneAddresses: [{ AvailabilityZone: 'us-east-1b', AllocationIds: ['eipalloc-1b'] }] },
        { ...base, AvailabilityZoneAddresses: ZONE_1A }
      )
      .catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/is deleting, so cdkd stopped waiting/);
    expect(isMarkedNonRetryable(err)).toBe(true);
    expect(sleep).not.toHaveBeenCalled();
    expect(sent(DisassociateNatGatewayAddressCommand)).toEqual([]);
  });

  it('refuses when DescribeNatGateways does not return the gateway', async () => {
    mockSend.mockResolvedValue({ NatGateways: [] });
    await expect(
      new EC2Provider().update(
        'Nat',
        NAT,
        TYPE,
        { ...base, AvailabilityZoneAddresses: ZONES_1A_1B },
        { ...base, AvailabilityZoneAddresses: ZONE_1A }
      )
    ).rejects.toThrow(/was not returned by DescribeNatGateways/);
    expect(sent(AssociateNatGatewayAddressCommand)).toEqual([]);
  });

  it('applies the address change before the tags', async () => {
    mockSend.mockImplementation((c: unknown) =>
      Promise.resolve(c instanceof DescribeNatGatewaysCommand ? liveGateway([ADDR_1A]) : {})
    );
    await new EC2Provider().update(
      'Nat',
      NAT,
      TYPE,
      { ...base, AvailabilityZoneAddresses: ZONES_1A_1B, Tags: [{ Key: 'Name', Value: 'x' }] },
      { ...base, AvailabilityZoneAddresses: ZONE_1A }
    );
    const order = mockSend.mock.calls
      .map(([c]) => (c as object).constructor.name)
      .filter((n) => n !== 'DescribeNatGatewaysCommand');
    expect(order).toEqual(['AssociateNatGatewayAddressCommand', 'CreateTagsCommand']);
  });

  it('refuses an unreadable desired AvailabilityZoneAddresses before any call', async () => {
    await expect(
      new EC2Provider().update(
        'Nat',
        NAT,
        TYPE,
        { ...base, AvailabilityZoneAddresses: 'us-east-1a' },
        { ...base, AvailabilityZoneAddresses: ZONE_1A }
      )
    ).rejects.toSatisfy(
      (e: unknown) =>
        /AvailabilityZoneAddresses of NatGateway Nat is not a list/.test((e as Error).message) &&
        isMarkedNonRetryable(e)
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('refuses dropping AvailabilityZoneAddresses before any call, as CloudFormation fails it', async () => {
    await expect(
      new EC2Provider().update(
        'Nat',
        NAT,
        TYPE,
        { ...base, Tags: [{ Key: 'Name', Value: 'two' }] },
        { ...base, AvailabilityZoneAddresses: ZONE_1A }
      )
    ).rejects.toSatisfy(
      (e: unknown) =>
        /cannot drop AvailabilityZoneAddresses/.test((e as Error).message) && isMarkedNonRetryable(e)
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('refuses adding AvailabilityZoneAddresses to an automatic-mode gateway (a replacement)', async () => {
    await expect(
      new EC2Provider().update('Nat', NAT, TYPE, { ...base, AvailabilityZoneAddresses: ZONE_1A }, base)
    ).rejects.toThrow(ResourceUpdateNotSupportedError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('applies a Tags change in place instead of refusing the update', async () => {
    mockSend.mockResolvedValue({});
    await new EC2Provider().update(
      'Nat',
      NAT,
      TYPE,
      { SubnetId: 'subnet-1', Tags: [{ Key: 'Name', Value: 'two' }] },
      { SubnetId: 'subnet-1', Tags: [{ Key: 'Name', Value: 'one' }, { Key: 'Gone', Value: 'x' }] }
    );
    expect(sent(CreateTagsCommand).map((c) => c.input)).toEqual([
      { Resources: [NAT], Tags: [{ Key: 'Name', Value: 'two' }] },
    ]);
    expect(sent(DeleteTagsCommand).map((c) => c.input)).toEqual([
      { Resources: [NAT], Tags: [{ Key: 'Gone' }] },
    ]);
    expect(sent(DescribeNatGatewaysCommand)).toEqual([]);
  });

  it.each([
    ['SubnetId', { SubnetId: 'subnet-2' }],
    ['VpcId', { VpcId: 'vpc-2' }],
    ['AvailabilityMode', { AvailabilityMode: 'zonal' }],
    ['ConnectivityType', { ConnectivityType: 'private' }],
    ['AllocationId', { AllocationId: 'eipalloc-9' }],
    ['PrivateIpAddress', { PrivateIpAddress: '10.0.0.9' }],
    ['SecondaryAllocationIds', { SecondaryAllocationIds: ['eipalloc-9'] }],
    ['SecondaryPrivateIpAddresses', { SecondaryPrivateIpAddresses: ['10.0.0.8'] }],
    ['SecondaryPrivateIpAddressCount', { SecondaryPrivateIpAddressCount: 3 }],
    // A removal of a secondary list is a change too.
    ['SecondaryAllocationIds', { SecondaryAllocationIds: undefined }],
  ])('still refuses a %s change, before any call', async (key, change) => {
    const previous = {
      SubnetId: 'subnet-1',
      VpcId: 'vpc-1',
      AvailabilityMode: 'regional',
      ConnectivityType: 'public',
      AllocationId: 'eipalloc-1',
      PrivateIpAddress: '10.0.0.1',
      SecondaryAllocationIds: ['eipalloc-2'],
      SecondaryPrivateIpAddresses: ['10.0.0.2'],
      SecondaryPrivateIpAddressCount: 1,
    };
    await expect(
      new EC2Provider().update('Nat', NAT, TYPE, { ...previous, ...change }, previous)
    ).rejects.toThrow(ResourceUpdateNotSupportedError);
    await expect(
      new EC2Provider().update('Nat', NAT, TYPE, { ...previous, ...change }, previous)
    ).rejects.toThrow(new RegExp(`cannot change ${key}`));
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('does not read a create-only key the record never declared as a change', async () => {
    // A drift --revert bag carries readback keys (AvailabilityMode, VpcId)
    // that a zonal record written before #2762 does not hold.
    mockSend.mockResolvedValue({});
    await expect(
      new EC2Provider().update(
        'Nat',
        NAT,
        TYPE,
        { SubnetId: 'subnet-1', AvailabilityMode: 'zonal', VpcId: 'vpc-1' },
        { SubnetId: 'subnet-1' }
      )
    ).resolves.toMatchObject({ wasReplaced: false });
  });
});

describe('readCurrentState', () => {
  it('reports a manual-mode regional gateway in the recorded zone spelling', async () => {
    mockSend.mockResolvedValue(liveGateway([ADDR_1A, ADDR_1B]));
    const read = await new EC2Provider().readCurrentState(NAT, 'Nat', TYPE, {
      AvailabilityMode: 'regional',
      VpcId: 'vpc-1',
      AvailabilityZoneAddresses: [
        { AvailabilityZoneId: 'use1-az2', AllocationIds: ['eipalloc-1b'] },
        { AvailabilityZone: 'us-east-1a', AllocationIds: ['eipalloc-1a'] },
      ],
    });
    expect(read).toMatchObject({
      AvailabilityMode: 'regional',
      VpcId: 'vpc-1',
      AvailabilityZoneAddresses: [
        { AvailabilityZoneId: 'use1-az2', AllocationIds: ['eipalloc-1b'] },
        { AvailabilityZone: 'us-east-1a', AllocationIds: ['eipalloc-1a'] },
      ],
    });
  });

  it('reports no AvailabilityZoneAddresses for an automatic-mode gateway', async () => {
    const live = liveGateway([ADDR_1A]);
    (live['NatGateways'] as Record<string, unknown>[])[0]!['AutoProvisionZones'] = 'enabled';
    mockSend.mockResolvedValue(live);
    const read = (await new EC2Provider().readCurrentState(NAT, 'Nat', TYPE, {
      AvailabilityMode: 'regional',
      VpcId: 'vpc-1',
    })) as Record<string, unknown>;
    expect(read['AvailabilityMode']).toBe('regional');
    expect(read).not.toHaveProperty('AvailabilityZoneAddresses');
  });
});

describe('pure helpers', () => {
  it('readNatZoneAddresses tells absent from unusable', () => {
    expect(readNatZoneAddresses(undefined)).toEqual({ kind: 'absent' });
    expect(readNatZoneAddresses(null)).toEqual({ kind: 'absent' });
    expect(readNatZoneAddresses({}).kind).toBe('unusable');
    expect(readNatZoneAddresses([{ AvailabilityZone: 1, AllocationIds: ['a'] }]).kind).toBe(
      'unusable'
    );
    expect(readNatZoneAddresses([{ AvailabilityZone: 'z', AllocationIds: ['a', 2] }]).kind).toBe(
      'unusable'
    );
  });

  it('readNatZoneAddresses refuses an allocation id declared twice, within or across entries', () => {
    expect(readNatZoneAddresses([{ AvailabilityZone: 'z', AllocationIds: ['a', 'a'] }])).toEqual({
      kind: 'unusable',
      reason: 'declares allocation id a more than once',
    });
    expect(
      readNatZoneAddresses([
        { AvailabilityZone: 'z', AllocationIds: ['a'] },
        { AvailabilityZone: 'y', AllocationIds: ['a'] },
      ]).kind
    ).toBe('unusable');
  });

  it('planNatZoneAddressUpdate ignores an address whose association failed', () => {
    const plan = planNatZoneAddressUpdate(
      [{ availabilityZone: 'us-east-1b', allocationIds: ['eipalloc-1b'] }],
      [ADDR_1A, { ...ADDR_1B, Status: 'failed' }]
    );
    expect(plan.associate).toEqual([
      { availabilityZone: 'us-east-1b', allocationIds: ['eipalloc-1b'] },
    ]);
    expect(plan.moved).toEqual([]);
  });

  it('readbackNatZoneAddresses spells an unrecorded zone by its id when AWS gives only that, and drops a zone-less address', () => {
    expect(
      readbackNatZoneAddresses(
        [
          { AllocationId: 'eipalloc-9', AvailabilityZoneId: 'use1-az4', Status: 'succeeded' },
          { AllocationId: 'eipalloc-8', Status: 'succeeded' },
        ],
        []
      )
    ).toEqual([{ AvailabilityZoneId: 'use1-az4', AllocationIds: ['eipalloc-9'] }]);
  });

  it('planNatZoneAddressUpdate ignores an address already being released', () => {
    const plan = planNatZoneAddressUpdate(
      [{ availabilityZone: 'us-east-1b', allocationIds: ['eipalloc-1b'] }],
      [ADDR_1A, { ...ADDR_1B, Status: 'disassociating' }]
    );
    expect(plan.associate).toEqual([
      { availabilityZone: 'us-east-1b', allocationIds: ['eipalloc-1b'] },
    ]);
    expect(plan.disassociate).toEqual([{ allocationId: 'eipalloc-1a', associationId: 'eipassoc-1a' }]);
  });

  it('planNatZoneAddressUpdate matches a zone by its id', () => {
    const plan = planNatZoneAddressUpdate(
      [{ availabilityZoneId: 'use1-az1', allocationIds: ['eipalloc-1a'] }],
      [ADDR_1A]
    );
    expect(plan).toEqual({
      associate: [],
      disassociate: [],
      moved: [],
      awaitingRelease: [],
      keptSettled: true,
    });
  });

  it('readbackNatZoneAddresses appends unrecorded zones and drops an emptied recorded zone', () => {
    expect(
      readbackNatZoneAddresses(
        [ADDR_1B],
        [{ availabilityZone: 'us-east-1a', allocationIds: ['eipalloc-1a'] }]
      )
    ).toEqual([{ AvailabilityZone: 'us-east-1b', AllocationIds: ['eipalloc-1b'] }]);
  });
});

describe('Fn::GetAtt attributes', () => {
  it('records RouteTableId and the flags from the available-state wait, at no extra call', async () => {
    delete process.env['CDKD_NO_WAIT'];
    const live = liveGateway([ADDR_1A]);
    (live['NatGateways'] as Record<string, unknown>[])[0]!['RouteTableId'] = 'rtb-nat';
    mockSend.mockImplementation((c: unknown) =>
      Promise.resolve(c instanceof DescribeNatGatewaysCommand ? live : { NatGateway: { NatGatewayId: NAT } })
    );
    const result = await new EC2Provider().create('Nat', TYPE, {
      AvailabilityMode: 'regional',
      VpcId: 'vpc-1',
      AvailabilityZoneAddresses: ZONE_1A,
    });
    expect(result.attributes).toEqual({
      NatGatewayId: NAT,
      RouteTableId: 'rtb-nat',
      AutoProvisionZones: 'disabled',
      AutoScalingIps: 'disabled',
    });
    expect(sent(DescribeNatGatewaysCommand)).toHaveLength(1);
  });

  it('records what the create answer carries under --no-wait, at no extra call', async () => {
    // Measured: CreateNatGateway answers with both automatic-mode flags, while
    // RouteTableId is still null until the gateway is available.
    mockSend.mockResolvedValue({
      NatGateway: {
        NatGatewayId: NAT,
        AvailabilityMode: 'regional',
        AutoProvisionZones: 'enabled',
        AutoScalingIps: 'enabled',
      },
    });
    const result = await new EC2Provider().create('Nat', TYPE, {
      AvailabilityMode: 'regional',
      VpcId: 'vpc-1',
    });
    expect(result.attributes).toEqual({
      NatGatewayId: NAT,
      AutoProvisionZones: 'enabled',
      AutoScalingIps: 'enabled',
    });
    expect(sent(DescribeNatGatewaysCommand)).toEqual([]);
  });

  it("answers a zonal gateway's EniId, never a regional one's", () => {
    const zonal = {
      NatGatewayId: NAT,
      AvailabilityMode: 'zonal' as const,
      NatGatewayAddresses: [{ ...ADDR_1A, NetworkInterfaceId: 'eni-1', IsPrimary: true }],
    };
    expect(natGatewayAttributes(zonal)).toEqual({ NatGatewayId: NAT, EniId: 'eni-1' });
    expect(natGatewayAttributes({ ...zonal, AvailabilityMode: 'regional' })).toEqual({
      NatGatewayId: NAT,
    });
    // No address flagged primary: the first one stands in.
    expect(
      natGatewayAttributes({
        ...zonal,
        NatGatewayAddresses: [
          { ...ADDR_1A, NetworkInterfaceId: 'eni-first' },
          { ...ADDR_1B, NetworkInterfaceId: 'eni-second' },
        ],
      })
    ).toEqual({ NatGatewayId: NAT, EniId: 'eni-first' });
  });

  it('import() records the same attributes', async () => {
    const live = liveGateway([ADDR_1A]);
    (live['NatGateways'] as Record<string, unknown>[])[0]!['RouteTableId'] = 'rtb-nat';
    mockSend.mockResolvedValue(live);
    const imported = await new EC2Provider().import({
      logicalId: 'Nat',
      resourceType: TYPE,
      stackName: 'S',
      region: 'us-east-1',
      properties: {},
      knownPhysicalId: NAT,
    });
    expect(imported?.attributes).toMatchObject({ RouteTableId: 'rtb-nat' });
  });
});

describe('getAttribute', () => {
  it('reads RouteTableId and the automatic-mode flags off DescribeNatGateways', async () => {
    const live = liveGateway([ADDR_1A]);
    (live['NatGateways'] as Record<string, unknown>[])[0]!['RouteTableId'] = 'rtb-nat';
    mockSend.mockResolvedValue(live);
    const provider = new EC2Provider();
    expect(await provider.getAttribute(NAT, TYPE, 'RouteTableId')).toBe('rtb-nat');
    expect(await provider.getAttribute(NAT, TYPE, 'AutoProvisionZones')).toBe('disabled');
    expect(await provider.getAttribute(NAT, TYPE, 'AutoScalingIps')).toBe('disabled');
    expect(await provider.getAttribute(NAT, TYPE, 'NatGatewayId')).toBe(NAT);
    expect(await provider.getAttribute(NAT, TYPE, 'EniId')).toBeUndefined();
  });
});

describe('review round 3 (#5337)', () => {
  it('getAttribute answers nothing for a gateway DescribeNatGateways no longer returns', async () => {
    mockSend.mockResolvedValue({ NatGateways: [] });
    expect(await new EC2Provider().getAttribute(NAT, TYPE, 'RouteTableId')).toBeUndefined();
  });

  it('readbackNatZoneAddresses drops addresses being released or whose association failed', () => {
    expect(
      readbackNatZoneAddresses(
        [
          ADDR_1A,
          { ...ADDR_1B, Status: 'disassociating' },
          { AllocationId: 'eipalloc-1c', AvailabilityZone: 'us-east-1c', Status: 'failed' },
        ],
        [{ availabilityZone: 'us-east-1a', allocationIds: ['eipalloc-1a'] }]
      )
    ).toEqual([{ AvailabilityZone: 'us-east-1a', AllocationIds: ['eipalloc-1a'] }]);
  });

  it("readCurrentState reads a zonal gateway's AllocationId off its PRIMARY address", async () => {
    mockSend.mockResolvedValue({
      NatGateways: [
        {
          NatGatewayId: NAT,
          State: 'available',
          SubnetId: 'subnet-1',
          AvailabilityMode: 'zonal',
          ConnectivityType: 'public',
          NatGatewayAddresses: [
            { AllocationId: 'eipalloc-secondary', PrivateIp: '10.0.0.9', IsPrimary: false },
            { AllocationId: 'eipalloc-primary', PrivateIp: '10.0.0.5', IsPrimary: true },
          ],
        },
      ],
    });
    const read = (await new EC2Provider().readCurrentState(NAT, 'Nat', TYPE, {
      SubnetId: 'subnet-1',
    })) as Record<string, unknown>;
    expect(read['AllocationId']).toBe('eipalloc-primary');
    expect(read['PrivateIpAddress']).toBe('10.0.0.5');
  });
});

describe('review round 4 (#5337)', () => {
  it('readbackNatZoneAddresses keeps the recorded order of several ids in one zone, appending new ones', () => {
    const a1 = { ...ADDR_1A, AllocationId: 'eipalloc-x' };
    const a2 = { ...ADDR_1A, AllocationId: 'eipalloc-y' };
    const a3 = { ...ADDR_1A, AllocationId: 'eipalloc-z' };
    expect(
      readbackNatZoneAddresses(
        [a3, a1, a2],
        [{ availabilityZone: 'us-east-1a', allocationIds: ['eipalloc-y', 'eipalloc-x'] }]
      )
    ).toEqual([
      { AvailabilityZone: 'us-east-1a', AllocationIds: ['eipalloc-y', 'eipalloc-x', 'eipalloc-z'] },
    ]);
  });

  it('readCurrentState reports no undeclared AllocationId / PrivateIpAddress for a regional gateway', async () => {
    const live = liveGateway([{ ...ADDR_1A, PrivateIp: '10.0.0.5', IsPrimary: true }]);
    mockSend.mockResolvedValue(live);
    const read = (await new EC2Provider().readCurrentState(NAT, 'Nat', TYPE, {
      AvailabilityMode: 'regional',
      VpcId: 'vpc-1',
      AvailabilityZoneAddresses: ZONE_1A,
    })) as Record<string, unknown>;
    expect(read).not.toHaveProperty('AllocationId');
    expect(read).not.toHaveProperty('PrivateIpAddress');
  });

  it('readCurrentState reports a DECLARED AllocationId for a regional gateway (CDK automatic mode with an EIP)', async () => {
    const live = liveGateway([{ ...ADDR_1A, IsPrimary: true }]);
    (live['NatGateways'] as Record<string, unknown>[])[0]!['AutoProvisionZones'] = 'enabled';
    mockSend.mockResolvedValue(live);
    const read = (await new EC2Provider().readCurrentState(NAT, 'Nat', TYPE, {
      AvailabilityMode: 'regional',
      VpcId: 'vpc-1',
      AllocationId: 'eipalloc-1a',
    })) as Record<string, unknown>;
    expect(read['AllocationId']).toBe('eipalloc-1a');
    expect(read).not.toHaveProperty('PrivateIpAddress');
  });
});
