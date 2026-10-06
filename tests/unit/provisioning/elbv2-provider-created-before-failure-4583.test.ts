import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#4583: when a create's wiring fails AFTER the create call
// returned and the cleanup could not delete what it made, the thrown error
// names that ARN so `cdkd rollback --revert-failed` can delete it. A cleanup
// that succeeded, a cleanup skipped for a resource that held the name before
// the create, and the create call's own failure name nothing.

const { mockSend, ownershipSend } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  // The by-name (by-port, for a listener) lookup before a create
  // (go-to-k/cdkd#4403).
  ownershipSend: vi.fn(),
}));

function nameIsFree(command: { constructor: { name: string } }): Promise<unknown> {
  if (command.constructor.name === 'DescribeListenersCommand') {
    // Another port is taken; port 80 is free.
    return Promise.resolve({ Listeners: [{ Port: 443, ListenerArn: 'arn:other' }] });
  }
  return Promise.reject(
    Object.assign(new Error('One or more resources not found'), {
      name:
        command.constructor.name === 'DescribeTargetGroupsCommand'
          ? 'TargetGroupNotFoundException'
          : 'LoadBalancerNotFoundException',
    })
  );
}

vi.mock('@aws-sdk/client-elastic-load-balancing-v2', async () => {
  const actual = await vi.importActual<
    typeof import('@aws-sdk/client-elastic-load-balancing-v2')
  >('@aws-sdk/client-elastic-load-balancing-v2');
  return {
    ...actual,
    ElasticLoadBalancingV2Client: vi.fn().mockImplementation(() => ({
      send: (command: { input?: { Names?: unknown }; constructor: { name: string } }) =>
        command.input?.Names !== undefined ||
        command.constructor.name === 'DescribeListenersCommand'
          ? ownershipSend(command)
          : mockSend(command),
      config: { region: () => Promise.resolve('us-east-1') },
    })),
    waitUntilLoadBalancerAvailable: vi.fn().mockResolvedValue({ state: 'SUCCESS' }),
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
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';

const LB_TYPE = 'AWS::ElasticLoadBalancingV2::LoadBalancer';
const TG_TYPE = 'AWS::ElasticLoadBalancingV2::TargetGroup';
const LISTENER_TYPE = 'AWS::ElasticLoadBalancingV2::Listener';
const LB_ARN = 'arn:aws:elasticloadbalancing:us-east-1:123:loadbalancer/app/MyLb/abc';
const TG_ARN = 'arn:aws:elasticloadbalancing:us-east-1:123:targetgroup/MyTg/abc';
const LISTENER_ARN = 'arn:aws:elasticloadbalancing:us-east-1:123:listener/app/MyLb/abc/def';

/** Rejected by `withRetry` at once (a 400 validation error). */
function nonRetryable(message: string): Error {
  return Object.assign(new Error(message), {
    name: 'ValidationException',
    $metadata: { httpStatusCode: 400 },
  });
}

async function failure(run: () => Promise<unknown>): Promise<unknown> {
  return run().then(
    () => {
      throw new Error('expected create to fail');
    },
    (e: unknown) => e
  );
}

const cases = [
  {
    label: 'LoadBalancer',
    type: LB_TYPE,
    arn: LB_ARN,
    deleteCommand: 'DeleteLoadBalancerCommand',
    created: { LoadBalancers: [{ LoadBalancerArn: LB_ARN, LoadBalancerName: 'MyLb' }] },
    held: { LoadBalancers: [{ LoadBalancerArn: LB_ARN, LoadBalancerName: 'MyLb' }] },
    props: {
      Name: 'MyLb',
      Subnets: ['subnet-aaa'],
      LoadBalancerAttributes: [{ Key: 'idle_timeout.timeout_seconds', Value: '60' }],
    },
  },
  {
    label: 'TargetGroup',
    type: TG_TYPE,
    arn: TG_ARN,
    deleteCommand: 'DeleteTargetGroupCommand',
    created: { TargetGroups: [{ TargetGroupArn: TG_ARN, TargetGroupName: 'MyTg' }] },
    held: { TargetGroups: [{ TargetGroupArn: TG_ARN, TargetGroupName: 'MyTg' }] },
    props: {
      Name: 'MyTg',
      Port: 80,
      Protocol: 'HTTP',
      VpcId: 'vpc-aaa',
      TargetGroupAttributes: [{ Key: 'deregistration_delay.timeout_seconds', Value: '30' }],
    },
  },
  {
    label: 'Listener',
    type: LISTENER_TYPE,
    arn: LISTENER_ARN,
    deleteCommand: 'DeleteListenerCommand',
    created: { Listeners: [{ ListenerArn: LISTENER_ARN }] },
    // The listener already on the same port of the same load balancer.
    held: { Listeners: [{ ListenerArn: LISTENER_ARN, Port: 80 }] },
    props: {
      LoadBalancerArn: LB_ARN,
      Port: 80,
      Protocol: 'HTTP',
      DefaultActions: [{ Type: 'fixed-response', FixedResponseConfig: { StatusCode: '200' } }],
      ListenerAttributes: [{ Key: 'routing.http.response.server.enabled', Value: 'false' }],
    },
  },
] as const;

/** The `Delete*Command` inputs `mockSend` received under `name`. */
function sentDeletes(name: string): unknown[] {
  return mockSend.mock.calls
    .map(([command]) => command as { constructor: { name: string }; input: unknown })
    .filter((command) => command.constructor.name === name)
    .map((command) => command.input);
}

function deleteInput(c: (typeof cases)[number]): Record<string, string> {
  return c.label === 'LoadBalancer'
    ? { LoadBalancerArn: c.arn }
    : c.label === 'TargetGroup'
      ? { TargetGroupArn: c.arn }
      : { ListenerArn: c.arn };
}

describe('ELBv2Provider create marks a resource its cleanup left behind (go-to-k/cdkd#4583)', () => {
  let provider: ELBv2Provider;

  beforeEach(() => {
    mockSend.mockReset();
    ownershipSend.mockReset();
    ownershipSend.mockImplementation(nameIsFree);
    provider = new ELBv2Provider();
  });

  describe.each(cases)('$label', (c) => {
    it('names the ARN when the wiring fails and the cleanup delete fails too', async () => {
      mockSend.mockResolvedValueOnce(c.created);
      mockSend.mockRejectedValueOnce(nonRetryable('wiring boom'));
      mockSend.mockRejectedValueOnce(new Error('cleanup delete refused'));

      const error = await failure(() => provider.create('Res', c.type, c.props));

      expect((error as Error).message).toContain('wiring boom');
      expect(createdBeforeFailure(error, 'Res', c.type)).toBe(c.arn);
    });

    it('names nothing when the cleanup delete succeeded', async () => {
      mockSend.mockResolvedValueOnce(c.created);
      mockSend.mockRejectedValueOnce(nonRetryable('wiring boom'));
      mockSend.mockResolvedValueOnce({});

      const error = await failure(() => provider.create('Res', c.type, c.props));

      expect((error as Error).message).toContain('wiring boom');
      // The flow reached the cleanup and its delete was sent.
      expect(sentDeletes(c.deleteCommand)).toEqual([deleteInput(c)]);
      expect(createdBeforeFailure(error, 'Res', c.type)).toBeUndefined();
    });

    it("names nothing when the create call's own failure is thrown", async () => {
      mockSend.mockRejectedValueOnce(nonRetryable('create boom'));

      const error = await failure(() => provider.create('Res', c.type, c.props));

      expect((error as Error).message).toContain('create boom');
      expect(createdBeforeFailure(error, 'Res', c.type)).toBeUndefined();
    });

    if (c.held !== undefined) {
      const held = c.held;
      it('names nothing for a resource that held the name before the create', async () => {
        ownershipSend.mockReset();
        ownershipSend.mockResolvedValue(held);
        mockSend.mockResolvedValueOnce(c.created);
        mockSend.mockRejectedValueOnce(nonRetryable('wiring boom'));

        const error = await failure(() => provider.create('Res', c.type, c.props));

        expect((error as Error).message).toContain('wiring boom');
        // The cleanup was skipped, so no delete was sent either.
        expect(mockSend).toHaveBeenCalledTimes(2);
        expect(sentDeletes(c.deleteCommand)).toEqual([]);
        expect(createdBeforeFailure(error, 'Res', c.type)).toBeUndefined();
      });

      it('names nothing and deletes nothing when the lookup before the create cannot answer', async () => {
        ownershipSend.mockReset();
        ownershipSend.mockRejectedValue(
          Object.assign(new Error('not authorized'), { name: 'AccessDenied' })
        );
        mockSend.mockResolvedValueOnce(c.created);
        mockSend.mockRejectedValueOnce(nonRetryable('wiring boom'));

        const error = await failure(() => provider.create('Res', c.type, c.props));

        expect((error as Error).message).toContain('wiring boom');
        expect(ownershipSend).toHaveBeenCalled();
        expect(mockSend).toHaveBeenCalledTimes(2);
        expect(sentDeletes(c.deleteCommand)).toEqual([]);
        expect(createdBeforeFailure(error, 'Res', c.type)).toBeUndefined();
      });
    }
  });

  it('reads LoadBalancerNotFoundException from the listener lookup as free (the cleanup runs)', async () => {
    ownershipSend.mockReset();
    ownershipSend.mockRejectedValue(
      Object.assign(new Error('One or more load balancers not found'), {
        name: 'LoadBalancerNotFoundException',
      })
    );
    const listener = cases[2];
    mockSend.mockResolvedValueOnce(listener.created);
    mockSend.mockRejectedValueOnce(nonRetryable('wiring boom'));
    mockSend.mockResolvedValueOnce({}); // DeleteListener

    const error = await failure(() => provider.create('Res', LISTENER_TYPE, listener.props));

    expect(ownershipSend).toHaveBeenCalledTimes(1);
    expect(sentDeletes('DeleteListenerCommand')).toEqual([{ ListenerArn: LISTENER_ARN }]);
    expect(createdBeforeFailure(error, 'Res', LISTENER_TYPE)).toBeUndefined();
  });

  it('reads a listener on a later DescribeListeners page as held (by load balancer ARN + port)', async () => {
    ownershipSend.mockReset();
    ownershipSend
      .mockResolvedValueOnce({
        Listeners: [{ Port: 443, ListenerArn: 'arn:other' }],
        NextMarker: 'm1',
      })
      .mockResolvedValueOnce({
        Listeners: [{ Port: 80, ListenerArn: LISTENER_ARN }],
      });
    const listener = cases[2];
    mockSend.mockResolvedValueOnce(listener.created);
    mockSend.mockRejectedValueOnce(nonRetryable('wiring boom'));

    const error = await failure(() => provider.create('Res', LISTENER_TYPE, listener.props));

    expect(
      ownershipSend.mock.calls.map(([command]) => (command as { input: unknown }).input)
    ).toEqual([{ LoadBalancerArn: LB_ARN }, { LoadBalancerArn: LB_ARN, Marker: 'm1' }]);
    expect(sentDeletes('DeleteListenerCommand')).toEqual([]);
    expect(createdBeforeFailure(error, 'Res', LISTENER_TYPE)).toBeUndefined();
  });

  it('reads a DescribeListeners page loop that never ends as unknown (no delete, no mark)', async () => {
    ownershipSend.mockReset();
    ownershipSend.mockResolvedValue({
      Listeners: [{ Port: 443, ListenerArn: 'arn:other' }],
      NextMarker: 'again',
    });
    const listener = cases[2];
    mockSend.mockResolvedValueOnce(listener.created);
    mockSend.mockRejectedValueOnce(nonRetryable('wiring boom'));

    const error = await failure(() => provider.create('Res', LISTENER_TYPE, listener.props));

    expect((error as Error).message).toContain('wiring boom');
    // The lookup stopped at its 100-page cap and threw, not at a page answer.
    expect(ownershipSend).toHaveBeenCalledTimes(100);
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(sentDeletes('DeleteListenerCommand')).toEqual([]);
    expect(createdBeforeFailure(error, 'Res', LISTENER_TYPE)).toBeUndefined();
  });

  it('reads a listener with no Port (Gateway Load Balancer) as not holding port 80', async () => {
    ownershipSend.mockReset();
    ownershipSend.mockResolvedValue({ Listeners: [{ ListenerArn: 'arn:gwlb-listener' }] });
    const listener = cases[2];
    mockSend.mockResolvedValueOnce(listener.created);
    mockSend.mockRejectedValueOnce(nonRetryable('wiring boom'));
    mockSend.mockRejectedValueOnce(new Error('cleanup delete refused'));

    const error = await failure(() => provider.create('Res', LISTENER_TYPE, listener.props));

    // `free`: the cleanup ran on the listener this create returned, and its
    // failure marks that listener.
    expect(sentDeletes('DeleteListenerCommand')).toEqual([{ ListenerArn: LISTENER_ARN }]);
    expect(createdBeforeFailure(error, 'Res', LISTENER_TYPE)).toBe(LISTENER_ARN);
  });

  it('reads a listener with no Port as holding a create that also names no Port', async () => {
    ownershipSend.mockReset();
    ownershipSend.mockResolvedValue({ Listeners: [{ ListenerArn: LISTENER_ARN }] });
    const { Port: _port, Protocol: _protocol, ...props } = cases[2].props;
    mockSend.mockResolvedValueOnce(cases[2].created);
    mockSend.mockRejectedValueOnce(nonRetryable('wiring boom'));

    const error = await failure(() => provider.create('Res', LISTENER_TYPE, props));

    expect((error as Error).message).toContain('wiring boom');
    expect(sentDeletes('DeleteListenerCommand')).toEqual([]);
    expect(createdBeforeFailure(error, 'Res', LISTENER_TYPE)).toBeUndefined();
  });
});
