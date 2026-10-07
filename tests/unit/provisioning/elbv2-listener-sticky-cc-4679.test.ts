import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#4679: a listener first deployed while tagged was routed through
// Cloud Control and recorded `provisionedBy: 'cc-api'`. #2085 moved NEW tagged
// listeners to the SDK provider, but the sticky rule kept the existing record on
// Cloud Control, whose update leaves a removed ListenerAttributes key live. The
// listener is now an 'sdk-coverage' sticky exemption: the deploy that drops the
// key returns the record to the SDK provider, which resets it.

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('@aws-sdk/client-elastic-load-balancing-v2', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-elastic-load-balancing-v2')>(
    '@aws-sdk/client-elastic-load-balancing-v2'
  );
  return {
    ...actual,
    ElasticLoadBalancingV2Client: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { getLogger: () => ({ ...logger, child: () => logger }) };
});

import { ModifyListenerAttributesCommand } from '@aws-sdk/client-elastic-load-balancing-v2';
import { ELBv2Provider } from '../../../src/provisioning/providers/elbv2-provider.js';
import {
  ProviderRegistry,
  STICKY_CC_MIGRATION_EXEMPT,
} from '../../../src/provisioning/provider-registry.js';

const LISTENER = 'AWS::ElasticLoadBalancingV2::Listener';
const LB_ARN = 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/my-alb/0123456789abcdef';
const LISTENER_ARN =
  'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/my-alb/0123456789abcdef/fedcba9876543210';

/** The listener the alb fixture synthesizes, with the stack's tags. */
const taggedListener = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  LoadBalancerArn: LB_ARN,
  Port: 80,
  Protocol: 'HTTP',
  DefaultActions: [{ Type: 'forward', TargetGroupArn: 'arn:tg' }],
  Tags: [{ Key: 'Project', Value: 'cdkd' }],
  ...extra,
});

const SERVER_HEADER_OFF = {
  ListenerAttributes: [{ Key: 'routing.http.response.server.enabled', Value: 'false' }],
};

const sentOf = <T>(cls: new (...args: never[]) => T): T[] =>
  mockSend.mock.calls.map(([c]) => c as unknown).filter((c): c is T => c instanceof cls);

function registryWithListener(): { registry: ProviderRegistry; sdk: ELBv2Provider } {
  const registry = new ProviderRegistry();
  const sdk = new ELBv2Provider();
  registry.register(LISTENER, sdk);
  return { registry, sdk };
}

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue({});
});

describe('a cc-api ALB listener returns to the SDK provider (go-to-k/cdkd#4679)', () => {
  it("is admitted as 'sdk-coverage', proven by the alb fixture", () => {
    expect(STICKY_CC_MIGRATION_EXEMPT.get(LISTENER)).toMatchObject({
      mode: 'sdk-coverage',
      integFixture: 'alb',
    });
  });

  it('the deploy that drops ListenerAttributes routes the cc-api record to the SDK provider, which resets the key', async () => {
    const { registry, sdk } = registryWithListener();
    const decision = registry.getProviderFor({
      resourceType: LISTENER,
      properties: taggedListener(),
      previousProperties: taggedListener(SERVER_HEADER_OFF),
      provisionedBy: 'cc-api',
    });
    expect(decision.provider).toBe(sdk);
    expect(decision.provisionedBy).toBe('sdk');
    expect(decision.sdkMigration).toBe(true);

    // The routed provider, on the record's own ARN, sends the reset Cloud
    // Control never sent.
    await decision.provider.update(
      'Listener',
      LISTENER_ARN,
      LISTENER,
      taggedListener(),
      taggedListener(SERVER_HEADER_OFF)
    );
    expect(sentOf(ModifyListenerAttributesCommand).map((c) => c.input)).toEqual([
      {
        ListenerArn: LISTENER_ARN,
        Attributes: [{ Key: 'routing.http.response.server.enabled', Value: 'true' }],
      },
    ]);
  });

  it('--pin-cc-api keeps the record on Cloud Control', () => {
    const { registry } = registryWithListener();
    const decision = registry.getProviderFor({
      resourceType: LISTENER,
      properties: taggedListener(),
      previousProperties: taggedListener(SERVER_HEADER_OFF),
      provisionedBy: 'cc-api',
      forceCcApi: true,
    });
    expect(decision.provisionedBy).toBe('cc-api');
    expect(decision.sdkMigration).toBeUndefined();
  });

  it('a read with no template bag (destroy, drift, observed capture) stays on Cloud Control', () => {
    const { registry } = registryWithListener();
    const decision = registry.getProviderFor({ resourceType: LISTENER, provisionedBy: 'cc-api' });
    expect(decision.provisionedBy).toBe('cc-api');
  });
});
