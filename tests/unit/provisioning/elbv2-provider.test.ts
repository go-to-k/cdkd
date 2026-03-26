import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock AWS clients before importing the provider
const mockSend = vi.fn();

vi.mock('@aws-sdk/client-elastic-load-balancing-v2', async () => {
  const actual = await vi.importActual('@aws-sdk/client-elastic-load-balancing-v2');
  return {
    ...actual,
    ElasticLoadBalancingV2Client: vi.fn().mockImplementation(() => ({ send: mockSend })),
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

describe('ELBv2Provider', () => {
  let provider: ELBv2Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ELBv2Provider();
  });

  // ─── LoadBalancer ───────────────────────────────────────────────────

  describe('LoadBalancer', () => {
    describe('create', () => {
      it('should create a LoadBalancer and return ARN with attributes', async () => {
        mockSend.mockResolvedValueOnce({
          LoadBalancers: [
            {
              LoadBalancerArn:
                'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/my-alb/1234567890abcdef',
              DNSName: 'my-alb-123456789.us-east-1.elb.amazonaws.com',
              CanonicalHostedZoneId: 'Z35SXDOTRQ7X7K',
              LoadBalancerName: 'my-alb',
            },
          ],
        });

        const result = await provider.create(
          'MyALB',
          'AWS::ElasticLoadBalancingV2::LoadBalancer',
          {
            Name: 'my-alb',
            Subnets: ['subnet-111', 'subnet-222'],
            SecurityGroups: ['sg-123'],
            Scheme: 'internet-facing',
            Type: 'application',
          }
        );

        expect(result.physicalId).toBe(
          'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/my-alb/1234567890abcdef'
        );
        expect(result.attributes).toEqual({
          DNSName: 'my-alb-123456789.us-east-1.elb.amazonaws.com',
          CanonicalHostedZoneID: 'Z35SXDOTRQ7X7K',
          LoadBalancerArn:
            'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/my-alb/1234567890abcdef',
          LoadBalancerFullName: 'app/my-alb/1234567890abcdef',
          LoadBalancerName: 'my-alb',
        });
        expect(mockSend).toHaveBeenCalledTimes(1);

        const createCall = mockSend.mock.calls[0][0];
        expect(createCall.constructor.name).toBe('CreateLoadBalancerCommand');
        expect(createCall.input.Name).toBe('my-alb');
        expect(createCall.input.Subnets).toEqual(['subnet-111', 'subnet-222']);
      });

      it('should throw ProvisioningError on failure', async () => {
        mockSend.mockRejectedValueOnce(new Error('Access Denied'));

        await expect(
          provider.create('MyALB', 'AWS::ElasticLoadBalancingV2::LoadBalancer', {
            Name: 'my-alb',
            Subnets: ['subnet-111'],
          })
        ).rejects.toThrow('Failed to create LoadBalancer MyALB');
      });
    });

    describe('delete', () => {
      it('should delete a LoadBalancer', async () => {
        mockSend.mockResolvedValueOnce({});

        await provider.delete(
          'MyALB',
          'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/my-alb/1234567890abcdef',
          'AWS::ElasticLoadBalancingV2::LoadBalancer'
        );

        expect(mockSend).toHaveBeenCalledTimes(1);
        const deleteCall = mockSend.mock.calls[0][0];
        expect(deleteCall.constructor.name).toBe('DeleteLoadBalancerCommand');
      });

      it('should handle not-found gracefully', async () => {
        const notFoundError = new Error('LoadBalancer does not exist');
        (notFoundError as { name: string }).name = 'LoadBalancerNotFoundException';
        mockSend.mockRejectedValueOnce(notFoundError);

        await provider.delete(
          'MyALB',
          'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/my-alb/1234567890abcdef',
          'AWS::ElasticLoadBalancingV2::LoadBalancer'
        );

        expect(mockSend).toHaveBeenCalledTimes(1);
      });

      it('should throw ProvisioningError on unexpected failure', async () => {
        mockSend.mockRejectedValueOnce(new Error('Access Denied'));

        await expect(
          provider.delete(
            'MyALB',
            'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/my-alb/1234567890abcdef',
            'AWS::ElasticLoadBalancingV2::LoadBalancer'
          )
        ).rejects.toThrow('Failed to delete LoadBalancer MyALB');
      });
    });
  });

  // ─── TargetGroup ────────────────────────────────────────────────────

  describe('TargetGroup', () => {
    describe('create', () => {
      it('should create a TargetGroup and return ARN with attributes', async () => {
        mockSend.mockResolvedValueOnce({
          TargetGroups: [
            {
              TargetGroupArn:
                'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/my-tg/1234567890abcdef',
              TargetGroupName: 'my-tg',
            },
          ],
        });

        const result = await provider.create(
          'MyTG',
          'AWS::ElasticLoadBalancingV2::TargetGroup',
          {
            Name: 'my-tg',
            Protocol: 'HTTP',
            Port: 80,
            VpcId: 'vpc-123',
            TargetType: 'instance',
            HealthCheckPath: '/health',
          }
        );

        expect(result.physicalId).toBe(
          'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/my-tg/1234567890abcdef'
        );
        expect(result.attributes).toEqual({
          TargetGroupArn:
            'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/my-tg/1234567890abcdef',
          TargetGroupFullName: 'my-tg/1234567890abcdef',
          TargetGroupName: 'my-tg',
        });
        expect(mockSend).toHaveBeenCalledTimes(1);

        const createCall = mockSend.mock.calls[0][0];
        expect(createCall.constructor.name).toBe('CreateTargetGroupCommand');
        expect(createCall.input.Protocol).toBe('HTTP');
        expect(createCall.input.Port).toBe(80);
      });

      it('should throw ProvisioningError on failure', async () => {
        mockSend.mockRejectedValueOnce(new Error('Access Denied'));

        await expect(
          provider.create('MyTG', 'AWS::ElasticLoadBalancingV2::TargetGroup', {
            Name: 'my-tg',
            Protocol: 'HTTP',
            Port: 80,
            VpcId: 'vpc-123',
          })
        ).rejects.toThrow('Failed to create TargetGroup MyTG');
      });
    });

    describe('update', () => {
      it('should modify target group and return updated attributes', async () => {
        // ModifyTargetGroup
        mockSend.mockResolvedValueOnce({});
        // DescribeTargetGroups
        mockSend.mockResolvedValueOnce({
          TargetGroups: [
            {
              TargetGroupArn:
                'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/my-tg/1234567890abcdef',
              TargetGroupName: 'my-tg',
            },
          ],
        });

        const result = await provider.update(
          'MyTG',
          'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/my-tg/1234567890abcdef',
          'AWS::ElasticLoadBalancingV2::TargetGroup',
          {
            HealthCheckPath: '/healthz',
            HealthCheckIntervalSeconds: 15,
          },
          {
            HealthCheckPath: '/health',
            HealthCheckIntervalSeconds: 30,
          }
        );

        expect(result.physicalId).toBe(
          'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/my-tg/1234567890abcdef'
        );
        expect(result.wasReplaced).toBe(false);
        expect(result.attributes).toEqual({
          TargetGroupArn:
            'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/my-tg/1234567890abcdef',
          TargetGroupFullName: 'my-tg/1234567890abcdef',
          TargetGroupName: 'my-tg',
        });
        expect(mockSend).toHaveBeenCalledTimes(2);

        const modifyCall = mockSend.mock.calls[0][0];
        expect(modifyCall.constructor.name).toBe('ModifyTargetGroupCommand');
        expect(modifyCall.input.HealthCheckPath).toBe('/healthz');

        const describeCall = mockSend.mock.calls[1][0];
        expect(describeCall.constructor.name).toBe('DescribeTargetGroupsCommand');
      });

      it('should throw ProvisioningError on failure', async () => {
        mockSend.mockRejectedValueOnce(new Error('Access Denied'));

        await expect(
          provider.update(
            'MyTG',
            'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/my-tg/1234567890abcdef',
            'AWS::ElasticLoadBalancingV2::TargetGroup',
            { HealthCheckPath: '/healthz' },
            { HealthCheckPath: '/health' }
          )
        ).rejects.toThrow('Failed to update TargetGroup MyTG');
      });
    });

    describe('delete', () => {
      it('should delete a TargetGroup', async () => {
        mockSend.mockResolvedValueOnce({});

        await provider.delete(
          'MyTG',
          'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/my-tg/1234567890abcdef',
          'AWS::ElasticLoadBalancingV2::TargetGroup'
        );

        expect(mockSend).toHaveBeenCalledTimes(1);
        const deleteCall = mockSend.mock.calls[0][0];
        expect(deleteCall.constructor.name).toBe('DeleteTargetGroupCommand');
      });

      it('should handle not-found gracefully', async () => {
        const notFoundError = new Error('TargetGroup not found');
        (notFoundError as { name: string }).name = 'TargetGroupNotFoundException';
        mockSend.mockRejectedValueOnce(notFoundError);

        await provider.delete(
          'MyTG',
          'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/my-tg/1234567890abcdef',
          'AWS::ElasticLoadBalancingV2::TargetGroup'
        );

        expect(mockSend).toHaveBeenCalledTimes(1);
      });
    });
  });

  // ─── Listener ───────────────────────────────────────────────────────

  describe('Listener', () => {
    describe('create', () => {
      it('should create a Listener and return ARN', async () => {
        mockSend.mockResolvedValueOnce({
          Listeners: [
            {
              ListenerArn:
                'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/my-alb/1234567890abcdef/abcdef1234567890',
            },
          ],
        });

        const result = await provider.create(
          'MyListener',
          'AWS::ElasticLoadBalancingV2::Listener',
          {
            LoadBalancerArn:
              'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/my-alb/1234567890abcdef',
            Port: 80,
            Protocol: 'HTTP',
            DefaultActions: [
              {
                Type: 'forward',
                TargetGroupArn:
                  'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/my-tg/1234567890abcdef',
              },
            ],
          }
        );

        expect(result.physicalId).toBe(
          'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/my-alb/1234567890abcdef/abcdef1234567890'
        );
        expect(result.attributes).toEqual({
          ListenerArn:
            'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/my-alb/1234567890abcdef/abcdef1234567890',
        });
        expect(mockSend).toHaveBeenCalledTimes(1);

        const createCall = mockSend.mock.calls[0][0];
        expect(createCall.constructor.name).toBe('CreateListenerCommand');
        expect(createCall.input.Port).toBe(80);
        expect(createCall.input.Protocol).toBe('HTTP');
      });

      it('should throw ProvisioningError on failure', async () => {
        mockSend.mockRejectedValueOnce(new Error('Access Denied'));

        await expect(
          provider.create('MyListener', 'AWS::ElasticLoadBalancingV2::Listener', {
            LoadBalancerArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/my-alb/123',
            Port: 80,
            Protocol: 'HTTP',
          })
        ).rejects.toThrow('Failed to create Listener MyListener');
      });
    });

    describe('update', () => {
      it('should update a Listener', async () => {
        mockSend.mockResolvedValueOnce({});

        const listenerArn =
          'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/my-alb/1234567890abcdef/abcdef1234567890';

        const result = await provider.update(
          'MyListener',
          listenerArn,
          'AWS::ElasticLoadBalancingV2::Listener',
          {
            Port: 8080,
            Protocol: 'HTTP',
          },
          {
            Port: 80,
            Protocol: 'HTTP',
          }
        );

        expect(result.physicalId).toBe(listenerArn);
        expect(result.wasReplaced).toBe(false);
        expect(result.attributes).toEqual({ ListenerArn: listenerArn });
        expect(mockSend).toHaveBeenCalledTimes(1);

        const modifyCall = mockSend.mock.calls[0][0];
        expect(modifyCall.constructor.name).toBe('ModifyListenerCommand');
        expect(modifyCall.input.Port).toBe(8080);
      });

      it('should throw ProvisioningError on failure', async () => {
        mockSend.mockRejectedValueOnce(new Error('Access Denied'));

        await expect(
          provider.update(
            'MyListener',
            'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/my-alb/123/456',
            'AWS::ElasticLoadBalancingV2::Listener',
            { Port: 8080 },
            { Port: 80 }
          )
        ).rejects.toThrow('Failed to update Listener MyListener');
      });
    });

    describe('delete', () => {
      it('should delete a Listener', async () => {
        mockSend.mockResolvedValueOnce({});

        await provider.delete(
          'MyListener',
          'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/my-alb/1234567890abcdef/abcdef1234567890',
          'AWS::ElasticLoadBalancingV2::Listener'
        );

        expect(mockSend).toHaveBeenCalledTimes(1);
        const deleteCall = mockSend.mock.calls[0][0];
        expect(deleteCall.constructor.name).toBe('DeleteListenerCommand');
      });

      it('should handle not-found gracefully', async () => {
        const notFoundError = new Error('Listener not found');
        (notFoundError as { name: string }).name = 'ListenerNotFoundException';
        mockSend.mockRejectedValueOnce(notFoundError);

        await provider.delete(
          'MyListener',
          'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/my-alb/1234567890abcdef/abcdef1234567890',
          'AWS::ElasticLoadBalancingV2::Listener'
        );

        expect(mockSend).toHaveBeenCalledTimes(1);
      });

      it('should throw ProvisioningError on unexpected failure', async () => {
        mockSend.mockRejectedValueOnce(new Error('Access Denied'));

        await expect(
          provider.delete(
            'MyListener',
            'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/my-alb/123/456',
            'AWS::ElasticLoadBalancingV2::Listener'
          )
        ).rejects.toThrow('Failed to delete Listener MyListener');
      });
    });
  });

  // ─── Unsupported resource type ──────────────────────────────────────

  describe('unsupported resource type', () => {
    it('should throw on unsupported resource type for create', async () => {
      await expect(
        provider.create('MyResource', 'AWS::ElasticLoadBalancingV2::ListenerRule', {})
      ).rejects.toThrow('Unsupported resource type');
    });

    it('should throw on unsupported resource type for update', async () => {
      await expect(
        provider.update('MyResource', 'arn:123', 'AWS::ElasticLoadBalancingV2::ListenerRule', {}, {})
      ).rejects.toThrow('Unsupported resource type');
    });

    it('should throw on unsupported resource type for delete', async () => {
      await expect(
        provider.delete('MyResource', 'arn:123', 'AWS::ElasticLoadBalancingV2::ListenerRule')
      ).rejects.toThrow('Unsupported resource type');
    });
  });
});
