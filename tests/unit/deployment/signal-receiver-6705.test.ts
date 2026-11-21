import { describe, expect, it, vi } from 'vite-plus/test';
import {
  CancelUpdateStackCommand,
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStackResourceCommand,
  DescribeStacksCommand,
  GetTemplateCommand,
  UpdateStackCommand,
} from '@aws-sdk/client-cloudformation';
import {
  deleteSignalReceiver,
  isReceiver,
  isoDurationMs,
  RECEIVER_DESCRIPTION,
  RECEIVER_TAG_KEY,
  removeSignalReceiverNamed,
  SignalReceiver,
  signalCandidateOf,
  signalCandidatesOf,
  canReceiveFor,
} from '../../../src/deployment/deploy-engine/signal-receiver.js';

const RECEIVER_TAGS = [{ Key: RECEIVER_TAG_KEY, Value: 'true' }];
const ARN = 'arn:aws:cloudformation:us-east-1:123456789012:stack/App/11111111-2222-3333-4444-555555555555';

function receiverStack(status = 'CREATE_COMPLETE') {
  return { StackId: ARN, StackName: 'App', StackStatus: status, Description: RECEIVER_DESCRIPTION, Tags: RECEIVER_TAGS };
}

function logger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
}

type Handler = (command: unknown) => unknown;

/** A client whose `send` dispatches on the command class. */
function client(handlers: Map<unknown, Handler>) {
  const calls: unknown[] = [];
  const send = vi.fn(async (command: { constructor: unknown; input: unknown }) => {
    calls.push(command);
    const handler = handlers.get(command.constructor);
    if (handler === undefined) throw new Error(`unexpected ${String(command.constructor)}`);
    return handler(command);
  });
  return { client: { send } as never, calls, send };
}

const notFound = () => {
  throw new Error('Stack with id App does not exist');
};

const clock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
};

const instance = {
  Type: 'AWS::EC2::Instance',
  CreationPolicy: { ResourceSignal: { Count: 2, Timeout: 'PT10M' } },
  Metadata: { 'AWS::CloudFormation::Init': { config: {} } },
};

describe('signal candidates (go-to-k/cdkd#6705)', () => {
  it('reads count, timeout and cfn-init metadata', () => {
    expect(signalCandidateOf(instance)).toEqual({ count: 2, timeoutMs: 600_000, hasInitMetadata: true });
    expect(signalCandidateOf({ Type: 'X', CreationPolicy: { ResourceSignal: {} } })).toEqual({
      count: 1,
      timeoutMs: 300_000,
      hasInitMetadata: false,
    });
    expect(signalCandidateOf({ Type: 'X', Metadata: { 'AWS::CloudFormation::Init': {} } })).toEqual({
      count: 0,
      timeoutMs: 0,
      hasInitMetadata: true,
    });
    expect(signalCandidateOf({ Type: 'X', CreationPolicy: { AutoScalingCreationPolicy: {} } })).toBeUndefined();
    expect(signalCandidateOf({ Type: 'X', Metadata: { Other: 1 } })).toBeUndefined();
  });

  it('caps the timeout at 12 hours and parses ISO durations', () => {
    expect(signalCandidateOf({ CreationPolicy: { ResourceSignal: { Timeout: 'PT13H' } } })?.timeoutMs).toBe(43_200_000);
    expect(isoDurationMs('PT1H2M3S')).toBe(3_723_000);
    expect(isoDurationMs('PT')).toBeUndefined();
    expect(isoDurationMs(5)).toBeUndefined();
  });

  it('lists only resources asking for something', () => {
    const map = signalCandidatesOf({ Resources: { I: instance, B: { Type: 'AWS::S3::Bucket' } } } as never);
    expect([...map.keys()]).toEqual(['I']);
  });

  it('refuses a nested child name as a stack name', () => {
    expect(canReceiveFor('App')).toBe(true);
    expect(canReceiveFor('App~Child')).toBe(false);
  });

  it('recognises a receiver only by tag AND description', () => {
    expect(isReceiver(receiverStack())).toBe(true);
    expect(isReceiver({ ...receiverStack(), Description: 'x' })).toBe(false);
    expect(isReceiver({ ...receiverStack(), Tags: [] })).toBe(false);
  });
});

describe('SignalReceiver.ensure', () => {
  it('creates the receiver when none exists and returns its id', async () => {
    let created = false;
    const { client: c, calls } = client(
      new Map<unknown, Handler>([
        [DescribeStacksCommand, () => (created ? { Stacks: [receiverStack()] } : notFound())],
        [CreateStackCommand, () => ((created = true), { StackId: ARN })],
      ])
    );
    const log = logger();
    const r = new SignalReceiver('App', new Map([['I', signalCandidateOf(instance)!]]), () => c, log, clock());
    await expect(r.ensure(undefined)).resolves.toBe(ARN);
    const create = calls.find((x) => x instanceof CreateStackCommand) as CreateStackCommand;
    expect(create.input.StackName).toBe('App');
    expect(create.input.Tags).toEqual(RECEIVER_TAGS);
    expect(JSON.parse(create.input.TemplateBody!).Description).toBe(RECEIVER_DESCRIPTION);
  });

  it('leaves a foreign stack holding the name alone and falls back', async () => {
    const { client: c, calls } = client(
      new Map<unknown, Handler>([
        [DescribeStacksCommand, () => ({ Stacks: [{ StackId: ARN, StackStatus: 'CREATE_COMPLETE', Tags: [] }] })],
      ])
    );
    const log = logger();
    const r = new SignalReceiver('App', new Map(), () => c, log, clock());
    await expect(r.ensure(undefined)).resolves.toBeUndefined();
    expect(calls.some((x) => x instanceof CreateStackCommand || x instanceof DeleteStackCommand)).toBe(false);
    expect(log.warn.mock.calls[0]![0]).toMatch(/is not cdkd's signal receiver/);
  });

  it('falls back with a warning when CloudFormation refuses', async () => {
    const { client: c } = client(
      new Map<unknown, Handler>([
        [
          DescribeStacksCommand,
          () => {
            throw Object.assign(new Error('not authorized'), { name: 'AccessDenied' });
          },
        ],
      ])
    );
    const log = logger();
    const r = new SignalReceiver('App', new Map(), () => c, log, clock());
    await expect(r.ensure(ARN)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('reuses the recorded receiver without creating one', async () => {
    const { client: c, calls } = client(
      new Map<unknown, Handler>([[DescribeStacksCommand, () => ({ Stacks: [receiverStack('UPDATE_COMPLETE')] })]])
    );
    const r = new SignalReceiver('App', new Map(), () => c, logger(), clock());
    await expect(r.ensure(ARN)).resolves.toBe(ARN);
    expect(calls.some((x) => x instanceof CreateStackCommand)).toBe(false);
  });
});

describe('SignalReceiver.arm / awaitSignals / settle', () => {
  function armedReceiver(
    resourceStatus: () => string | undefined,
    existing: Record<string, unknown> = {},
    updatesFinish = false
  ) {
    const updates: Record<string, unknown>[] = [];
    let stackStatus = 'UPDATE_COMPLETE';
    const { client: c, calls } = client(
      new Map<unknown, Handler>([
        [
          DescribeStacksCommand,
          () => {
            const out = { Stacks: [receiverStack(stackStatus)] };
            if (updatesFinish) stackStatus = 'UPDATE_COMPLETE';
            return out;
          },
        ],
        [GetTemplateCommand, () => ({ TemplateBody: JSON.stringify({ Resources: existing }) })],
        [
          UpdateStackCommand,
          (cmd) => {
            updates.push(JSON.parse((cmd as UpdateStackCommand).input.TemplateBody!).Resources);
            stackStatus = 'UPDATE_IN_PROGRESS';
            return {};
          },
        ],
        [
          DescribeStackResourceCommand,
          () => {
            const status = resourceStatus();
            if (status === undefined) notFound();
            return { StackResourceDetail: { ResourceStatus: status, ResourceStatusReason: 'why' } };
          },
        ],
        [CancelUpdateStackCommand, () => ({})],
      ])
    );
    const r = new SignalReceiver('App', new Map([['I', signalCandidateOf(instance)!]]), () => c, logger(), clock());
    return { r, updates, calls, setStatus: (s: string) => (stackStatus = s) };
  }

  it('arms a created resource with a fresh waiter carrying its metadata', async () => {
    const { r, updates } = armedReceiver(() => 'CREATE_IN_PROGRESS');
    await r.ensure(ARN);
    const armed = await r.arm(new Set(['I']), async () => ({ 'AWS::CloudFormation::Init': { resolved: true } }));
    expect([...armed]).toEqual(['I']);
    expect(r.isArmed('I')).toBe(true);
    expect(updates[0]!['I']).toEqual({
      Type: 'AWS::CloudFormation::WaitCondition',
      CreationPolicy: { ResourceSignal: { Count: 2, Timeout: 'PT12H' } },
      Metadata: { 'AWS::CloudFormation::Init': { resolved: true } },
    });
  });

  it('keeps an unchanged cfn-init resource on a metadata holder, unarmed', async () => {
    const { r, updates } = armedReceiver(() => 'CREATE_IN_PROGRESS');
    await r.ensure(ARN);
    await r.arm(new Set(), async () => ({ m: 1 }));
    expect(r.isArmed('I')).toBe(false);
    expect(updates[0]!['I']).toEqual({ Type: 'AWS::CloudFormation::WaitConditionHandle', Metadata: { m: 1 } });
  });

  it('does not cover a resource whose metadata cannot be sent', async () => {
    const { r } = armedReceiver(() => 'CREATE_IN_PROGRESS');
    await r.ensure(ARN);
    const armed = await r.arm(new Set(['I']), async () => {
      throw new Error('reads a NoEcho value');
    });
    expect(armed.size).toBe(0);
  });

  it('removes an earlier waiter in its own update before re-arming it', async () => {
    const earlier = { Type: 'AWS::CloudFormation::WaitCondition' };
    const { r, updates } = armedReceiver(() => 'CREATE_IN_PROGRESS', { I: earlier }, true);
    await r.ensure(ARN);
    await expect(r.arm(new Set(['I']), async () => undefined)).resolves.toEqual(new Set(['I']));
    expect(updates[0]!['I']).toBeUndefined();
    expect((updates[1]!['I'] as { Type: string }).Type).toBe('AWS::CloudFormation::WaitCondition');
  });

  it('awaitSignals succeeds on CREATE_COMPLETE', async () => {
    const statuses = ['CREATE_IN_PROGRESS', 'CREATE_IN_PROGRESS', 'CREATE_COMPLETE'];
    let armingDone = false;
    const { r } = armedReceiver(() => (armingDone ? statuses.shift() : 'CREATE_IN_PROGRESS'));
    await r.ensure(ARN);
    await r.arm(new Set(['I']), async () => undefined);
    armingDone = true;
    await expect(r.awaitSignals('I', 0, () => false)).resolves.toBeUndefined();
  });

  it('awaitSignals fails on CREATE_FAILED with the reason', async () => {
    let armingDone = false;
    const { r } = armedReceiver(() => (armingDone ? 'CREATE_FAILED' : 'CREATE_IN_PROGRESS'));
    await r.ensure(ARN);
    await r.arm(new Set(['I']), async () => undefined);
    armingDone = true;
    await expect(r.awaitSignals('I', 0, () => false)).rejects.toThrow(/FAILURE signal.*why/);
  });

  it('awaitSignals fails at the policy timeout', async () => {
    const { r } = armedReceiver(() => 'CREATE_IN_PROGRESS');
    await r.ensure(ARN);
    await r.arm(new Set(['I']), async () => undefined);
    await expect(r.awaitSignals('I', 0, () => false)).rejects.toThrow(/did not receive 2 CreationPolicy signal\(s\) within 600s/);
  });

  it('awaitSignals stops with the deploy', async () => {
    const { r } = armedReceiver(() => 'CREATE_IN_PROGRESS');
    await r.ensure(ARN);
    await r.arm(new Set(['I']), async () => undefined);
    await expect(r.awaitSignals('I', 0, () => true)).rejects.toThrow(/stopped with the deploy/);
  });

  it('awaitSignals is a no-op for an unarmed resource', async () => {
    const { r, calls } = armedReceiver(() => 'CREATE_IN_PROGRESS');
    await expect(r.awaitSignals('I', 0, () => true)).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('settle cancels the update a deploy left in progress', async () => {
    const { r, calls } = armedReceiver(() => 'CREATE_IN_PROGRESS');
    await r.ensure(ARN);
    await r.arm(new Set(['I']), async () => undefined);
    await r.settle();
    expect(calls.some((x) => x instanceof CancelUpdateStackCommand)).toBe(true);
  });
});

describe('receiver deletion', () => {
  it('deletes only a stack carrying the receiver marks', async () => {
    const own = client(new Map<unknown, Handler>([[DescribeStacksCommand, () => ({ Stacks: [receiverStack()] })], [DeleteStackCommand, () => ({})]]));
    await deleteSignalReceiver(own.client, ARN, logger());
    expect(own.calls.some((x) => x instanceof DeleteStackCommand)).toBe(true);

    const foreign = client(
      new Map<unknown, Handler>([[DescribeStacksCommand, () => ({ Stacks: [{ ...receiverStack(), Tags: [] }] })]])
    );
    await deleteSignalReceiver(foreign.client, ARN, logger());
    expect(foreign.calls.some((x) => x instanceof DeleteStackCommand)).toBe(false);
  });

  it('warns with the delete-stack command when the delete fails', async () => {
    const { client: c } = client(
      new Map<unknown, Handler>([
        [DescribeStacksCommand, () => ({ Stacks: [receiverStack()] })],
        [
          DeleteStackCommand,
          () => {
            throw new Error('denied');
          },
        ],
      ])
    );
    const log = logger();
    await deleteSignalReceiver(c, ARN, log);
    expect(log.warn.mock.calls[0]![0]).toMatch(/aws cloudformation delete-stack --stack-name/);
  });

  it('export removes the receiver holding the name and waits until it is gone', async () => {
    let deleted = false;
    const { client: c, calls } = client(
      new Map<unknown, Handler>([
        [DescribeStacksCommand, () => (deleted ? notFound() : { Stacks: [receiverStack()] })],
        [DeleteStackCommand, () => ((deleted = true), {})],
      ])
    );
    await removeSignalReceiverNamed(c, 'App', logger(), clock());
    expect(calls.filter((x) => x instanceof DeleteStackCommand)).toHaveLength(1);
  });

  it('export leaves a foreign stack holding the name alone', async () => {
    const { client: c, calls } = client(
      new Map<unknown, Handler>([[DescribeStacksCommand, () => ({ Stacks: [{ StackId: ARN, StackStatus: 'CREATE_COMPLETE' }] })]])
    );
    await removeSignalReceiverNamed(c, 'App', logger(), clock());
    expect(calls.some((x) => x instanceof DeleteStackCommand)).toBe(false);
  });
});
