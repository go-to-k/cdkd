import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  DescribeInstancesCommand,
  ModifyInstanceAttributeCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  type Instance,
} from '@aws-sdk/client-ec2';

// go-to-k/cdkd#7023: an AWS::EC2::Instance EbsOptimized change is applied in
// place with a stop, ModifyInstanceAttribute { EbsOptimized } and a start, as
// CloudFormation does (measured us-east-1, a t3.micro: unset -> true,
// true -> false and false -> true each kept the instance id).

const { mockSend, warn } = vi.hoisted(() => ({ mockSend: vi.fn(), warn: vi.fn() }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
    cloudFormation: {
      send: vi.fn(() => Promise.reject(new Error('DescribeType is not reachable here'))),
    },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
    child: vi.fn(function (this: unknown) { return this; }),
  };
  return {
    getLogger: () => ({ child: () => childLogger, debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() }),
  };
});

vi.mock('@aws-sdk/client-ec2', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    waitUntilInstanceRunning: vi.fn(() => Promise.resolve({})),
    waitUntilInstanceTerminated: vi.fn(() => Promise.resolve({})),
  };
});

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import { isRefusedBeforeApplying } from '../../../src/deployment/prior-attempt-scope.js';

const TYPE = 'AWS::EC2::Instance';
const BASE = { ImageId: 'ami-1', InstanceType: 't3.micro', SubnetId: 'subnet-1' };

/** The instance as DescribeInstances answers it (state follows Stop / Start). */
let live: Instance;

function sent<T>(ctor: new (...a: never[]) => T): Array<Record<string, unknown>> {
  return mockSend.mock.calls
    .filter((c) => c[0] instanceof ctor)
    .map((c) => (c[0] as { input: Record<string, unknown> }).input);
}

/** The mutating calls, in order, by command name. */
function writes(): string[] {
  return mockSend.mock.calls
    .map((c) => c[0] as object)
    .filter(
      (cmd) =>
        cmd instanceof StopInstancesCommand ||
        cmd instanceof StartInstancesCommand ||
        cmd instanceof ModifyInstanceAttributeCommand
    )
    .map((cmd) => cmd.constructor.name);
}

const update = (
  desired: Record<string, unknown>,
  previous: Record<string, unknown>,
  context?: Record<string, unknown>
) => new EC2Provider().update('Inst', 'i-1', TYPE, desired, previous, context);

beforeEach(() => {
  mockSend.mockReset();
  warn.mockReset();
  live = { InstanceId: 'i-1', State: { Name: 'running' }, RootDeviceType: 'ebs', EbsOptimized: false };
  vi.spyOn(
    EC2Provider.prototype as unknown as { sleep: () => Promise<void> },
    'sleep'
  ).mockResolvedValue(undefined);
  mockSend.mockImplementation((cmd: unknown) => {
    if (cmd instanceof StopInstancesCommand) live.State = { Name: 'stopped' };
    if (cmd instanceof StartInstancesCommand) live.State = { Name: 'running' };
    if (cmd instanceof ModifyInstanceAttributeCommand) {
      const v = (cmd.input as { EbsOptimized?: { Value?: boolean } }).EbsOptimized?.Value;
      if (v !== undefined) live.EbsOptimized = v;
    }
    if (cmd instanceof DescribeInstancesCommand) {
      return Promise.resolve({ Reservations: [{ Instances: [structuredClone(live)] }] });
    }
    return Promise.resolve({});
  });
});

afterEach(() => {
  delete process.env['CDKD_NO_WAIT'];
});

describe('AWS::EC2::Instance EbsOptimized update (go-to-k/cdkd#7023)', () => {
  it('adds EbsOptimized: true with a stop, the modify and a start, keeping the instance', async () => {
    const result = await update({ ...BASE, EbsOptimized: true }, BASE);
    expect(writes()).toEqual([
      'StopInstancesCommand',
      'ModifyInstanceAttributeCommand',
      'StartInstancesCommand',
    ]);
    expect(sent(ModifyInstanceAttributeCommand)).toEqual([
      { InstanceId: 'i-1', EbsOptimized: { Value: true } },
    ]);
    expect(result.physicalId).toBe('i-1');
    expect(result.wasReplaced).toBe(false);
    expect(live.State?.Name).toBe('running');
  });

  it('turns it off the same way', async () => {
    live.EbsOptimized = true;
    await update({ ...BASE, EbsOptimized: false }, { ...BASE, EbsOptimized: true });
    expect(sent(ModifyInstanceAttributeCommand)).toEqual([
      { InstanceId: 'i-1', EbsOptimized: { Value: false } },
    ]);
    expect(writes()[0]).toBe('StopInstancesCommand');
  });

  it('takes a stringly-typed boolean', async () => {
    await update({ ...BASE, EbsOptimized: 'true' }, BASE);
    expect(sent(ModifyInstanceAttributeCommand)).toEqual([
      { InstanceId: 'i-1', EbsOptimized: { Value: true } },
    ]);
  });

  it('costs no stop when the instance already has the value', async () => {
    live.EbsOptimized = true;
    await update({ ...BASE, EbsOptimized: true }, BASE);
    expect(writes()).toEqual([]);
  });

  it('sends nothing for an equal value in another spelling', async () => {
    await update({ ...BASE, EbsOptimized: 'false' }, { ...BASE, EbsOptimized: false });
    expect(writes()).toEqual([]);
  });

  it('changes it in the same stopped window as an InstanceType change', async () => {
    await update({ ...BASE, InstanceType: 't3.small', EbsOptimized: true }, BASE);
    expect(writes()).toEqual([
      'StopInstancesCommand',
      'ModifyInstanceAttributeCommand',
      'ModifyInstanceAttributeCommand',
      'StartInstancesCommand',
    ]);
    expect(sent(ModifyInstanceAttributeCommand)).toEqual([
      { InstanceId: 'i-1', InstanceType: { Value: 't3.small' } },
      { InstanceId: 'i-1', EbsOptimized: { Value: true } },
    ]);
  });

  it('refuses a malformed value on a forward update before any call', async () => {
    const error = await update({ ...BASE, EbsOptimized: 'yes' }, BASE).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/EbsOptimized/);
    expect(isRefusedBeforeApplying(error, 'Inst')).toBe(true);
    expect(writes()).toEqual([]);
  });

  it('keeps the live value, with a warning, for a malformed value on a rollback revert', async () => {
    await update({ ...BASE, EbsOptimized: 'yes' }, BASE, { replayingState: true });
    expect(writes()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/EbsOptimized/));
  });

  // CloudFormation fails an update that removes it ("No attributes specified").
  it('refuses a removal on a forward update before any call', async () => {
    live.EbsOptimized = true;
    const error = await update(BASE, { ...BASE, EbsOptimized: true }).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/EbsOptimized was removed from the template/);
    expect(isRefusedBeforeApplying(error, 'Inst')).toBe(true);
    expect(writes()).toEqual([]);
  });

  it('keeps the live value, with a warning, when a rollback revert would remove it', async () => {
    live.EbsOptimized = true;
    await update(BASE, { ...BASE, EbsOptimized: true }, { replayingState: true });
    expect(writes()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/does not declare EbsOptimized/));
  });

  it('refuses an instance-store-backed instance before any call', async () => {
    live.RootDeviceType = 'instance-store';
    const error = await update({ ...BASE, EbsOptimized: true }, BASE).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/EbsOptimized can change only on a stopped instance/);
    expect(writes()).toEqual([]);
  });

  it('leaves an instance the user had stopped stopped', async () => {
    live.State = { Name: 'stopped' };
    await update({ ...BASE, EbsOptimized: true }, BASE);
    expect(writes()).toEqual(['ModifyInstanceAttributeCommand']);
    expect(live.State?.Name).toBe('stopped');
  });
});
