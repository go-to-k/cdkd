import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#5394: `Targets[].QuicServerId` was dropped by `toTargetDescriptions`
// and absent from the update diff key, so it never reached RegisterTargets /
// DeregisterTargets and a change to it alone was never sent.

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-elastic-load-balancing-v2', async () => {
  const actual = await vi.importActual('@aws-sdk/client-elastic-load-balancing-v2');
  return {
    ...actual,
    ElasticLoadBalancingV2Client: vi.fn().mockImplementation(() => ({
      send: (command: { constructor: { name: string }; input?: { Names?: unknown } }) =>
        // The by-name lookup before a create (go-to-k/cdkd#4403): the name is free.
        command.input?.Names !== undefined
          ? Promise.reject(
              Object.assign(new Error('One or more resources not found'), {
                name:
                  command.constructor.name === 'DescribeTargetGroupsCommand'
                    ? 'TargetGroupNotFoundException'
                    : 'LoadBalancerNotFoundException',
              })
            )
          : mockSend(command),
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

const warned: string[] = [];

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn((message: string) => {
      warned.push(message);
    }),
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

import { ELBv2Provider } from '../../../src/provisioning/providers/elbv2-provider.js';

const TG_TYPE = 'AWS::ElasticLoadBalancingV2::TargetGroup';
const TG_ARN =
  'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/issue5394/1234567890abcdef';
const QUIC_A = '0x0123456789abcdef';
const QUIC_B = '0xfedcba9876543210';

function sent(name: string): Array<Record<string, unknown>> {
  return mockSend.mock.calls
    .filter((c) => c[0].constructor.name === name)
    .map((c) => c[0].input as Record<string, unknown>);
}

let provider: ELBv2Provider;

beforeEach(() => {
  vi.clearAllMocks();
  warned.length = 0;
  provider = new ELBv2Provider();
  mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
    switch (cmd.constructor.name) {
      case 'CreateTargetGroupCommand':
        return Promise.resolve({
          TargetGroups: [{ TargetGroupArn: TG_ARN, TargetGroupName: 'issue5394' }],
        });
      case 'DescribeTargetGroupsCommand':
        return Promise.resolve({ TargetGroups: [{ TargetGroupArn: TG_ARN }] });
      default:
        return Promise.resolve({});
    }
  });
});

describe('TargetGroup Targets[].QuicServerId (#5394)', () => {
  it('create sends QuicServerId to RegisterTargets; an entry without one stays without', async () => {
    await provider.create('Tg', TG_TYPE, {
      Name: 'issue5394',
      Port: 443,
      Protocol: 'QUIC',
      Targets: [{ Id: 'i-1', QuicServerId: QUIC_A }, { Id: 'i-2' }],
    });
    expect(sent('RegisterTargetsCommand')[0]!['Targets']).toEqual([
      { Id: 'i-1', QuicServerId: QUIC_A },
      { Id: 'i-2' },
    ]);
  });

  it('update registers a newly added QUIC target with its QuicServerId', async () => {
    await provider.update(
      'Tg',
      TG_ARN,
      TG_TYPE,
      { Port: 443, Targets: [{ Id: 'i-1', QuicServerId: QUIC_A }] },
      { Port: 443, Targets: [] }
    );
    expect(sent('RegisterTargetsCommand')[0]!['Targets']).toEqual([
      { Id: 'i-1', Port: 443, QuicServerId: QUIC_A },
    ]);
    expect(sent('DeregisterTargetsCommand')).toEqual([]);
  });

  it('update deregisters a removed QUIC target with its QuicServerId', async () => {
    await provider.update(
      'Tg',
      TG_ARN,
      TG_TYPE,
      { Port: 443, Targets: [] },
      { Port: 443, Targets: [{ Id: 'i-1', QuicServerId: QUIC_A }] }
    );
    expect(sent('DeregisterTargetsCommand')[0]!['Targets']).toEqual([
      { Id: 'i-1', Port: 443, QuicServerId: QUIC_A },
    ]);
    expect(sent('RegisterTargetsCommand')).toEqual([]);
  });

  it('a change to QuicServerId alone is sent as a register of the new and a deregister of the old', async () => {
    await provider.update(
      'Tg',
      TG_ARN,
      TG_TYPE,
      { Port: 443, Targets: [{ Id: 'i-1', QuicServerId: QUIC_B }] },
      { Port: 443, Targets: [{ Id: 'i-1', QuicServerId: QUIC_A }] }
    );
    expect(sent('RegisterTargetsCommand')[0]!['Targets']).toEqual([
      { Id: 'i-1', Port: 443, QuicServerId: QUIC_B },
    ]);
    expect(sent('DeregisterTargetsCommand')[0]!['Targets']).toEqual([
      { Id: 'i-1', Port: 443, QuicServerId: QUIC_A },
    ]);
  });

  it.each([
    ['A to B', QUIC_A, QUIC_B],
    ['absent to A', undefined, QUIC_A],
  ])('a QuicServerId-only change (%s) deregisters BEFORE it registers', async (_l, from, to) => {
    const entry = (q?: string) => ({ Id: 'i-1', ...(q !== undefined && { QuicServerId: q }) });
    await provider.update(
      'Tg',
      TG_ARN,
      TG_TYPE,
      { Port: 443, Targets: [entry(to)] },
      { Port: 443, Targets: [entry(from)] }
    );
    const order = mockSend.mock.calls
      .map((c) => c[0].constructor.name as string)
      .filter((n) => n === 'RegisterTargetsCommand' || n === 'DeregisterTargetsCommand');
    expect(order).toEqual(['DeregisterTargetsCommand', 'RegisterTargetsCommand']);
  });

  it('a removed target still deregisters AFTER the register of a new one', async () => {
    await provider.update(
      'Tg',
      TG_ARN,
      TG_TYPE,
      { Port: 443, Targets: [{ Id: 'i-2', QuicServerId: QUIC_B }] },
      { Port: 443, Targets: [{ Id: 'i-1', QuicServerId: QUIC_A }] }
    );
    const order = mockSend.mock.calls
      .map((c) => c[0].constructor.name as string)
      .filter((n) => n === 'RegisterTargetsCommand' || n === 'DeregisterTargetsCommand');
    expect(order).toEqual(['RegisterTargetsCommand', 'DeregisterTargetsCommand']);
  });

  it('refuses a desired QuicServerId holding a dynamic reference before any call', async () => {
    await expect(
      provider.update(
        'Tg',
        TG_ARN,
        TG_TYPE,
        { Port: 443, Targets: [{ Id: 'i-1', QuicServerId: '{{resolve:secretsmanager:x:SecretString:q::}}' }] },
        { Port: 443, Targets: [] }
      )
    ).rejects.toThrow(/an Id or QuicServerId holds a dynamic reference/);
    expect(sent('RegisterTargetsCommand')).toEqual([]);
  });

  it('never deregisters a recorded QuicServerId that holds a dynamic reference', async () => {
    await provider.update(
      'Tg',
      TG_ARN,
      TG_TYPE,
      { Port: 443, Targets: [] },
      { Port: 443, Targets: [{ Id: 'i-1', QuicServerId: '{{resolve:secretsmanager:x:SecretString:q::}}' }] }
    );
    expect(sent('DeregisterTargetsCommand')).toEqual([]);
  });

  it('refuses a desired QuicServerId in its masked spelling, naming the cause (create and update)', async () => {
    const targets = [{ Id: 'i-1', QuicServerId: '***' }];
    const createErr = await provider
      .create('Tg', TG_TYPE, { Name: 'issue5394', Port: 443, Targets: targets })
      .then(
        () => new Error('expected a rejection'),
        (e: Error) => e
      );
    expect(createErr.message).toContain('an Id or QuicServerId holds a dynamic reference or its mask');
    const updateErr = await provider
      .update('Tg', TG_ARN, TG_TYPE, { Port: 443, Targets: targets }, { Port: 443, Targets: [] })
      .then(
        () => new Error('expected a rejection'),
        (e: Error) => e
      );
    expect(updateErr.message).toContain('an Id or QuicServerId holds a dynamic reference or its mask');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('never deregisters a recorded QuicServerId in its masked spelling', async () => {
    await provider.update(
      'Tg',
      TG_ARN,
      TG_TYPE,
      { Port: 443, Targets: [] },
      { Port: 443, Targets: [{ Id: 'i-1', QuicServerId: '***' }] }
    );
    expect(sent('DeregisterTargetsCommand')).toEqual([]);
  });

  it('an unchanged QUIC target sends nothing', async () => {
    await provider.update(
      'Tg',
      TG_ARN,
      TG_TYPE,
      { Port: 443, Targets: [{ Id: 'i-1', QuicServerId: QUIC_A }] },
      { Port: 443, Targets: [{ Id: 'i-1', QuicServerId: QUIC_A }] }
    );
    expect(sent('RegisterTargetsCommand')).toEqual([]);
    expect(sent('DeregisterTargetsCommand')).toEqual([]);
  });

  it.each([[''], [7]])('refuses a malformed QuicServerId %j before any call', async (value) => {
    await expect(
      provider.create('Tg', TG_TYPE, {
        Name: 'issue5394',
        Port: 443,
        Targets: [{ Id: 'i-1', QuicServerId: value }],
      })
    ).rejects.toThrow(/not a list of targets/);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

/** Every Register / Deregister call in order, as `<verb> <Id>/<QuicServerId>,...`. */
function targetCalls(): string[] {
  return mockSend.mock.calls
    .map((c) => c[0] as { constructor: { name: string }; input: Record<string, unknown> })
    .filter(
      (c) =>
        c.constructor.name === 'RegisterTargetsCommand' ||
        c.constructor.name === 'DeregisterTargetsCommand'
    )
    .map((c) => {
      const verb = c.constructor.name === 'RegisterTargetsCommand' ? 'register' : 'deregister';
      const targets = c.input['Targets'] as Array<{ Id: string; QuicServerId?: string }>;
      return `${verb} ${targets.map((t) => `${t.Id}/${t.QuicServerId ?? '-'}`).join(',')}`;
    });
}

/** Make the nth (1-based) RegisterTargets call fail; the others succeed. */
function failRegisterCalls(failing: number[]): void {
  const base = mockSend.getMockImplementation()!;
  let n = 0;
  mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
    if (cmd.constructor.name === 'RegisterTargetsCommand' && failing.includes(++n)) {
      return Promise.reject(new Error('refused by the service'));
    }
    return base(cmd);
  });
}

describe('TargetGroup QuicServerId — ordering and failure handling (#5394)', () => {
  it('a change to an ABSENT server id registers first, so the service refusal leaves the live target registered', async () => {
    failRegisterCalls([1]);
    await expect(
      provider.update(
        'Tg',
        TG_ARN,
        TG_TYPE,
        { Port: 443, Targets: [{ Id: 'i-1' }] },
        { Port: 443, Targets: [{ Id: 'i-1', QuicServerId: QUIC_A }] }
      )
    ).rejects.toThrow(/refused by the service/);
    expect(targetCalls()).toEqual(['register i-1/-']);
  });

  it('re-registers the deregistered targets when the register of the new server id fails', async () => {
    failRegisterCalls([1]);
    await expect(
      provider.update(
        'Tg',
        TG_ARN,
        TG_TYPE,
        { Port: 443, Targets: [{ Id: 'i-1', QuicServerId: QUIC_B }] },
        { Port: 443, Targets: [{ Id: 'i-1', QuicServerId: QUIC_A }] }
      )
    ).rejects.toThrow(/refused by the service/);
    expect(targetCalls()).toEqual([
      `deregister i-1/${QUIC_A}`,
      `register i-1/${QUIC_B}`,
      `register i-1/${QUIC_A}`,
    ]);
  });

  it('names how many targets stay deregistered, without values, when the re-register also fails', async () => {
    failRegisterCalls([1, 2]);
    const err = await provider
      .update(
        'Tg',
        TG_ARN,
        TG_TYPE,
        { Port: 443, Targets: [{ Id: 'i-1', QuicServerId: QUIC_B }] },
        { Port: 443, Targets: [{ Id: 'i-1', QuicServerId: QUIC_A }] }
      )
      .then(
        () => new Error('expected a rejection'),
        (e: Error) => e
      );
    expect(err.message).toContain('1 target(s) were deregistered');
    expect(err.message).not.toContain(QUIC_A);
    expect(err.message).not.toContain(QUIC_B);
    expect(err.message).not.toContain('i-1');
    const causes = ((err.cause as Error).cause as AggregateError).errors as Error[];
    expect(causes.map((e) => e.message)).toEqual([
      'refused by the service',
      'refused by the service',
    ]);
  });

  it('a mixed update orders: deregister the server-id change, register all new, deregister the removed', async () => {
    await provider.update(
      'Tg',
      TG_ARN,
      TG_TYPE,
      { Port: 443, Targets: [{ Id: 'i-1', QuicServerId: QUIC_B }] },
      {
        Port: 443,
        Targets: [
          { Id: 'i-1', QuicServerId: QUIC_A },
          { Id: 'i-2', QuicServerId: QUIC_A },
        ],
      }
    );
    expect(targetCalls()).toEqual([
      `deregister i-1/${QUIC_A}`,
      `register i-1/${QUIC_B}`,
      `deregister i-2/${QUIC_A}`,
    ]);
  });

  it('a recorded list [secret-derived QuicServerId, plain target] deregisters only the plain one', async () => {
    await provider.update(
      'Tg',
      TG_ARN,
      TG_TYPE,
      { Port: 443, Targets: [] },
      {
        Port: 443,
        Targets: [
          { Id: 'i-1', QuicServerId: '{{resolve:secretsmanager:x:SecretString:q::}}' },
          { Id: 'i-2', QuicServerId: QUIC_A },
        ],
      }
    );
    expect(targetCalls()).toEqual([`deregister i-2/${QUIC_A}`]);
  });

  describe('an unreadable recorded Targets, read from the live group', () => {
    function primeLive(descriptions: unknown[]): void {
      const base = mockSend.getMockImplementation()!;
      mockSend.mockImplementation((cmd: { constructor: { name: string } }) =>
        cmd.constructor.name === 'DescribeTargetHealthCommand'
          ? Promise.resolve({ TargetHealthDescriptions: descriptions })
          : base(cmd)
      );
    }

    it('deregisters the live tuple holding ANOTHER server id before registering the desired one', async () => {
      primeLive([
        {
          Target: { Id: 'i-1', Port: 443, AvailabilityZone: 'us-east-1a', QuicServerId: QUIC_A },
          TargetHealth: { State: 'healthy' },
        },
      ]);
      await provider.update(
        'Tg',
        TG_ARN,
        TG_TYPE,
        { Port: 443, Targets: [{ Id: 'i-1', QuicServerId: QUIC_B }] },
        { Port: 443, Targets: { Ref: 'Instance' } }
      );
      expect(targetCalls()).toEqual([`deregister i-1/${QUIC_A}`, `register i-1/${QUIC_B}`]);
      // The old tuple carries the desired entry's AvailabilityZone (none here), not the
      // live one: a live zone would key differently from the register and unpair them.
      expect(sent('DeregisterTargetsCommand')[0]!['Targets']).toEqual([
        { Id: 'i-1', Port: 443, QuicServerId: QUIC_A },
      ]);
      expect(warned.find((w) => w.includes('Targets of TargetGroup Tg'))).toBeUndefined();
    });

    it('leaves a live target with the SAME server id alone', async () => {
      primeLive([
        {
          Target: { Id: 'i-1', Port: 443, QuicServerId: QUIC_A },
          TargetHealth: { State: 'healthy' },
        },
      ]);
      await provider.update(
        'Tg',
        TG_ARN,
        TG_TYPE,
        { Port: 443, Targets: [{ Id: 'i-1', QuicServerId: QUIC_A }] },
        { Port: 443, Targets: { Ref: 'Instance' } }
      );
      expect(targetCalls()).toEqual([]);
    });
  });
});
