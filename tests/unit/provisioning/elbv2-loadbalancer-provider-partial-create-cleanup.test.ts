import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend, warnSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  warnSpy: vi.fn(),
}));

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
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import { ELBv2Provider } from '../../../src/provisioning/providers/elbv2-provider.js';

const RESOURCE_TYPE = 'AWS::ElasticLoadBalancingV2::LoadBalancer';
const LB_ARN =
  'arn:aws:elasticloadbalancing:us-east-1:123:loadbalancer/app/MyLb/abcdef1234567890';

describe('ELBv2Provider createLoadBalancer partial-create cleanup (Issue #376)', () => {
  let provider: ELBv2Provider;

  beforeEach(() => {
    mockSend.mockReset();
    warnSpy.mockReset();
    provider = new ELBv2Provider();
  });

  it('issues DeleteLoadBalancerCommand when ModifyLoadBalancerAttributes fails after CreateLoadBalancer succeeded', async () => {
    mockSend.mockResolvedValueOnce({
      LoadBalancers: [
        {
          LoadBalancerArn: LB_ARN,
          DNSName: 'mylb-123.us-east-1.elb.amazonaws.com',
          CanonicalHostedZoneId: 'Z123',
          LoadBalancerName: 'MyLb',
        },
      ],
    }); // CreateLoadBalancerCommand
    mockSend.mockRejectedValueOnce(new Error('ModifyLBAttributes boom')); // ModifyLoadBalancerAttributesCommand
    mockSend.mockResolvedValueOnce({}); // DeleteLoadBalancerCommand cleanup

    await expect(
      provider.create('MyLb', RESOURCE_TYPE, {
        Name: 'MyLb',
        Subnets: ['subnet-aaa', 'subnet-bbb'],
        LoadBalancerAttributes: [{ Key: 'idle_timeout.timeout_seconds', Value: '60' }],
      })
    ).rejects.toThrow('Failed to create LoadBalancer');

    const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
    expect(names).toEqual([
      'CreateLoadBalancerCommand',
      'ModifyLoadBalancerAttributesCommand',
      'DeleteLoadBalancerCommand',
    ]);
    expect(mockSend.mock.calls[2][0].input).toEqual({ LoadBalancerArn: LB_ARN });
  });

  it('does NOT issue DeleteLoadBalancerCommand when CreateLoadBalancer itself fails', async () => {
    mockSend.mockRejectedValueOnce(new Error('CreateLoadBalancer boom'));

    await expect(
      provider.create('MyLb', RESOURCE_TYPE, {
        Name: 'MyLb',
        Subnets: ['subnet-aaa'],
      })
    ).rejects.toThrow('Failed to create LoadBalancer');

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].constructor.name).toBe('CreateLoadBalancerCommand');
  });

  it('re-throws the original error even when cleanup itself fails', async () => {
    mockSend.mockResolvedValueOnce({
      LoadBalancers: [
        {
          LoadBalancerArn: LB_ARN,
          DNSName: 'mylb-123.us-east-1.elb.amazonaws.com',
          CanonicalHostedZoneId: 'Z123',
          LoadBalancerName: 'MyLb',
        },
      ],
    });
    mockSend.mockRejectedValueOnce(new Error('ModifyLBAttributes boom (original)'));
    mockSend.mockRejectedValueOnce(new Error('DeleteLoadBalancer also failed'));

    await expect(
      provider.create('MyLb', RESOURCE_TYPE, {
        Name: 'MyLb',
        Subnets: ['subnet-aaa'],
        LoadBalancerAttributes: [{ Key: 'idle_timeout.timeout_seconds', Value: '60' }],
      })
    ).rejects.toThrow('ModifyLBAttributes boom (original)');

    expect(warnSpy).toHaveBeenCalled();
    const warnMsg = String(warnSpy.mock.calls[0][0]);
    expect(warnMsg).toContain('aws elbv2 delete-load-balancer --load-balancer-arn');
    expect(warnMsg).toContain(LB_ARN);
  });
});
