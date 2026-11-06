import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  AttachVolumeCommand,
  DescribeInstancesCommand,
  DescribeVolumesCommand,
  DetachVolumeCommand,
  RunInstancesCommand,
  TerminateInstancesCommand,
  waitUntilInstanceRunning,
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

const { mockSend, warn, cfnSend } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  warn: vi.fn(),
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

vi.mock('@aws-sdk/client-ec2', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, waitUntilInstanceRunning: vi.fn(() => Promise.resolve({})) };
});

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';
import { isRefusedBeforeApplying } from '../../../src/deployment/prior-attempt-scope.js';

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

/** The volume writes, in order, as `<Attach|Detach> <volume> <device>`. */
function volumeWrites(): string[] {
  return mockSend.mock.calls
    .map((c) => c[0] as object)
    .filter((cmd) => cmd instanceof AttachVolumeCommand || cmd instanceof DetachVolumeCommand)
    .map((cmd) => {
      const input = (cmd as unknown as { input: Record<string, string> }).input;
      const verb = cmd instanceof AttachVolumeCommand ? 'Attach' : 'Detach';
      return `${verb} ${input['VolumeId']} ${input['Device']}`;
    });
}

/** volume id -> its attachment, as the mocked EC2 holds it. */
let attachments: Map<string, { InstanceId: string; Device: string; State: string }>;
let failAttach: Error | undefined;
let failDetach: Error | undefined;
/** When set, an AttachVolume is accepted but never shows up in DescribeVolumes. */
let attachInvisible: boolean;
let bdm: Array<{ DeviceName: string; Ebs: { VolumeId: string } }>;

beforeEach(() => {
  mockSend.mockReset();
  warn.mockReset();
  vi.mocked(waitUntilInstanceRunning).mockClear();
  attachments = new Map();
  failAttach = undefined;
  failDetach = undefined;
  attachInvisible = false;
  bdm = [];
  vi.spyOn(
    EC2Provider.prototype as unknown as { sleep: () => Promise<void> },
    'sleep'
  ).mockResolvedValue(undefined);
  let volumeReads = 0;
  mockSend.mockImplementation((cmd: unknown) => {
    const input = (cmd as { input: Record<string, unknown> }).input;
    if (cmd instanceof RunInstancesCommand) {
      return Promise.resolve({ Instances: [{ InstanceId: 'i-new' }] });
    }
    if (cmd instanceof DescribeInstancesCommand) {
      return Promise.resolve({
        Reservations: [
          {
            Instances: [
              {
                InstanceId: 'i-new',
                State: { Name: 'running' },
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
      attachments.delete(input['VolumeId'] as string);
      return Promise.resolve({ State: 'detaching' });
    }
    if (cmd instanceof DescribeVolumesCommand) {
      // The waits' sleep is stubbed: a wait that never sees its target fails
      // the test instead of spinning.
      if (++volumeReads > 50) return Promise.reject(new Error('runaway DescribeVolumes poll'));
      const id = (input['VolumeIds'] as string[])[0]!;
      const attachment = attachments.get(id);
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
    expect(sent(DescribeVolumesCommand)).toHaveLength(5);
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
    expect(volumeWrites()).toEqual(['Detach vol-1 /dev/sdf', 'Attach vol-2 /dev/sdg']);
    expect(sent(DetachVolumeCommand)[0]).toMatchObject({ InstanceId: 'i-new' });
  });

  it('re-attaches a volume whose Device changed', async () => {
    attachments.set('vol-2', { InstanceId: 'i-new', Device: '/dev/sdg', State: 'attached' });
    await update({ ...BASE, Volumes: [SDH2] }, { ...BASE, Volumes: [SDG2] });
    expect(volumeWrites()).toEqual(['Detach vol-2 /dev/sdg', 'Attach vol-2 /dev/sdh']);
  });

  it('detaches every listed volume when the property is removed', async () => {
    attachments.set('vol-1', { InstanceId: 'i-new', Device: '/dev/sdf', State: 'attached' });
    attachments.set('vol-2', { InstanceId: 'i-new', Device: '/dev/sdg', State: 'attached' });
    await update(BASE, { ...BASE, Volumes: [SDF1, SDG2] }, { removedProperties: new Set(['Volumes']) });
    expect(volumeWrites()).toEqual(['Detach vol-1 /dev/sdf', 'Detach vol-2 /dev/sdg']);
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
    expect(volumeWrites()).toEqual(['Detach vol-1 /dev/sdf']);
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
    await new EC2Provider().update(
      'Inst',
      'i-new',
      TYPE,
      { ...BASE, LaunchTemplate: { LaunchTemplateId: 'lt-1', Version: 2 } },
      { ...BASE, LaunchTemplate: { LaunchTemplateId: 'lt-1', Version: '2' } }
    );
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

  it('omits Volumes for a bag that does not declare them', async () => {
    bdm = [{ DeviceName: '/dev/sdf', Ebs: { VolumeId: 'vol-1' } }];
    const state = await new EC2Provider().readCurrentState('i-new', 'Inst', TYPE, BASE);
    expect(state).not.toHaveProperty('Volumes');
  });

  it('declares LaunchTemplate unreadable for drift', () => {
    expect(new EC2Provider().getDriftUnknownPaths(TYPE)).toContain('LaunchTemplate');
  });
});
