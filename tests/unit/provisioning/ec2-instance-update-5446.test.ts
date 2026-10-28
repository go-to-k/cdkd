import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  AssociateIamInstanceProfileCommand,
  DescribeIamInstanceProfileAssociationsCommand,
  DescribeInstancesCommand,
  DescribeSecurityGroupsCommand,
  DisassociateIamInstanceProfileCommand,
  ModifyInstanceAttributeCommand,
  ReplaceIamInstanceProfileAssociationCommand,
  StartInstancesCommand,
  StopInstancesCommand,
} from '@aws-sdk/client-ec2';

// Issue #5446: an AWS::EC2::Instance update applies InstanceType / UserData
// (stop -> modify -> start), IamInstanceProfile, SecurityGroupIds and a
// DeleteOnTermination-only BlockDeviceMappings change, as CloudFormation does
// (measured, us-east-1), instead of reporting success with AWS unchanged.

const { mockSend, deadline } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  deadline: { remainingMs: Number.POSITIVE_INFINITY, expired: false },
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

const logs = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn() }));
vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: logs.info,
    warn: logs.warn,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: logs.info,
      warn: logs.warn,
      error: vi.fn(),
    }),
  };
});

vi.mock('../../../src/deployment/resource-deadline.js', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    enclosingDeadlineRemainingMs: () => deadline.remainingMs,
    enclosingDeadlineExpired: () => deadline.expired,
  };
});

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import type { UpdateContext } from '../../../src/types/resource.js';

const ID = 'i-0123456789abcdef0';
const MUTATING = [
  StopInstancesCommand,
  StartInstancesCommand,
  ModifyInstanceAttributeCommand,
  AssociateIamInstanceProfileCommand,
  ReplaceIamInstanceProfileAssociationCommand,
  DisassociateIamInstanceProfileCommand,
];

interface World {
  states: string[]; // successive State.Name answers to DescribeInstances
  rootDeviceType?: string;
  association?: { AssociationId: string; State: string };
  failModify?: (input: Record<string, unknown>) => Error | undefined;
}
let world: World;

function install(): void {
  let describes = 0;
  mockSend.mockImplementation((command: unknown) => {
    if (command instanceof DescribeInstancesCommand) {
      // The waits' sleep is stubbed, so a wait that never sees its target
      // state would spin; fail it instead, as a red test rather than a hang.
      if (++describes > 50) return Promise.reject(new Error('runaway DescribeInstances poll'));
      const name = world.states.length > 1 ? world.states.shift()! : world.states[0];
      return Promise.resolve({
        Reservations: [
          {
            Instances: [
              {
                InstanceId: ID,
                State: name === undefined ? undefined : { Name: name },
                RootDeviceType: world.rootDeviceType ?? 'ebs',
                VpcId: 'vpc-1',
              },
            ],
          },
        ],
      });
    }
    if (command instanceof DescribeIamInstanceProfileAssociationsCommand) {
      return Promise.resolve({
        IamInstanceProfileAssociations: world.association ? [world.association] : [],
      });
    }
    if (command instanceof DescribeSecurityGroupsCommand) {
      return Promise.resolve({ SecurityGroups: [{ GroupId: 'sg-default', GroupName: 'default' }] });
    }
    if (command instanceof ModifyInstanceAttributeCommand && world.failModify) {
      const err = world.failModify(command.input as unknown as Record<string, unknown>);
      if (err) return Promise.reject(err);
    }
    return Promise.resolve({});
  });
}

const mutatingCalls = () =>
  mockSend.mock.calls
    .map((c) => c[0])
    .filter((cmd) => MUTATING.some((K) => cmd instanceof K))
    .map((cmd) => ({ name: (cmd as object).constructor.name, input: (cmd as { input: unknown }).input }));

const B64 = (s: string) => Buffer.from(s).toString('base64');
const BASE = {
  ImageId: 'ami-1',
  InstanceType: 't3.nano',
  SubnetId: 'subnet-1',
  SecurityGroupIds: ['sg-a'],
  UserData: B64('#!/bin/bash\necho v1\n'),
  IamInstanceProfile: 'profile-1',
};

async function update(
  desired: Record<string, unknown>,
  previous: Record<string, unknown> = BASE,
  context?: UpdateContext
) {
  return new EC2Provider().update('Inst', ID, 'AWS::EC2::Instance', desired, previous, context);
}

beforeEach(() => {
  vi.clearAllMocks();
  deadline.remainingMs = Number.POSITIVE_INFINITY;
  deadline.expired = false;
  delete process.env['CDKD_NO_WAIT'];
  world = { states: ['running'] };
  install();
  vi.spyOn(EC2Provider.prototype as unknown as { sleep: () => Promise<void> }, 'sleep').mockResolvedValue(
    undefined
  );
});

describe('InstanceType / UserData: stop -> modify -> start', () => {
  it('changes InstanceType on a stopped instance and starts it again', async () => {
    world.states = ['running', 'running', 'stopping', 'stopped', 'pending', 'running'];
    await update({ ...BASE, InstanceType: 't3.micro' });
    expect(mutatingCalls()).toEqual([
      { name: 'StopInstancesCommand', input: { InstanceIds: [ID] } },
      {
        name: 'ModifyInstanceAttributeCommand',
        input: { InstanceId: ID, InstanceType: { Value: 't3.micro' } },
      },
      { name: 'StartInstancesCommand', input: { InstanceIds: [ID] } },
    ]);
  });

  it('sends UserData as the RAW bytes of the template base64', async () => {
    world.states = ['running', 'running', 'stopped', 'running'];
    await update({ ...BASE, UserData: B64('#!/bin/bash\necho v2\n') });
    const modify = mutatingCalls().find((c) => c.name === 'ModifyInstanceAttributeCommand')!;
    const value = (modify.input as { UserData: { Value: Uint8Array } }).UserData.Value;
    expect(Buffer.from(value).toString()).toBe('#!/bin/bash\necho v2\n');
  });

  it('stops and starts once for an InstanceType and UserData change together', async () => {
    world.states = ['running', 'running', 'stopped', 'running'];
    await update({ ...BASE, InstanceType: 't3.micro', UserData: B64('v2') });
    const names = mutatingCalls().map((c) => c.name);
    expect(names).toEqual([
      'StopInstancesCommand',
      'ModifyInstanceAttributeCommand',
      'ModifyInstanceAttributeCommand',
      'StartInstancesCommand',
    ]);
  });

  it('clears a removed UserData (an empty blob), as CloudFormation does', async () => {
    world.states = ['running', 'running', 'stopped', 'running'];
    const { UserData: _gone, ...rest } = BASE;
    await update(rest, BASE, { removedProperties: new Set(['UserData']) });
    const modify = mutatingCalls().find((c) => c.name === 'ModifyInstanceAttributeCommand')!;
    expect((modify.input as { UserData: { Value: Uint8Array } }).UserData.Value).toHaveLength(0);
  });

  it('modifies an instance the user stopped and leaves it stopped', async () => {
    world.states = ['stopped'];
    await update({ ...BASE, InstanceType: 't3.micro' });
    expect(mutatingCalls().map((c) => c.name)).toEqual(['ModifyInstanceAttributeCommand']);
  });

  it('under --no-wait still waits for stopped, but not for running', async () => {
    process.env['CDKD_NO_WAIT'] = 'true';
    world.states = ['running', 'running', 'stopped', 'pending'];
    await update({ ...BASE, InstanceType: 't3.micro' });
    expect(mutatingCalls().map((c) => c.name)).toContain('StartInstancesCommand');
    // plan read + state read + one stop poll; no running poll after the start
    const describes = mockSend.mock.calls.filter((c) => c[0] instanceof DescribeInstancesCommand);
    expect(describes.length).toBe(4); // + the attribute refresh
    expect(world.states).toEqual(['pending']);
  });

  it('starts the instance again when the modify fails after the stop', async () => {
    world.states = ['running', 'running', 'stopped'];
    world.failModify = () => Object.assign(new Error('bad type'), { name: 'InvalidParameterValue' });
    await expect(update({ ...BASE, InstanceType: 't3.bogus' })).rejects.toThrow(/bad type/);
    expect(mutatingCalls().map((c) => c.name)).toEqual([
      'StopInstancesCommand',
      'ModifyInstanceAttributeCommand',
      'StartInstancesCommand',
    ]);
  });

  it('fails non-retryably when the instance terminates during the wait', async () => {
    world.states = ['running', 'running', 'terminated'];
    await expect(update({ ...BASE, InstanceType: 't3.micro' })).rejects.toThrow(
      /terminated while cdkd waited for it to be stopped/
    );
    expect(mutatingCalls().map((c) => c.name)).not.toContain('ModifyInstanceAttributeCommand');
  });

  it('ends the wait at the resource deadline, without a start', async () => {
    world.states = ['running', 'running', 'stopping'];
    deadline.remainingMs = 0;
    deadline.expired = true;
    const err = await update({ ...BASE, InstanceType: 't3.micro' }).then(
      () => undefined,
      (e: unknown) => e as Error
    );
    expect(err?.message).toMatch(/timed out waiting for instance .* to be stopped/);
    // The wait's own error passes through updateInstance's wrap unchanged.
    expect(err?.message.startsWith('Inst (AWS::EC2::Instance): ')).toBe(true);
    expect(mutatingCalls().map((c) => c.name)).toEqual(['StopInstancesCommand']);
    expect(logs.warn.mock.calls.flat().join('\n')).toContain('aws ec2 start-instances');
  });
});

describe('refusals before any mutating call', () => {
  it('refuses a removed InstanceType (CloudFormation fails it)', async () => {
    const { InstanceType: _gone, ...rest } = BASE;
    await expect(
      update(rest, BASE, { removedProperties: new Set(['InstanceType']) })
    ).rejects.toThrow(/InstanceType was removed from the template/);
    expect(mutatingCalls()).toEqual([]);
  });

  it('a rollback restoring a state without InstanceType warns and keeps it', async () => {
    const { InstanceType: _gone, ...rest } = BASE;
    await update(rest, BASE, { removedProperties: new Set(['InstanceType']), replayingState: true });
    expect(mutatingCalls()).toEqual([]);
    expect(logs.warn).toHaveBeenCalled();
  });

  it.each([
    ['UserData', '***'],
    ['UserData', '{{resolve:secretsmanager:s}}'],
    ['InstanceType', '{{resolve:ssm:/t}}'],
    ['IamInstanceProfile', '***'],
  ])('refuses a recorded stand-in for %s (%s)', async (key, value) => {
    await expect(update({ ...BASE, [key]: value })).rejects.toThrow(/recorded stand-in/);
    expect(mutatingCalls()).toEqual([]);
  });

  it('refuses a stand-in inside SecurityGroupIds', async () => {
    await expect(update({ ...BASE, SecurityGroupIds: ['sg-a', '***'] })).rejects.toThrow(
      /recorded stand-in/
    );
    expect(mutatingCalls()).toEqual([]);
  });

  it('refuses a stop on an instance-store-backed instance, naming --replace', async () => {
    world.rootDeviceType = 'instance-store';
    await expect(update({ ...BASE, InstanceType: 't3.micro' })).rejects.toThrow(/--replace/);
    expect(mutatingCalls()).toEqual([]);
  });
});

describe('IamInstanceProfile', () => {
  it('replaces the existing association', async () => {
    world.association = { AssociationId: 'iip-assoc-1', State: 'associated' };
    await update({ ...BASE, IamInstanceProfile: 'profile-2' });
    expect(mutatingCalls()).toEqual([
      {
        name: 'ReplaceIamInstanceProfileAssociationCommand',
        input: { AssociationId: 'iip-assoc-1', IamInstanceProfile: { Name: 'profile-2' } },
      },
    ]);
  });

  it('associates when there is none', async () => {
    const { IamInstanceProfile: _none, ...rest } = BASE;
    await update({ ...BASE, IamInstanceProfile: 'arn:aws:iam::1:instance-profile/p/profile-2' }, rest);
    expect(mutatingCalls()).toEqual([
      {
        name: 'AssociateIamInstanceProfileCommand',
        input: {
          InstanceId: ID,
          IamInstanceProfile: { Arn: 'arn:aws:iam::1:instance-profile/p/profile-2' },
        },
      },
    ]);
  });

  it('disassociates a removed profile', async () => {
    world.association = { AssociationId: 'iip-assoc-1', State: 'associated' };
    const { IamInstanceProfile: _gone, ...rest } = BASE;
    await update(rest, BASE, { removedProperties: new Set(['IamInstanceProfile']) });
    expect(mutatingCalls()).toEqual([
      { name: 'DisassociateIamInstanceProfileCommand', input: { AssociationId: 'iip-assoc-1' } },
    ]);
  });

  it('a name and the ARN of the same profile are no change', async () => {
    await update(
      { ...BASE, IamInstanceProfile: 'arn:aws:iam::1:instance-profile/profile-1' },
      BASE
    );
    expect(mutatingCalls()).toEqual([]);
  });
});

describe('SecurityGroupIds', () => {
  it('sets the new groups with ModifyInstanceAttribute', async () => {
    await update({ ...BASE, SecurityGroupIds: ['sg-b', 'sg-c'] });
    expect(mutatingCalls()).toEqual([
      { name: 'ModifyInstanceAttributeCommand', input: { InstanceId: ID, Groups: ['sg-b', 'sg-c'] } },
    ]);
  });

  it('a reorder is no change', async () => {
    await update({ ...BASE, SecurityGroupIds: ['sg-b', 'sg-a'] }, { ...BASE, SecurityGroupIds: ['sg-a', 'sg-b'] });
    expect(mutatingCalls()).toEqual([]);
  });

  it("a removal puts the VPC's default group in place, as CloudFormation does", async () => {
    const { SecurityGroupIds: _gone, ...rest } = BASE;
    await update(rest, BASE, { removedProperties: new Set(['SecurityGroupIds']) });
    expect(mutatingCalls()).toEqual([
      { name: 'ModifyInstanceAttributeCommand', input: { InstanceId: ID, Groups: ['sg-default'] } },
    ]);
  });
});

describe('BlockDeviceMappings DeleteOnTermination', () => {
  const withDot = (dot: unknown) => ({
    ...BASE,
    BlockDeviceMappings: [{ DeviceName: '/dev/sdf', Ebs: { VolumeSize: 8, DeleteOnTermination: dot } }],
  });

  it('flips only the changed device in place', async () => {
    await update(withDot(false), withDot(true));
    expect(mutatingCalls()).toEqual([
      {
        name: 'ModifyInstanceAttributeCommand',
        input: {
          InstanceId: ID,
          BlockDeviceMappings: [{ DeviceName: '/dev/sdf', Ebs: { DeleteOnTermination: false } }],
        },
      },
    ]);
  });

  it('sends nothing for a change it cannot apply (the engine replaces those)', async () => {
    await update(
      { ...BASE, BlockDeviceMappings: [{ DeviceName: '/dev/sdf', Ebs: { VolumeSize: 9 } }] },
      { ...BASE, BlockDeviceMappings: [{ DeviceName: '/dev/sdf', Ebs: { VolumeSize: 8 } }] }
    );
    expect(mutatingCalls()).toEqual([]);
  });
});

describe('what counts as a change', () => {
  it('update(state, state) issues no mutating call', async () => {
    await update(BASE, BASE);
    expect(mutatingCalls()).toEqual([]);
  });

  it('follows changedProperties over a redacted previous value', async () => {
    const prev = { ...BASE, UserData: '***' };
    await update(BASE, prev, { changedProperties: new Set(['Tags']) });
    expect(mutatingCalls()).toEqual([]);

    world.states = ['running', 'running', 'stopped', 'running'];
    await update(BASE, prev, { changedProperties: new Set(['UserData']) });
    expect(mutatingCalls().map((c) => c.name)).toContain('StopInstancesCommand');
  });

  it('two state records redacted alike are no change (a rollback revert)', async () => {
    const rec = { ...BASE, UserData: '***' };
    await update(rec, rec, { removedProperties: new Set(), replayingState: true });
    expect(mutatingCalls()).toEqual([]);
  });

  it('a key both sides lack is never cleared (drift --revert readback)', async () => {
    const { UserData: _a, ...readback } = BASE;
    await update(readback, readback, { removedProperties: new Set(), desiredFromAwsReadback: true });
    expect(mutatingCalls()).toEqual([]);
  });
});
