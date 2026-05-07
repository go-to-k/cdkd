import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DescribeLoadBalancersCommand,
  DescribeTagsCommand,
  DescribeTargetGroupsCommand,
  DescribeListenersCommand,
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
        .mockResolvedValueOnce({ TagDescriptions: [{ ResourceArn: 'arn:lb', Tags: [] }] });

      const result = await provider.readCurrentState(
        'arn:lb',
        'L',
        'AWS::ElasticLoadBalancingV2::LoadBalancer'
      );

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeLoadBalancersCommand);
      expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(DescribeTagsCommand);
      expect(result).toEqual({
        Name: 'mylb',
        Scheme: 'internet-facing',
        Type: 'application',
        IpAddressType: 'ipv4',
        Subnets: ['subnet-a', 'subnet-b'],
        SecurityGroups: ['sg-1'],
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
        .mockResolvedValueOnce({ TagDescriptions: [{ ResourceArn: 'arn:tg', Tags: [] }] });

      const result = await provider.readCurrentState(
        'arn:tg',
        'L',
        'AWS::ElasticLoadBalancingV2::TargetGroup'
      );

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeTargetGroupsCommand);
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
        Tags: [],
      });
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
        .mockResolvedValueOnce({ TagDescriptions: [{ ResourceArn: 'arn:listener', Tags: [] }] });

      const result = await provider.readCurrentState(
        'arn:listener',
        'L',
        'AWS::ElasticLoadBalancingV2::Listener'
      );

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeListenersCommand);
      expect(result).toEqual({
        LoadBalancerArn: 'arn:lb',
        Port: 443,
        Protocol: 'HTTPS',
        SslPolicy: 'ELBSecurityPolicy-2016-08',
        Certificates: [{ CertificateArn: 'arn:cert', IsDefault: true }],
        DefaultActions: [{ Type: 'forward', TargetGroupArn: 'arn:tg' }],
        Tags: [],
      });
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

  it('omits Tags when DescribeTags returns no user tags', async () => {
    mockSend
      .mockResolvedValueOnce({
        LoadBalancers: [{ LoadBalancerArn: 'arn:lb', LoadBalancerName: 'mylb' }],
      })
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
});
