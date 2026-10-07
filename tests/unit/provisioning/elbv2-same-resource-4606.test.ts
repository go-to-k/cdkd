import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#4606: the live identity read a successful deploy asks before
// deleting a fix-forward's earlier load balancer, target group or listener.
// Only `'different'` lets it delete.

const { mockSend, clientRegion, providerLogger } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  clientRegion: { value: 'us-east-1' },
  providerLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  },
}));

vi.mock('@aws-sdk/client-elastic-load-balancing-v2', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-elastic-load-balancing-v2')>(
    '@aws-sdk/client-elastic-load-balancing-v2'
  );
  return {
    ...actual,
    ElasticLoadBalancingV2Client: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve(clientRegion.value) },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ ...providerLogger, child: () => providerLogger }),
}));

import {
  DeleteListenerCommand,
  DeleteLoadBalancerCommand,
  DeleteTargetGroupCommand,
  DescribeListenersCommand,
  DescribeLoadBalancersCommand,
  DescribeTargetGroupsCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { ELBv2Provider } from '../../../src/provisioning/providers/elbv2-provider.js';

const LB = 'AWS::ElasticLoadBalancingV2::LoadBalancer';
const TG = 'AWS::ElasticLoadBalancingV2::TargetGroup';
const LISTENER = 'AWS::ElasticLoadBalancingV2::Listener';
const CTX = { expectedRegion: 'us-east-1' };
const SCOPE = 'arn:aws:elasticloadbalancing:us-east-1:123456789012';

// Both of a pair share the NAME: the AWS-minted id segment is what tells a
// re-created resource from the earlier one.
const LB_A = `${SCOPE}:loadbalancer/app/orphan-lb/0123456789abcdef`;
const LB_B = `${SCOPE}:loadbalancer/app/orphan-lb/fedcba9876543210`;
const TG_A = `${SCOPE}:targetgroup/orphan-tg/0123456789abcdef`;
const TG_B = `${SCOPE}:targetgroup/orphan-tg/fedcba9876543210`;
const L_A = `${SCOPE}:listener/app/orphan-lb/0123456789abcdef/1111111111111111`;
const L_B = `${SCOPE}:listener/app/orphan-lb/0123456789abcdef/2222222222222222`;

const awsError = (name: string, message = name): Error =>
  Object.assign(new Error(message), { name });

type Live = Record<string, 'live' | 'gone' | Error>;

const KINDS = [
  {
    type: LB,
    a: LB_A,
    b: LB_B,
    command: DescribeLoadBalancersCommand,
    notFound: 'LoadBalancerNotFoundException',
    arnsOf: (input: Record<string, unknown>) => input['LoadBalancerArns'] as string[],
    respond: (arns: Array<string | undefined>) => ({
      LoadBalancers: arns.map((arn) => ({ LoadBalancerArn: arn })),
    }),
  },
  {
    type: TG,
    a: TG_A,
    b: TG_B,
    command: DescribeTargetGroupsCommand,
    notFound: 'TargetGroupNotFoundException',
    arnsOf: (input: Record<string, unknown>) => input['TargetGroupArns'] as string[],
    respond: (arns: Array<string | undefined>) => ({
      TargetGroups: arns.map((arn) => ({ TargetGroupArn: arn })),
    }),
  },
  {
    type: LISTENER,
    a: L_A,
    b: L_B,
    command: DescribeListenersCommand,
    notFound: 'ListenerNotFoundException',
    arnsOf: (input: Record<string, unknown>) => input['ListenerArns'] as string[],
    respond: (arns: Array<string | undefined>) => ({
      Listeners: arns.map((arn) => ({ ListenerArn: arn })),
    }),
  },
] as const;
type Kind = (typeof KINDS)[number];

/** The kind's `Describe*` answers per ARN: itself, or its own not-found error. */
function live(kind: Kind, entries: Live): void {
  mockSend.mockImplementation(async (cmd: { input: Record<string, unknown> }) => {
    if (!(cmd instanceof kind.command)) throw new Error('unexpected command');
    const arn = kind.arnsOf(cmd.input)[0]!;
    const entry = entries[arn];
    if (entry === undefined || entry === 'gone') throw awsError(kind.notFound);
    if (entry instanceof Error) throw entry;
    return kind.respond([arn]);
  });
}

const readArns = (kind: Kind): unknown[] =>
  mockSend.mock.calls.map(([c]) => kind.arnsOf((c as { input: Record<string, unknown> }).input));

let provider: ELBv2Provider;

beforeEach(() => {
  vi.clearAllMocks();
  clientRegion.value = 'us-east-1';
  provider = new ELBv2Provider();
});

describe.each(KINDS)('ELBv2Provider.isSameResource for $type (go-to-k/cdkd#4606)', (kind) => {
  const { type, a, b } = kind;

  it('another live resource is different, after reading the record first, then the journaled one', async () => {
    live(kind, { [a]: 'live', [b]: 'live' });
    expect(await provider.isSameResource(a, { physicalId: b }, type, CTX)).toBe('different');
    expect(readArns(kind)).toEqual([[b], [a]]);
  });

  it('a journaled resource AWS reports gone is different once the record reads back', async () => {
    live(kind, { [a]: 'gone', [b]: 'live' });
    expect(await provider.isSameResource(a, { physicalId: b }, type, CTX)).toBe('different');
  });

  it('the record resource gone is unknown, not different, and the journaled one is not read', async () => {
    live(kind, { [a]: 'live', [b]: 'gone' });
    expect(await provider.isSameResource(a, { physicalId: b }, type, CTX)).toBe('unknown');
    expect(readArns(kind)).toEqual([[b]]);
  });

  it('equal ARNs are the same without a read', async () => {
    live(kind, {});
    expect(await provider.isSameResource(a, { physicalId: a }, type, CTX)).toBe('same');
    expect(mockSend).not.toHaveBeenCalled();
  });

  // Defensive: ELBv2 does not answer one ARN with another; a read naming the
  // record's resource must never read as 'different'.
  it('a journaled ARN reading back as the record resource is the same', async () => {
    mockSend.mockImplementation(async () => kind.respond([b]));
    expect(await provider.isSameResource(a, { physicalId: b }, type, CTX)).toBe('same');
  });

  it('a journaled ARN reading back as a third ARN is unknown', async () => {
    const third = `${a.slice(0, -1)}9`;
    mockSend.mockImplementation(async (cmd: { input: Record<string, unknown> }) => {
      const arn = kind.arnsOf(cmd.input)[0]!;
      return kind.respond([arn === b ? b : third]);
    });
    expect(await provider.isSameResource(a, { physicalId: b }, type, CTX)).toBe('unknown');
  });

  it('a record ARN reading back in another spelling is unknown, and the journaled one is not read', async () => {
    mockSend.mockImplementation(async () => kind.respond([b.replace('orphan', 'ORPHAN')]));
    expect(await provider.isSameResource(a, { physicalId: b }, type, CTX)).toBe('unknown');
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('a read that fails other than not-found throws (the caller reads it as unknown)', async () => {
    live(kind, { [a]: awsError('AccessDenied', 'denied'), [b]: 'live' });
    await expect(provider.isSameResource(a, { physicalId: b }, type, CTX)).rejects.toThrow(
      'denied'
    );
  });

  it("another ELBv2 type's not-found error is not read as gone", async () => {
    const other = KINDS.find((k) => k.type !== type)!.notFound;
    live(kind, { [a]: awsError(other), [b]: 'live' });
    await expect(provider.isSameResource(a, { physicalId: b }, type, CTX)).rejects.toThrow(other);
  });

  it.each([
    ['no resource', []],
    ['two resources', [b, a]],
    ['a resource without an ARN', [undefined]],
  ] as const)('a response naming %s throws rather than reading as gone', async (_label, arns) => {
    mockSend.mockResolvedValue(kind.respond([...arns]));
    await expect(provider.isSameResource(a, { physicalId: b }, type, CTX)).rejects.toThrow(
      'did not return exactly the resource asked for'
    );
  });

  it('a client in another region is unknown, with no read', async () => {
    clientRegion.value = 'eu-west-1';
    live(kind, { [a]: 'gone', [b]: 'live' });
    expect(await provider.isSameResource(a, { physicalId: b }, type, CTX)).toBe('unknown');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('ARNs of another region, account or partition are unknown, with no read', async () => {
    live(kind, { [a]: 'gone', [b]: 'live' });
    const inRegion = (arn: string, region: string): string => arn.replace(':us-east-1:', `:${region}:`);
    for (const [journaled, recorded] of [
      // Both in a region other than the stack's.
      [inRegion(a, 'eu-west-1'), inRegion(b, 'eu-west-1')],
      // One each side.
      [inRegion(a, 'eu-west-1'), b],
      [a, b.replace(':123456789012:', ':210987654321:')],
      [a.replace('arn:aws:', 'arn:aws-cn:'), b],
    ] as const) {
      expect(await provider.isSameResource(journaled, { physicalId: recorded }, type, CTX)).toBe(
        'unknown'
      );
    }
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("an id that is not this type's ARN is unknown, with no read", async () => {
    live(kind, { [a]: 'gone', [b]: 'live' });
    const otherTypeArn = KINDS.find((k) => k.type !== type)!.b;
    for (const [journaled, recorded] of [
      ['', b],
      [a, ''],
      ['orphan-lb', b],
      [a, 'orphan-lb'],
      [a, otherTypeArn],
      [otherTypeArn, b],
      [`${a}/x`, b],
      [a.toUpperCase(), b],
    ] as const) {
      expect(await provider.isSameResource(journaled, { physicalId: recorded }, type, CTX)).toBe(
        'unknown'
      );
    }
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('ELBv2Provider.isSameResource for another type (go-to-k/cdkd#4606)', () => {
  it('is unknown, with no read, even for distinct ELBv2 ARNs', async () => {
    live(KINDS[0], { [LB_A]: 'gone', [LB_B]: 'live' });
    for (const type of ['AWS::ElasticLoadBalancingV2::ListenerRule', 'AWS::EC2::VPC']) {
      expect(await provider.isSameResource(LB_A, { physicalId: LB_B }, type, CTX)).toBe('unknown');
      expect(await provider.isSameResource(LB_A, { physicalId: LB_A }, type, CTX)).toBe('unknown');
    }
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('the load balancer forms gwy and net are recognised too', async () => {
    for (const form of ['net', 'gwy']) {
      const journaled = LB_A.replace('/app/', `/${form}/`);
      const recorded = LB_B.replace('/app/', `/${form}/`);
      live(KINDS[0], { [journaled]: 'gone', [recorded]: 'live' });
      expect(await provider.isSameResource(journaled, { physicalId: recorded }, LB, CTX)).toBe(
        'different'
      );
    }
  });
});

describe('ELBv2Provider.delete of a journaled resource already gone (go-to-k/cdkd#4606)', () => {
  it.each([
    [LB, LB_A, DeleteLoadBalancerCommand, 'LoadBalancerNotFoundException'],
    [TG, TG_A, DeleteTargetGroupCommand, 'TargetGroupNotFoundException'],
    [LISTENER, L_A, DeleteListenerCommand, 'ListenerNotFoundException'],
  ] as const)('%s names it once at info, since the settle then exits 0', async (type, id, cmdClass, name) => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof cmdClass) throw awsError(name, 'not found');
      throw new Error('unexpected command');
    });
    await provider.delete('Orphan', id, type, {}, {
      expectedRegion: 'us-east-1',
      failedCreateOrphan: true,
    });
    const infos = providerLogger.info.mock.calls.map(([m]) => String(m));
    expect(infos).toHaveLength(1);
    expect(infos[0]).toContain(id);
    expect(infos[0]).toContain('(Orphan)');
    expect(infos[0]).toContain('already gone');

    // A record's own delete keeps the quiet debug line.
    providerLogger.info.mockClear();
    await provider.delete('Orphan', id, type, {}, { expectedRegion: 'us-east-1' });
    expect(providerLogger.info).not.toHaveBeenCalled();
    expect(providerLogger.debug.mock.calls.map(([m]) => String(m))).toContain(
      `${type.split('::')[2]} ${id} does not exist, skipping deletion`
    );
  });
});
