import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DescribeInstancesCommand, DescribeVolumesCommand } from '@aws-sdk/client-ec2';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(function (this: unknown) { return this; }),
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

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import { declaredBlockDeviceNames } from '../../../src/provisioning/providers/ec2/read-instance-state.js';
import { undeclaredUncomparedDriftKeys } from '../../../src/cli/commands/drift.js';

const TYPE = 'AWS::EC2::Instance';

/**
 * go-to-k/cdkd#6384: an `AWS::EC2::VolumeAttachment` attaches `/dev/sdf` after
 * the instance settled, so `DescribeInstances` lists it beside the root
 * volume the baseline recorded. Answer per COMMAND, so the readback's other
 * best-effort calls (attributes, credit specification) need no primers.
 */
function liveInstanceWithAttachment(): void {
  mockSend.mockImplementation((command: unknown) => {
    if (command instanceof DescribeInstancesCommand) {
      return Promise.resolve({
        Reservations: [
          {
            Instances: [
              {
                InstanceId: 'i-1',
                State: { Name: 'running' },
                BlockDeviceMappings: [
                  { DeviceName: '/dev/xvda', Ebs: { VolumeId: 'vol-root', DeleteOnTermination: true } },
                  { DeviceName: '/dev/sdf', Ebs: { VolumeId: 'vol-att', DeleteOnTermination: false } },
                ],
              },
            ],
          },
        ],
      });
    }
    if (command instanceof DescribeVolumesCommand) {
      return Promise.resolve({
        Volumes: [
          { VolumeId: 'vol-root', VolumeType: 'gp3', Size: 8 },
          { VolumeId: 'vol-att', VolumeType: 'gp3', Size: 1 },
        ],
      });
    }
    // The per-property reads (#6759: a failed one rejects the read).
    return Promise.resolve({});
  });
}

const ROOT = { DeviceName: '/dev/xvda', Ebs: { DeleteOnTermination: true, VolumeType: 'gp3', VolumeSize: 8 } };
const ATTACHED = {
  DeviceName: '/dev/sdf',
  Ebs: { DeleteOnTermination: false, VolumeType: 'gp3', VolumeSize: 1 },
};

describe('EC2 Instance BlockDeviceMappings vs a sibling VolumeAttachment (go-to-k/cdkd#6384)', () => {
  let provider: EC2Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    provider = new EC2Provider();
  });

  it('drift does not compare an undeclared BlockDeviceMappings', () => {
    expect(undeclaredUncomparedDriftKeys(TYPE, { InstanceType: 't4g.nano' })).toEqual([
      'BlockDeviceMappings',
    ]);
    expect(undeclaredUncomparedDriftKeys(TYPE, { BlockDeviceMappings: [] })).toEqual([]);
  });

  it('narrows a declared list to its declared devices', async () => {
    liveInstanceWithAttachment();
    const read = (await provider.readCurrentState('i-1', 'Inst', TYPE, {
      BlockDeviceMappings: [{ DeviceName: '/dev/xvda', Ebs: { VolumeSize: 8 } }],
    })) as Record<string, unknown>;
    expect(read['BlockDeviceMappings']).toEqual([ROOT]);
  });

  it('reads every live device for a bag that does not declare the list', async () => {
    liveInstanceWithAttachment();
    const read = (await provider.readCurrentState('i-1', 'Inst', TYPE, {
      InstanceType: 't4g.nano',
    })) as Record<string, unknown>;
    expect(read['BlockDeviceMappings']).toEqual([ROOT, ATTACHED]);
  });

  it.each([
    ['a non-string DeviceName', [{ DeviceName: { Ref: 'Dev' } }]],
    ['a non-object entry', ['x']],
    ['a non-array list', { DeviceName: '/dev/xvda' }],
  ])('does not narrow a declared list with %s', async (_l, declared) => {
    liveInstanceWithAttachment();
    const read = (await provider.readCurrentState('i-1', 'Inst', TYPE, {
      BlockDeviceMappings: declared,
    })) as Record<string, unknown>;
    expect(read['BlockDeviceMappings']).toEqual([ROOT, ATTACHED]);
  });

  it('does not narrow when no declared device name matches a live one', async () => {
    liveInstanceWithAttachment();
    const read = (await provider.readCurrentState('i-1', 'Inst', TYPE, {
      BlockDeviceMappings: [{ DeviceName: 'xvda' }],
    })) as Record<string, unknown>;
    expect(read['BlockDeviceMappings']).toEqual([ROOT, ATTACHED]);
  });

  it('declaredBlockDeviceNames answers the declared names, or undefined when unreadable', () => {
    expect(declaredBlockDeviceNames({ BlockDeviceMappings: [{ DeviceName: '/dev/sdb' }] })).toEqual(
      new Set(['/dev/sdb'])
    );
    expect(declaredBlockDeviceNames({ BlockDeviceMappings: [] })).toEqual(new Set());
    expect(declaredBlockDeviceNames({})).toBeUndefined();
    expect(declaredBlockDeviceNames(undefined)).toBeUndefined();
    expect(declaredBlockDeviceNames({ BlockDeviceMappings: [null] })).toBeUndefined();
  });

  it('drops an undeclared device from a baseline recorded before the narrowing', async () => {
    const declared = { BlockDeviceMappings: [{ DeviceName: '/dev/sdb' }] };
    const sdb = { DeviceName: '/dev/sdb', Ebs: { VolumeSize: 20 } };
    const out = await provider.canonicalizeDriftPair(
      TYPE,
      { BlockDeviceMappings: [ROOT, sdb], InstanceType: 't4g.nano' },
      { BlockDeviceMappings: [sdb] },
      declared
    );
    expect(out.baseline).toEqual({ BlockDeviceMappings: [sdb], InstanceType: 't4g.nano' });
    expect(out.aws).toEqual({ BlockDeviceMappings: [sdb] });
  });

  it('keeps a declared device the readback lost, so its removal is still drift', async () => {
    const declared = {
      BlockDeviceMappings: [{ DeviceName: '/dev/sdb' }, { DeviceName: '/dev/sdc' }],
    };
    const sdb = { DeviceName: '/dev/sdb', Ebs: { VolumeSize: 20 } };
    const sdc = { DeviceName: '/dev/sdc', Ebs: { VolumeSize: 30 } };
    // sdc detached out of band: the readback narrows to sdb, the baseline keeps sdc.
    const out = await provider.canonicalizeDriftPair(
      TYPE,
      { BlockDeviceMappings: [ROOT, sdb, sdc] },
      { BlockDeviceMappings: [sdb] },
      declared
    );
    expect(out.baseline).toEqual({ BlockDeviceMappings: [sdb, sdc] });
  });

  it('leaves the baseline whole when the readback was not narrowed (no declared name matched)', async () => {
    // Every declared device gone, or a spelling AWS reports differently: the
    // readback is the whole live list, so stripping the baseline would compare
    // an empty list against it on every run.
    const declared = { BlockDeviceMappings: [{ DeviceName: 'xvda' }] };
    const baseline = { BlockDeviceMappings: [ROOT, ATTACHED] };
    const out = await provider.canonicalizeDriftPair(
      TYPE,
      baseline,
      { BlockDeviceMappings: [ROOT, ATTACHED] },
      declared
    );
    expect(out.baseline).toBe(baseline);
  });

  it('leaves the baseline alone for a bag that does not declare the list', async () => {
    const baseline = { BlockDeviceMappings: [ROOT] };
    const out = await provider.canonicalizeDriftPair(TYPE, baseline, { BlockDeviceMappings: [] }, {});
    expect(out.baseline).toBe(baseline);
  });
});
