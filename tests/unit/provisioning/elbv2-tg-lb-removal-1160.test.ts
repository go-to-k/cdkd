import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  ModifyLoadBalancerAttributesCommand,
  SetIpAddressTypeCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';

const { mockSend, warn } = vi.hoisted(() => ({ mockSend: vi.fn(), warn: vi.fn() }));

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

import { ELBv2Provider } from '../../../src/provisioning/providers/elbv2-provider.js';
import { prepareRemovalForUpdate } from '../../../src/provisioning/update-removal.js';

const LB = 'AWS::ElasticLoadBalancingV2::LoadBalancer';
const TG = 'AWS::ElasticLoadBalancingV2::TargetGroup';
const LB_ARN = 'arn:aws:elasticloadbalancing:us-east-1:0:loadbalancer/app/my-alb/1';

/** Every SetIpAddressType input the update sent. */
function setIpAddressTypeInputs(): unknown[] {
  return mockSend.mock.calls
    .filter((c) => c[0] instanceof SetIpAddressTypeCommand)
    .map((c) => (c[0] as SetIpAddressTypeCommand).input);
}

describe('ELBv2Provider LoadBalancer IpAddressType removal reset (issue #1160)', () => {
  let provider: ELBv2Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    provider = new ELBv2Provider();
  });

  // CFn A/B us-east-1 2026-10-17: a CloudFormation update dropping
  // `IpAddressType: dualstack` from an ALB set it back to `ipv4` in place.
  it('removed: dropping IpAddressType resets it to the create default "ipv4"', async () => {
    await provider.update('Alb', LB_ARN, LB, {}, { IpAddressType: 'dualstack' });

    expect(setIpAddressTypeInputs()).toEqual([{ LoadBalancerArn: LB_ARN, IpAddressType: 'ipv4' }]);
  });

  it('never-present: no IpAddressType on either side sends no SetIpAddressType', async () => {
    await provider.update('Alb', LB_ARN, LB, {}, {});

    expect(setIpAddressTypeInputs()).toEqual([]);
  });

  it('kept: a changed IpAddressType is sent as declared', async () => {
    await provider.update(
      'Alb',
      LB_ARN,
      LB,
      { IpAddressType: 'dualstack' },
      { IpAddressType: 'ipv4' }
    );

    expect(setIpAddressTypeInputs()).toEqual([
      { LoadBalancerArn: LB_ARN, IpAddressType: 'dualstack' },
    ]);
  });

  it('a removed IpAddressType that was already "ipv4" sends nothing', async () => {
    await provider.update('Alb', LB_ARN, LB, {}, { IpAddressType: 'ipv4' });

    expect(setIpAddressTypeInputs()).toEqual([]);
  });

  it('drift --revert writes no reset for a value its recorded baseline lacks', async () => {
    // The previous side is the live readback there (go-to-k/cdkd#4147 rule).
    await provider.update('Alb', LB_ARN, LB, {}, { IpAddressType: 'dualstack' }, {
      desiredFromAwsReadback: true,
    });

    expect(setIpAddressTypeInputs()).toEqual([]);
  });
});

describe('ELBv2Provider removalHandledInUpdate for LoadBalancer and TargetGroup (#1160)', () => {
  const provider = new ELBv2Provider();

  it.each([
    [LB, 14],
    [TG, 20],
  ])('%s: covers every property the provider handles', (type, count) => {
    const handled = [...provider.handledProperties.get(type)!];
    expect(handled.length).toBe(count);
    expect([...provider.removalHandledInUpdate.get(type)!].sort()).toEqual([...handled].sort());
  });

  it('a removal CloudFormation leaves in place is not named by the shared warning', () => {
    // That warning says CloudFormation would reset the value, which the A/B
    // disproved for these properties.
    const lb = prepareRemovalForUpdate(
      provider,
      LB,
      { Type: 'application' },
      {
        Type: 'application',
        LoadBalancerAttributes: [{ Key: 'idle_timeout.timeout_seconds', Value: '90' }],
        EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic: 'off',
        EnablePrefixForIpv6SourceNat: 'on',
        IpAddressType: 'dualstack',
      }
    );
    expect(lb.context.removedProperties?.size).toBe(4);
    expect(lb.unhandled).toEqual([]);
    expect(lb.injected).toEqual([]);

    const tg = prepareRemovalForUpdate(
      provider,
      TG,
      { Protocol: 'HTTP' },
      {
        Protocol: 'HTTP',
        Matcher: { HttpCode: '200-299' },
        HealthCheckPath: '/health',
        HealthCheckPort: '8080',
        TargetGroupAttributes: [{ Key: 'deregistration_delay.timeout_seconds', Value: '60' }],
      }
    );
    expect(tg.context.removedProperties?.size).toBe(4);
    expect(tg.unhandled).toEqual([]);
    expect(tg.injected).toEqual([]);
  });
});

describe('ELBv2Provider removed log-delivery LoadBalancerAttributes (#1160)', () => {
  let provider: ELBv2Provider;
  const BUCKET = 'my-log-bucket-name';
  const LOG_WARNING = 'may keep delivering logs to the bucket it names';

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    provider = new ELBv2Provider();
  });

  function attributeCalls(): unknown[] {
    return mockSend.mock.calls
      .filter((c) => c[0] instanceof ModifyLoadBalancerAttributesCommand)
      .map((c) => (c[0] as ModifyLoadBalancerAttributesCommand).input.Attributes);
  }
  function warnings(): string[] {
    return warn.mock.calls.map((c) => String(c[0]));
  }

  // CFn A/B us-east-1 2026-10-17: CloudFormation KEPT a dropped
  // access_logs.s3.enabled / bucket / prefix and connection_logs.s3.*, so the
  // keys are kept here too, with a warning naming them.
  it('keeps removed access-log keys and warns once, naming the keys but never the bucket', async () => {
    await provider.update(
      'Alb',
      LB_ARN,
      LB,
      { LoadBalancerAttributes: [{ Key: 'idle_timeout.timeout_seconds', Value: '90' }] },
      {
        LoadBalancerAttributes: [
          { Key: 'idle_timeout.timeout_seconds', Value: '90' },
          { Key: 'access_logs.s3.enabled', Value: 'true' },
          { Key: 'access_logs.s3.bucket', Value: BUCKET },
          { Key: 'connection_logs.s3.enabled', Value: 'true' },
        ],
      }
    );

    expect(attributeCalls()).toEqual([]);
    const lines = warnings().filter((w) => w.includes(LOG_WARNING));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(
      'Alb: LoadBalancerAttributes keys access_logs.s3.enabled, access_logs.s3.bucket, connection_logs.s3.enabled are no longer declared and keep their live value'
    );
    expect(lines[0]).not.toContain(BUCKET);
  });

  it('does not name a kind the desired bag turns off: only the bucket of that kind was dropped', async () => {
    await provider.update(
      'Alb',
      LB_ARN,
      LB,
      {
        LoadBalancerAttributes: [
          { Key: 'access_logs.s3.enabled', Value: 'false' },
          { Key: 'connection_logs.s3.enabled', Value: 'true' },
        ],
      },
      {
        LoadBalancerAttributes: [
          { Key: 'access_logs.s3.enabled', Value: 'true' },
          { Key: 'access_logs.s3.bucket', Value: BUCKET },
          { Key: 'connection_logs.s3.enabled', Value: 'true' },
          { Key: 'connection_logs.s3.bucket', Value: BUCKET },
        ],
      }
    );

    const lines = warnings().filter((w) => w.includes(LOG_WARNING));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('key connection_logs.s3.bucket is no longer declared');
    expect(lines[0]).not.toContain('access_logs');
  });

  it('does not warn for a removed key that is not a log-delivery key', async () => {
    await provider.update('Alb', LB_ARN, LB, {}, {
      LoadBalancerAttributes: [{ Key: 'idle_timeout.timeout_seconds', Value: '90' }],
    });

    expect(attributeCalls()).toEqual([]);
    expect(warnings().some((w) => w.includes(LOG_WARNING))).toBe(false);
  });

  it('does not warn when the log keys stay declared, even when one changes', async () => {
    await provider.update(
      'Alb',
      LB_ARN,
      LB,
      {
        LoadBalancerAttributes: [
          { Key: 'access_logs.s3.enabled', Value: 'false' },
          { Key: 'access_logs.s3.bucket', Value: BUCKET },
        ],
      },
      {
        LoadBalancerAttributes: [
          { Key: 'access_logs.s3.enabled', Value: 'true' },
          { Key: 'access_logs.s3.bucket', Value: BUCKET },
        ],
      }
    );

    expect(attributeCalls()).toEqual([[{ Key: 'access_logs.s3.enabled', Value: 'false' }]]);
    expect(warnings().some((w) => w.includes(LOG_WARNING))).toBe(false);
  });

  it('drift --revert does not print it: the readback-only key takes the #4147 warning instead', async () => {
    await provider.update(
      'Alb',
      LB_ARN,
      LB,
      { LoadBalancerAttributes: [] },
      { LoadBalancerAttributes: [{ Key: 'access_logs.s3.enabled', Value: 'true' }] },
      { desiredFromAwsReadback: true }
    );

    expect(warnings().some((w) => w.includes(LOG_WARNING))).toBe(false);
    expect(warnings().some((w) => w.includes('which the recorded baseline holds no value'))).toBe(
      true
    );
  });
});
