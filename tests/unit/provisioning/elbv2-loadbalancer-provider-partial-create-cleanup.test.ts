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
    // The `active` wait (issue #1274) lives inside the same try/catch this
    // suite exercises. Stub it so these cases keep testing the
    // ModifyLoadBalancerAttributes failure path; the wait-failure branch of
    // the same cleanup is covered by elbv2-loadbalancer-active-wait.test.ts.
    waitUntilLoadBalancerAvailable: vi.fn().mockResolvedValue({ state: 'SUCCESS' }),
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
import {
  FORGED_CTRL,
  FORGED_QUOTE,
  expectQuotedAfter,
  expectWithheld,
} from './pasteable-aws-command-assert.js';

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

// Issue #3136: the load balancer and target group ARNs are AWS-minted (off the
// create response) but embed the TEMPLATE-chosen name, and both manual-delete
// commands route them through `pasteableAwsCommand`.
describe('ELBv2Provider partial-create manual-delete commands (issue #3136)', () => {
  let provider: ELBv2Provider;

  beforeEach(() => {
    mockSend.mockReset();
    warnSpy.mockReset();
    provider = new ELBv2Provider();
  });

  async function lbWarn(arn: string): Promise<string> {
    mockSend.mockResolvedValueOnce({
      LoadBalancers: [{ LoadBalancerArn: arn, DNSName: 'd', CanonicalHostedZoneId: 'Z', LoadBalancerName: 'MyLb' }],
    });
    mockSend.mockRejectedValueOnce(new Error('ModifyLBAttributes boom'));
    mockSend.mockRejectedValueOnce(new Error('DeleteLoadBalancer also failed'));
    await expect(
      provider.create('MyLb', RESOURCE_TYPE, {
        Name: 'MyLb',
        Subnets: ['subnet-aaa'],
        LoadBalancerAttributes: [{ Key: 'idle_timeout.timeout_seconds', Value: '60' }],
      })
    ).rejects.toThrow('ModifyLBAttributes boom');
    return String(warnSpy.mock.calls[0][0]);
  }

  async function tgWarn(arn: string): Promise<string> {
    mockSend.mockResolvedValueOnce({ TargetGroups: [{ TargetGroupArn: arn, TargetGroupName: 'MyTg' }] });
    mockSend.mockRejectedValueOnce(new Error('ModifyTGAttributes boom'));
    mockSend.mockRejectedValueOnce(new Error('DeleteTargetGroup also failed'));
    await expect(
      provider.create('MyTg', 'AWS::ElasticLoadBalancingV2::TargetGroup', {
        Name: 'MyTg',
        Port: 80,
        Protocol: 'HTTP',
        VpcId: 'vpc-aaa',
        TargetGroupAttributes: [{ Key: 'deregistration_delay.timeout_seconds', Value: '30' }],
      })
    ).rejects.toThrow('ModifyTGAttributes boom');
    return String(warnSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('TargetGroup')));
  }

  it.each([
    ['LoadBalancer', lbWarn, 'aws elbv2 delete-load-balancer --load-balancer-arn ', LB_ARN],
    [
      'TargetGroup',
      tgWarn,
      'aws elbv2 delete-target-group --target-group-arn ',
      'arn:aws:elasticloadbalancing:us-east-1:123:targetgroup/MyTg/abc',
    ],
  ] as const)('%s: a clean ARN is bare; a forged one is quoted or withholds the command', async (_t, warnFor, flag, arn) => {
    expect(await warnFor(arn)).toContain(`${flag}${arn}`);
    warnSpy.mockReset();
    expectQuotedAfter(await warnFor(`${arn}${FORGED_QUOTE}`), flag, `${arn}${FORGED_QUOTE}`);
    warnSpy.mockReset();
    expectWithheld(await warnFor(`${arn}${FORGED_CTRL}`), flag.trim());
  });

  it('withholds the target group command for an ARN the caller masker would change', async () => {
    const arn = 'arn:aws:elasticloadbalancing:us-east-1:123:targetgroup/MyTg-s3cr3t/abc';
    mockSend.mockResolvedValueOnce({ TargetGroups: [{ TargetGroupArn: arn, TargetGroupName: 'MyTg' }] });
    mockSend.mockRejectedValueOnce(new Error('ModifyTGAttributes boom'));
    mockSend.mockRejectedValueOnce(new Error('DeleteTargetGroup also failed'));
    await expect(
      provider.create(
        'MyTg',
        'AWS::ElasticLoadBalancingV2::TargetGroup',
        {
          Name: 'MyTg',
          Port: 80,
          Protocol: 'HTTP',
          VpcId: 'vpc-aaa',
          TargetGroupAttributes: [{ Key: 'deregistration_delay.timeout_seconds', Value: '30' }],
        },
        { maskSecrets: (t: string) => t.replaceAll('s3cr3t', '***') }
      )
    ).rejects.toThrow('ModifyTGAttributes boom');
    expectWithheld(
      warnSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('TargetGroup'))!,
      'aws elbv2 delete-target-group'
    );
  });

  it('withholds the load balancer command for an ARN the caller masker would change', async () => {
    const arn = `${LB_ARN}-s3cr3t`;
    mockSend.mockResolvedValueOnce({
      LoadBalancers: [{ LoadBalancerArn: arn, DNSName: 'd', CanonicalHostedZoneId: 'Z', LoadBalancerName: 'MyLb' }],
    });
    mockSend.mockRejectedValueOnce(new Error('ModifyLBAttributes boom'));
    mockSend.mockRejectedValueOnce(new Error('DeleteLoadBalancer also failed'));
    await expect(
      provider.create(
        'MyLb',
        RESOURCE_TYPE,
        {
          Name: 'MyLb',
          Subnets: ['subnet-aaa'],
          LoadBalancerAttributes: [{ Key: 'idle_timeout.timeout_seconds', Value: '60' }],
        },
        { maskSecrets: (t: string) => t.replaceAll('s3cr3t', '***') }
      )
    ).rejects.toThrow('ModifyLBAttributes boom');
    expectWithheld(String(warnSpy.mock.calls[0][0]), 'aws elbv2 delete-load-balancer');
  });
});

