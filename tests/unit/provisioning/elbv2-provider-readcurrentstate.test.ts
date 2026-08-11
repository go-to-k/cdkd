import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  DescribeLoadBalancersCommand,
  DescribeLoadBalancerAttributesCommand,
  DescribeCapacityReservationCommand,
  DescribeTagsCommand,
  DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand,
  DescribeListenersCommand,
  DescribeListenerAttributesCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';

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

describe('ELBv2Provider.readCurrentState', () => {
  let provider: ELBv2Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ELBv2Provider();
  });

  describe('AWS::ElasticLoadBalancingV2::LoadBalancer', () => {
    it('returns CFn-shaped LB properties (happy path)', async () => {
      mockSend
        .mockResolvedValueOnce({
          LoadBalancers: [
            {
              LoadBalancerArn: 'arn:lb',
              LoadBalancerName: 'mylb',
              Scheme: 'internet-facing',
              Type: 'application',
              IpAddressType: 'ipv4',
              AvailabilityZones: [{ SubnetId: 'subnet-a' }, { SubnetId: 'subnet-b' }],
              SecurityGroups: ['sg-1'],
            },
          ],
        })
        // DescribeCapacityReservation (#609) — no reservation set.
        .mockResolvedValueOnce({})
        // DescribeLoadBalancerAttributes returns lex-unsorted; the
        // provider re-sorts.
        .mockResolvedValueOnce({
          Attributes: [
            { Key: 'idle_timeout.timeout_seconds', Value: '60' },
            { Key: 'access_logs.s3.enabled', Value: 'false' },
          ],
        })
        .mockResolvedValueOnce({ TagDescriptions: [{ ResourceArn: 'arn:lb', Tags: [] }] });

      const result = await provider.readCurrentState(
        'arn:lb',
        'L',
        'AWS::ElasticLoadBalancingV2::LoadBalancer'
      );

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeLoadBalancersCommand);
      expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(DescribeCapacityReservationCommand);
      expect(mockSend.mock.calls[2]?.[0]).toBeInstanceOf(DescribeLoadBalancerAttributesCommand);
      expect(mockSend.mock.calls[3]?.[0]).toBeInstanceOf(DescribeTagsCommand);
      expect(result).toEqual({
        Name: 'mylb',
        Scheme: 'internet-facing',
        Type: 'application',
        IpAddressType: 'ipv4',
        Subnets: ['subnet-a', 'subnet-b'],
        SecurityGroups: ['sg-1'],
        // Sorted by Key.
        LoadBalancerAttributes: [
          { Key: 'access_logs.s3.enabled', Value: 'false' },
          { Key: 'idle_timeout.timeout_seconds', Value: '60' },
        ],
        Tags: [],
      });
    });

    it('returns undefined when LB is gone', async () => {
      mockSend.mockRejectedValueOnce(
        Object.assign(new Error('not found'), { name: 'LoadBalancerNotFoundException' })
      );
      const result = await provider.readCurrentState(
        'arn:lb',
        'L',
        'AWS::ElasticLoadBalancingV2::LoadBalancer'
      );
      expect(result).toBeUndefined();
    });
  });

  describe('AWS::ElasticLoadBalancingV2::TargetGroup', () => {
    it('returns CFn-shaped TG properties (happy path)', async () => {
      mockSend
        .mockResolvedValueOnce({
          TargetGroups: [
            {
              TargetGroupArn: 'arn:tg',
              TargetGroupName: 'mytg',
              Protocol: 'HTTP',
              Port: 80,
              VpcId: 'vpc-1',
              TargetType: 'ip',
              HealthCheckProtocol: 'HTTP',
              HealthCheckPort: '80',
              HealthCheckPath: '/health',
              HealthCheckEnabled: true,
              HealthCheckIntervalSeconds: 30,
              HealthCheckTimeoutSeconds: 5,
              HealthyThresholdCount: 2,
              UnhealthyThresholdCount: 3,
              Matcher: { HttpCode: '200' },
            },
          ],
        })
        // DescribeTargetGroupAttributes (#609) — full set, provider sorts.
        .mockResolvedValueOnce({
          Attributes: [{ Key: 'deregistration_delay.timeout_seconds', Value: '300' }],
        })
        // DescribeTargetHealth (#1620) — the registered target set. Port 8080
        // differs from the group's own 80, so it survives the default-drop.
        .mockResolvedValueOnce({
          TargetHealthDescriptions: [
            { Target: { Id: '10.0.1.10', Port: 8080 }, TargetHealth: { State: 'healthy' } },
          ],
        })
        .mockResolvedValueOnce({ TagDescriptions: [{ ResourceArn: 'arn:tg', Tags: [] }] });

      const result = await provider.readCurrentState(
        'arn:tg',
        'L',
        'AWS::ElasticLoadBalancingV2::TargetGroup'
      );

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeTargetGroupsCommand);
      expect(mockSend.mock.calls[2]?.[0]).toBeInstanceOf(DescribeTargetHealthCommand);
      expect(result).toEqual({
        Name: 'mytg',
        Protocol: 'HTTP',
        Port: 80,
        VpcId: 'vpc-1',
        TargetType: 'ip',
        HealthCheckProtocol: 'HTTP',
        HealthCheckPort: '80',
        HealthCheckPath: '/health',
        HealthCheckEnabled: true,
        HealthCheckIntervalSeconds: 30,
        HealthCheckTimeoutSeconds: 5,
        HealthyThresholdCount: 2,
        UnhealthyThresholdCount: 3,
        Matcher: { HttpCode: '200' },
        TargetGroupAttributes: [{ Key: 'deregistration_delay.timeout_seconds', Value: '300' }],
        Targets: [{ Id: '10.0.1.10', Port: 8080 }],
        Tags: [],
      });
    });

    describe('Targets readback (issue #1620)', () => {
      const targetGroupHead = {
        TargetGroups: [{ TargetGroupArn: 'arn:tg', TargetGroupName: 'mytg', TargetType: 'ip' }],
      };

      async function readTargets(
        healthResponse: unknown
      ): Promise<Record<string, unknown> | undefined> {
        mockSend
          .mockResolvedValueOnce(targetGroupHead)
          .mockResolvedValueOnce({ Attributes: [] })
          .mockResolvedValueOnce(healthResponse)
          .mockResolvedValueOnce({ TagDescriptions: [{ ResourceArn: 'arn:tg', Tags: [] }] });
        return provider.readCurrentState(
          'arn:tg',
          'L',
          'AWS::ElasticLoadBalancingV2::TargetGroup'
        );
      }

      it('EXCLUDES a draining target so a deregistration in flight is not frozen into the baseline', async () => {
        const result = await readTargets({
          TargetHealthDescriptions: [
            { Target: { Id: '10.0.1.10', Port: 80 }, TargetHealth: { State: 'healthy' } },
            { Target: { Id: '10.0.1.99', Port: 80 }, TargetHealth: { State: 'draining' } },
          ],
        });
        expect(result?.['Targets']).toEqual([{ Id: '10.0.1.10', Port: 80 }]);
      });

      it('INCLUDES every non-draining state — registration is not health', async () => {
        // The polarity the draining test above cannot pin: an `unused` /
        // `unhealthy` / `initial` target IS registered, so dropping it would
        // report a live target as removed.
        const result = await readTargets({
          TargetHealthDescriptions: [
            { Target: { Id: '10.0.1.10', Port: 80 }, TargetHealth: { State: 'initial' } },
            { Target: { Id: '10.0.1.11', Port: 80 }, TargetHealth: { State: 'unused' } },
            { Target: { Id: '10.0.1.12', Port: 80 }, TargetHealth: { State: 'unhealthy' } },
            { Target: { Id: '10.0.1.13', Port: 80 }, TargetHealth: { State: 'unavailable' } },
            { Target: { Id: '10.0.1.14', Port: 80 } },
          ],
        });
        expect((result?.['Targets'] as Array<{ Id: string }>).map((t) => t.Id)).toEqual([
          '10.0.1.10',
          '10.0.1.11',
          '10.0.1.12',
          '10.0.1.13',
          '10.0.1.14',
        ]);
      });

      it("drops the AvailabilityZone AWS substitutes as 'all' but keeps a real one", async () => {
        const result = await readTargets({
          TargetHealthDescriptions: [
            {
              Target: { Id: '10.0.1.10', Port: 8080, AvailabilityZone: 'all' },
              TargetHealth: { State: 'healthy' },
            },
            {
              Target: { Id: '10.0.1.11', Port: 8080, AvailabilityZone: 'us-east-1a' },
              TargetHealth: { State: 'healthy' },
            },
          ],
        });
        expect(result?.['Targets']).toEqual([
          { Id: '10.0.1.10', Port: 8080 },
          { Id: '10.0.1.11', Port: 8080, AvailabilityZone: 'us-east-1a' },
        ]);
      });

      it('drops the AvailabilityZone entirely on a non-ip target group', async () => {
        // CFn only accepts the member for `ip` targets, and DeregisterTargets
        // rejects it on an instance group — so echoing it back would make
        // `--revert` fail on exactly the resources it is meant to repair.
        mockSend
          .mockResolvedValueOnce({
            TargetGroups: [
              {
                TargetGroupArn: 'arn:tg',
                TargetGroupName: 'mytg',
                TargetType: 'instance',
                Port: 80,
              },
            ],
          })
          .mockResolvedValueOnce({ Attributes: [] })
          .mockResolvedValueOnce({
            TargetHealthDescriptions: [
              {
                Target: { Id: 'i-0abc', Port: 8080, AvailabilityZone: 'us-east-1a' },
                TargetHealth: { State: 'healthy' },
              },
            ],
          })
          .mockResolvedValueOnce({ TagDescriptions: [{ ResourceArn: 'arn:tg', Tags: [] }] });

        const result = await provider.readCurrentState(
          'arn:tg',
          'L',
          'AWS::ElasticLoadBalancingV2::TargetGroup'
        );
        expect(result?.['Targets']).toEqual([{ Id: 'i-0abc', Port: 8080 }]);
      });

      it('drops the Port AWS substitutes from the target group itself, keeps an override', async () => {
        // The destructive case (#1635 review): a template `Targets: [{Id}]`
        // reads back as `{Id, Port: <group port>}`, and `updateTargetGroup`
        // keys its register/deregister diff on the whole tuple — so the extra
        // member makes the SAME live target look like a different one and
        // `drift --revert` deregisters it.
        mockSend
          .mockResolvedValueOnce({
            TargetGroups: [
              { TargetGroupArn: 'arn:tg', TargetGroupName: 'mytg', TargetType: 'ip', Port: 80 },
            ],
          })
          .mockResolvedValueOnce({ Attributes: [] })
          .mockResolvedValueOnce({
            TargetHealthDescriptions: [
              { Target: { Id: '10.0.1.10', Port: 80 }, TargetHealth: { State: 'healthy' } },
              { Target: { Id: '10.0.1.11', Port: 9000 }, TargetHealth: { State: 'healthy' } },
            ],
          })
          .mockResolvedValueOnce({ TagDescriptions: [{ ResourceArn: 'arn:tg', Tags: [] }] });

        const result = await provider.readCurrentState(
          'arn:tg',
          'L',
          'AWS::ElasticLoadBalancingV2::TargetGroup'
        );
        expect(result?.['Targets']).toEqual([
          { Id: '10.0.1.10' },
          { Id: '10.0.1.11', Port: 9000 },
        ]);
      });

      it('emits an empty list when no target is registered', async () => {
        const result = await readTargets({ TargetHealthDescriptions: [] });
        expect(result?.['Targets']).toEqual([]);
      });

      it('leaves Targets ABSENT when the health read fails (no permission), never empty', async () => {
        // An empty list would read as "every target was removed" and
        // `--revert` would then re-register them all.
        mockSend
          .mockResolvedValueOnce(targetGroupHead)
          .mockResolvedValueOnce({ Attributes: [] })
          .mockRejectedValueOnce(
            Object.assign(new Error('denied'), { name: 'AccessDeniedException' })
          )
          .mockResolvedValueOnce({ TagDescriptions: [{ ResourceArn: 'arn:tg', Tags: [] }] });

        const result = await provider.readCurrentState(
          'arn:tg',
          'L',
          'AWS::ElasticLoadBalancingV2::TargetGroup'
        );
        expect(result).toBeDefined();
        expect('Targets' in (result as Record<string, unknown>)).toBe(false);
      });
    });

    it('declares Targets UNORDERED and no longer declares it unknown', () => {
      expect(provider.getDriftUnorderedPaths('AWS::ElasticLoadBalancingV2::TargetGroup')).toEqual([
        'Targets',
      ]);
      expect(provider.getDriftUnknownPaths('AWS::ElasticLoadBalancingV2::TargetGroup')).toEqual([]);
      // Scoped to the TargetGroup type only.
      expect(provider.getDriftUnorderedPaths('AWS::ElasticLoadBalancingV2::LoadBalancer')).toEqual(
        []
      );
    });
  });

  describe('AWS::ElasticLoadBalancingV2::Listener', () => {
    it('returns CFn-shaped Listener properties (happy path)', async () => {
      mockSend
        .mockResolvedValueOnce({
          Listeners: [
            {
              ListenerArn: 'arn:listener',
              LoadBalancerArn: 'arn:lb',
              Port: 443,
              Protocol: 'HTTPS',
              SslPolicy: 'ELBSecurityPolicy-2016-08',
              Certificates: [{ CertificateArn: 'arn:cert', IsDefault: true }],
              DefaultActions: [{ Type: 'forward', TargetGroupArn: 'arn:tg' }],
            },
          ],
        })
        // DescribeListenerAttributes — AWS returns the full set unsorted; the
        // provider sorts by Key.
        .mockResolvedValueOnce({
          Attributes: [
            { Key: 'tcp.idle_timeout.seconds', Value: '350' },
            { Key: 'routing.http.response.server.enabled', Value: 'true' },
          ],
        })
        .mockResolvedValueOnce({ TagDescriptions: [{ ResourceArn: 'arn:listener', Tags: [] }] });

      const result = await provider.readCurrentState(
        'arn:listener',
        'L',
        'AWS::ElasticLoadBalancingV2::Listener'
      );

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeListenersCommand);
      expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(DescribeListenerAttributesCommand);
      expect(result).toEqual({
        LoadBalancerArn: 'arn:lb',
        Port: 443,
        Protocol: 'HTTPS',
        SslPolicy: 'ELBSecurityPolicy-2016-08',
        Certificates: [{ CertificateArn: 'arn:cert', IsDefault: true }],
        DefaultActions: [{ Type: 'forward', TargetGroupArn: 'arn:tg' }],
        AlpnPolicy: [],
        MutualAuthentication: {},
        // Sorted by Key for stable positional compare.
        ListenerAttributes: [
          { Key: 'routing.http.response.server.enabled', Value: 'true' },
          { Key: 'tcp.idle_timeout.seconds', Value: '350' },
        ],
        Tags: [],
      });
    });

    it('surfaces AlpnPolicy + MutualAuthentication when AWS returns them (TLS listener)', async () => {
      mockSend
        .mockResolvedValueOnce({
          Listeners: [
            {
              ListenerArn: 'arn:listener',
              LoadBalancerArn: 'arn:lb',
              Port: 443,
              Protocol: 'TLS',
              AlpnPolicy: ['HTTP2Preferred'],
              MutualAuthentication: { Mode: 'verify', TrustStoreArn: 'arn:ts' },
              DefaultActions: [{ Type: 'forward', TargetGroupArn: 'arn:tg' }],
            },
          ],
        })
        .mockResolvedValueOnce({ Attributes: [] })
        .mockResolvedValueOnce({ TagDescriptions: [{ ResourceArn: 'arn:listener', Tags: [] }] });

      const result = await provider.readCurrentState(
        'arn:listener',
        'L',
        'AWS::ElasticLoadBalancingV2::Listener'
      );
      expect(result).toMatchObject({
        AlpnPolicy: ['HTTP2Preferred'],
        MutualAuthentication: { Mode: 'verify', TrustStoreArn: 'arn:ts' },
      });
    });

    it('emits ListenerAttributes sorted by Key from DescribeListenerAttributes', async () => {
      mockSend
        .mockResolvedValueOnce({
          Listeners: [
            {
              ListenerArn: 'arn:listener',
              LoadBalancerArn: 'arn:lb',
              Port: 80,
              Protocol: 'HTTP',
              DefaultActions: [{ Type: 'forward', TargetGroupArn: 'arn:tg' }],
            },
          ],
        })
        .mockResolvedValueOnce({
          Attributes: [
            { Key: 'tcp.idle_timeout.seconds', Value: '3600' },
            { Key: 'routing.http.response.server.enabled', Value: 'false' },
          ],
        })
        .mockResolvedValueOnce({ TagDescriptions: [{ ResourceArn: 'arn:listener', Tags: [] }] });

      const result = await provider.readCurrentState(
        'arn:listener',
        'L',
        'AWS::ElasticLoadBalancingV2::Listener'
      );
      expect(result).toMatchObject({
        ListenerAttributes: [
          { Key: 'routing.http.response.server.enabled', Value: 'false' },
          { Key: 'tcp.idle_timeout.seconds', Value: '3600' },
        ],
      });
    });

    it('leaves ListenerAttributes absent when DescribeListenerAttributes errors (no false drift)', async () => {
      mockSend
        .mockResolvedValueOnce({
          Listeners: [
            {
              ListenerArn: 'arn:listener',
              LoadBalancerArn: 'arn:lb',
              Port: 80,
              Protocol: 'HTTP',
              DefaultActions: [{ Type: 'forward', TargetGroupArn: 'arn:tg' }],
            },
          ],
        })
        .mockRejectedValueOnce(new Error('AccessDenied'))
        .mockResolvedValueOnce({ TagDescriptions: [{ ResourceArn: 'arn:listener', Tags: [] }] });

      const result = await provider.readCurrentState(
        'arn:listener',
        'L',
        'AWS::ElasticLoadBalancingV2::Listener'
      );
      expect(result).toBeDefined();
      expect(result).not.toHaveProperty('ListenerAttributes');
    });

    it('returns undefined when listener is gone', async () => {
      mockSend.mockRejectedValueOnce(
        Object.assign(new Error('not found'), { name: 'ListenerNotFoundException' })
      );
      const result = await provider.readCurrentState(
        'arn:listener',
        'L',
        'AWS::ElasticLoadBalancingV2::Listener'
      );
      expect(result).toBeUndefined();
    });
  });

  it('surfaces LoadBalancer Tags from DescribeTags with aws:* filtered out', async () => {
    mockSend
      .mockResolvedValueOnce({
        LoadBalancers: [{ LoadBalancerArn: 'arn:lb', LoadBalancerName: 'mylb' }],
      })
      .mockResolvedValueOnce({}) // DescribeCapacityReservation (#609)
      .mockResolvedValueOnce({ Attributes: [] })
      .mockResolvedValueOnce({
        TagDescriptions: [
          {
            ResourceArn: 'arn:lb',
            Tags: [
              { Key: 'Foo', Value: 'Bar' },
              { Key: 'aws:cdk:path', Value: 'MyStack/MyLB/Resource' },
            ],
          },
        ],
      });

    const result = await provider.readCurrentState(
      'arn:lb',
      'L',
      'AWS::ElasticLoadBalancingV2::LoadBalancer'
    );
    expect(result?.Tags).toEqual([{ Key: 'Foo', Value: 'Bar' }]);
  });

  it('emits empty Tags array when DescribeTags returns no user tags', async () => {
    mockSend
      .mockResolvedValueOnce({
        LoadBalancers: [{ LoadBalancerArn: 'arn:lb', LoadBalancerName: 'mylb' }],
      })
      .mockResolvedValueOnce({}) // DescribeCapacityReservation (#609)
      .mockResolvedValueOnce({ Attributes: [] })
      .mockResolvedValueOnce({
        TagDescriptions: [
          {
            ResourceArn: 'arn:lb',
            Tags: [{ Key: 'aws:cdk:path', Value: 'MyStack/MyLB/Resource' }],
          },
        ],
      });

    const result = await provider.readCurrentState(
      'arn:lb',
      'L',
      'AWS::ElasticLoadBalancingV2::LoadBalancer'
    );
    expect(result?.Tags).toEqual([]);
  });

  it('emits empty LoadBalancerAttributes array when DescribeLoadBalancerAttributes returns none', async () => {
    mockSend
      .mockResolvedValueOnce({
        LoadBalancers: [{ LoadBalancerArn: 'arn:lb', LoadBalancerName: 'mylb' }],
      })
      .mockResolvedValueOnce({}) // DescribeCapacityReservation (#609)
      .mockResolvedValueOnce({ Attributes: [] })
      .mockResolvedValueOnce({ TagDescriptions: [{ ResourceArn: 'arn:lb', Tags: [] }] });

    const result = await provider.readCurrentState(
      'arn:lb',
      'L',
      'AWS::ElasticLoadBalancingV2::LoadBalancer'
    );
    expect(result?.LoadBalancerAttributes).toEqual([]);
  });
});
