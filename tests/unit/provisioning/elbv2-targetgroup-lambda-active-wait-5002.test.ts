import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#5002: a `lambda` target group waits for each target function to
// be Active before RegisterTargets; every other target group never builds a
// Lambda client.

const order: string[] = [];
const mockSend = vi.fn();
const mockWait = vi.fn();
const lambdaCtor = vi.fn();

vi.mock('@aws-sdk/client-elastic-load-balancing-v2', async () => {
  const actual = await vi.importActual('@aws-sdk/client-elastic-load-balancing-v2');
  return {
    ...actual,
    ElasticLoadBalancingV2Client: vi.fn().mockImplementation(() => ({
      send: (command: { constructor: { name: string }; input?: { Names?: unknown } }) =>
        command.input?.Names !== undefined
          ? Promise.reject(
              Object.assign(new Error('not found'), { name: 'TargetGroupNotFoundException' })
            )
          : mockSend(command),
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-lambda', async () => {
  const actual = await vi.importActual('@aws-sdk/client-lambda');
  return {
    ...actual,
    LambdaClient: vi.fn().mockImplementation((config: unknown) => {
      lambdaCtor(config);
      return { send: vi.fn(), config: { region: () => Promise.resolve('ap-northeast-1') } };
    }),
    waitUntilFunctionActiveV2: (...args: unknown[]) => mockWait(...args),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const l = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return { getLogger: () => l };
});

import { ELBv2Provider } from '../../../src/provisioning/providers/elbv2-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

const TG_TYPE = 'AWS::ElasticLoadBalancingV2::TargetGroup';
const TG_ARN = 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/t/1234567890abcdef';
const FN_ARN = 'arn:aws:lambda:ap-northeast-1:123456789012:function:fn';

function sentNames(): string[] {
  return mockSend.mock.calls.map((c) => c[0].constructor.name);
}

describe('TargetGroup Lambda target Active wait (#5002)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    order.length = 0;
    mockWait.mockResolvedValue({ state: 'SUCCESS' });
    mockSend.mockImplementation(async (command: { constructor: { name: string } }) => {
      order.push(command.constructor.name);
      if (command.constructor.name === 'CreateTargetGroupCommand') {
        return { TargetGroups: [{ TargetGroupArn: TG_ARN }] };
      }
      return {};
    });
    mockWait.mockImplementation(async () => {
      order.push('wait');
      return { state: 'SUCCESS' };
    });
  });

  it('waits for the function before RegisterTargets, in the function ARN region', async () => {
    await new ELBv2Provider().create('Tg', TG_TYPE, {
      TargetType: 'lambda',
      Targets: [{ Id: FN_ARN }],
    });
    expect(mockWait).toHaveBeenCalledTimes(1);
    expect(mockWait.mock.calls[0][1]).toEqual({ FunctionName: FN_ARN });
    expect(lambdaCtor.mock.calls[0][0]).toMatchObject({ region: 'ap-northeast-1' });
    expect(order.indexOf('wait')).toBeGreaterThan(order.indexOf('CreateTargetGroupCommand'));
    expect(order.indexOf('wait')).toBeLessThan(order.indexOf('RegisterTargetsCommand'));
  });

  it('never builds a Lambda client or waits for a non-lambda target group', async () => {
    await new ELBv2Provider().create('Tg', TG_TYPE, {
      TargetType: 'ip',
      Port: 80,
      Protocol: 'HTTP',
      VpcId: 'vpc-1',
      Targets: [{ Id: '10.0.0.1' }],
    });
    expect(sentNames()).toContain('RegisterTargetsCommand');
    expect(lambdaCtor).not.toHaveBeenCalled();
    expect(mockWait).not.toHaveBeenCalled();
  });

  it('fails with a ProvisioningError naming the group and function, and does not register', async () => {
    mockWait.mockRejectedValue(
      new Error(JSON.stringify({ state: 'FAILURE', reason: { Configuration: { State: 'Failed' } } }))
    );
    const err = await new ELBv2Provider()
      .create('Tg', TG_TYPE, { TargetType: 'lambda', Targets: [{ Id: FN_ARN }] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProvisioningError);
    expect((err as ProvisioningError).message).toContain('Tg');
    expect((err as ProvisioningError).message).toContain(FN_ARN);
    expect(sentNames()).not.toContain('RegisterTargetsCommand');
  });

  it('waits on the update path before registering a newly added Lambda target', async () => {
    await new ELBv2Provider().update(
      'Tg',
      TG_ARN,
      TG_TYPE,
      { TargetType: 'lambda', Targets: [{ Id: FN_ARN }] },
      { TargetType: 'lambda', Targets: [] }
    );
    expect(mockWait).toHaveBeenCalledTimes(1);
    expect(order.indexOf('wait')).toBeLessThan(order.indexOf('RegisterTargetsCommand'));
  });
});
