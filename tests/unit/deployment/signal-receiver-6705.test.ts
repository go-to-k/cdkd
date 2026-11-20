import { describe, it, expect, vi } from 'vite-plus/test';
import type { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import {
  buildSignalReceiver,
  isoDurationMs,
  receiverTemplate,
  RECEIVER_TAG_KEY,
  signalCandidateOf,
  SignalReceiver,
  type SignalCandidate,
} from '../../../src/deployment/deploy-engine/signal-receiver.js';
import { honorCreationPolicy } from '../../../src/deployment/deploy-engine/update-policy.js';

// go-to-k/cdkd#6705: the CloudFormation signal receiver that lets a cdkd
// deploy honor `CreationPolicy` signals and serve `cfn-init` metadata.

const logger = () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn() });

type Cmd = { constructor: { name: string }; input: Record<string, unknown> };

/** A CloudFormation client answering by command name. */
function client(handlers: Record<string, (input: Record<string, unknown>) => unknown>) {
  const send = vi.fn(async (cmd: Cmd) => {
    const h = handlers[cmd.constructor.name];
    if (h === undefined) throw new Error(`unexpected ${cmd.constructor.name}`);
    return h(cmd.input);
  });
  return { client: { send } as unknown as CloudFormationClient, send };
}

const notFound = () => {
  throw new Error('Stack with id S does not exist');
};

function receiver(
  candidates: Record<string, SignalCandidate>,
  c: CloudFormationClient,
  log = logger(),
  clock = { t: 0 }
) {
  return new SignalReceiver('S', new Map(Object.entries(candidates)), () => c, log, {
    sleep: async (ms) => {
      clock.t += ms;
    },
    now: () => clock.t,
  });
}

const POLICY: SignalCandidate = { count: 1, timeoutMs: 600_000, hasInitMetadata: false };

describe('signalCandidateOf', () => {
  it('reads a CreationPolicy ResourceSignal (defaults: Count 1, Timeout PT5M)', () => {
    expect(
      signalCandidateOf({ CreationPolicy: { ResourceSignal: { Count: 2, Timeout: 'PT15M' } } })
    ).toEqual({ count: 2, timeoutMs: 900_000, hasInitMetadata: false });
    expect(signalCandidateOf({ CreationPolicy: { ResourceSignal: {} } })).toEqual({
      count: 1,
      timeoutMs: 300_000,
      hasInitMetadata: false,
    });
  });

  it('caps the timeout at 12 h and reads a quoted count', () => {
    expect(
      signalCandidateOf({ CreationPolicy: { ResourceSignal: { Count: '3', Timeout: 'PT20H' } } })
    ).toEqual({ count: 3, timeoutMs: 12 * 3600_000, hasInitMetadata: false });
  });

  it('marks cfn-init metadata, with or without a policy', () => {
    expect(signalCandidateOf({ Metadata: { 'AWS::CloudFormation::Init': {} } })).toEqual({
      count: 0,
      timeoutMs: 0,
      hasInitMetadata: true,
    });
  });

  it('is undefined for a resource asking for neither', () => {
    expect(signalCandidateOf({ Metadata: { 'aws:cdk:path': 'x' } })).toBeUndefined();
    expect(signalCandidateOf({ CreationPolicy: { StartFleet: true } })).toBeUndefined();
    expect(signalCandidateOf(undefined)).toBeUndefined();
  });
});

describe('isoDurationMs / receiverTemplate / canReceiveFor', () => {
  it('parses CloudFormation durations', () => {
    expect(isoDurationMs('PT1H30M')).toBe(5_400_000);
    expect(isoDurationMs('PT90S')).toBe(90_000);
    expect(isoDurationMs('15M')).toBeUndefined();
  });

  it('builds one WaitCondition per entry, metadata carried, the receiver timeout at the maximum', () => {
    const t = JSON.parse(
      receiverTemplate([
        { logicalId: 'Inst', count: 2, metadata: { 'AWS::CloudFormation::Init': { config: {} } } },
        { logicalId: 'InitOnly', count: 0 },
      ])
    );
    expect(t.Resources.Inst).toEqual({
      Type: 'AWS::CloudFormation::WaitCondition',
      CreationPolicy: { ResourceSignal: { Count: 2, Timeout: 'PT12H' } },
      Metadata: { 'AWS::CloudFormation::Init': { config: {} } },
    });
    expect(t.Resources.InitOnly.CreationPolicy.ResourceSignal.Count).toBe(1);
  });

  it('refuses a nested child name, which holds ~', () => {
    expect(SignalReceiver.canReceiveFor('MyStack')).toBe(true);
    expect(SignalReceiver.canReceiveFor('Parent~Child')).toBe(false);
  });
});

describe('buildSignalReceiver', () => {
  const t = {
    Resources: {
      Inst: { Type: 'AWS::EC2::Instance', CreationPolicy: { ResourceSignal: {} } },
      Bucket: { Type: 'AWS::S3::Bucket' },
    },
  };

  it('is undefined when no CREATE row asks, or for a nested child', () => {
    expect(buildSignalReceiver({ logger: logger() }, 'S', [{ logicalId: 'Bucket' }], t)).toBeUndefined();
    expect(buildSignalReceiver({ logger: logger() }, 'P~C', [{ logicalId: 'Inst' }], t)).toBeUndefined();
  });

  it('covers the asking CREATE rows', () => {
    const r = buildSignalReceiver({ logger: logger() }, 'S', [{ logicalId: 'Inst' }, { logicalId: 'Bucket' }], t);
    expect(r?.candidate('Inst')).toBeDefined();
    expect(r?.candidate('Bucket')).toBeUndefined();
  });
});

describe('SignalReceiver.cover', () => {
  it('creates the receiver once (tagged), for every candidate, and waits for its resources', async () => {
    let created: Record<string, unknown> | undefined;
    const { client: c, send } = client({
      DescribeStacksCommand: notFound,
      CreateStackCommand: (input) => {
        created = input;
        return {};
      },
      DescribeStackResourcesCommand: () => ({
        StackResources: [{ LogicalResourceId: 'A' }, { LogicalResourceId: 'B' }],
      }),
    });
    const r = receiver({ A: POLICY, B: { count: 0, timeoutMs: 0, hasInitMetadata: true } }, c);
    const resolve = vi.fn(async () => ({ 'AWS::CloudFormation::Init': { config: {} } }));
    const [a, b] = await Promise.all([r.cover('A', resolve), r.cover('B', resolve)]);
    expect([a, b]).toEqual(['covered', 'covered']);
    expect(send.mock.calls.filter(([cmd]) => cmd.constructor.name === 'CreateStackCommand')).toHaveLength(1);
    expect(created?.['StackName']).toBe('S');
    expect(created?.['Tags']).toEqual([{ Key: RECEIVER_TAG_KEY, Value: 'true' }]);
    expect(resolve).toHaveBeenCalledWith('B');
    expect(resolve).not.toHaveBeenCalledWith('A');
  });

  it('leaves a stack it did not make alone, and covers nothing', async () => {
    const log = logger();
    const { client: c, send } = client({
      DescribeStacksCommand: () => ({ Stacks: [{ StackStatus: 'CREATE_COMPLETE', Tags: [] }] }),
    });
    expect(await receiver({ A: POLICY }, c, log).cover('A', vi.fn())).toBe('not-covered');
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(log.warn.mock.calls[0]![0])).toMatch(/not a cdkd signal receiver.*left alone/);
  });

  it('deletes a receiver an interrupted deploy left, then creates its own', async () => {
    let described = 0;
    const { client: c, send } = client({
      DescribeStacksCommand: () => {
        described++;
        if (described === 1) {
          return { Stacks: [{ StackStatus: 'CREATE_IN_PROGRESS', Tags: [{ Key: RECEIVER_TAG_KEY, Value: 'true' }] }] };
        }
        return notFound();
      },
      DeleteStackCommand: () => ({}),
      CreateStackCommand: () => ({}),
      DescribeStackResourcesCommand: () => ({ StackResources: [{ LogicalResourceId: 'A' }] }),
    });
    expect(await receiver({ A: POLICY }, c).cover('A', vi.fn())).toBe('covered');
    expect(send.mock.calls.map(([cmd]) => cmd.constructor.name)).toEqual([
      'DescribeStacksCommand',
      'DeleteStackCommand',
      'DescribeStacksCommand',
      'CreateStackCommand',
      'DescribeStackResourcesCommand',
    ]);
  });

  it('falls back when CreateStack is denied, without throwing', async () => {
    const log = logger();
    const { client: c } = client({
      DescribeStacksCommand: notFound,
      CreateStackCommand: () => {
        throw Object.assign(new Error('not authorized'), { name: 'AccessDenied' });
      },
    });
    const r = receiver({ A: POLICY }, c, log);
    expect(await r.cover('A', vi.fn())).toBe('not-covered');
    expect(String(log.warn.mock.calls[0]![0])).toMatch(/created without waiting for signals/);
    await r.dispose();
  });

  it('leaves out a candidate whose metadata does not resolve yet', async () => {
    const { client: c } = client({
      DescribeStacksCommand: notFound,
      CreateStackCommand: () => ({}),
      DescribeStackResourcesCommand: () => ({ StackResources: [{ LogicalResourceId: 'A' }] }),
    });
    const r = receiver({ A: POLICY, B: { count: 1, timeoutMs: 1000, hasInitMetadata: true } }, c);
    const resolve = vi.fn(async () => {
      throw new Error('Ref not found');
    });
    expect(await r.cover('A', resolve)).toBe('covered');
    expect(await r.cover('B', resolve)).toBe('not-covered');
  });

  it('is not-covered for a resource that is not a candidate, with no call', async () => {
    const { client: c, send } = client({});
    expect(await receiver({ A: POLICY }, c).cover('Other', vi.fn())).toBe('not-covered');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('SignalReceiver.awaitSignals', () => {
  const statuses = (...s: Array<{ ResourceStatus: string; ResourceStatusReason?: string }>) => {
    let i = 0;
    return client({
      DescribeStackResourceCommand: () => ({ StackResourceDetail: s[Math.min(i++, s.length - 1)] }),
    });
  };

  it('returns once the receiver resource completes', async () => {
    const { client: c, send } = statuses(
      { ResourceStatus: 'CREATE_IN_PROGRESS' },
      { ResourceStatus: 'CREATE_COMPLETE' }
    );
    await receiver({ A: POLICY }, c).awaitSignals('A', 0);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('fails on a FAILURE signal, naming the reason', async () => {
    const { client: c } = statuses({ ResourceStatus: 'CREATE_FAILED', ResourceStatusReason: 'Received FAILURE signal' });
    await expect(receiver({ A: POLICY }, c).awaitSignals('A', 0)).rejects.toThrow(
      /A received a FAILURE signal or did not signal.*Received FAILURE signal/
    );
  });

  it('fails once the declared Timeout passes, counted from the create', async () => {
    const clock = { t: 0 };
    const { client: c } = statuses({ ResourceStatus: 'CREATE_IN_PROGRESS' });
    await expect(receiver({ A: POLICY }, c, logger(), clock).awaitSignals('A', 0)).rejects.toThrow(
      /did not receive 1 CreationPolicy signal\(s\) within 600s/
    );
    expect(clock.t).toBe(600_000);
  });

  it('waits for nothing on a metadata-only entry', async () => {
    const { client: c, send } = client({});
    await receiver({ A: { count: 0, timeoutMs: 0, hasInitMetadata: true } }, c).awaitSignals('A', 0);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('SignalReceiver.dispose', () => {
  it('deletes only a receiver this deploy created, and never throws', async () => {
    const none = client({});
    await receiver({ A: POLICY }, none.client).dispose();
    expect(none.send).not.toHaveBeenCalled();

    const { client: c, send } = client({
      DescribeStacksCommand: notFound,
      CreateStackCommand: () => ({}),
      DescribeStackResourcesCommand: () => ({ StackResources: [{ LogicalResourceId: 'A' }] }),
      DeleteStackCommand: () => {
        throw new Error('throttled');
      },
    });
    const log = logger();
    const r = receiver({ A: POLICY }, c, log);
    await r.cover('A', vi.fn());
    await expect(r.dispose()).resolves.toBeUndefined();
    expect(send.mock.calls.at(-1)![0].constructor.name).toBe('DeleteStackCommand');
    expect(String(log.warn.mock.calls[0]![0])).toMatch(/Could not delete the CloudFormation signal receiver/);
  });
});

describe('honorCreationPolicy', () => {
  it('waits through the receiver when it covers the resource, and does not warn', async () => {
    const { client: c } = client({
      DescribeStacksCommand: notFound,
      CreateStackCommand: () => ({}),
      DescribeStackResourcesCommand: () => ({ StackResources: [{ LogicalResourceId: 'A' }] }),
      DescribeStackResourceCommand: () => ({ StackResourceDetail: { ResourceStatus: 'CREATE_COMPLETE' } }),
    });
    const r = receiver({ A: POLICY }, c);
    await r.cover('A', vi.fn());
    const log = logger();
    await honorCreationPolicy(log, r, 'A', { CreationPolicy: { ResourceSignal: {} } } as never, 0);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('warns that the policy is not honored when nothing covers the resource', async () => {
    const log = logger();
    await honorCreationPolicy(log, undefined, 'A', { CreationPolicy: { ResourceSignal: {} } } as never, 0);
    expect(String(log.warn.mock.calls[0]![0])).toMatch(/CreationPolicy is not honored/);
  });
});
