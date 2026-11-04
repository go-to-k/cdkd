import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateTagsCommand,
  DescribeInstancesCommand,
  ModifyInstanceAttributeCommand,
  RunInstancesCommand,
} from '@aws-sdk/client-ec2';

// go-to-k/cdkd#5630: AWS::EC2::Instance SourceDestCheck, Tenancy,
// PlacementGroupName, PrivateIpAddress and PropagateTagsToVolumeOnCreation.
// CloudFormation measured (us-east-1, 2026-11-04, a t3.nano):
//  - SourceDestCheck changes in place; a removal sets it back to true.
//  - Tenancy: adding `default`, or removing a declared `default`, launches a
//    new instance (change set `Replacement: Conditional`).
//  - PlacementGroupName / PrivateIpAddress: `Replacement: True` (schema
//    create-only).
//  - PropagateTagsToVolumeOnCreation tags the volumes at launch only: a Tags
//    change, or removing the flag, leaves the volume tags as they are.

const { mockSend, warn } = vi.hoisted(() => ({ mockSend: vi.fn(), warn: vi.fn() }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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
import { ReplacementRulesRegistry } from '../../../src/analyzer/replacement-rules.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';
import { isRefusedBeforeApplying } from '../../../src/deployment/prior-attempt-scope.js';

const TYPE = 'AWS::EC2::Instance';
const BASE = { ImageId: 'ami-1', InstanceType: 't3.nano', SubnetId: 'subnet-1' };
const TAGS = [{ Key: 'team', Value: 'a' }];

function sent<T>(ctor: new (...a: never[]) => T): Array<Record<string, unknown>> {
  return mockSend.mock.calls
    .filter((c) => c[0] instanceof ctor)
    .map((c) => (c[0] as { input: Record<string, unknown> }).input);
}

const describedInstance = (extra: Record<string, unknown> = {}) => ({
  Reservations: [
    {
      Instances: [
        {
          InstanceId: 'i-new',
          State: { Name: 'running' },
          BlockDeviceMappings: [{ DeviceName: '/dev/xvda', Ebs: { VolumeId: 'vol-root' } }],
          ...extra,
        },
      ],
    },
  ],
});

beforeEach(() => {
  mockSend.mockReset();
  warn.mockReset();
  mockSend.mockImplementation((cmd: unknown) => {
    if (cmd instanceof RunInstancesCommand) {
      return Promise.resolve({ Instances: [{ InstanceId: 'i-new' }] });
    }
    if (cmd instanceof DescribeInstancesCommand) return Promise.resolve(describedInstance());
    return Promise.resolve({});
  });
});

describe('AWS::EC2::Instance create (#5630)', () => {
  it('sends Tenancy and PlacementGroupName in Placement and PrivateIpAddress on RunInstances', async () => {
    await new EC2Provider().create('Inst', TYPE, {
      ...BASE,
      AvailabilityZone: 'us-east-1a',
      Tenancy: 'dedicated',
      PlacementGroupName: 'pg-1',
      PrivateIpAddress: '10.0.1.5',
    });
    const [input] = sent(RunInstancesCommand);
    expect(input).toMatchObject({
      Placement: { AvailabilityZone: 'us-east-1a', Tenancy: 'dedicated', GroupName: 'pg-1' },
      PrivateIpAddress: '10.0.1.5',
    });
  });

  it('sends a Placement holding only what the template declares, and none for none', async () => {
    await new EC2Provider().create('Inst', TYPE, { ...BASE, PlacementGroupName: 'pg-1' });
    expect(sent(RunInstancesCommand)[0]?.['Placement']).toEqual({ GroupName: 'pg-1' });
    mockSend.mockClear();
    await new EC2Provider().create('Inst', TYPE, BASE);
    const [input] = sent(RunInstancesCommand);
    expect(input?.['Placement']).toBeUndefined();
    expect(input?.['PrivateIpAddress']).toBeUndefined();
  });

  it('turns SourceDestCheck off after launch when the template declares false', async () => {
    await new EC2Provider().create('Inst', TYPE, { ...BASE, SourceDestCheck: 'false' });
    expect(sent(ModifyInstanceAttributeCommand)).toEqual([
      { InstanceId: 'i-new', SourceDestCheck: { Value: false } },
    ]);
  });

  it.each([
    ['true', { SourceDestCheck: true }],
    ['absent', {}],
  ])('sends no SourceDestCheck call when it is %s (EC2 default)', async (_label, extra) => {
    await new EC2Provider().create('Inst', TYPE, { ...BASE, ...extra });
    expect(sent(ModifyInstanceAttributeCommand)).toHaveLength(0);
  });

  it('terminates the launched instance when turning SourceDestCheck off fails', async () => {
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof RunInstancesCommand) {
        return Promise.resolve({ Instances: [{ InstanceId: 'i-new' }] });
      }
      if (cmd instanceof ModifyInstanceAttributeCommand) {
        return Promise.reject(Object.assign(new Error('boom'), { name: 'InternalError' }));
      }
      return Promise.resolve({});
    });
    await expect(
      new EC2Provider().create('Inst', TYPE, { ...BASE, SourceDestCheck: false })
    ).rejects.toThrow(/boom/);
    expect(
      mockSend.mock.calls.some((c) => c[0]?.constructor?.name === 'TerminateInstancesCommand')
    ).toBe(true);
  });

  it('copies the instance tags into a volume TagSpecification when PropagateTagsToVolumeOnCreation is true', async () => {
    await new EC2Provider().create('Inst', TYPE, {
      ...BASE,
      Tags: TAGS,
      PropagateTagsToVolumeOnCreation: 'true',
    });
    expect(sent(RunInstancesCommand)[0]?.['TagSpecifications']).toEqual([
      { ResourceType: 'instance', Tags: TAGS },
      { ResourceType: 'volume', Tags: TAGS },
    ]);
  });

  it.each([
    ['false', { PropagateTagsToVolumeOnCreation: false }],
    ['absent', {}],
  ])('tags only the instance when PropagateTagsToVolumeOnCreation is %s', async (_l, extra) => {
    await new EC2Provider().create('Inst', TYPE, { ...BASE, Tags: TAGS, ...extra });
    expect(sent(RunInstancesCommand)[0]?.['TagSpecifications']).toEqual([
      { ResourceType: 'instance', Tags: TAGS },
    ]);
  });

  it('tags the attached volumes with CreateTags when the launch had to go out untagged', async () => {
    let first = true;
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof RunInstancesCommand) {
        if (first && cmd.input.TagSpecifications !== undefined) {
          first = false;
          return Promise.reject(
            Object.assign(
              new Error(
                'You are not authorized to perform this operation. User: arn:aws:sts::123456789012:assumed-role/r/s is not authorized to perform: ec2:CreateTags on resource: arn:aws:ec2:us-east-1:123456789012:instance/* because no identity-based policy allows the ec2:CreateTags action.'
              ),
              { name: 'UnauthorizedOperation' }
            )
          );
        }
        return Promise.resolve({ Instances: [{ InstanceId: 'i-new' }] });
      }
      if (cmd instanceof DescribeInstancesCommand) return Promise.resolve(describedInstance());
      return Promise.resolve({});
    });
    await new EC2Provider().create('Inst', TYPE, {
      ...BASE,
      Tags: TAGS,
      PropagateTagsToVolumeOnCreation: true,
    });
    expect(sent(CreateTagsCommand).map((i) => i['Resources'])).toEqual([['i-new'], ['vol-root']]);
  });

  it.each([
    ['Tenancy', { Tenancy: 1 }],
    ['PlacementGroupName', { PlacementGroupName: { Ref: 'Pg' } }],
    ['PrivateIpAddress', { PrivateIpAddress: ['10.0.1.5'] }],
    ['SourceDestCheck', { SourceDestCheck: 'yes' }],
    ['PropagateTagsToVolumeOnCreation', { PropagateTagsToVolumeOnCreation: 'maybe' }],
  ])('refuses a malformed %s before RunInstances', async (label, extra) => {
    const error = await new EC2Provider()
      .create('Inst', TYPE, { ...BASE, ...extra })
      .catch((e: unknown) => e);
    expect(String(error)).toMatch(new RegExp(`${label}.*The instance Inst was not launched`));
    expect(sent(RunInstancesCommand)).toHaveLength(0);
  });
});

describe('AWS::EC2::Instance update (#5630)', () => {
  it.each([
    [false, true],
    [true, false],
  ])('changes SourceDestCheck %s -> %s in place', async (before, after) => {
    await new EC2Provider().update(
      'Inst',
      'i-new',
      TYPE,
      { ...BASE, SourceDestCheck: after },
      { ...BASE, SourceDestCheck: before }
    );
    expect(sent(ModifyInstanceAttributeCommand)).toEqual([
      { InstanceId: 'i-new', SourceDestCheck: { Value: after } },
    ]);
  });

  it('sets a removed SourceDestCheck back to true, from the engine-injected default or a bare removal', async () => {
    const provider = new EC2Provider();
    expect(provider.removalDefaults.get(TYPE)?.get('SourceDestCheck')).toBe(true);
    await provider.update(
      'Inst',
      'i-new',
      TYPE,
      { ...BASE, SourceDestCheck: true },
      { ...BASE, SourceDestCheck: false },
      { removedProperties: new Set(['SourceDestCheck']) }
    );
    await provider.update('Inst', 'i-new', TYPE, BASE, { ...BASE, SourceDestCheck: 'false' });
    expect(sent(ModifyInstanceAttributeCommand)).toEqual([
      { InstanceId: 'i-new', SourceDestCheck: { Value: true } },
      { InstanceId: 'i-new', SourceDestCheck: { Value: true } },
    ]);
  });

  it('sends nothing when a removed SourceDestCheck was already true, or for a spelling change', async () => {
    const provider = new EC2Provider();
    await provider.update('Inst', 'i-new', TYPE, BASE, { ...BASE, SourceDestCheck: true });
    await provider.update(
      'Inst',
      'i-new',
      TYPE,
      { ...BASE, SourceDestCheck: 'false' },
      { ...BASE, SourceDestCheck: false }
    );
    expect(sent(ModifyInstanceAttributeCommand)).toHaveLength(0);
  });

  it('refuses a malformed SourceDestCheck before any call, and warns on a rollback replay', async () => {
    const provider = new EC2Provider();
    const error = await provider
      .update('Inst', 'i-new', TYPE, { ...BASE, SourceDestCheck: 'yes' }, BASE)
      .catch((e: unknown) => e);
    expect(String(error)).toMatch(/SourceDestCheck must be a boolean.*was not updated/);
    expect(isRefusedBeforeApplying(error, 'Inst')).toBe(true);
    expect(mockSend).not.toHaveBeenCalled();

    await provider.update(
      'Inst',
      'i-new',
      TYPE,
      { ...BASE, SourceDestCheck: 'yes' },
      { ...BASE, SourceDestCheck: false },
      { replayingState: true }
    );
    expect(sent(ModifyInstanceAttributeCommand)).toHaveLength(0);
    expect(warn.mock.calls.flat().join('\n')).toMatch(/SourceDestCheck.*left at its current AWS value/);
  });

  it('sends nothing for a PropagateTagsToVolumeOnCreation change or removal', async () => {
    const provider = new EC2Provider();
    await provider.update(
      'Inst',
      'i-new',
      TYPE,
      { ...BASE, PropagateTagsToVolumeOnCreation: false },
      { ...BASE, PropagateTagsToVolumeOnCreation: true }
    );
    await provider.update('Inst', 'i-new', TYPE, BASE, {
      ...BASE,
      PropagateTagsToVolumeOnCreation: true,
    });
    const mutating = mockSend.mock.calls.filter(
      (c) => !(c[0] instanceof DescribeInstancesCommand)
    );
    expect(mutating).toHaveLength(0);
  });

  it.each([
    ['Tenancy', 'default', 'dedicated'],
    ['Tenancy', 'dedicated', 'default'],
    ['PlacementGroupName', 'pg-1', 'pg-2'],
    ['PrivateIpAddress', '10.0.1.5', '10.0.1.6'],
  ])('refuses a %s change that reaches update() (drift --revert) before any call', async (key, live, declared) => {
    const error = await new EC2Provider()
      .update(
        'Inst',
        'i-new',
        TYPE,
        { ...BASE, [key]: declared },
        { ...BASE, [key]: live },
        { desiredFromAwsReadback: true }
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect(String(error)).toContain(key);
    expect(isRefusedBeforeApplying(error, 'Inst')).toBe(true);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('a drift --revert whose template omits Tenancy / PrivateIpAddress sends nothing', async () => {
    await new EC2Provider().update(
      'Inst',
      'i-new',
      TYPE,
      BASE,
      { ...BASE, Tenancy: 'default', PrivateIpAddress: '10.0.1.9' },
      { desiredFromAwsReadback: true, removedProperties: new Set() }
    );
    expect(
      mockSend.mock.calls.filter((c) => !(c[0] instanceof DescribeInstancesCommand))
    ).toHaveLength(0);
  });
});

describe('AWS::EC2::Instance Tenancy replacement (#5630)', () => {
  const rules = new ReplacementRulesRegistry();
  it.each([
    ['default -> dedicated', 'default', 'dedicated'],
    ['dedicated -> default', 'dedicated', 'default'],
    ['a removal of default', 'default', undefined],
    ['a removal of dedicated', 'dedicated', undefined],
  ])('replaces for %s, as CloudFormation does', (_l, before, after) => {
    expect(rules.requiresReplacement(TYPE, 'Tenancy', before, after)).toBe(true);
  });

  it.each([
    ['a value the record lacks (default)', undefined, 'default'],
    ['a value the record lacks (dedicated)', undefined, 'dedicated'],
    ['dedicated -> host (unmeasured; refused by the provider)', 'dedicated', 'host'],
    ['an unchanged value', 'dedicated', 'dedicated'],
  ])('does not replace for %s', (_l, before, after) => {
    expect(rules.requiresReplacement(TYPE, 'Tenancy', before, after)).toBe(false);
  });

  it.each(['CpuOptions', 'HibernationOptions', 'PlacementGroupName', 'PrivateIpAddress'])(
    'classifies a %s change as a replacement without DescribeType',
    (key) => {
      expect(rules.requiresReplacement(TYPE, key, 'a', 'b')).toBe(true);
    }
  );
});

describe('AWS::EC2::Instance Tenancy the record lacks (#5630)', () => {
  const live = (tenancy: string) =>
    mockSend.mockImplementation((cmd: unknown) =>
      cmd instanceof DescribeInstancesCommand
        ? Promise.resolve(describedInstance({ Placement: { Tenancy: tenancy } }))
        : Promise.resolve({})
    );
  const nonDescribe = () =>
    mockSend.mock.calls.filter((c) => !(c[0] instanceof DescribeInstancesCommand));

  it('sends nothing when the live tenancy already matches (a record an earlier --prefer-sdk-route deploy wrote)', async () => {
    live('default');
    await new EC2Provider().update('Inst', 'i-new', TYPE, { ...BASE, Tenancy: 'default' }, BASE);
    expect(sent(DescribeInstancesCommand).length).toBeGreaterThan(0);
    expect(nonDescribe()).toHaveLength(0);
  });

  it('refuses before any mutating call when the live tenancy differs, naming --replace', async () => {
    live('default');
    const error = await new EC2Provider()
      .update('Inst', 'i-new', TYPE, { ...BASE, Tenancy: 'dedicated', SourceDestCheck: false }, BASE)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect(String(error)).toMatch(/declares Tenancy dedicated, the instance has default.*--replace/);
    expect(isRefusedBeforeApplying(error, 'Inst')).toBe(true);
    expect(nonDescribe()).toHaveLength(0);
  });

  it('a rollback replay with a differing live tenancy warns and applies the rest', async () => {
    live('default');
    await new EC2Provider().update(
      'Inst',
      'i-new',
      TYPE,
      { ...BASE, Tenancy: 'dedicated', SourceDestCheck: false },
      BASE,
      { replayingState: true }
    );
    expect(sent(ModifyInstanceAttributeCommand)).toEqual([
      { InstanceId: 'i-new', SourceDestCheck: { Value: false } },
    ]);
    expect(warn.mock.calls.flat().join('\n')).toMatch(/declares Tenancy dedicated/);
  });
});

describe('AWS::EC2::Instance Tenancy on a rollback revert (#5630)', () => {
  it('a replay reading an adopted Tenancy as a removal warns and still reverts the other members', async () => {
    await new EC2Provider().update(
      'Inst',
      'i-new',
      TYPE,
      { ...BASE, SourceDestCheck: true },
      { ...BASE, Tenancy: 'default', SourceDestCheck: false },
      { replayingState: true }
    );
    expect(sent(ModifyInstanceAttributeCommand)).toEqual([
      { InstanceId: 'i-new', SourceDestCheck: { Value: true } },
    ]);
    expect(warn.mock.calls.flat().join('\n')).toMatch(/rollback would change Tenancy \(default -> unset\)/);
  });
});

describe('AWS::EC2::Instance Tenancy dedicated <-> host (#5630, unmeasured)', () => {
  it('refuses before any AWS call: neither replaced nor applied', async () => {
    const error = await new EC2Provider()
      .update('Inst', 'i-new', TYPE, { ...BASE, Tenancy: 'host' }, { ...BASE, Tenancy: 'dedicated' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect(String(error)).toMatch(/does not change Tenancy dedicated -> host.*not been measured/);
    expect(isRefusedBeforeApplying(error, 'Inst')).toBe(true);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('warns and keeps the tenancy on a rollback replay', async () => {
    await new EC2Provider().update(
      'Inst',
      'i-new',
      TYPE,
      { ...BASE, Tenancy: 'host' },
      { ...BASE, Tenancy: 'dedicated' },
      { replayingState: true }
    );
    expect(mockSend.mock.calls.filter((c) => !(c[0] instanceof DescribeInstancesCommand))).toHaveLength(0);
    expect(warn.mock.calls.flat().join('\n')).toMatch(/Tenancy dedicated -> host, which cdkd does not apply/);
  });
});

describe('AWS::EC2::Instance readCurrentState (#5630)', () => {
  it('reads PlacementGroupName from Placement.GroupName, and omits an empty one', async () => {
    mockSend.mockImplementation((cmd: unknown) =>
      cmd instanceof DescribeInstancesCommand
        ? Promise.resolve(
            describedInstance({
              Placement: { AvailabilityZone: 'us-east-1a', Tenancy: 'default', GroupName: 'pg-1' },
              SourceDestCheck: false,
              PrivateIpAddress: '10.0.1.5',
            })
          )
        : Promise.resolve({ Volumes: [] })
    );
    const provider = new EC2Provider();
    const state = (await provider.readCurrentState('i-new', 'Inst', TYPE, {})) as Record<
      string,
      unknown
    >;
    expect(state).toMatchObject({
      PlacementGroupName: 'pg-1',
      Tenancy: 'default',
      SourceDestCheck: false,
      PrivateIpAddress: '10.0.1.5',
    });

    mockSend.mockImplementation((cmd: unknown) =>
      cmd instanceof DescribeInstancesCommand
        ? Promise.resolve(describedInstance({ Placement: { GroupName: '' } }))
        : Promise.resolve({ Volumes: [] })
    );
    const empty = (await provider.readCurrentState('i-new', 'Inst', TYPE, {})) as Record<
      string,
      unknown
    >;
    expect(empty).not.toHaveProperty('PlacementGroupName');
  });
});
