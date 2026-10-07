/**
 * Issue #4400: a protected `AWS::AutoScaling::AutoScalingGroup` routed through
 * Cloud Control is deleted by the SDK `ASGProvider` (issue #798), whose
 * `--remove-protection` flip registries -- the group's `DeletionProtection`
 * (#4235) and each launched instance's `DisableApiTermination` (#4397) -- live
 * on the provider INSTANCE. A delegate built per `delete()` call started every
 * re-entered attempt with empty registries, so attempt 1 turning the guards
 * off and failing retryably, then attempt 2 reading them OFF and failing
 * terminally, restored neither. These cases drive the REAL `ASGProvider`
 * through `CloudControlProvider.delete`, with only the AWS clients faked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const asgSend = vi.hoisted(() => vi.fn());
const ec2Send = vi.hoisted(() => vi.fn());
const ccSend = vi.hoisted(() => vi.fn());
const asgClientCtor = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-auto-scaling', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    AutoScalingClient: vi.fn().mockImplementation((config: { region?: string }) => {
      asgClientCtor(config.region);
      return { send: asgSend, config: { region: () => Promise.resolve('us-east-1') } };
    }),
  };
});

vi.mock('@aws-sdk/client-ec2', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    EC2Client: vi.fn().mockImplementation(() => ({
      send: ec2Send,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudControl: { send: ccSend, config: { region: () => Promise.resolve('us-east-1') } },
    ec2: { send: ec2Send, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({ child: () => child, debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  };
});

import { CloudControlProvider } from '../../../src/provisioning/cloud-control-provider.js';

type Cmd = { constructor: { name: string }; input: Record<string, unknown> };

const ASG_TYPE = 'AWS::AutoScaling::AutoScalingGroup';
const ASG = 'my-asg';
const I1 = 'i-0aaaaaaaaaaaaaaa1';
const CTX = { removeProtection: true, expectedRegion: 'us-east-1' };
const REFUSAL = 'because its deletion protection is enabled';

/** A group delete refusal matching no retryable pattern: TERMINAL. */
function terminalRefusal(): Error {
  const e = new Error(`Cannot delete Auto Scaling group ${ASG} ${REFUSAL}`);
  e.name = 'ValidationError';
  return e;
}

function throttle(): Error {
  const e = new Error('Rate exceeded');
  e.name = 'Throttling';
  return e;
}

/**
 * Fake services holding the group's and the instance's guard across calls,
 * so attempt 2 reads what attempt 1 wrote.
 */
function script(deletes: (Error | undefined)[]): void {
  let groupGuard = 'prevent-force-deletion';
  let instanceGuard = true;
  let deleteCalls = 0;
  asgSend.mockImplementation(async (cmd: Cmd) => {
    switch (cmd.constructor.name) {
      case 'DescribeAutoScalingGroupsCommand':
        return {
          AutoScalingGroups: [
            {
              AutoScalingGroupName: ASG,
              DeletionProtection: groupGuard,
              Instances: [{ InstanceId: I1 }],
            },
          ],
        };
      case 'UpdateAutoScalingGroupCommand': {
        const level = cmd.input['DeletionProtection'];
        if (typeof level === 'string') groupGuard = level;
        return {};
      }
      case 'DeleteAutoScalingGroupCommand': {
        const outcome = deletes[deleteCalls];
        deleteCalls += 1;
        if (outcome) throw outcome;
        return {};
      }
      default:
        throw new Error(`unexpected ASG command ${cmd.constructor.name}`);
    }
  });
  ec2Send.mockImplementation(async (cmd: Cmd) => {
    switch (cmd.constructor.name) {
      case 'DescribeInstanceAttributeCommand':
        return { DisableApiTermination: { Value: instanceGuard } };
      case 'ModifyInstanceAttributeCommand':
        instanceGuard = (cmd.input['DisableApiTermination'] as { Value: boolean }).Value;
        return {};
      default:
        throw new Error(`unexpected EC2 command ${cmd.constructor.name}`);
    }
  });
}

/** The group `DeletionProtection` writes, in order. */
function groupWrites(): unknown[] {
  return asgSend.mock.calls
    .map((c) => c[0] as Cmd)
    .filter((c) => c.constructor.name === 'UpdateAutoScalingGroupCommand')
    .map((c) => c.input['DeletionProtection']);
}

/** The instance `DisableApiTermination` writes, in order. */
function instanceWrites(): boolean[] {
  return ec2Send.mock.calls
    .map((c) => c[0] as Cmd)
    .filter((c) => c.constructor.name === 'ModifyInstanceAttributeCommand')
    .map((c) => (c.input['DisableApiTermination'] as { Value: boolean }).Value);
}

const del = (provider: CloudControlProvider) =>
  provider
    .delete('Asg', ASG, ASG_TYPE, undefined, CTX)
    .then(() => undefined)
    .catch((e: unknown) => e);

describe('CloudControlProvider keeps ONE ASGProvider delegate across delete() re-entry (issue #4400)', () => {
  const savedRegion = process.env['AWS_REGION'];

  beforeEach(() => {
    vi.clearAllMocks();
    asgSend.mockReset();
    ec2Send.mockReset();
    process.env['AWS_REGION'] = 'us-east-1';
  });

  afterEach(() => {
    if (savedRegion === undefined) delete process.env['AWS_REGION'];
    else process.env['AWS_REGION'] = savedRegion;
  });

  it('a retryable attempt then a terminal one restores BOTH the group guard and the instance guard', async () => {
    script([throttle(), terminalRefusal()]);
    const provider = new CloudControlProvider();

    const first = await del(provider);
    expect((first as Error).message).toContain('Rate exceeded');
    // Retryable: a re-entry is coming, so nothing is put back yet.
    expect(groupWrites()).toEqual(['none']);
    expect(instanceWrites()).toEqual([false]);

    // Attempt 2 reads both guards OFF -- attempt 1 is why -- and must restore
    // from what attempt 1 recorded.
    const second = await del(provider);
    expect((second as Error).message).toContain(REFUSAL);
    // Only the LAST write is pinned: whether attempt 2 re-writes an
    // already-off guard is the delegate's business, not this fix's.
    expect(groupWrites().at(-1)).toBe('prevent-force-deletion');
    expect(instanceWrites().at(-1)).toBe(true);
    // The whole sequence went through the SDK delegate, never Cloud Control.
    expect(ccSend).not.toHaveBeenCalled();
  });

  it('builds the delegate once per region: a second call in the same region reuses it, another region gets its own', async () => {
    script([throttle(), throttle(), throttle()]);
    const provider = new CloudControlProvider();

    await del(provider);
    await del(provider);
    // One delegate builds TWO AutoScalingClients together: the shared one and
    // its `CreateAutoScalingGroup` client (issue #4639).
    expect(asgClientCtor.mock.calls).toEqual([['us-east-1'], ['us-east-1']]);

    // The delegate binds its clients to the ambient region at construction,
    // so a call made under another one must not inherit a us-east-1 client.
    process.env['AWS_REGION'] = 'us-west-2';
    await del(provider);
    expect(asgClientCtor.mock.calls).toEqual([
      ['us-east-1'],
      ['us-east-1'],
      ['us-west-2'],
      ['us-west-2'],
    ]);
  });

  it('two CONCURRENT first calls in one region share one delegate', async () => {
    script([throttle(), throttle()]);
    const provider = new CloudControlProvider();

    await Promise.all([del(provider), del(provider)]);

    expect(asgClientCtor.mock.calls).toEqual([['us-east-1'], ['us-east-1']]);
  });
});
