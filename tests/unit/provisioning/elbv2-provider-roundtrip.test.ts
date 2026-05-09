import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ModifyTargetGroupCommand,
  ModifyListenerCommand,
  ModifyLoadBalancerAttributesCommand,
  SetSubnetsCommand,
  SetSecurityGroupsCommand,
  SetIpAddressTypeCommand,
  AddTagsCommand,
  RemoveTagsCommand,
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

  // ─── LoadBalancer (mostly-immutable update) ───────────────────────

  it('LoadBalancer.update is a clean no-op when only LoadBalancerAttributes match between observed and itself', async () => {
    // No-drift round-trip: same observed on both sides, no diff, no
    // AWS call. The previous immutable-only behavior would have thrown
    // here; with LoadBalancerAttributes now mutable in update() the
    // no-diff case must be a clean pass-through.
    const observed = {
      Name: 'mylb',
      Subnets: ['subnet-a', 'subnet-b'],
      SecurityGroups: ['sg-1'],
      Scheme: 'internet-facing',
      Type: 'application',
      IpAddressType: 'ipv4',
      LoadBalancerAttributes: [{ Key: 'idle_timeout.timeout_seconds', Value: '60' }],
      Tags: [],
    };

    const result = await provider.update(
      'L',
      LB_ARN,
      'AWS::ElasticLoadBalancingV2::LoadBalancer',
      observed,
      observed
    );

    expect(result).toEqual({ physicalId: LB_ARN, wasReplaced: false });
    // No diff between newAttrs and oldAttrs → no Modify call.
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('LoadBalancer.update rejects with ResourceUpdateNotSupportedError when an immutable field changed', async () => {
    // Scheme is immutable. The deploy engine triggers replacement via
    // immutable-property detection, but if --revert ever lands here
    // with such a diff we must surface a clear error rather than
    // silently no-op'ing.
    await expect(
      provider.update(
        'L',
        LB_ARN,
        'AWS::ElasticLoadBalancingV2::LoadBalancer',
        { Scheme: 'internet-facing' },
        { Scheme: 'internal' }
      )
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('LoadBalancer.update wires SetSubnets when Subnets change', async () => {
    mockSend.mockResolvedValueOnce({});
    await provider.update(
      'L',
      LB_ARN,
      'AWS::ElasticLoadBalancingV2::LoadBalancer',
      { Subnets: ['subnet-a', 'subnet-c'] },
      { Subnets: ['subnet-a', 'subnet-b'] }
    );
    const call = mockSend.mock.calls.find((c) => c[0] instanceof SetSubnetsCommand);
    expect(call).toBeDefined();
    expect(call?.[0].input).toMatchObject({
      LoadBalancerArn: LB_ARN,
      Subnets: ['subnet-a', 'subnet-c'],
    });
  });

  it('LoadBalancer.update prefers SubnetMappings over Subnets when both present', async () => {
    mockSend.mockResolvedValueOnce({});
    const newMappings = [
      { SubnetId: 'subnet-a', AllocationId: 'eipalloc-1' },
      { SubnetId: 'subnet-b' },
    ];
    await provider.update(
      'L',
      LB_ARN,
      'AWS::ElasticLoadBalancingV2::LoadBalancer',
      { Subnets: ['subnet-a', 'subnet-b'], SubnetMappings: newMappings },
      { Subnets: ['subnet-a', 'subnet-b'], SubnetMappings: [{ SubnetId: 'subnet-a' }] }
    );
    const call = mockSend.mock.calls.find((c) => c[0] instanceof SetSubnetsCommand);
    expect(call).toBeDefined();
    const input = call?.[0].input as { Subnets?: unknown; SubnetMappings?: unknown };
    expect(input.SubnetMappings).toEqual(newMappings);
    // Subnets must NOT be sent alongside SubnetMappings (full-replace).
    expect(input.Subnets).toBeUndefined();
  });

  it('LoadBalancer.update no-ops Subnets/SubnetMappings when unchanged', async () => {
    const same = {
      Subnets: ['subnet-a', 'subnet-b'],
    };
    await provider.update('L', LB_ARN, 'AWS::ElasticLoadBalancingV2::LoadBalancer', same, same);
    expect(mockSend.mock.calls.find((c) => c[0] instanceof SetSubnetsCommand)).toBeUndefined();
  });

  it('LoadBalancer.update wires SetSecurityGroups when SecurityGroups change', async () => {
    mockSend.mockResolvedValueOnce({});
    await provider.update(
      'L',
      LB_ARN,
      'AWS::ElasticLoadBalancingV2::LoadBalancer',
      { SecurityGroups: ['sg-1', 'sg-2'] },
      { SecurityGroups: ['sg-1'] }
    );
    const call = mockSend.mock.calls.find((c) => c[0] instanceof SetSecurityGroupsCommand);
    expect(call).toBeDefined();
    expect(call?.[0].input).toMatchObject({
      LoadBalancerArn: LB_ARN,
      SecurityGroups: ['sg-1', 'sg-2'],
    });
  });

  it('LoadBalancer.update no-ops SecurityGroups when unchanged', async () => {
    const same = { SecurityGroups: ['sg-1'] };
    await provider.update('L', LB_ARN, 'AWS::ElasticLoadBalancingV2::LoadBalancer', same, same);
    expect(
      mockSend.mock.calls.find((c) => c[0] instanceof SetSecurityGroupsCommand)
    ).toBeUndefined();
  });

  it('LoadBalancer.update wires SetIpAddressType when IpAddressType changes', async () => {
    mockSend.mockResolvedValueOnce({});
    await provider.update(
      'L',
      LB_ARN,
      'AWS::ElasticLoadBalancingV2::LoadBalancer',
      { IpAddressType: 'dualstack' },
      { IpAddressType: 'ipv4' }
    );
    const call = mockSend.mock.calls.find((c) => c[0] instanceof SetIpAddressTypeCommand);
    expect(call).toBeDefined();
    expect(call?.[0].input).toMatchObject({
      LoadBalancerArn: LB_ARN,
      IpAddressType: 'dualstack',
    });
  });

  it('LoadBalancer.update no-ops IpAddressType when unchanged', async () => {
    const same = { IpAddressType: 'ipv4' };
    await provider.update('L', LB_ARN, 'AWS::ElasticLoadBalancingV2::LoadBalancer', same, same);
    expect(
      mockSend.mock.calls.find((c) => c[0] instanceof SetIpAddressTypeCommand)
    ).toBeUndefined();
  });

  it('LoadBalancer.update wires AddTags / RemoveTags on tag diff', async () => {
    // Add Foo=Bar, remove Old. Wire shape mirrors applyTagDiff.
    mockSend
      .mockResolvedValueOnce({}) // RemoveTags
      .mockResolvedValueOnce({}); // AddTags
    await provider.update(
      'L',
      LB_ARN,
      'AWS::ElasticLoadBalancingV2::LoadBalancer',
      { Tags: [{ Key: 'Foo', Value: 'Bar' }] },
      { Tags: [{ Key: 'Old', Value: 'Gone' }] }
    );
    const remove = mockSend.mock.calls.find((c) => c[0] instanceof RemoveTagsCommand);
    const add = mockSend.mock.calls.find((c) => c[0] instanceof AddTagsCommand);
    expect(remove?.[0].input).toMatchObject({ ResourceArns: [LB_ARN], TagKeys: ['Old'] });
    expect(add?.[0].input).toMatchObject({
      ResourceArns: [LB_ARN],
      Tags: [{ Key: 'Foo', Value: 'Bar' }],
    });
  });

  it('LoadBalancer.update wires only LoadBalancerAttributes when only that field changed', async () => {
    // Regression guard for the PR #175 path: nothing else fires.
    mockSend.mockResolvedValueOnce({});
    await provider.update(
      'L',
      LB_ARN,
      'AWS::ElasticLoadBalancingV2::LoadBalancer',
      { LoadBalancerAttributes: [{ Key: 'idle_timeout.timeout_seconds', Value: '120' }] },
      { LoadBalancerAttributes: [{ Key: 'idle_timeout.timeout_seconds', Value: '60' }] }
    );
    expect(
      mockSend.mock.calls.find((c) => c[0] instanceof ModifyLoadBalancerAttributesCommand)
    ).toBeDefined();
    expect(mockSend.mock.calls.find((c) => c[0] instanceof SetSubnetsCommand)).toBeUndefined();
    expect(
      mockSend.mock.calls.find((c) => c[0] instanceof SetSecurityGroupsCommand)
    ).toBeUndefined();
    expect(
      mockSend.mock.calls.find((c) => c[0] instanceof SetIpAddressTypeCommand)
    ).toBeUndefined();
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

  it('Listener.update forwards AlpnPolicy on diff', async () => {
    mockSend.mockResolvedValueOnce({});
    await provider.update(
      'L',
      LISTENER_ARN,
      'AWS::ElasticLoadBalancingV2::Listener',
      {
        LoadBalancerArn: LB_ARN,
        Port: 443,
        Protocol: 'TLS',
        AlpnPolicy: ['HTTP2Only'],
        DefaultActions: [{ Type: 'forward', TargetGroupArn: TG_ARN }],
      },
      {
        LoadBalancerArn: LB_ARN,
        Port: 443,
        Protocol: 'TLS',
        AlpnPolicy: ['HTTP1Only'],
        DefaultActions: [{ Type: 'forward', TargetGroupArn: TG_ARN }],
      }
    );
    const call = mockSend.mock.calls.find((c) => c[0] instanceof ModifyListenerCommand);
    expect(call).toBeDefined();
    expect(call?.[0].input).toMatchObject({ AlpnPolicy: ['HTTP2Only'] });
  });

  it('Listener.update forwards MutualAuthentication on diff', async () => {
    mockSend.mockResolvedValueOnce({});
    const newMutual = { Mode: 'verify', TrustStoreArn: 'arn:ts' };
    await provider.update(
      'L',
      LISTENER_ARN,
      'AWS::ElasticLoadBalancingV2::Listener',
      {
        LoadBalancerArn: LB_ARN,
        Port: 443,
        Protocol: 'HTTPS',
        MutualAuthentication: newMutual,
        DefaultActions: [{ Type: 'forward', TargetGroupArn: TG_ARN }],
      },
      {
        LoadBalancerArn: LB_ARN,
        Port: 443,
        Protocol: 'HTTPS',
        MutualAuthentication: { Mode: 'off' },
        DefaultActions: [{ Type: 'forward', TargetGroupArn: TG_ARN }],
      }
    );
    const call = mockSend.mock.calls.find((c) => c[0] instanceof ModifyListenerCommand);
    expect(call).toBeDefined();
    expect(call?.[0].input).toMatchObject({ MutualAuthentication: newMutual });
  });

  it('Listener.update drops empty AlpnPolicy [] placeholder', async () => {
    // Round-trip from readListener emits AlpnPolicy: [] for non-TLS
    // listeners. ModifyListener rejects an empty AlpnPolicy on non-TLS,
    // so the wire layer must drop the placeholder.
    const observed = {
      LoadBalancerArn: LB_ARN,
      Port: 80,
      Protocol: 'HTTP',
      AlpnPolicy: [] as string[],
      DefaultActions: [{ Type: 'forward', TargetGroupArn: TG_ARN }],
    };
    mockSend.mockResolvedValueOnce({});
    await provider.update(
      'L',
      LISTENER_ARN,
      'AWS::ElasticLoadBalancingV2::Listener',
      observed,
      observed
    );
    const call = mockSend.mock.calls.find((c) => c[0] instanceof ModifyListenerCommand);
    expect(call).toBeDefined();
    const input = call?.[0].input as { AlpnPolicy?: unknown };
    expect(input.AlpnPolicy).toBeUndefined();
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
