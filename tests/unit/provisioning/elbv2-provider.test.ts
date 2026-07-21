import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Mock AWS clients before importing the provider
const mockSend = vi.fn();

vi.mock('@aws-sdk/client-elastic-load-balancing-v2', async () => {
  const actual = await vi.importActual('@aws-sdk/client-elastic-load-balancing-v2');
  return {
    ...actual,
    ElasticLoadBalancingV2Client: vi.fn().mockImplementation(() => ({ send: mockSend, config: { region: () => Promise.resolve('us-east-1') } })),
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
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';

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

    describe('update', () => {
      it('should reject with ResourceUpdateNotSupportedError when an immutable field changed', async () => {
        // Scheme is immutable — the deploy engine triggers replacement,
        // but if --revert ever lands here with such a diff we must surface
        // the error rather than silently no-op.
        await expect(
          provider.update(
            'MyALB',
            'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/my-alb/123',
            'AWS::ElasticLoadBalancingV2::LoadBalancer',
            { Scheme: 'internet-facing' },
            { Scheme: 'internal' }
          )
        ).rejects.toThrow(ResourceUpdateNotSupportedError);
        expect(mockSend).not.toHaveBeenCalled();
      });

      it('applies LoadBalancerAttributes diff via ModifyLoadBalancerAttributes (drift --revert path)', async () => {
        const { ModifyLoadBalancerAttributesCommand } = await import(
          '@aws-sdk/client-elastic-load-balancing-v2'
        );
        mockSend.mockResolvedValueOnce({});

        const result = await provider.update(
          'MyALB',
          'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/my-alb/123',
          'AWS::ElasticLoadBalancingV2::LoadBalancer',
          {
            LoadBalancerAttributes: [{ Key: 'idle_timeout.timeout_seconds', Value: '60' }],
          },
          {
            LoadBalancerAttributes: [{ Key: 'idle_timeout.timeout_seconds', Value: '300' }],
          }
        );

        expect(result).toEqual({
          physicalId:
            'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/my-alb/123',
          wasReplaced: false,
        });
        expect(mockSend).toHaveBeenCalledTimes(1);
        const cmd = mockSend.mock.calls[0]?.[0];
        expect(cmd).toBeInstanceOf(ModifyLoadBalancerAttributesCommand);
        expect((cmd as InstanceType<typeof ModifyLoadBalancerAttributesCommand>).input).toEqual({
          LoadBalancerArn:
            'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/my-alb/123',
          Attributes: [{ Key: 'idle_timeout.timeout_seconds', Value: '60' }],
        });
      });

      it('clears removed LoadBalancerAttributes by submitting empty Value (AWS-documented clear)', async () => {
        const { ModifyLoadBalancerAttributesCommand } = await import(
          '@aws-sdk/client-elastic-load-balancing-v2'
        );
        mockSend.mockResolvedValueOnce({});

        await provider.update(
          'MyALB',
          'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/my-alb/123',
          'AWS::ElasticLoadBalancingV2::LoadBalancer',
          // newAttrs has no access_logs.s3.enabled
          {
            LoadBalancerAttributes: [{ Key: 'idle_timeout.timeout_seconds', Value: '60' }],
          },
          // oldAttrs DID have access_logs.s3.enabled
          {
            LoadBalancerAttributes: [
              { Key: 'idle_timeout.timeout_seconds', Value: '60' },
              { Key: 'access_logs.s3.enabled', Value: 'true' },
            ],
          }
        );

        const cmd = mockSend.mock.calls[0]?.[0] as InstanceType<
          typeof ModifyLoadBalancerAttributesCommand
        >;
        // Only the changed/removed key is submitted: idle_timeout was
        // 60 on both sides (no change → not resubmitted);
        // access_logs.s3.enabled was removed → submitted with Value: ''
        // (AWS-documented clear).
        expect(cmd.input.Attributes).toEqual([
          { Key: 'access_logs.s3.enabled', Value: '' },
        ]);
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

      it('should issue ModifyListenerAttributes after create when ListenerAttributes is set', async () => {
        const listenerArn =
          'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/my-alb/1234567890abcdef/abcdef1234567890';
        // 1) CreateListener  2) ModifyListenerAttributes
        mockSend.mockResolvedValueOnce({ Listeners: [{ ListenerArn: listenerArn }] });
        mockSend.mockResolvedValueOnce({});

        const result = await provider.create(
          'MyListener',
          'AWS::ElasticLoadBalancingV2::Listener',
          {
            LoadBalancerArn:
              'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/my-alb/1234567890abcdef',
            Port: 80,
            Protocol: 'HTTP',
            DefaultActions: [{ Type: 'forward' }],
            ListenerAttributes: [
              { Key: 'routing.http.response.server.enabled', Value: 'false' },
            ],
          }
        );

        expect(result.physicalId).toBe(listenerArn);
        expect(mockSend).toHaveBeenCalledTimes(2);
        const createCall = mockSend.mock.calls[0][0];
        expect(createCall.constructor.name).toBe('CreateListenerCommand');
        const modifyAttrsCall = mockSend.mock.calls[1][0];
        expect(modifyAttrsCall.constructor.name).toBe('ModifyListenerAttributesCommand');
        expect(modifyAttrsCall.input.ListenerArn).toBe(listenerArn);
        expect(modifyAttrsCall.input.Attributes).toEqual([
          { Key: 'routing.http.response.server.enabled', Value: 'false' },
        ]);
      });

      it('should NOT issue ModifyListenerAttributes when ListenerAttributes is absent / empty', async () => {
        const listenerArn =
          'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/my-alb/1234567890abcdef/abcdef1234567890';
        mockSend.mockResolvedValueOnce({ Listeners: [{ ListenerArn: listenerArn }] });

        await provider.create('MyListener', 'AWS::ElasticLoadBalancingV2::Listener', {
          LoadBalancerArn:
            'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/my-alb/1234567890abcdef',
          Port: 80,
          Protocol: 'HTTP',
          DefaultActions: [{ Type: 'forward' }],
          ListenerAttributes: [],
        });

        // Only CreateListener — no attributes call.
        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(mockSend.mock.calls[0][0].constructor.name).toBe('CreateListenerCommand');
      });

      it('should pass string Values through to ModifyListenerAttributes (no [object Object])', async () => {
        const listenerArn =
          'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/my-nlb/1234567890abcdef/abcdef1234567890';
        mockSend.mockResolvedValueOnce({ Listeners: [{ ListenerArn: listenerArn }] });
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyListener', 'AWS::ElasticLoadBalancingV2::Listener', {
          LoadBalancerArn:
            'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/net/my-nlb/1234567890abcdef',
          Port: 443,
          Protocol: 'TCP',
          DefaultActions: [{ Type: 'forward' }],
          // CDK emits the numeric attribute as a STRING; verify it rides
          // through verbatim as a string.
          ListenerAttributes: [{ Key: 'tcp.idle_timeout.seconds', Value: '3600' }],
        });

        const modifyAttrsCall = mockSend.mock.calls[1][0];
        expect(modifyAttrsCall.input.Attributes).toEqual([
          { Key: 'tcp.idle_timeout.seconds', Value: '3600' },
        ]);
        expect(typeof modifyAttrsCall.input.Attributes[0].Value).toBe('string');
      });

      it('should drop malformed ListenerAttributes entries (non-scalar Value / missing Key) instead of emitting [object Object]', async () => {
        const listenerArn =
          'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/my-alb/1234567890abcdef/abcdef1234567890';
        mockSend.mockResolvedValueOnce({ Listeners: [{ ListenerArn: listenerArn }] });
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyListener', 'AWS::ElasticLoadBalancingV2::Listener', {
          LoadBalancerArn:
            'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/my-alb/1234567890abcdef',
          Port: 80,
          Protocol: 'HTTP',
          DefaultActions: [{ Type: 'forward' }],
          ListenerAttributes: [
            { Key: 'routing.http.response.server.enabled', Value: 'false' },
            // Non-scalar Value must be dropped (never String()-coerced to "[object Object]").
            { Key: 'routing.http.bad', Value: { nested: 'object' } },
            // Missing Key must be dropped.
            { Value: 'orphan-value' },
          ],
        });

        const modifyAttrsCall = mockSend.mock.calls[1][0];
        // Only the well-formed scalar entry survives.
        expect(modifyAttrsCall.input.Attributes).toEqual([
          { Key: 'routing.http.response.server.enabled', Value: 'false' },
        ]);
        // Defensive: no value was ever coerced to the object-stringification artifact.
        for (const attr of modifyAttrsCall.input.Attributes) {
          expect(attr.Value).not.toBe('[object Object]');
        }
      });

      it('should delete the just-created Listener and rethrow when ModifyListenerAttributes fails (atomicity)', async () => {
        const listenerArn =
          'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/my-alb/1234567890abcdef/abcdef1234567890';
        // 1) CreateListener succeeds  2) ModifyListenerAttributes fails  3) DeleteListener cleanup
        mockSend.mockResolvedValueOnce({ Listeners: [{ ListenerArn: listenerArn }] });
        mockSend.mockRejectedValueOnce(new Error('attribute key is invalid'));
        mockSend.mockResolvedValueOnce({});

        await expect(
          provider.create('MyListener', 'AWS::ElasticLoadBalancingV2::Listener', {
            LoadBalancerArn:
              'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/my-alb/1234567890abcdef',
            Port: 80,
            Protocol: 'HTTP',
            DefaultActions: [{ Type: 'forward' }],
            ListenerAttributes: [{ Key: 'routing.http.response.server.enabled', Value: 'false' }],
          })
        ).rejects.toThrow('Failed to create Listener MyListener');

        // Create + Modify (fail) + Delete (cleanup) = 3 calls.
        expect(mockSend).toHaveBeenCalledTimes(3);
        const cleanupCall = mockSend.mock.calls[2][0];
        expect(cleanupCall.constructor.name).toBe('DeleteListenerCommand');
        expect(cleanupCall.input.ListenerArn).toBe(listenerArn);
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

      it('should issue ModifyListenerAttributes when ListenerAttributes changed', async () => {
        const listenerArn =
          'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/my-alb/1234567890abcdef/abcdef1234567890';
        // 1) ModifyListener  2) ModifyListenerAttributes
        mockSend.mockResolvedValueOnce({});
        mockSend.mockResolvedValueOnce({});

        await provider.update(
          'MyListener',
          listenerArn,
          'AWS::ElasticLoadBalancingV2::Listener',
          {
            Port: 80,
            Protocol: 'HTTP',
            ListenerAttributes: [
              { Key: 'routing.http.response.server.enabled', Value: 'false' },
            ],
          },
          {
            Port: 80,
            Protocol: 'HTTP',
            ListenerAttributes: [
              { Key: 'routing.http.response.server.enabled', Value: 'true' },
            ],
          }
        );

        expect(mockSend).toHaveBeenCalledTimes(2);
        const modifyAttrsCall = mockSend.mock.calls[1][0];
        expect(modifyAttrsCall.constructor.name).toBe('ModifyListenerAttributesCommand');
        expect(modifyAttrsCall.input.Attributes).toEqual([
          { Key: 'routing.http.response.server.enabled', Value: 'false' },
        ]);
      });

      it('should clear a removed ListenerAttribute by pushing the empty-string default', async () => {
        const listenerArn =
          'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/my-alb/1234567890abcdef/abcdef1234567890';
        mockSend.mockResolvedValueOnce({});
        mockSend.mockResolvedValueOnce({});

        await provider.update(
          'MyListener',
          listenerArn,
          'AWS::ElasticLoadBalancingV2::Listener',
          { Port: 80, ListenerAttributes: [] },
          {
            Port: 80,
            ListenerAttributes: [
              { Key: 'routing.http.response.server.enabled', Value: 'false' },
            ],
          }
        );

        expect(mockSend).toHaveBeenCalledTimes(2);
        const modifyAttrsCall = mockSend.mock.calls[1][0];
        expect(modifyAttrsCall.input.Attributes).toEqual([
          { Key: 'routing.http.response.server.enabled', Value: '' },
        ]);
      });

      it('should NOT issue ModifyListenerAttributes when ListenerAttributes is unchanged', async () => {
        const listenerArn =
          'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/my-alb/1234567890abcdef/abcdef1234567890';
        mockSend.mockResolvedValueOnce({});

        await provider.update(
          'MyListener',
          listenerArn,
          'AWS::ElasticLoadBalancingV2::Listener',
          {
            Port: 80,
            ListenerAttributes: [
              { Key: 'routing.http.response.server.enabled', Value: 'false' },
            ],
          },
          {
            Port: 80,
            ListenerAttributes: [
              { Key: 'routing.http.response.server.enabled', Value: 'false' },
            ],
          }
        );

        // Only ModifyListener — no attributes call since nothing changed.
        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(mockSend.mock.calls[0][0].constructor.name).toBe('ModifyListenerCommand');
      });

      it('should throw ProvisioningError when ModifyListenerAttributes fails on update', async () => {
        const listenerArn =
          'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/my-alb/123/456';
        // 1) ModifyListener succeeds  2) ModifyListenerAttributes fails
        mockSend.mockResolvedValueOnce({});
        mockSend.mockRejectedValueOnce(new Error('attribute key is invalid'));

        await expect(
          provider.update(
            'MyListener',
            listenerArn,
            'AWS::ElasticLoadBalancingV2::Listener',
            {
              Port: 80,
              ListenerAttributes: [{ Key: 'routing.http.response.server.enabled', Value: 'false' }],
            },
            { Port: 80, ListenerAttributes: [] }
          )
        ).rejects.toThrow('Failed to update Listener MyListener');
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

  describe('import', () => {
    function makeInput(overrides: Record<string, unknown> = {}) {
      return {
        logicalId: 'MyALB',
        resourceType: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
        cdkPath: 'MyStack/MyALB',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: {},
        ...overrides,
      };
    }

    it('LoadBalancer explicit override: DescribeLoadBalancers verifies and returns the ARN', async () => {
      const arn = 'arn:aws:elasticloadbalancing:us-east-1:123:loadbalancer/app/adopted/abc';
      mockSend.mockResolvedValueOnce({ LoadBalancers: [{ LoadBalancerArn: arn }] });

      const result = await provider.import(makeInput({ knownPhysicalId: arn }));

      expect(result).toEqual({ physicalId: arn, attributes: {} });
      const call = mockSend.mock.calls[0][0];
      expect(call.constructor.name).toBe('DescribeLoadBalancersCommand');
      expect(call.input).toEqual({ LoadBalancerArns: [arn] });
    });

    // The `aws:cdk:path` tag walk was removed in issue #1134: AWS rejects
    // `aws:`-prefixed tag writes, so that tag never exists on a real resource
    // and the walk could not match. Without an explicit override, import must
    // report not-found without any AWS call.
    it('LoadBalancer returns null without an override and issues no AWS call', async () => {
      const result = await provider.import(makeInput());
      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('TargetGroup explicit override: DescribeTargetGroups verifies and returns the ARN', async () => {
      const tgArn =
        'arn:aws:elasticloadbalancing:us-east-1:123:targetgroup/my-tg/abcdef0123456789';
      mockSend.mockResolvedValueOnce({ TargetGroups: [{ TargetGroupArn: tgArn }] });

      const result = await provider.import(
        makeInput({
          logicalId: 'MyTG',
          resourceType: 'AWS::ElasticLoadBalancingV2::TargetGroup',
          cdkPath: 'MyStack/MyTG',
          knownPhysicalId: tgArn,
        })
      );

      expect(result).toEqual({ physicalId: tgArn, attributes: {} });
      const call = mockSend.mock.calls[0][0];
      expect(call.constructor.name).toBe('DescribeTargetGroupsCommand');
    });

    it('TargetGroup returns null without an override and issues no AWS call', async () => {
      const result = await provider.import(
        makeInput({
          logicalId: 'MyTG',
          resourceType: 'AWS::ElasticLoadBalancingV2::TargetGroup',
          cdkPath: 'MyStack/MyTG',
        })
      );
      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});
