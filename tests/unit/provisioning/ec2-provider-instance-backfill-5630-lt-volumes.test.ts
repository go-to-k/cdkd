import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  AttachVolumeCommand,
  DescribeInstancesCommand,
  DescribeVolumesCommand,
  DetachVolumeCommand,
  RunInstancesCommand,
  TerminateInstancesCommand,
  CreateTagsCommand,
  StopInstancesCommand,
  StartInstancesCommand,
  waitUntilInstanceRunning,
  waitUntilInstanceTerminated,
} from '@aws-sdk/client-ec2';

// go-to-k/cdkd#5630 (fourth slice): AWS::EC2::Instance LaunchTemplate and
// Volumes. CloudFormation measured (us-east-1, 2026-11-06, a t3.nano launched
// from a launch template):
//  - LaunchTemplate: a Version change creates a new instance (schema
//    create-only). The template's instance tags are merged with the
//    instance's Tags, the instance's value winning on a shared key.
//  - Volumes: adding an entry attaches the volume, removing one detaches it, a
//    Device change detaches and re-attaches it, and removing the property
//    detaches every listed volume, all on the same running instance. A
//    replacement while a listed volume is attached fails ("already attached
//    to an instance").

const { mockSend, warn, cfnSend, deadlineRemaining } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  warn: vi.fn(),
  // The enclosing resource deadline the waits read; none by default.
  deadlineRemaining: vi.fn(() => Number.POSITIVE_INFINITY),
  cfnSend: vi.fn(() => Promise.reject(new Error('DescribeType is not reachable here'))),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
    cloudFormation: { send: cfnSend },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
    }),
  };
});

vi.mock('../../../src/deployment/resource-deadline.js', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, enclosingDeadlineRemainingMs: deadlineRemaining };
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
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';
import { isRefusedBeforeApplying } from '../../../src/deployment/prior-attempt-scope.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors/marks.js';
import {
  disarmInterruptWatchForTests,
  interruptWatchTestSeam,
  isInterruptedWaitError,
} from '../../../src/provisioning/interrupt-watch.js';

const TYPE = 'AWS::EC2::Instance';
const BASE = { ImageId: 'ami-1', InstanceType: 't3.nano', SubnetId: 'subnet-1' };
const SDF1 = { Device: '/dev/sdf', VolumeId: 'vol-1' };
const SDG2 = { Device: '/dev/sdg', VolumeId: 'vol-2' };
const SDH2 = { Device: '/dev/sdh', VolumeId: 'vol-2' };

function sent<T>(ctor: new (...a: never[]) => T): Array<Record<string, unknown>> {
  return mockSend.mock.calls
    .filter((c) => c[0] instanceof ctor)
    .map((c) => (c[0] as { input: Record<string, unknown> }).input);
}

/** DescribeInstances sent after the TerminateInstances (the termination wait's reads). */
function describesAfterTerminate(): number {
  const start = mockSend.mock.calls.findIndex((c) => c[0] instanceof TerminateInstancesCommand);
  if (start < 0) return 0;
  return mockSend.mock.calls.slice(start).filter((c) => c[0] instanceof DescribeInstancesCommand)
    .length;
}

/** The volume writes, in order, as `<Attach|Detach> <volume> <device>`. */
function volumeWrites(): string[] {
  return mockSend.mock.calls
    .map((c) => c[0] as object)
    .filter((cmd) => cmd instanceof AttachVolumeCommand || cmd instanceof DetachVolumeCommand)
    .map((cmd) => {
      const input = (cmd as unknown as { input: Record<string, string> }).input;
      const verb = cmd instanceof AttachVolumeCommand ? 'Attach' : 'Detach';
      // A DetachVolume names no Device (it detaches from the instance).
      return verb === 'Attach'
        ? `${verb} ${input['VolumeId']} ${input['Device']}`
        : `${verb} ${input['VolumeId']}${input['Device'] === undefined ? '' : ` ${input['Device']}`}`;
    });
}

/** volume id -> its attachment, as the mocked EC2 holds it. */
let attachments: Map<string, { InstanceId: string; Device: string; State: string }>;
let failAttach: Error | undefined;
let failDetach: Error | undefined;
/** When set, an AttachVolume is accepted but never shows up in DescribeVolumes. */
let attachInvisible: boolean;
let bdm: Array<{ DeviceName: string; Ebs: { VolumeId: string } }>;
/** Reads that still show a detached volume as `detaching` after its DetachVolume. */
let detachingReads: number;
/** Volume ids DescribeVolumes answers InvalidVolume.NotFound for. */
let goneVolumes: Set<string>;
/** When set, the tagged RunInstances is denied ec2:CreateTags (the untagged re-send). */
let denyTaggedLaunch: boolean;
/** The instance's state after the last StopInstances / StartInstances (running before either). */
let powerState: string;
/** When set, every DescribeVolumes fails with this error. */
let failVolumeRead: Error | undefined;
/** Called on each DescribeVolumes before it answers. */
let onVolumeRead: (() => void) | undefined;
/** States the instance reads after TerminateInstances, in order (the last repeats). */
let terminateStates: string[];

beforeEach(() => {
  mockSend.mockReset();
  warn.mockReset();
  vi.mocked(waitUntilInstanceRunning).mockClear();
  attachments = new Map();
  failAttach = undefined;
  failDetach = undefined;
  attachInvisible = false;
  bdm = [];
  detachingReads = 0;
  goneVolumes = new Set();
  denyTaggedLaunch = false;
  powerState = 'running';
  failVolumeRead = undefined;
  onVolumeRead = undefined;
  terminateStates = ['terminated'];
  deadlineRemaining.mockReset();
  deadlineRemaining.mockReturnValue(Number.POSITIVE_INFINITY);
  vi.mocked(waitUntilInstanceTerminated).mockClear();
  vi.spyOn(
    EC2Provider.prototype as unknown as { sleep: () => Promise<void> },
    'sleep'
  ).mockResolvedValue(undefined);
  let volumeReads = 0;
  mockSend.mockImplementation((cmd: unknown) => {
    const input = (cmd as { input: Record<string, unknown> }).input;
    if (cmd instanceof RunInstancesCommand) {
      if (denyTaggedLaunch && input['TagSpecifications'] !== undefined) {
        return Promise.reject(
          Object.assign(
            new Error(
              'You are not authorized to perform this operation. User: arn:aws:sts::123456789012:assumed-role/r/s is not authorized to perform: ec2:CreateTags on resource: arn:aws:ec2:us-east-1:123456789012:instance/*'
            ),
            { name: 'UnauthorizedOperation' }
          )
        );
      }
      return Promise.resolve({ Instances: [{ InstanceId: 'i-new' }] });
    }
    if (cmd instanceof StopInstancesCommand) powerState = 'stopped';
    if (cmd instanceof StartInstancesCommand) powerState = 'running';
    if (cmd instanceof TerminateInstancesCommand) powerState = 'terminating';
    if (cmd instanceof DescribeInstancesCommand) {
      const state =
        powerState === 'terminating'
          ? terminateStates.length > 1
            ? terminateStates.shift()!
            : terminateStates[0]!
          : powerState;
      return Promise.resolve({
        Reservations: [
          {
            Instances: [
              {
                InstanceId: 'i-new',
                State: { Name: state },
                RootDeviceType: 'ebs',
                BlockDeviceMappings: bdm,
              },
            ],
          },
        ],
      });
    }
    if (cmd instanceof AttachVolumeCommand) {
      if (failAttach !== undefined) return Promise.reject(failAttach);
      if (!attachInvisible) {
        attachments.set(input['VolumeId'] as string, {
          InstanceId: input['InstanceId'] as string,
          Device: input['Device'] as string,
          State: 'attached',
        });
      }
      return Promise.resolve({ State: 'attaching' });
    }
    if (cmd instanceof DetachVolumeCommand) {
      if (failDetach !== undefined) return Promise.reject(failDetach);
      const id = input['VolumeId'] as string;
      const held = attachments.get(id);
      // EC2 refuses a DetachVolume naming a Device the volume is not at.
      if (held !== undefined && input['Device'] !== undefined && input['Device'] !== held.Device) {
        return Promise.reject(
          Object.assign(new Error('No attachment at that device'), {
            name: 'InvalidAttachment.NotFound',
          })
        );
      }
      if (held !== undefined && detachingReads > 0) held.State = 'detaching';
      else attachments.delete(id);
      return Promise.resolve({ State: 'detaching' });
    }
    if (cmd instanceof DescribeVolumesCommand) {
      // The waits' sleep is stubbed: a wait that never sees its target fails
      // the test instead of spinning.
      if (++volumeReads > 50) return Promise.reject(new Error('runaway DescribeVolumes poll'));
      onVolumeRead?.();
      if (failVolumeRead !== undefined) return Promise.reject(failVolumeRead);
      const id = (input['VolumeIds'] as string[])[0]!;
      if (goneVolumes.has(id)) {
        return Promise.reject(
          Object.assign(new Error(`The volume '${id}' does not exist.`), {
            name: 'InvalidVolume.NotFound',
          })
        );
      }
      const attachment = attachments.get(id);
      if (attachment?.State === 'detaching' && --detachingReads <= 0) attachments.delete(id);
      return Promise.resolve({
        Volumes: [{ VolumeId: id, Attachments: attachment === undefined ? [] : [attachment] }],
      });
    }
    return Promise.resolve({});
  });
});

afterEach(() => {
  delete process.env['CDKD_NO_WAIT'];
});

describe('AWS::EC2::Instance LaunchTemplate create (#5630)', () => {
  it('launches from the template with no ImageId or InstanceType, a numeric Version sent as its string', async () => {
    await new EC2Provider().create('Inst', TYPE, {
      SubnetId: 'subnet-1',
      LaunchTemplate: { LaunchTemplateId: 'lt-1', Version: 3 },
    });
    const [input] = sent(RunInstancesCommand);
    expect(input?.['LaunchTemplate']).toEqual({ LaunchTemplateId: 'lt-1', Version: '3' });
    expect(input).not.toHaveProperty('ImageId');
    expect(input).not.toHaveProperty('InstanceType');
  });

  it('sends a LaunchTemplateName and keeps a declared ImageId / InstanceType beside it', async () => {
    await new EC2Provider().create('Inst', TYPE, {
      ...BASE,
      LaunchTemplate: { LaunchTemplateName: 'web', Version: '$Latest' },
    });
    expect(sent(RunInstancesCommand)[0]).toMatchObject({
      ImageId: 'ami-1',
      InstanceType: 't3.nano',
      LaunchTemplate: { LaunchTemplateName: 'web', Version: '$Latest' },
    });
  });

  it('still requires ImageId, and defaults InstanceType, without a LaunchTemplate', async () => {
    await expect(
      new EC2Provider().create('Inst', TYPE, { SubnetId: 'subnet-1' })
    ).rejects.toThrow(/ImageId is required for EC2 Instance Inst/);
    await new EC2Provider().create('Inst', TYPE, { ImageId: 'ami-1' });
    expect(sent(RunInstancesCommand)[0]).toMatchObject({ ImageId: 'ami-1', InstanceType: 't3.micro' });
    expect(sent(RunInstancesCommand)[0]).not.toHaveProperty('LaunchTemplate');
  });

  it.each([
    ['a non-object LaunchTemplate', 'lt-1', /LaunchTemplate must be an object/],
    ['one naming neither an id nor a name', { Version: '1' }, /must name a LaunchTemplateId or a LaunchTemplateName/],
    ['a blank id and no name', { LaunchTemplateId: '' }, /must name a LaunchTemplateId or a LaunchTemplateName/],
    ['a non-string id', { LaunchTemplateId: 7 }, /LaunchTemplate\.LaunchTemplateId must be a non-empty string/],
  ])('refuses %s before RunInstances', async (_label, value, says) => {
    await expect(
      new EC2Provider().create('Inst', TYPE, { SubnetId: 'subnet-1', LaunchTemplate: value })
    ).rejects.toThrow(says);
    expect(sent(RunInstancesCommand)).toHaveLength(0);
  });
});

describe('AWS::EC2::Instance Volumes create (#5630)', () => {
  it('attaches each volume once the instance runs, waiting for running even under --no-wait', async () => {
    process.env['CDKD_NO_WAIT'] = 'true';
    await new EC2Provider().create('Inst', TYPE, { ...BASE, Volumes: [SDF1, SDG2] });
    expect(waitUntilInstanceRunning).toHaveBeenCalledTimes(1);
    expect(volumeWrites()).toEqual(['Attach vol-1 /dev/sdf', 'Attach vol-2 /dev/sdg']);
    expect(sent(AttachVolumeCommand)[0]).toMatchObject({ InstanceId: 'i-new' });
  });

  it('skips the running wait under --no-wait when no volume is declared', async () => {
    process.env['CDKD_NO_WAIT'] = 'true';
    await new EC2Provider().create('Inst', TYPE, BASE);
    expect(waitUntilInstanceRunning).not.toHaveBeenCalled();
    expect(volumeWrites()).toEqual([]);
  });

  it('terminates the new instance when a volume another instance holds cannot attach', async () => {
    attachments.set('vol-1', { InstanceId: 'i-old', Device: '/dev/sdf', State: 'attached' });
    failAttach = Object.assign(new Error('vol-1 is already attached to an instance'), {
      name: 'VolumeInUse',
    });
    await expect(
      new EC2Provider().create('Inst', TYPE, { ...BASE, Volumes: [SDF1] })
    ).rejects.toThrow(/already attached to an instance/);
    expect(sent(TerminateInstancesCommand)).toEqual([{ InstanceIds: ['i-new'] }]);
  });

  it('takes a refused AttachVolume whose volume already sits here at that device as the attachment', async () => {
    attachments.set('vol-1', { InstanceId: 'i-new', Device: '/dev/sdf', State: 'attached' });
    failAttach = Object.assign(new Error('already attached'), { name: 'VolumeInUse' });
    await new EC2Provider().create('Inst', TYPE, { ...BASE, Volumes: [SDF1] });
    expect(sent(TerminateInstancesCommand)).toHaveLength(0);
  });

  it('fails the attach wait when the attachment never appears', async () => {
    attachInvisible = true;
    await expect(
      new EC2Provider().create('Inst', TYPE, { ...BASE, Volumes: [SDF1] })
    ).rejects.toThrow(/volume vol-1 is not attached at \/dev\/sdf while cdkd waited/);
    // A read right after AttachVolume can lag it: 15 empty reads, not one.
    expect(sent(DescribeVolumesCommand)).toHaveLength(15);
  });

  it('waits for the instance to terminate when a create fails after an AttachVolume, so the volume is free for a rollback', async () => {
    attachInvisible = true;
    await expect(
      new EC2Provider().create('Inst', TYPE, { ...BASE, Volumes: [SDF1] })
    ).rejects.toThrow(/not attached at \/dev\/sdf/);
    expect(sent(TerminateInstancesCommand)).toEqual([{ InstanceIds: ['i-new'] }]);
    // Polled DescribeInstances after the terminate until `terminated`.
    expect(describesAfterTerminate()).toBeGreaterThan(0);
    expect(warn.mock.calls.flat().join('\n')).not.toMatch(/not seen terminated/);
  });

  it('still reads, a bounded number of times, when the create failed past the resource deadline', async () => {
    attachInvisible = true;
    terminateStates = ['shutting-down', 'shutting-down', 'terminated'];
    deadlineRemaining.mockImplementation(() =>
      powerState === 'terminating' ? 0 : Number.POSITIVE_INFINITY
    );
    await expect(
      new EC2Provider().create('Inst', TYPE, { ...BASE, Volumes: [SDF1] })
    ).rejects.toThrow(/not attached at \/dev\/sdf/);
    expect(describesAfterTerminate()).toBe(3);
    expect(warn.mock.calls.flat().join('\n')).not.toMatch(/not seen terminated/);
  });

  it('waits for termination after an ambiguous AttachVolume failure whose read lags to no attachment', async () => {
    failAttach = Object.assign(new Error('socket hang up'), { name: 'TimeoutError' });
    await expect(
      new EC2Provider().create('Inst', TYPE, { ...BASE, Volumes: [SDF1] })
    ).rejects.toThrow(/socket hang up/);
    expect(describesAfterTerminate()).toBeGreaterThan(0);
  });

  it('warns "interrupted", and still throws the attach error, when Ctrl-C lands in the termination wait', async () => {
    disarmInterruptWatchForTests();
    interruptWatchTestSeam.commandOwnsInterrupts = () => true;
    const baseline = process.listeners('SIGINT');
    try {
      attachInvisible = true;
      terminateStates = ['shutting-down'];
      const base = mockSend.getMockImplementation()!;
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof DescribeInstancesCommand && powerState === 'terminating') {
          for (const l of process.listeners('SIGINT').filter((x) => !baseline.includes(x))) {
            (l as unknown as () => void)();
          }
        }
        return base(cmd);
      });
      const error = await new EC2Provider()
        .create('Inst', TYPE, { ...BASE, Volumes: [SDF1] })
        .catch((e: unknown) => e);
      expect(String(error)).toMatch(/not attached at \/dev\/sdf/);
      const warned = warn.mock.calls.flat().join('\n');
      expect(warned).toMatch(/was not seen terminated after its failed create \(interrupted\)/);
      expect(warned).not.toMatch(/STILL RUNNING/);
      expect(describesAfterTerminate()).toBe(1);
    } finally {
      disarmInterruptWatchForTests();
      delete interruptWatchTestSeam.commandOwnsInterrupts;
    }
  });

  it('warns, and still throws the attach error, when the instance is not seen terminated before the deadline', async () => {
    attachInvisible = true;
    terminateStates = ['shutting-down'];
    // Room for the attach wait, then none once the instance is terminating.
    deadlineRemaining.mockImplementation(() =>
      powerState === 'terminating' ? 0 : Number.POSITIVE_INFINITY
    );
    const error = await new EC2Provider()
      .create('Inst', TYPE, { ...BASE, Volumes: [SDF1] })
      .catch((e: unknown) => e);
    expect(String(error)).toMatch(/volume vol-1 is not attached at \/dev\/sdf/);
    const warned = warn.mock.calls.flat().join('\n');
    expect(warned).toMatch(/Instance i-new of Inst was not seen terminated after its failed create \(timed out\)/);
    expect(warned).not.toMatch(/STILL RUNNING/);
    // Past the deadline it still read, a bounded number of times.
    expect(describesAfterTerminate()).toBe(12);
  });

  it('warns, and still throws the attach error, when the termination read fails', async () => {
    attachInvisible = true;
    const base = mockSend.getMockImplementation()!;
    mockSend.mockImplementation((cmd: unknown) =>
      cmd instanceof DescribeInstancesCommand && powerState === 'terminating'
        ? Promise.reject(Object.assign(new Error('throttled'), { name: 'RequestLimitExceeded' }))
        : base(cmd)
    );
    const error = await new EC2Provider()
      .create('Inst', TYPE, { ...BASE, Volumes: [SDF1] })
      .catch((e: unknown) => e);
    expect(String(error)).toMatch(/volume vol-1 is not attached at \/dev\/sdf/);
    const warned = warn.mock.calls.flat().join('\n');
    expect(warned).toMatch(/was not seen terminated after its failed create \(read failed: /);
    expect(warned).not.toMatch(/STILL RUNNING/);
  });

  it('does not wait for termination when the only AttachVolume was refused outright (a 4xx)', async () => {
    attachments.set('vol-1', { InstanceId: 'i-old', Device: '/dev/sdf', State: 'attached' });
    failAttach = Object.assign(new Error('vol-1 is already attached to an instance'), {
      name: 'VolumeInUse',
      $metadata: { httpStatusCode: 400 },
    });
    await expect(
      new EC2Provider().create('Inst', TYPE, { ...BASE, Volumes: [SDF1] })
    ).rejects.toThrow(/VolumeInUse/);
    expect(sent(TerminateInstancesCommand)).toHaveLength(1);
    expect(describesAfterTerminate()).toBe(0);
  });

  it('does not wait for termination when the create failed before any AttachVolume', async () => {
    let describes = 0;
    const base = mockSend.getMockImplementation()!;
    mockSend.mockImplementation((cmd: unknown) =>
      cmd instanceof DescribeInstancesCommand && ++describes === 1
        ? Promise.reject(Object.assign(new Error('boom'), { name: 'InternalError' }))
        : base(cmd)
    );
    await expect(new EC2Provider().create('Inst', TYPE, BASE)).rejects.toThrow();
    expect(sent(TerminateInstancesCommand)).toHaveLength(1);
    expect(waitUntilInstanceTerminated).not.toHaveBeenCalled();
    expect(powerState).toBe('terminating');
    expect(
      mockSend.mock.calls
        .map((c) => c[0] as object)
        .slice(mockSend.mock.calls.findIndex((c) => c[0] instanceof TerminateInstancesCommand))
        .filter((cmd) => cmd instanceof DescribeInstancesCommand)
    ).toHaveLength(0);
  });

  it('runs the instance-profile check under --no-wait once declared Volumes made the create wait for running', async () => {
    process.env['CDKD_NO_WAIT'] = 'true';
    const ensure = vi
      .spyOn(
        EC2Provider.prototype as unknown as { ensureIamInstanceProfileAssociated: () => Promise<void> },
        'ensureIamInstanceProfileAssociated'
      )
      .mockResolvedValue(undefined);
    await new EC2Provider().create('Inst', TYPE, {
      ...BASE,
      IamInstanceProfile: 'profile',
      Volumes: [SDF1],
    });
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.flat().join('\n')).not.toMatch(/Skipped the IAM instance profile/);
    ensure.mockRestore();
  });

  it("does not propagate the instance's tags to the declared Volumes on the untagged re-send", async () => {
    denyTaggedLaunch = true;
    bdm = [
      { DeviceName: '/dev/xvda', Ebs: { VolumeId: 'vol-root' } },
      { DeviceName: '/dev/sdf', Ebs: { VolumeId: 'vol-1' } },
    ];
    await new EC2Provider().create('Inst', TYPE, {
      ...BASE,
      PropagateTagsToVolumeOnCreation: true,
      Tags: [{ Key: 'k', Value: 'v' }],
      Volumes: [SDF1],
    });
    const tagged = sent(CreateTagsCommand).flatMap((i) => i['Resources'] as string[]);
    expect(tagged).toContain('vol-root');
    expect(tagged).not.toContain('vol-1');
  });

  it('refuses an attach whose volume this instance holds at ANOTHER device', async () => {
    attachments.set('vol-1', { InstanceId: 'i-new', Device: '/dev/sdz', State: 'attached' });
    failAttach = Object.assign(new Error('already attached'), { name: 'VolumeInUse' });
    await expect(
      new EC2Provider().create('Inst', TYPE, { ...BASE, Volumes: [SDF1] })
    ).rejects.toThrow(/already attached/);
  });

  it('times out the attach wait at the resource deadline, non-retryably', async () => {
    attachments.set('vol-1', { InstanceId: 'i-new', Device: '/dev/sdf', State: 'attaching' });
    failAttach = Object.assign(new Error('already attaching'), { name: 'VolumeInUse' });
    let reads = 0;
    onVolumeRead = () => {
      if (++reads >= 3) deadlineRemaining.mockReturnValue(0);
    };
    const error = await new EC2Provider()
      .create('Inst', TYPE, { ...BASE, Volumes: [SDF1] })
      .catch((e: unknown) => e);
    expect(String(error)).toMatch(
      /timed out waiting for volume vol-1 to be attached at \/dev\/sdf on instance i-new \(last attachment state: attaching\)/
    );
    expect(isMarkedNonRetryable(error)).toBe(true);
  });

  it('ends the attach wait on Ctrl-C with an InterruptedWaitError', async () => {
    disarmInterruptWatchForTests();
    interruptWatchTestSeam.commandOwnsInterrupts = () => true;
    const baseline = process.listeners('SIGINT');
    try {
      attachments.set('vol-1', { InstanceId: 'i-new', Device: '/dev/sdf', State: 'attaching' });
      failAttach = Object.assign(new Error('already attaching'), { name: 'VolumeInUse' });
      let reads = 0;
      onVolumeRead = () => {
        // The first read is the refused attach's own; interrupt inside the wait.
        if (++reads === 2) {
          for (const l of process.listeners('SIGINT').filter((x) => !baseline.includes(x))) {
            (l as unknown as () => void)();
          }
        }
      };
      const error = await new EC2Provider()
        .create('Inst', TYPE, { ...BASE, Volumes: [SDF1] })
        .catch((e: unknown) => e);
      expect(isInterruptedWaitError(error)).toBe(true);
    } finally {
      disarmInterruptWatchForTests();
      delete interruptWatchTestSeam.commandOwnsInterrupts;
    }
  });

  it('surfaces the original refused AttachVolume when the volume cannot be read either', async () => {
    failAttach = Object.assign(new Error('attach refused'), { name: 'IncorrectState' });
    failVolumeRead = Object.assign(new Error('read throttled'), { name: 'RequestLimitExceeded' });
    await expect(
      new EC2Provider().create('Inst', TYPE, { ...BASE, Volumes: [SDF1] })
    ).rejects.toThrow(/attach refused/);
  });

  it('fails the attach wait when the volume is no longer listed', async () => {
    goneVolumes.add('vol-1');
    attachInvisible = true;
    await expect(
      new EC2Provider().create('Inst', TYPE, { ...BASE, Volumes: [SDF1] })
    ).rejects.toThrow(/volume vol-1 is no longer returned by DescribeVolumes/);
  });

  it.each([
    ['a non-list Volumes', { Device: '/dev/sdf', VolumeId: 'vol-1' }, /Volumes must be a list/],
    ['an entry without a VolumeId', [{ Device: '/dev/sdf' }], /Volumes\[0\]\.VolumeId is required/],
    ['an entry with a blank Device', [{ Device: '', VolumeId: 'vol-1' }], /Volumes\[0\]\.Device is required/],
    ['a null entry', [null], /Volumes\[0\] must be an object/],
  ])('refuses %s before RunInstances', async (_label, value, says) => {
    await expect(
      new EC2Provider().create('Inst', TYPE, { ...BASE, Volumes: value })
    ).rejects.toThrow(says);
    expect(sent(RunInstancesCommand)).toHaveLength(0);
  });
});

describe('AWS::EC2::Instance Volumes update (#5630)', () => {
  const update = (
    desired: Record<string, unknown>,
    previous: Record<string, unknown>,
    context?: Record<string, unknown>
  ) => new EC2Provider().update('Inst', 'i-new', TYPE, desired, previous, context);

  it('detaches a removed entry before attaching an added one', async () => {
    attachments.set('vol-1', { InstanceId: 'i-new', Device: '/dev/sdf', State: 'attached' });
    await update({ ...BASE, Volumes: [SDG2] }, { ...BASE, Volumes: [SDF1] });
    expect(volumeWrites()).toEqual(['Detach vol-1', 'Attach vol-2 /dev/sdg']);
    expect(sent(DetachVolumeCommand)[0]).toMatchObject({ InstanceId: 'i-new' });
  });

  it('re-attaches a volume whose Device changed only once its detach has finished', async () => {
    attachments.set('vol-2', { InstanceId: 'i-new', Device: '/dev/sdg', State: 'attached' });
    detachingReads = 2;
    await update({ ...BASE, Volumes: [SDH2] }, { ...BASE, Volumes: [SDG2] });
    expect(volumeWrites()).toEqual(['Detach vol-2', 'Attach vol-2 /dev/sdh']);
    // The detach wait read `detaching` twice and then no attachment, all
    // before the AttachVolume went out.
    const order = mockSend.mock.calls
      .map((c) => c[0] as object)
      .filter(
        (cmd) =>
          cmd instanceof DescribeVolumesCommand ||
          cmd instanceof AttachVolumeCommand ||
          cmd instanceof DetachVolumeCommand
      )
      .map((cmd) => cmd.constructor.name);
    expect(order.slice(0, 5)).toEqual([
      'DetachVolumeCommand',
      'DescribeVolumesCommand',
      'DescribeVolumesCommand',
      'DescribeVolumesCommand',
      'AttachVolumeCommand',
    ]);
  });

  it('converges when the recorded Device went stale: the volume is detached from wherever it sits, then attached as declared', async () => {
    attachments.set('vol-1', { InstanceId: 'i-new', Device: '/dev/sdh', State: 'attached' });
    await update(
      { ...BASE, Volumes: [{ Device: '/dev/sdh', VolumeId: 'vol-1' }] },
      { ...BASE, Volumes: [SDF1] }
    );
    expect(volumeWrites()).toEqual(['Detach vol-1', 'Attach vol-1 /dev/sdh']);
    expect(attachments.get('vol-1')).toMatchObject({ Device: '/dev/sdh', State: 'attached' });
  });

  it('takes a refused DetachVolume whose volume already reads detaching as under way', async () => {
    attachments.set('vol-1', { InstanceId: 'i-new', Device: '/dev/sdf', State: 'detaching' });
    detachingReads = 2;
    failDetach = Object.assign(new Error('already detaching'), { name: 'IncorrectState' });
    await update(BASE, { ...BASE, Volumes: [SDF1] }, { removedProperties: new Set(['Volumes']) });
    expect(volumeWrites()).toEqual(['Detach vol-1']);
    expect(attachments.has('vol-1')).toBe(false);
  });

  it('surfaces the original refused DetachVolume when the volume cannot be read either', async () => {
    attachments.set('vol-1', { InstanceId: 'i-new', Device: '/dev/sdf', State: 'attached' });
    failDetach = Object.assign(new Error('detach refused'), { name: 'IncorrectState' });
    failVolumeRead = Object.assign(new Error('read throttled'), { name: 'RequestLimitExceeded' });
    await expect(
      update(BASE, { ...BASE, Volumes: [SDF1] }, { removedProperties: new Set(['Volumes']) })
    ).rejects.toThrow(/detach refused/);
  });

  it('applies the volume writes on the running instance, before an InstanceType change stops it', async () => {
    attachments.set('vol-1', { InstanceId: 'i-new', Device: '/dev/sdf', State: 'attached' });
    await update(
      { ...BASE, InstanceType: 't3.small', Volumes: [SDG2] },
      { ...BASE, Volumes: [SDF1] }
    );
    const order = mockSend.mock.calls
      .map((c) => c[0] as object)
      .filter(
        (cmd) =>
          cmd instanceof AttachVolumeCommand ||
          cmd instanceof DetachVolumeCommand ||
          cmd instanceof StopInstancesCommand ||
          cmd instanceof StartInstancesCommand
      )
      .map((cmd) => cmd.constructor.name);
    expect(order).toEqual([
      'DetachVolumeCommand',
      'AttachVolumeCommand',
      'StopInstancesCommand',
      'StartInstancesCommand',
    ]);
    expect(powerState).toBe('running');
  });

  it('takes a refused DetachVolume for a volume EC2 no longer lists as detached', async () => {
    goneVolumes.add('vol-1');
    failDetach = Object.assign(new Error('gone'), { name: 'InvalidVolume.NotFound' });
    await update(BASE, { ...BASE, Volumes: [SDF1] }, { removedProperties: new Set(['Volumes']) });
    expect(volumeWrites()).toEqual(['Detach vol-1']);
  });

  it('surfaces a refused DetachVolume while the volume sits on this instance at another device', async () => {
    attachments.set('vol-1', { InstanceId: 'i-new', Device: '/dev/sdz', State: 'attached' });
    failDetach = Object.assign(new Error('wrong device'), { name: 'InvalidAttachment.NotFound' });
    await expect(
      update(BASE, { ...BASE, Volumes: [SDF1] }, { removedProperties: new Set(['Volumes']) })
    ).rejects.toThrow(/wrong device/);
  });

  it('detaches every listed volume when the property is removed', async () => {
    attachments.set('vol-1', { InstanceId: 'i-new', Device: '/dev/sdf', State: 'attached' });
    attachments.set('vol-2', { InstanceId: 'i-new', Device: '/dev/sdg', State: 'attached' });
    await update(BASE, { ...BASE, Volumes: [SDF1, SDG2] }, { removedProperties: new Set(['Volumes']) });
    expect(volumeWrites()).toEqual(['Detach vol-1', 'Detach vol-2']);
  });

  it('sends nothing for a reordered list, or an unchanged one', async () => {
    await update({ ...BASE, Volumes: [SDG2, SDF1] }, { ...BASE, Volumes: [SDF1, SDG2] });
    await update({ ...BASE, Volumes: [SDF1] }, { ...BASE, Volumes: [SDF1] });
    expect(volumeWrites()).toEqual([]);
  });

  it('takes a refused DetachVolume for a volume no longer attached here as detached', async () => {
    failDetach = Object.assign(new Error("vol-1 is in the 'available' state"), {
      name: 'IncorrectState',
    });
    await update(BASE, { ...BASE, Volumes: [SDF1] }, { removedProperties: new Set(['Volumes']) });
    expect(volumeWrites()).toEqual(['Detach vol-1']);
  });

  it('surfaces a refused DetachVolume while the volume is still attached here', async () => {
    attachments.set('vol-1', { InstanceId: 'i-new', Device: '/dev/sdf', State: 'attached' });
    failDetach = Object.assign(new Error('detach refused'), { name: 'UnauthorizedOperation' });
    await expect(
      update(BASE, { ...BASE, Volumes: [SDF1] }, { removedProperties: new Set(['Volumes']) })
    ).rejects.toThrow(/detach refused/);
  });

  it('refuses a malformed desired list before any call, on a rollback replay too', async () => {
    for (const context of [undefined, { replayingState: true }]) {
      const error = await update(
        { ...BASE, Volumes: [{ Device: '/dev/sdf' }] },
        { ...BASE, Volumes: [SDF1] },
        context
      ).catch((e: unknown) => e);
      expect(String(error)).toMatch(/Volumes\[0\]\.VolumeId is required\. The instance Inst was not updated/);
      expect(isRefusedBeforeApplying(error, 'Inst')).toBe(true);
    }
    expect(volumeWrites()).toEqual([]);
  });

  it('attaches the declared volumes and detaches none when the record is malformed, with a warning', async () => {
    await update({ ...BASE, Volumes: [SDF1] }, { ...BASE, Volumes: 'vol-9' });
    expect(volumeWrites()).toEqual(['Attach vol-1 /dev/sdf']);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/cannot tell which volumes to detach/));
  });

  it('honours changedProperties: a drift revert naming another member sends no volume call', async () => {
    await update(
      { ...BASE, Volumes: [SDG2] },
      { ...BASE, Volumes: [SDF1] },
      { changedProperties: new Set(['Tags']) }
    );
    expect(volumeWrites()).toEqual([]);
  });
});

describe('AWS::EC2::Instance LaunchTemplate update (#5630)', () => {
  it('refuses a LaunchTemplate change reaching update() before any call (it is create-only)', async () => {
    const error = await new EC2Provider()
      .update(
        'Inst',
        'i-new',
        TYPE,
        { ...BASE, LaunchTemplate: { LaunchTemplateId: 'lt-1', Version: '2' } },
        { ...BASE, LaunchTemplate: { LaunchTemplateId: 'lt-1', Version: '1' } }
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect(String(error)).toMatch(/LaunchTemplate can be set only when the instance is launched/);
  });

  it('reads a numeric Version and its string as the same template', async () => {
    await expect(
      new EC2Provider().update(
        'Inst',
        'i-new',
        TYPE,
        { ...BASE, LaunchTemplate: { LaunchTemplateId: 'lt-1', Version: 2 } },
        { ...BASE, LaunchTemplate: { LaunchTemplateId: 'lt-1', Version: '2' } }
      )
    ).resolves.toMatchObject({ physicalId: 'i-new', wasReplaced: false });
    expect(volumeWrites()).toEqual([]);
  });
});

describe('AWS::EC2::Instance LaunchTemplate / Volumes read-back (#5630)', () => {
  it('reads Volumes as the live attachments of the declared volumes, in the declared order', async () => {
    bdm = [
      { DeviceName: '/dev/xvda', Ebs: { VolumeId: 'vol-root' } },
      { DeviceName: '/dev/sdh', Ebs: { VolumeId: 'vol-2' } },
      { DeviceName: '/dev/sdk', Ebs: { VolumeId: 'vol-other' } },
      { DeviceName: '/dev/sdf', Ebs: { VolumeId: 'vol-1' } },
    ];
    const state = await new EC2Provider().readCurrentState('i-new', 'Inst', TYPE, {
      ...BASE,
      Volumes: [SDF1, SDG2],
    });
    expect((state as Record<string, unknown>)['Volumes']).toEqual([SDF1, SDH2]);
  });

  it('reads Volumes as an empty list when a declared volume was detached out of band', async () => {
    bdm = [{ DeviceName: '/dev/xvda', Ebs: { VolumeId: 'vol-root' } }];
    const state = await new EC2Provider().readCurrentState('i-new', 'Inst', TYPE, {
      ...BASE,
      Volumes: [SDF1],
    });
    expect((state as Record<string, unknown>)['Volumes']).toEqual([]);
  });

  it('omits Volumes for a malformed recorded list instead of throwing', async () => {
    bdm = [{ DeviceName: '/dev/sdf', Ebs: { VolumeId: 'vol-1' } }];
    const state = await new EC2Provider().readCurrentState('i-new', 'Inst', TYPE, {
      ...BASE,
      Volumes: [null],
    });
    expect(state).not.toHaveProperty('Volumes');
  });

  it('omits Volumes for a bag that does not declare them', async () => {
    bdm = [{ DeviceName: '/dev/sdf', Ebs: { VolumeId: 'vol-1' } }];
    const state = await new EC2Provider().readCurrentState('i-new', 'Inst', TYPE, BASE);
    expect(state).not.toHaveProperty('Volumes');
  });

  it('declares LaunchTemplate unreadable for drift', () => {
    expect(new EC2Provider().getDriftUnknownPaths(TYPE)).toContain('LaunchTemplate');
  });
});
