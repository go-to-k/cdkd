import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { ModifyTargetGroupCommand } from '@aws-sdk/client-elastic-load-balancing-v2';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-elastic-load-balancing-v2', async () => {
  const actual = await vi.importActual('@aws-sdk/client-elastic-load-balancing-v2');
  return {
    ...actual,
    ElasticLoadBalancingV2Client: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
    waitUntilLoadBalancerAvailable: vi.fn().mockResolvedValue({ state: 'SUCCESS' }),
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

import { ELBv2Provider } from '../../../src/provisioning/providers/elbv2-provider.js';

const TG_ARN = 'arn:aws:elasticloadbalancing:us-east-1:0:targetgroup/tg/1';
const TG_TYPE = 'AWS::ElasticLoadBalancingV2::TargetGroup';

/** The single ModifyTargetGroup input of the update, or undefined. */
function modifyTargetGroupInput(): Record<string, unknown> | undefined {
  const call = mockSend.mock.calls.find((c) => c[0] instanceof ModifyTargetGroupCommand);
  return call?.[0].input as Record<string, unknown> | undefined;
}

describe('ELBv2Provider TargetGroup HealthCheckPort removal reset (issue #1160)', () => {
  let provider: ELBv2Provider;

  beforeEach(() => {
    // clearAllMocks (NOT resetAllMocks) — reset would wipe the module-mock
    // client constructor's implementation and every send would explode.
    vi.clearAllMocks();
    // ModifyTargetGroup -> {}; DescribeTargetGroups -> one TG record.
    mockSend.mockResolvedValue({ TargetGroups: [{ TargetGroupName: 'tg' }] });
    provider = new ELBv2Provider();
  });

  // ─── The #1157-pattern trio ──────────────────────────────────────────

  it('removed: dropping HealthCheckPort resets it to the CFn create default "traffic-port"', async () => {
    const previous = { Protocol: 'HTTP', HealthCheckPort: '8443' };
    const desired = { Protocol: 'HTTP' };

    await provider.update('TG', TG_ARN, TG_TYPE, desired, previous);

    expect(modifyTargetGroupInput()).toMatchObject({ HealthCheckPort: 'traffic-port' });
  });

  it('never-present: no HealthCheckPort on either side sends undefined (no reset)', async () => {
    const props = { Protocol: 'HTTP' };

    await provider.update('TG', TG_ARN, TG_TYPE, props, props);

    expect(modifyTargetGroupInput()?.['HealthCheckPort']).toBeUndefined();
  });

  it('kept: a desired HealthCheckPort passes through unchanged', async () => {
    const previous = { Protocol: 'HTTP', HealthCheckPort: '8443' };
    const desired = { Protocol: 'HTTP', HealthCheckPort: '9000' };

    await provider.update('TG', TG_ARN, TG_TYPE, desired, previous);

    expect(modifyTargetGroupInput()).toMatchObject({ HealthCheckPort: '9000' });
  });

  // ─── GENEVE deferral ─────────────────────────────────────────────────

  it('GENEVE target group: removal is deferred (pass-through, no traffic-port reset)', async () => {
    // GLB TGs default the health-check port to 80, not `traffic-port`, and
    // CFn's removal behavior there is not A/B-verified — the provider
    // retains (sends undefined) instead of guessing.
    const previous = { Protocol: 'GENEVE', HealthCheckPort: '8443' };
    const desired = { Protocol: 'GENEVE' };

    await provider.update('TG', TG_ARN, TG_TYPE, desired, previous);

    expect(modifyTargetGroupInput()?.['HealthCheckPort']).toBeUndefined();
  });

  it('GENEVE protocol resolved from the PREVIOUS side when the desired side omits it', async () => {
    const previous = { Protocol: 'GENEVE', HealthCheckPort: '8443' };
    const desired = {};

    await provider.update('TG', TG_ARN, TG_TYPE, desired, previous);

    expect(modifyTargetGroupInput()?.['HealthCheckPort']).toBeUndefined();
  });

  // ─── CFn-parity retention pins (live A/B 2026-08-10) ────────────────
  //
  // CloudFormation RETAINS every other health-check field on removal —
  // HealthCheckProtocol / HealthCheckPath / HealthCheckEnabled /
  // HealthCheckIntervalSeconds / HealthCheckTimeoutSeconds /
  // HealthyThresholdCount / UnhealthyThresholdCount all kept their
  // customized values through a real CFn removal update. cdkd's
  // pass-through (absent -> undefined -> ModifyTargetGroup merge) is
  // therefore PARITY, not a bug. These pins make a future "reset them
  // too" change a conscious decision requiring a fresh CFn A/B.
  it('parity: removing the OTHER health-check fields sends undefined (CFn retains them)', async () => {
    const previous = {
      Protocol: 'HTTP',
      HealthCheckProtocol: 'HTTPS',
      HealthCheckPath: '/hc',
      HealthCheckEnabled: true,
      HealthCheckIntervalSeconds: 60,
      HealthCheckTimeoutSeconds: 30,
      HealthyThresholdCount: 7,
      UnhealthyThresholdCount: 7,
    };
    const desired = { Protocol: 'HTTP' };

    await provider.update('TG', TG_ARN, TG_TYPE, desired, previous);

    const input = modifyTargetGroupInput();
    expect(input?.['HealthCheckProtocol']).toBeUndefined();
    expect(input?.['HealthCheckPath']).toBeUndefined();
    expect(input?.['HealthCheckEnabled']).toBeUndefined();
    expect(input?.['HealthCheckIntervalSeconds']).toBeUndefined();
    expect(input?.['HealthCheckTimeoutSeconds']).toBeUndefined();
    expect(input?.['HealthyThresholdCount']).toBeUndefined();
    expect(input?.['UnhealthyThresholdCount']).toBeUndefined();
  });
});
