import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ModifyTargetGroupCommand,
  ModifyListenerCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';

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

import { ELBv2Provider } from '../../../src/provisioning/providers/elbv2-provider.js';

const LB_ARN = 'arn:aws:elasticloadbalancing:us-east-1:0:loadbalancer/app/mylb/abc';
const TG_ARN = 'arn:aws:elasticloadbalancing:us-east-1:0:targetgroup/mytg/abc';
const LISTENER_ARN = 'arn:aws:elasticloadbalancing:us-east-1:0:listener/app/mylb/abc/def';

describe('ELBv2Provider read-update round-trip', () => {
  let provider: ELBv2Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ELBv2Provider();
  });

  // ─── LoadBalancer (immutable update) ──────────────────────────────

  it('LoadBalancer.update rejects with ResourceUpdateNotSupportedError; no spurious AWS calls', async () => {
    // LB updates are immutable in cdkd — the only safe round-trip
    // outcome is a clear error, NOT a silent no-op against AWS. The
    // drift --revert summary surfaces this as "could not revert" (vs
    // generic "AWS update failed").
    const observed = {
      Name: 'mylb',
      Subnets: ['subnet-a', 'subnet-b'],
      SecurityGroups: ['sg-1'],
      Scheme: 'internet-facing',
      Type: 'application',
      IpAddressType: 'ipv4',
      Tags: [],
    };

    await expect(
      provider.update('L', LB_ARN, 'AWS::ElasticLoadBalancingV2::LoadBalancer', observed, observed)
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);

    // No AWS calls — the error fires before any send().
    expect(mockSend).not.toHaveBeenCalled();
  });

  // ─── TargetGroup ──────────────────────────────────────────────────

  it('Class 2 — TargetGroup TCP no-drift round-trip does NOT push Matcher: {} to ModifyTargetGroup', async () => {
    // Class 2 mechanical guard. readCurrentState always-emits
    // `Matcher: {}` so console-side ADD of HttpCode is detectable;
    // ModifyTargetGroup rejects an empty Matcher with "Matcher must
    // contain either HttpCode or GrpcCode". The wire layer in
    // updateTargetGroup must drop the placeholder.
    const observed = {
      Name: 'mytg',
      Protocol: 'TCP',
      Port: 80,
      VpcId: 'vpc-1',
      TargetType: 'instance',
      HealthCheckProtocol: 'TCP',
      HealthCheckPort: 'traffic-port',
      HealthCheckEnabled: true,
      HealthCheckIntervalSeconds: 30,
      HealthCheckTimeoutSeconds: 10,
      HealthyThresholdCount: 5,
      UnhealthyThresholdCount: 2,
      // Matcher always-emit placeholder for non-HTTP target groups
      Matcher: {},
      Tags: [],
    };

    // ModifyTargetGroup → DescribeTargetGroups → DescribeTags (no tag diff)
    mockSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ TargetGroups: [{ TargetGroupName: 'mytg' }] })
      .mockResolvedValueOnce({ TagDescriptions: [{ ResourceArn: TG_ARN, Tags: [] }] });

    await provider.update(
      'L',
      TG_ARN,
      'AWS::ElasticLoadBalancingV2::TargetGroup',
      observed,
      observed
    );

    const modifyCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof ModifyTargetGroupCommand
    );
    expect(modifyCalls).toHaveLength(1);
    const input = modifyCalls[0]?.[0].input as { Matcher?: unknown };
    // The fix: empty-object Matcher is dropped from API input.
    expect(input.Matcher).toBeUndefined();
  });

  it('TargetGroup HTTP with non-empty Matcher round-trip preserves Matcher in ModifyTargetGroup', async () => {
    // Complement to the Class 2 guard: a real Matcher must still flow
    // through unchanged (only `{}` is the rejection-shape).
    const observed = {
      Name: 'mytg',
      Protocol: 'HTTP',
      Port: 80,
      VpcId: 'vpc-1',
      TargetType: 'instance',
      HealthCheckProtocol: 'HTTP',
      HealthCheckPort: 'traffic-port',
      HealthCheckPath: '/health',
      HealthCheckEnabled: true,
      Matcher: { HttpCode: '200' },
      Tags: [],
    };

    mockSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ TargetGroups: [{ TargetGroupName: 'mytg' }] })
      .mockResolvedValueOnce({ TagDescriptions: [{ ResourceArn: TG_ARN, Tags: [] }] });

    await provider.update(
      'L',
      TG_ARN,
      'AWS::ElasticLoadBalancingV2::TargetGroup',
      observed,
      observed
    );

    const modifyCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof ModifyTargetGroupCommand
    );
    expect(modifyCalls).toHaveLength(1);
    const input = modifyCalls[0]?.[0].input as { Matcher?: { HttpCode?: string } };
    expect(input.Matcher).toEqual({ HttpCode: '200' });
  });

  it('Class 1 — TargetGroup TargetType=lambda no-drift round-trip does NOT push HealthCheckPath / Matcher to ModifyTargetGroup', async () => {
    // Class 1 mechanical guard. Lambda target groups don't carry
    // HealthCheckPath / Matcher in the AWS-current snapshot
    // (readCurrentState only emits HealthCheckPath when AWS returned
    // it). The Matcher placeholder still appears as `{}` and must be
    // dropped at the wire layer (Class 2 fix subsumes the Class 1
    // case here).
    const observed = {
      Name: 'mytg-lambda',
      VpcId: 'vpc-1',
      TargetType: 'lambda',
      // HealthCheckProtocol is also not standard on lambda targets —
      // observed snapshot may omit it entirely (readCurrentState only
      // emits when AWS returned it).
      HealthCheckEnabled: false,
      Matcher: {},
      Tags: [],
    };

    mockSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ TargetGroups: [{ TargetGroupName: 'mytg-lambda' }] })
      .mockResolvedValueOnce({ TagDescriptions: [{ ResourceArn: TG_ARN, Tags: [] }] });

    await provider.update(
      'L',
      TG_ARN,
      'AWS::ElasticLoadBalancingV2::TargetGroup',
      observed,
      observed
    );

    const modifyCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof ModifyTargetGroupCommand
    );
    expect(modifyCalls).toHaveLength(1);
    const input = modifyCalls[0]?.[0].input as {
      Matcher?: unknown;
      HealthCheckPath?: unknown;
    };
    // Lambda TG has no HealthCheckPath in observed, so it must not be in API input.
    expect(input.HealthCheckPath).toBeUndefined();
    // And the empty Matcher placeholder must be dropped.
    expect(input.Matcher).toBeUndefined();
  });

  // ─── Listener ─────────────────────────────────────────────────────

  it('Listener HTTPS no-drift round-trip preserves Certificates in ModifyListener', async () => {
    // HTTPS listener has Certificates legitimately. The round-trip
    // through ModifyListener must include them (otherwise --revert
    // would clear the cert on AWS even when state and AWS agree).
    const observed = {
      LoadBalancerArn: LB_ARN,
      Port: 443,
      Protocol: 'HTTPS',
      SslPolicy: 'ELBSecurityPolicy-2016-08',
      Certificates: [{ CertificateArn: 'arn:aws:acm:us-east-1:0:certificate/abc' }],
      DefaultActions: [
        { Type: 'forward', TargetGroupArn: TG_ARN },
      ] as Array<Record<string, unknown>>,
    };

    mockSend.mockResolvedValueOnce({});

    await provider.update(
      'L',
      LISTENER_ARN,
      'AWS::ElasticLoadBalancingV2::Listener',
      observed,
      observed
    );

    const modifyCalls = mockSend.mock.calls.filter((c) => c[0] instanceof ModifyListenerCommand);
    expect(modifyCalls).toHaveLength(1);
    const input = modifyCalls[0]?.[0].input as {
      Certificates?: Array<{ CertificateArn?: string }>;
      Protocol?: string;
      SslPolicy?: string;
    };
    expect(input.Certificates).toEqual([
      { CertificateArn: 'arn:aws:acm:us-east-1:0:certificate/abc' },
    ]);
    expect(input.Protocol).toBe('HTTPS');
    expect(input.SslPolicy).toBe('ELBSecurityPolicy-2016-08');
  });

  it('Class 1 — Listener HTTP no-drift round-trip does NOT include Certificates in ModifyListener', async () => {
    // Class 1 mechanical guard. HTTP listeners don't carry
    // Certificates / SslPolicy on the AWS-current side; readListener
    // only emits Certificates with the always-emit `[]` placeholder
    // and SslPolicy not at all. ModifyListener must NOT receive
    // `Certificates: []` (AWS rejects "Certificates can only be set
    // on HTTPS / TLS listeners"). The convertCertificates helper
    // returns undefined on empty input, dropping the key.
    const observed = {
      LoadBalancerArn: LB_ARN,
      Port: 80,
      Protocol: 'HTTP',
      // Always-emit placeholder for Certificates
      Certificates: [] as Array<Record<string, unknown>>,
      DefaultActions: [
        { Type: 'forward', TargetGroupArn: TG_ARN },
      ] as Array<Record<string, unknown>>,
      // SslPolicy not in observed — readListener gates the emit on
      // AWS returning it (HTTP listeners get nothing).
    };

    mockSend.mockResolvedValueOnce({});

    await provider.update(
      'L',
      LISTENER_ARN,
      'AWS::ElasticLoadBalancingV2::Listener',
      observed,
      observed
    );

    const modifyCalls = mockSend.mock.calls.filter((c) => c[0] instanceof ModifyListenerCommand);
    expect(modifyCalls).toHaveLength(1);
    const input = modifyCalls[0]?.[0].input as {
      Certificates?: unknown;
      SslPolicy?: unknown;
      Protocol?: string;
    };
    expect(input.Certificates).toBeUndefined();
    expect(input.SslPolicy).toBeUndefined();
    expect(input.Protocol).toBe('HTTP');
  });

  // ─── Cross-type sanity check: state == AWS produces no rejection-shape ──

  it('round-trip across resource types produces no AWS-rejection-shaped inputs', async () => {
    // Aggregate guard: every wire-layer call from a no-drift
    // round-trip must produce inputs AWS accepts as idempotent.
    // Specifically:
    //  - ModifyTargetGroup must not contain Matcher: {} (Class 2)
    //  - ModifyListener must not contain Certificates: [] (Class 1)
    const tgObserved = {
      Name: 'mytg',
      Protocol: 'TCP',
      Port: 80,
      VpcId: 'vpc-1',
      TargetType: 'instance',
      HealthCheckProtocol: 'TCP',
      HealthCheckEnabled: true,
      Matcher: {},
      Tags: [],
    };
    const listenerObserved = {
      LoadBalancerArn: LB_ARN,
      Port: 80,
      Protocol: 'HTTP',
      Certificates: [] as Array<Record<string, unknown>>,
      DefaultActions: [
        { Type: 'forward', TargetGroupArn: TG_ARN },
      ] as Array<Record<string, unknown>>,
    };

    // TG: ModifyTargetGroup → DescribeTargetGroups → DescribeTags
    mockSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ TargetGroups: [{ TargetGroupName: 'mytg' }] })
      .mockResolvedValueOnce({ TagDescriptions: [{ ResourceArn: TG_ARN, Tags: [] }] });
    await provider.update(
      'TG',
      TG_ARN,
      'AWS::ElasticLoadBalancingV2::TargetGroup',
      tgObserved,
      tgObserved
    );

    // Listener: ModifyListener
    mockSend.mockResolvedValueOnce({});
    await provider.update(
      'LST',
      LISTENER_ARN,
      'AWS::ElasticLoadBalancingV2::Listener',
      listenerObserved,
      listenerObserved
    );

    const modifyTGCall = mockSend.mock.calls.find((c) => c[0] instanceof ModifyTargetGroupCommand);
    const modifyListenerCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof ModifyListenerCommand
    );

    const tgInput = modifyTGCall?.[0].input as { Matcher?: unknown };
    expect(tgInput.Matcher).toBeUndefined();

    const listenerInput = modifyListenerCall?.[0].input as { Certificates?: unknown };
    expect(listenerInput.Certificates).toBeUndefined();
  });
});
