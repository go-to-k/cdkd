import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  DeleteLoadBalancerCommand,
  SetSubnetsCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';

// Issue #1274: `CreateLoadBalancer` returns synchronously but with
// `State.Code: provisioning`, so the LB is not servable and its `DNSName`
// 503s. CloudFormation and Terraform both wait for `active`; cdkd did not.
// These cases pin the wait, its `--no-wait` gate, and the partial-create
// cleanup that a wait failure must route through.

const { mockSend, waitUntilLoadBalancerAvailableMock, warnSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  waitUntilLoadBalancerAvailableMock: vi.fn(() => Promise.resolve({ state: 'SUCCESS' })),
  warnSpy: vi.fn(),
}));

vi.mock('@aws-sdk/client-elastic-load-balancing-v2', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    ElasticLoadBalancingV2Client: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
    waitUntilLoadBalancerAvailable: waitUntilLoadBalancerAvailableMock,
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

const LB_ARN =
  'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/my-lb/1234567890abcdef';

function mockCreateOk() {
  mockSend.mockResolvedValueOnce({
    LoadBalancers: [
      {
        LoadBalancerArn: LB_ARN,
        LoadBalancerName: 'my-lb',
        DNSName: 'my-lb-123.us-east-1.elb.amazonaws.com',
        CanonicalHostedZoneId: 'Z35SXDOTRQ7X7K',
        State: { Code: 'provisioning' },
      },
    ],
  });
}

const PROPS = { Subnets: ['subnet-1', 'subnet-2'], Type: 'application' };

describe('ELBv2Provider LoadBalancer active-state wait (issue #1274)', () => {
  let originalNoWait: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    waitUntilLoadBalancerAvailableMock.mockResolvedValue({ state: 'SUCCESS' });
    originalNoWait = process.env['CDKD_NO_WAIT'];
    delete process.env['CDKD_NO_WAIT'];
  });

  afterEach(() => {
    if (originalNoWait === undefined) delete process.env['CDKD_NO_WAIT'];
    else process.env['CDKD_NO_WAIT'] = originalNoWait;
  });

  it('waits for active by default, with a poll cap tighter than the SDK default', async () => {
    mockCreateOk();

    const result = await new ELBv2Provider().create(
      'MyLb',
      'AWS::ElasticLoadBalancingV2::LoadBalancer',
      PROPS
    );

    expect(result.physicalId).toBe(LB_ARN);
    expect(waitUntilLoadBalancerAvailableMock).toHaveBeenCalledTimes(1);

    const [waiterConfig, waiterInput] = waitUntilLoadBalancerAvailableMock.mock
      .calls[0] as unknown as [
      { maxWaitTime: number; minDelay: number; maxDelay: number },
      { LoadBalancerArns: string[] },
    ];
    expect(waiterInput.LoadBalancerArns).toEqual([LB_ARN]);
    // The AWS SDK defaults are minDelay 15 / maxDelay 120, which detect the
    // ready state up to two minutes late (the #1177 poll-cap sweep).
    expect(waiterConfig.minDelay).toBeLessThanOrEqual(5);
    expect(waiterConfig.maxDelay).toBeLessThanOrEqual(10);
    expect(waiterConfig.maxWaitTime).toBe(600);
  });

  it('skips the wait under CDKD_NO_WAIT', async () => {
    process.env['CDKD_NO_WAIT'] = 'true';
    mockCreateOk();

    const result = await new ELBv2Provider().create(
      'MyLb',
      'AWS::ElasticLoadBalancingV2::LoadBalancer',
      PROPS
    );

    expect(result.physicalId).toBe(LB_ARN);
    expect(waitUntilLoadBalancerAvailableMock).not.toHaveBeenCalled();
  });

  it('deletes the just-created LB and rethrows when the wait fails', async () => {
    mockCreateOk();
    waitUntilLoadBalancerAvailableMock.mockRejectedValueOnce(new Error('waiter timed out'));
    // The cleanup DeleteLoadBalancer.
    mockSend.mockResolvedValueOnce({});

    await expect(
      new ELBv2Provider().create('MyLb', 'AWS::ElasticLoadBalancingV2::LoadBalancer', PROPS)
    ).rejects.toThrow(/waiter timed out/);

    // Without the delete, the LB exists on AWS but not in cdkd state, and the
    // next deploy fails with DuplicateLoadBalancerName.
    const deleteCall = mockSend.mock.calls.find((c) => c[0] instanceof DeleteLoadBalancerCommand);
    expect(deleteCall).toBeDefined();
    expect((deleteCall![0] as DeleteLoadBalancerCommand).input.LoadBalancerArn).toBe(LB_ARN);
  });

  it('does NOT wait on update (the Set* calls act on an already-active LB)', async () => {
    // DescribeLoadBalancers for the current state, then the Set* call.
    mockSend.mockResolvedValue({
      LoadBalancers: [
        { LoadBalancerArn: LB_ARN, LoadBalancerName: 'my-lb', State: { Code: 'active' } },
      ],
    });

    await new ELBv2Provider().update(
      'MyLb',
      LB_ARN,
      'AWS::ElasticLoadBalancingV2::LoadBalancer',
      { ...PROPS, Subnets: ['subnet-1', 'subnet-3'] },
      PROPS
    );

    // Prove the update actually ran: a no-op would satisfy the assertion
    // below for the wrong reason.
    expect(mockSend.mock.calls.some((c) => c[0] instanceof SetSubnetsCommand)).toBe(true);
    expect(waitUntilLoadBalancerAvailableMock).not.toHaveBeenCalled();
  });

  it('warns with a manual-deletion pointer when the cleanup itself fails', async () => {
    mockCreateOk();
    waitUntilLoadBalancerAvailableMock.mockRejectedValueOnce(new Error('waiter timed out'));
    mockSend.mockRejectedValueOnce(new Error('delete denied'));

    await expect(
      new ELBv2Provider().create('MyLb', 'AWS::ElasticLoadBalancingV2::LoadBalancer', PROPS)
    ).rejects.toThrow(/waiter timed out/);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('aws elbv2 delete-load-balancer'));
  });
});
