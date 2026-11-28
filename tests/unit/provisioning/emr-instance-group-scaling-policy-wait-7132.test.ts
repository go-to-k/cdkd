import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-emr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-emr')>();
  return {
    ...actual,
    EMRClient: vi.fn(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

const debug = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(function (this: unknown) {
      return this;
    }),
  };
  return { getLogger: () => ({ ...childLogger, child: () => childLogger }) };
});

import {
  EMRInstanceGroupConfigProvider,
  resetEMRInstanceGroupCreateRetryStateForTests,
} from '../../../src/provisioning/providers/emr-instance-group-config-provider.js';
import { SCALING_POLICY_STALE_READ_GRACE_POLLS } from '../../../src/provisioning/providers/emr-instance-group-config/scaling-policy-wait.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors/marks.js';

/**
 * go-to-k/cdkd#7132: PutAutoScalingPolicy (and an AddInstanceGroups carrying
 * a policy) answers PENDING; the policy reads ATTACHED ~10-15 s later, and
 * CloudFormation completes only then. These pin the wait and both send sites.
 */

const TYPE = 'AWS::EMR::InstanceGroupConfig';
const CLUSTER = 'j-1A2B3C4D5E6F7';
const GROUP = 'ig-ABCDEF123456';
const POLICY = { Constraints: { MinCapacity: 1, MaxCapacity: 4 }, Rules: [] };
const BASE = {
  JobFlowId: CLUSTER,
  InstanceRole: 'TASK',
  InstanceType: 'm5.xlarge',
  InstanceCount: 2,
};

/** A ListInstanceGroups page whose group's policy reads `state`. */
const listing = (state: string | undefined, reason?: string): unknown => ({
  InstanceGroups: [
    {
      Id: GROUP,
      Status: { State: 'RUNNING' },
      RunningInstanceCount: 2,
      ...(state !== undefined && {
        AutoScalingPolicy: {
          Status: {
            State: state,
            ...(reason !== undefined && {
              StateChangeReason: { Code: 'PROVISION_FAILURE', Message: reason },
            }),
          },
        },
      }),
    },
  ],
});

/** Route by command name; an array is a queue whose last entry repeats. */
function route(routes: Record<string, unknown>): void {
  const queues = new Map<string, unknown[]>();
  mockSend.mockImplementation((command: object) => {
    const name = command.constructor.name;
    if (!(name in routes)) return Promise.reject(new Error(`Unexpected command: ${name}`));
    let value = routes[name];
    if (Array.isArray(value)) {
      if (!queues.has(name)) queues.set(name, [...(value as unknown[])]);
      const q = queues.get(name)!;
      value = q.length > 1 ? q.shift() : q[0];
    }
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  });
}

const lists = (): number =>
  mockSend.mock.calls.filter((c) => (c[0] as object).constructor.name === 'ListInstanceGroupsCommand')
    .length;

const provider = (): EMRInstanceGroupConfigProvider =>
  new EMRInstanceGroupConfigProvider({ pollIntervalMs: 0, maxWaitMs: 60_000 });

const mask = (s: string): string => s.replaceAll('SECRET', '***');

async function withFakeTimers<T>(fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    const p = fn();
    await vi.runAllTimersAsync();
    return await p;
  } finally {
    vi.useRealTimers();
  }
}

beforeEach(() => {
  mockSend.mockReset();
  debug.mockReset();
  resetEMRInstanceGroupCreateRetryStateForTests();
});

afterEach(() => {
  delete process.env['CDKD_NO_WAIT'];
});

describe('waitForAutoScalingPolicySettled (#7132)', () => {
  const wait = (opts: { answeredState?: string; maxPolls?: number } = {}): Promise<void> =>
    provider().waitForAutoScalingPolicySettled(CLUSTER, GROUP, 'Grp', TYPE, mask, {
      pollMs: 0,
      ...opts,
    });

  it('polls through PENDING / ATTACHING and returns on ATTACHED', async () => {
    route({ ListInstanceGroupsCommand: [listing('PENDING'), listing('ATTACHING'), listing('ATTACHED')] });
    await wait({ answeredState: 'PENDING' });
    expect(lists()).toBe(3);
  });

  it('after a Put that answered PENDING, an ATTACHED read before any attaching read is the old policy', async () => {
    route({ ListInstanceGroupsCommand: [listing('ATTACHED'), listing('PENDING'), listing('ATTACHED')] });
    await wait({ answeredState: 'PENDING' });
    expect(lists()).toBe(3);
  });

  it('fails FAILED after the grace, non-retryable, with EMR reason in debug only', async () => {
    route({
      ListInstanceGroupsCommand: listing('FAILED', 'role arn:aws:iam::123456789012:role/SECRET'),
    });
    const err = await wait().catch((e: unknown) => e as Error);
    expect((err as Error).message).toContain('settled as FAILED, expected ATTACHED');
    expect((err as Error).message).not.toContain('role/');
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('role/***'));
    expect(isMarkedNonRetryable(err)).toBe(true);
    expect(lists()).toBe(SCALING_POLICY_STALE_READ_GRACE_POLLS + 1);
  });

  it('fails when no policy ever appears', async () => {
    route({ ListInstanceGroupsCommand: listing(undefined) });
    await expect(wait()).rejects.toThrow('settled as no policy, expected ATTACHED');
  });

  it('reads again after a throttled read, and fails at once on any other read error', async () => {
    route({
      ListInstanceGroupsCommand: [
        Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' }),
        listing('ATTACHED'),
      ],
    });
    await wait();
    expect(lists()).toBe(2);
    mockSend.mockReset();
    route({
      ListInstanceGroupsCommand: Object.assign(new Error('nope'), { name: 'AccessDeniedException' }),
    });
    await expect(wait()).rejects.toThrow('nope');
    expect(lists()).toBe(1);
  });

  it('throws, never returns, when its poll cap runs out', async () => {
    route({ ListInstanceGroupsCommand: listing('ATTACHING') });
    const err = await wait({ maxPolls: 3 }).catch((e: unknown) => e as Error);
    expect((err as Error).message).toMatch(/still ATTACHING .*not confirmed/);
    expect(isMarkedNonRetryable(err)).toBe(true);
    expect(lists()).toBe(3);
  });

  it('skips under --no-wait', async () => {
    process.env['CDKD_NO_WAIT'] = 'true';
    await wait();
    expect(mockSend).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('CDKD_NO_WAIT=true'));
  });
});

describe('EMR instance group send sites wait for the policy (#7132)', () => {
  it('update: PutAutoScalingPolicy is followed by polling until ATTACHED', async () => {
    route({
      PutAutoScalingPolicyCommand: { AutoScalingPolicy: { Status: { State: 'PENDING' } } },
      ListInstanceGroupsCommand: [listing('PENDING'), listing('ATTACHING'), listing('ATTACHED')],
    });
    await withFakeTimers(() =>
      provider().update('Grp', GROUP, TYPE, { ...BASE, AutoScalingPolicy: POLICY }, BASE)
    );
    expect(lists()).toBe(3);
  });

  it('update: a policy that ends FAILED fails the update non-retryable', async () => {
    route({
      PutAutoScalingPolicyCommand: { AutoScalingPolicy: { Status: { State: 'PENDING' } } },
      ListInstanceGroupsCommand: [listing('PENDING'), listing('FAILED')],
    });
    const err = await withFakeTimers(() =>
      provider()
        .update('Grp', GROUP, TYPE, { ...BASE, AutoScalingPolicy: POLICY }, BASE)
        .catch((e: unknown) => e as Error)
    );
    expect((err as Error).message).toContain('settled as FAILED');
    expect(isMarkedNonRetryable(err)).toBe(true);
  });

  it('update: RemoveAutoScalingPolicy is not waited on', async () => {
    route({ RemoveAutoScalingPolicyCommand: {} });
    await provider().update('Grp', GROUP, TYPE, BASE, { ...BASE, AutoScalingPolicy: POLICY });
    expect(lists()).toBe(0);
  });

  it('create: a group added with a policy waits for ATTACHED after RUNNING', async () => {
    route({
      AddInstanceGroupsCommand: { InstanceGroupIds: [GROUP] },
      ListInstanceGroupsCommand: [listing('PENDING'), listing('PENDING'), listing('ATTACHED')],
    });
    await withFakeTimers(() =>
      provider().create('Grp', TYPE, { ...BASE, AutoScalingPolicy: POLICY })
    );
    // One read for RUNNING (which also reads PENDING), then two for the policy.
    expect(lists()).toBe(3);
  });

  it('create: a group without a policy does not wait for one', async () => {
    route({
      AddInstanceGroupsCommand: { InstanceGroupIds: [GROUP] },
      ListInstanceGroupsCommand: listing(undefined),
    });
    await provider().create('Grp', TYPE, BASE);
    expect(lists()).toBe(1);
  });
});
