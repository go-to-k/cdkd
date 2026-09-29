import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#4147: the mirror of #4144. An observed baseline captured while
// AWS was not returning an undeclared attribute key (`ddos_protection.syn_cookie.mode`
// comes and goes; an attribute AWS rolls out later never was there), then a
// readback that returns it. `cdkd drift` still reports it, since one read cannot
// tell a service-side addition from a value an operator set. `--revert` used to
// read it as a REMOVAL and send `Value: ''` (or a documented default), and a
// rejected `''` fails the whole Modify*Attributes call. On `drift --revert`
// (`desiredFromAwsReadback`) no attribute removal is sent any more.

const { mockSend, warn } = vi.hoisted(() => ({ mockSend: vi.fn(), warn: vi.fn() }));

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
    warn,
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
  ModifyListenerAttributesCommand,
  ModifyLoadBalancerAttributesCommand,
  ModifyTargetGroupAttributesCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { ELBv2Provider } from '../../../src/provisioning/providers/elbv2-provider.js';
import { calculateResourceDrift } from '../../../src/analyzer/drift-calculator.js';
import { buildRevertNewProperties } from '../../../src/cli/commands/drift.js';
import type { UpdateContext } from '../../../src/types/resource.js';

const LB = 'AWS::ElasticLoadBalancingV2::LoadBalancer';
const TG = 'AWS::ElasticLoadBalancingV2::TargetGroup';
const LISTENER = 'AWS::ElasticLoadBalancingV2::Listener';

const ARN: Record<string, string> = {
  [LB]: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/my-alb/123',
  [TG]: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/my-tg/456',
  [LISTENER]: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/my-alb/123/789',
};
const MODIFY: Record<string, new (...args: never[]) => { input: { Attributes?: unknown } }> = {
  [LB]: ModifyLoadBalancerAttributesCommand,
  [TG]: ModifyTargetGroupAttributesCommand,
  [LISTENER]: ModifyListenerAttributesCommand,
};

// A key with no documented default in any table: the LB / Listener resolver
// sends `''` for it, the TargetGroup one warns and retains.
const APPEARING = { Key: 'ddos_protection.syn_cookie.mode', Value: 'reactive' };
// A key WITH a documented default, held at a NON-default value, so every
// deploy-path resolver sends a reset for it.
const DEFAULTED: Record<string, Attr> = {
  [LB]: { Key: 'deletion_protection.enabled', Value: 'true' },
  [TG]: { Key: 'stickiness.enabled', Value: 'true' },
  [LISTENER]: { Key: 'routing.http.response.server.enabled', Value: 'false' },
};
// The documented default each resolver resets DEFAULTED to.
const RESET: Record<string, string> = { [LB]: 'false', [TG]: 'false', [LISTENER]: 'true' };
const OTHER = { Key: 'idle_timeout.timeout_seconds', Value: '60' };

type Attr = { Key: string; Value: string };

const TYPES = [
  [LB, 'LoadBalancerAttributes'],
  [TG, 'TargetGroupAttributes'],
  [LISTENER, 'ListenerAttributes'],
] as const;

describe('ELBv2Provider drift --revert — an attribute key only the readback holds (#4147)', () => {
  let provider: ELBv2Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    provider = new ELBv2Provider();
  });

  /**
   * What `runRevert` does: the pair pass on the desired bag, the comparison,
   * the overlay onto the raw readback, then `update()` with the readback as the
   * previous side. Returns the reported changes and every attribute payload.
   */
  async function revert(
    type: string,
    bag: string,
    baselineAttrs: Attr[],
    liveAttrs: Attr[],
    declared: Attr[] | undefined,
    context: UpdateContext = { desiredFromAwsReadback: true },
    options: { preserveUntemplated?: boolean } = {}
  ) {
    const desiredRaw = { [bag]: baselineAttrs };
    const aws = { [bag]: liveAttrs };
    const properties = declared === undefined ? {} : { [bag]: declared };
    const paired = await provider.canonicalizeDriftPair(type, desiredRaw, aws, properties);
    const changes = calculateResourceDrift(paired.baseline, paired.aws, {
      unionWalkObjects: true,
    });
    const sent = buildRevertNewProperties(changes, paired.baseline, aws, options);
    await provider.update('MyRes', ARN[type]!, type, sent, aws, context);
    const payloads = mockSend.mock.calls
      .map((c) => c[0] as unknown)
      .filter((c) => c instanceof MODIFY[type]!)
      .map((c) => (c as { input: { Attributes?: unknown } }).input.Attributes);
    return { changes, payloads };
  }

  function warnings(): string[] {
    return warn.mock.calls.map((c) => String(c[0]));
  }

  describe.each(TYPES)('%s', (type, bag) => {
    it('the readback-only key is still reported, but the revert sends no attribute write', async () => {
      const { changes, payloads } = await revert(
        type,
        bag,
        [OTHER],
        [APPEARING, OTHER],
        [OTHER]
      );
      expect(changes.map((c) => c.path)).toEqual([bag]);
      expect(payloads).toEqual([]);
      const lines = warnings().filter((w) => w.includes(APPEARING.Key));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(
        `MyRes: AWS reports ${bag} key ${APPEARING.Key}, which the recorded baseline holds no value for.`
      );
      expect(lines[0]).toContain('leaves its live value in place');
      expect(lines[0]).toContain("If its live value is what you intend, run 'cdkd drift --accept' to record it");
      expect(lines[0]).toContain('otherwise declare the value in the template and deploy');
    });

    it('beside a real attribute drift, only that attribute is sent', async () => {
      const { payloads } = await revert(
        type,
        bag,
        [OTHER],
        [APPEARING, { ...OTHER, Value: '300' }],
        [OTHER]
      );
      expect(payloads).toEqual([[OTHER]]);
    });

    it('a readback-only key with a documented default is not reset either', async () => {
      const { payloads } = await revert(
        type,
        bag,
        [OTHER],
        [DEFAULTED[type]!, { ...OTHER, Value: '300' }],
        [OTHER]
      );
      expect(payloads).toEqual([[OTHER]]);
      expect(warnings().some((w) => w.includes(DEFAULTED[type]!.Key))).toBe(true);
    });

    it('a DECLARED key the baseline lacks is left in place too, not reset', async () => {
      const { payloads } = await revert(
        type,
        bag,
        [OTHER],
        [DEFAULTED[type]!, { ...OTHER, Value: '300' }],
        [DEFAULTED[type]!, OTHER]
      );
      expect(payloads).toEqual([[OTHER]]);
    });

    it('the same pair on a TEMPLATE-path update still sends the removal (non-vacuity)', async () => {
      const { payloads } = await revert(
        type,
        bag,
        [OTHER],
        [DEFAULTED[type]!, { ...OTHER, Value: '300' }],
        [OTHER],
        {} // a template-path update: no context flag
      );
      expect(payloads).toEqual([[OTHER, { Key: DEFAULTED[type]!.Key, Value: RESET[type] }]]);
      expect(warnings().some((w) => w.includes('which the recorded baseline holds no value'))).toBe(
        false
      );
    });

    it('a rollback replay (replayingState) still sends the removal: the flag is revert-only', async () => {
      const { payloads } = await revert(
        type,
        bag,
        [OTHER],
        [DEFAULTED[type]!, OTHER],
        [OTHER],
        { replayingState: true }
      );
      expect(payloads).toEqual([[{ Key: DEFAULTED[type]!.Key, Value: RESET[type] }]]);
    });

    it('#4144 still holds on revert: an absent undeclared key is not written, a declared one is', async () => {
      const dropped = await revert(type, bag, [APPEARING, OTHER], [OTHER], [OTHER]);
      expect(dropped.changes).toEqual([]);
      expect(dropped.payloads).toEqual([]);
      mockSend.mockClear();
      const declared = await revert(type, bag, [APPEARING, OTHER], [OTHER], [APPEARING, OTHER]);
      expect(declared.payloads).toEqual([[APPEARING]]);
    });

    it('warns nothing when the revert leaves no key in place', async () => {
      const { payloads } = await revert(type, bag, [OTHER], [{ ...OTHER, Value: '300' }], [OTHER]);
      expect(payloads).toEqual([[OTHER]]);
      expect(warnings().some((w) => w.includes('which the recorded baseline holds no value'))).toBe(
        false
      );
    });
  });

  it("the LoadBalancer template-path removal of a key with no default is ''", async () => {
    // Pins what the revert used to send for the #4147 key, so the revert arm
    // above is measured against the real alternative.
    const { payloads } = await revert(
      LB,
      'LoadBalancerAttributes',
      [OTHER],
      [APPEARING, OTHER],
      [OTHER],
      {} // a template-path update: no context flag
    );
    expect(payloads).toEqual([[{ Key: APPEARING.Key, Value: '' }]]);
  });

  it('with no observed baseline the untemplated keys are merged in, so nothing is left in place', async () => {
    // `runRevert` sets preserveUntemplated when the record has no
    // observedProperties: the desired side is the template's bag.
    const { payloads } = await revert(
      LB,
      'LoadBalancerAttributes',
      [OTHER],
      [APPEARING, { ...OTHER, Value: '300' }],
      [OTHER],
      { desiredFromAwsReadback: true },
      { preserveUntemplated: true }
    );
    expect(payloads).toEqual([[OTHER]]);
    expect(warnings().some((w) => w.includes('which the recorded baseline holds no value'))).toBe(false);
  });

  it('masks a key that is a resolved secret, and names every key left in place', async () => {
    const secretKey = { Key: 'sekrit-attribute-key', Value: 'x' };
    const maskSecrets = (text: string) => text.replaceAll('sekrit-attribute-key', '***');
    const { payloads } = await revert(
      LB,
      'LoadBalancerAttributes',
      [OTHER],
      [APPEARING, secretKey, OTHER],
      [OTHER],
      { desiredFromAwsReadback: true, maskSecrets }
    );
    expect(payloads).toEqual([]);
    const all = warnings().join('\n');
    expect(all).not.toContain('sekrit-attribute-key');
    expect(all).toContain(`LoadBalancerAttributes keys ${APPEARING.Key}, ***, which`);
    expect(all).toContain("leaves their live values in place, and 'cdkd drift' keeps reporting them");
    expect(all).toContain("If their live values are what you intend, run 'cdkd drift --accept' to record them; otherwise declare the values in the template and deploy.");
  });

  it('a logical id with a control character is made display-safe', async () => {
    await provider.update(
      'My\u001b[2JRes',
      ARN[LB]!,
      LB,
      { LoadBalancerAttributes: [OTHER] },
      { LoadBalancerAttributes: [APPEARING, OTHER] },
      { desiredFromAwsReadback: true }
    );
    const line = warnings().find((w) => w.includes(APPEARING.Key));
    expect(line).toBeDefined();
    expect(line).not.toContain('\u001b');
  });
});
