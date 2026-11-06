import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  DescribeCapacityReservationCommand,
  DescribeListenerAttributesCommand,
  DescribeListenersCommand,
  DescribeLoadBalancerAttributesCommand,
  DescribeLoadBalancersCommand,
  DescribeTagsCommand,
  DescribeTargetGroupAttributesCommand,
  DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { ELBv2Provider } from '../../../src/provisioning/providers/elbv2-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

// The ELBv2 method bodies live in `src/provisioning/providers/elbv2/*.ts`; the
// class keeps one `return f.call(this, ...)` delegator per method. Each case
// pins one argument hand-off that no other suite observed: replacing that
// argument with `undefined` in the delegator left every other ELBv2 test green.

const LB_TYPE = 'AWS::ElasticLoadBalancingV2::LoadBalancer';
const TG_TYPE = 'AWS::ElasticLoadBalancingV2::TargetGroup';
const LISTENER_TYPE = 'AWS::ElasticLoadBalancingV2::Listener';
const LB_ARN = 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/lb/0123456789abcdef';
const TG_ARN = 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/tg/0123456789abcdef';
const LISTENER_ARN =
  'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/lb/0123456789abcdef/fedcba9876543210';

type Sent = { constructor: { name: string }; input: Record<string, unknown> };

function providerWith(send: (command: Sent) => Promise<unknown>): {
  provider: ELBv2Provider;
  sent: Sent[];
} {
  const provider = new ELBv2Provider();
  const sent: Sent[] = [];
  vi.spyOn(provider, 'getClient').mockReturnValue({
    send: (command: Sent) => {
      sent.push(command);
      return send(command);
    },
    config: { region: () => Promise.resolve('us-east-1') },
  } as unknown as ReturnType<ELBv2Provider['getClient']>);
  return { provider, sent };
}

function inputsOf(sent: Sent[], ctor: { name: string }): Array<Record<string, unknown>> {
  return sent.filter((c) => c.constructor.name === ctor.name).map((c) => c.input);
}

const accessDenied = (): Error =>
  Object.assign(new Error('User is not authorized to perform this action'), {
    name: 'AccessDeniedException',
  });

describe('ELBv2Provider delegators hand each argument to the moved body', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('readCurrentState reads the LoadBalancer the physical id names', async () => {
    const { provider, sent } = providerWith(async (c) => {
      if (c.constructor.name === DescribeLoadBalancersCommand.name) {
        return { LoadBalancers: [{ LoadBalancerArn: LB_ARN, LoadBalancerName: 'lb' }] };
      }
      return {};
    });
    await provider.readCurrentState(LB_ARN, 'Lb', LB_TYPE);
    expect(inputsOf(sent, DescribeLoadBalancersCommand)).toEqual([{ LoadBalancerArns: [LB_ARN] }]);
    expect(inputsOf(sent, DescribeLoadBalancerAttributesCommand)[0]).toEqual({
      LoadBalancerArn: LB_ARN,
    });
    expect(inputsOf(sent, DescribeTagsCommand)).toEqual([{ ResourceArns: [LB_ARN] }]);
  });

  it('readCurrentState reads the TargetGroup, its targets and its tags by the physical id', async () => {
    const { provider, sent } = providerWith(async (c) => {
      if (c.constructor.name === DescribeTargetGroupsCommand.name) {
        return { TargetGroups: [{ TargetGroupArn: TG_ARN, TargetGroupName: 'tg' }] };
      }
      return {};
    });
    await provider.readCurrentState(TG_ARN, 'Tg', TG_TYPE);
    expect(inputsOf(sent, DescribeTargetGroupsCommand)).toEqual([{ TargetGroupArns: [TG_ARN] }]);
    expect(inputsOf(sent, DescribeTargetGroupAttributesCommand)[0]).toEqual({
      TargetGroupArn: TG_ARN,
    });
    expect(inputsOf(sent, DescribeTargetHealthCommand)).toEqual([{ TargetGroupArn: TG_ARN }]);
    expect(inputsOf(sent, DescribeTagsCommand)).toEqual([{ ResourceArns: [TG_ARN] }]);
  });

  it('readCurrentState reads the Listener the physical id names', async () => {
    const { provider, sent } = providerWith(async (c) => {
      if (c.constructor.name === DescribeListenersCommand.name) {
        return { Listeners: [{ ListenerArn: LISTENER_ARN, LoadBalancerArn: LB_ARN, Port: 80 }] };
      }
      return {};
    });
    await provider.readCurrentState(LISTENER_ARN, 'Listener', LISTENER_TYPE);
    expect(inputsOf(sent, DescribeListenersCommand)).toEqual([{ ListenerArns: [LISTENER_ARN] }]);
    expect(inputsOf(sent, DescribeListenerAttributesCommand)[0]).toEqual({
      ListenerArn: LISTENER_ARN,
    });
  });

  it('holderCreatedAt reads the LoadBalancer the physical id names', async () => {
    const created = new Date('2026-01-02T03:04:05Z');
    const { provider, sent } = providerWith(async () => ({
      LoadBalancers: [{ LoadBalancerArn: LB_ARN, CreatedTime: created }],
    }));
    await expect(provider.holderCreatedAt(LB_TYPE, LB_ARN)).resolves.toBe(created.getTime());
    expect(inputsOf(sent, DescribeLoadBalancersCommand)).toEqual([{ LoadBalancerArns: [LB_ARN] }]);
  });

  it('waitForCapacityReservationProvisioned polls the given LoadBalancer and names the resource', async () => {
    const { provider, sent } = providerWith(async () => ({
      CapacityReservationState: [
        { AvailabilityZone: 'us-east-1a', State: { Code: 'failed', Reason: 'no capacity' } },
      ],
    }));
    await expect(provider.waitForCapacityReservationProvisioned(LB_ARN, 'MyLb')).rejects.toThrow(
      /Capacity reservation for MyLb failed in us-east-1a/
    );
    expect(inputsOf(sent, DescribeCapacityReservationCommand)).toEqual([
      { LoadBalancerArn: LB_ARN },
    ]);
  });

  it('convertActions returns the declared actions', () => {
    const actions = [{ Type: 'forward', TargetGroupArn: TG_ARN }];
    expect(new ELBv2Provider().convertActions(actions)).toBe(actions);
  });

  it('waitForLambdaTargetsActive names the resource in its skip line', async () => {
    const provider = new ELBv2Provider();
    const debug = vi.spyOn(provider.logger, 'debug').mockImplementation(() => undefined);
    await provider.waitForLambdaTargetsActive('MyTg', 'lambda', [{ Id: 'not-an-arn' }]);
    expect(debug).toHaveBeenCalledWith(
      'Skipping the Active wait for target not-an-arn of MyTg: not a Lambda function ARN'
    );
  });

  it('logDeleteTargetGone names what is gone for a failed-create orphan', () => {
    const provider = new ELBv2Provider();
    const info = vi.spyOn(provider.logger, 'info').mockImplementation(() => undefined);
    provider.logDeleteTargetGone(
      { failedCreateOrphan: true },
      'Target group',
      TG_ARN,
      'MyTg',
      'debug text'
    );
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]![0])).toContain(`Target group ${TG_ARN} (MyTg)`);
  });

  for (const [type, arn] of [
    [LB_TYPE, LB_ARN],
    [TG_TYPE, TG_ARN],
    [LISTENER_TYPE, LISTENER_ARN],
  ] as const) {
    it(`delete stamps a failed ${type.split('::')[2]} delete with its resource type and cause`, async () => {
      const denied = accessDenied();
      const { provider } = providerWith(async () => {
        throw denied;
      });
      const err = await provider.delete('Res', arn, type).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProvisioningError);
      expect((err as ProvisioningError).resourceType).toBe(type);
      expect((err as ProvisioningError).physicalId).toBe(arn);
      expect((err as Error).cause).toBe(denied);
    });
  }
});
