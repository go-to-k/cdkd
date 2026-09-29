import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#4144: the observed baseline of an ALB held
// `ddos_protection.syn_cookie.mode`, an attribute the template never declared,
// and a later DescribeLoadBalancerAttributes no longer returned it. That
// one-sided absence read as drift, and `--revert` would write the key back.
// `canonicalizeDriftPair` now drops such an entry from the BASELINE only.

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-elastic-load-balancing-v2', async () => {
  const actual = await vi.importActual<
    typeof import('@aws-sdk/client-elastic-load-balancing-v2')
  >('@aws-sdk/client-elastic-load-balancing-v2');
  return {
    ...actual,
    ElasticLoadBalancingV2Client: vi.fn().mockImplementation(() => ({
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

import { ModifyLoadBalancerAttributesCommand } from '@aws-sdk/client-elastic-load-balancing-v2';
import { ELBv2Provider } from '../../../src/provisioning/providers/elbv2-provider.js';
import { calculateResourceDrift } from '../../../src/analyzer/drift-calculator.js';
import { buildRevertNewProperties } from '../../../src/cli/commands/drift.js';

const LB = 'AWS::ElasticLoadBalancingV2::LoadBalancer';
const TG = 'AWS::ElasticLoadBalancingV2::TargetGroup';
const LISTENER = 'AWS::ElasticLoadBalancingV2::Listener';
const LB_ARN = 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/my-alb/123';

const VOLATILE = { Key: 'ddos_protection.syn_cookie.mode', Value: 'reactive' };
const IDLE = { Key: 'idle_timeout.timeout_seconds', Value: '60' };
const HTTP2 = { Key: 'routing.http2.enabled', Value: 'true' };

type Attr = { Key: string; Value: string };

/** What `cdkd drift` compares: the pair pass, then the comparator (observed baseline). */
async function driftOf(
  provider: ELBv2Provider,
  type: string,
  bag: string,
  baselineAttrs: unknown,
  liveAttrs: unknown,
  declaredAttrs?: unknown
) {
  const baseline = { [bag]: baselineAttrs };
  const aws = { [bag]: liveAttrs };
  const properties = declaredAttrs === undefined ? {} : { [bag]: declaredAttrs };
  const paired = await provider.canonicalizeDriftPair(type, baseline, aws, properties);
  return {
    paired,
    input: { baseline, aws },
    changes: calculateResourceDrift(paired.baseline, paired.aws, { unionWalkObjects: true }),
  };
}

describe('ELBv2Provider drift — an undeclared attribute AWS stops reporting (#4144)', () => {
  let provider: ELBv2Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ELBv2Provider();
  });

  it.each([
    [LB, 'LoadBalancerAttributes'],
    [TG, 'TargetGroupAttributes'],
    [LISTENER, 'ListenerAttributes'],
  ])('%s: an undeclared baseline key absent from the readback is not drift', async (type, bag) => {
    const { changes, paired, input } = await driftOf(
      provider,
      type,
      bag,
      [VOLATILE, IDLE],
      [IDLE],
      [IDLE]
    );
    expect(changes).toEqual([]);
    expect(paired.baseline[bag]).toEqual([IDLE]);
    // The readback side is never rewritten, and neither input is mutated.
    expect(paired.aws).toBe(input.aws);
    expect(input.baseline[bag]).toEqual([VOLATILE, IDLE]);
  });

  it('the same pair IS drift without the hook (non-vacuity)', () => {
    const changes = calculateResourceDrift(
      { LoadBalancerAttributes: [VOLATILE, IDLE] },
      { LoadBalancerAttributes: [IDLE] },
      { unionWalkObjects: true }
    );
    expect(changes.map((c) => c.path)).toEqual(['LoadBalancerAttributes']);
  });

  it('with NO declared bag every baseline key is undeclared, so the absent one is dropped', async () => {
    const { changes } = await driftOf(provider, LB, 'LoadBalancerAttributes', [VOLATILE, IDLE], [IDLE]);
    expect(changes).toEqual([]);
  });

  it('a DECLARED key the readback no longer reports is still drift', async () => {
    const { changes, paired } = await driftOf(
      provider,
      LB,
      'LoadBalancerAttributes',
      [VOLATILE, IDLE],
      [IDLE],
      [VOLATILE]
    );
    expect(changes.map((c) => c.path)).toEqual(['LoadBalancerAttributes']);
    expect(paired.baseline['LoadBalancerAttributes']).toEqual([VOLATILE, IDLE]);
  });

  it('a DECLARED key whose value changed is still drift', async () => {
    const { changes } = await driftOf(
      provider,
      LB,
      'LoadBalancerAttributes',
      [IDLE],
      [{ ...IDLE, Value: '300' }],
      [IDLE]
    );
    expect(changes.map((c) => c.path)).toEqual(['LoadBalancerAttributes']);
  });

  it('an UNDECLARED key present on both sides with a changed value is still drift', async () => {
    const { changes, paired, input } = await driftOf(
      provider,
      LB,
      'LoadBalancerAttributes',
      [HTTP2, IDLE],
      [{ ...HTTP2, Value: 'false' }, IDLE],
      [IDLE]
    );
    expect(changes.map((c) => c.path)).toEqual(['LoadBalancerAttributes']);
    // Nothing to drop: identity.
    expect(paired.baseline).toBe(input.baseline);
  });

  it('an UNDECLARED key only the readback holds (added out-of-band) is still drift', async () => {
    const { changes, paired, input } = await driftOf(
      provider,
      LB,
      'LoadBalancerAttributes',
      [IDLE],
      [VOLATILE, IDLE],
      [IDLE]
    );
    expect(changes.map((c) => c.path)).toEqual(['LoadBalancerAttributes']);
    expect(paired.baseline).toBe(input.baseline);
  });

  it('drops only the absent undeclared key: another real change beside it still reports', async () => {
    const { changes } = await driftOf(
      provider,
      LB,
      'LoadBalancerAttributes',
      [VOLATILE, HTTP2, IDLE],
      [{ ...HTTP2, Value: 'false' }, IDLE],
      [IDLE]
    );
    expect(changes).toHaveLength(1);
    // The comparator sorts keyed lists by Key.
    expect(changes[0]!.stateValue).toEqual([IDLE, HTTP2]);
    expect(changes[0]!.awsValue).toEqual([IDLE, { ...HTTP2, Value: 'false' }]);
  });

  describe('fails closed (identity) when declaration or readback is unknown', () => {
    it.each([
      ['the readback bag is absent (its read failed)', [VOLATILE, IDLE], undefined, [IDLE]],
      ['the readback bag is not an array', [VOLATILE, IDLE], { oops: 1 }, [IDLE]],
      ['the readback bag is empty (a degenerate reply)', [VOLATILE, IDLE], [], [IDLE]],
      ['the baseline bag is not an array', { oops: 1 }, [IDLE], [IDLE]],
      ['the declared bag is not an array', [VOLATILE, IDLE], [IDLE], { 'Fn::If': [] }],
      ['a declared entry has no string Key', [VOLATILE, IDLE], [IDLE], [{ Key: { Ref: 'P' } }]],
      ['a declared entry is not an object', [VOLATILE, IDLE], [IDLE], ['x']],
    ])('%s', async (_label, baselineAttrs, liveAttrs, declared) => {
      const baseline = { LoadBalancerAttributes: baselineAttrs };
      const aws = liveAttrs === undefined ? {} : { LoadBalancerAttributes: liveAttrs };
      const out = await provider.canonicalizeDriftPair(LB, baseline, aws, {
        LoadBalancerAttributes: declared,
      });
      expect(out.baseline).toBe(baseline);
      expect(out.aws).toBe(aws);
    });

    it('keeps a baseline entry that has no string Key', async () => {
      const odd = { Value: 'x' };
      const out = await provider.canonicalizeDriftPair(
        LB,
        { LoadBalancerAttributes: [odd, VOLATILE, IDLE] },
        { LoadBalancerAttributes: [IDLE] },
        {}
      );
      expect(out.baseline['LoadBalancerAttributes']).toEqual([odd, IDLE]);
    });
  });

  it('is scoped to the three ELBv2 types and their own bag', async () => {
    // Another type, even one carrying the same bag name, is untouched.
    const baseline = { LoadBalancerAttributes: [VOLATILE, IDLE] };
    const aws = { LoadBalancerAttributes: [IDLE] };
    const other = await provider.canonicalizeDriftPair('AWS::Other::Thing', baseline, aws, {});
    expect(other.baseline).toBe(baseline);
    // A TargetGroup does not trim the LoadBalancer bag.
    const tg = await provider.canonicalizeDriftPair(TG, baseline, aws, {});
    expect(tg.baseline).toBe(baseline);
    // A prototype member name is not a type.
    const proto = await provider.canonicalizeDriftPair('constructor', baseline, aws, {});
    expect(proto.baseline).toBe(baseline);
  });

  describe('--revert agrees with the comparison', () => {
    /** What `runRevert` sends: the pair-trimmed desired bag, overlaid onto the readback. */
    async function revert(baselineAttrs: Attr[], liveAttrs: Attr[], declared: Attr[]) {
      const desiredRaw = { LoadBalancerAttributes: baselineAttrs, SecurityGroups: ['sg-1'] };
      const aws = { LoadBalancerAttributes: liveAttrs, SecurityGroups: ['sg-2'] };
      const properties = { LoadBalancerAttributes: declared };
      const paired = await provider.canonicalizeDriftPair(LB, desiredRaw, aws, properties);
      const changes = calculateResourceDrift(paired.baseline, paired.aws, {
        unionWalkObjects: true,
      });
      const desired = (await provider.canonicalizeDriftPair(LB, desiredRaw, aws, properties))
        .baseline;
      const sent = buildRevertNewProperties(changes, desired, aws);
      mockSend.mockResolvedValue({});
      await provider.update('MyALB', LB_ARN, LB, sent, aws);
      const modify = mockSend.mock.calls
        .map((c) => c[0])
        .filter((c) => c instanceof ModifyLoadBalancerAttributesCommand) as Array<
        InstanceType<typeof ModifyLoadBalancerAttributesCommand>
      >;
      return { changes, modify };
    }

    it('an absent undeclared key alone is not reverted, so no attribute write is sent', async () => {
      const { changes, modify } = await revert([VOLATILE, IDLE], [IDLE], [IDLE]);
      expect(changes.map((c) => c.path)).toEqual(['SecurityGroups']);
      expect(modify).toEqual([]);
    });

    it('beside a real attribute drift, the revert resets that one and never writes the absent key', async () => {
      const { changes, modify } = await revert(
        [VOLATILE, HTTP2, IDLE],
        [{ ...HTTP2, Value: 'false' }, IDLE],
        [IDLE]
      );
      expect(changes.map((c) => c.path).sort()).toEqual([
        'LoadBalancerAttributes',
        'SecurityGroups',
      ]);
      expect(modify).toHaveLength(1);
      expect(modify[0]!.input.Attributes).toEqual([HTTP2]);
    });

    it('a DECLARED key AWS no longer reports is written back', async () => {
      const { modify } = await revert([VOLATILE, IDLE], [IDLE], [VOLATILE, IDLE]);
      expect(modify).toHaveLength(1);
      expect(modify[0]!.input.Attributes).toEqual([VOLATILE]);
    });
  });
});
