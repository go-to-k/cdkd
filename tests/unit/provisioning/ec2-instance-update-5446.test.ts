import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  AssociateIamInstanceProfileCommand,
  CreateTagsCommand,
  DeleteTagsCommand,
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

const { mockSend, deadline, interrupt } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  deadline: { remainingMs: Number.POSITIVE_INFINITY, expired: false },
  // Raised after this many isInterrupted() reads (Infinity: never).
  interrupt: { after: Number.POSITIVE_INFINITY, reads: 0 },
}));

vi.mock('../../../src/provisioning/interrupt-watch.js', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../../../src/provisioning/interrupt-watch.js');
  return {
    ...actual,
    startInterruptWatch: (what: string) => ({
      isInterrupted: () => ++interrupt.reads > interrupt.after,
      onInterrupted: () => new actual.InterruptedWaitError(what),
      dispose: () => undefined,
    }),
  };
});

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
import { isInterruptedWaitError } from '../../../src/provisioning/interrupt-watch.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors/marks.js';
import { isRefusedBeforeApplying } from '../../../src/deployment/prior-attempt-scope.js';
import type { UpdateContext } from '../../../src/types/resource.js';

// A fresh id per test: the provider remembers, per process, an instance it
// left stopped, so a shared id would carry one test's outcome into the next.
let idSeq = 0;
let ID = 'i-0123456789abcdef0';
const MUTATING = [
  StopInstancesCommand,
  StartInstancesCommand,
  ModifyInstanceAttributeCommand,
  AssociateIamInstanceProfileCommand,
  ReplaceIamInstanceProfileAssociationCommand,
  DisassociateIamInstanceProfileCommand,
  CreateTagsCommand,
  DeleteTagsCommand,
];

interface World {
  states: string[]; // successive State.Name answers to DescribeInstances
  rootDeviceType?: string;
  association?: { AssociationId: string; State: string };
  associationSeq?: Array<Array<{ AssociationId: string; State: string }>>; // successive describe answers
  failModify?: (input: Record<string, unknown>) => Error | undefined;
  failStart?: number; // reject the first N StartInstances calls
  failStop?: Error;
  associateErrors?: Error[]; // rejections for successive associate / replace calls
  vpcId?: string | null;
  defaultGroups?: Array<{ GroupId: string }>;
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
                VpcId: world.vpcId === null ? undefined : (world.vpcId ?? 'vpc-1'),
              },
            ],
          },
        ],
      });
    }
    if (command instanceof DescribeIamInstanceProfileAssociationsCommand) {
      if (world.associationSeq && world.associationSeq.length > 0) {
        return Promise.resolve({ IamInstanceProfileAssociations: world.associationSeq.shift() });
      }
      return Promise.resolve({
        IamInstanceProfileAssociations: world.association ? [world.association] : [],
      });
    }
    if (command instanceof DescribeSecurityGroupsCommand) {
      return Promise.resolve({
        SecurityGroups: world.defaultGroups ?? [{ GroupId: 'sg-default', GroupName: 'default' }],
      });
    }
    if (command instanceof StopInstancesCommand && world.failStop) {
      return Promise.reject(world.failStop);
    }
    if (command instanceof StartInstancesCommand && (world.failStart ?? 0) > 0) {
      world.failStart!--;
      return Promise.reject(
        Object.assign(new Error('Insufficient capacity'), { name: 'InsufficientInstanceCapacity' })
      );
    }
    if (
      (command instanceof AssociateIamInstanceProfileCommand ||
        command instanceof ReplaceIamInstanceProfileAssociationCommand) &&
      (world.associateErrors?.length ?? 0) > 0
    ) {
      return Promise.reject(world.associateErrors!.shift());
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
  ID = `i-0${(++idSeq).toString(16).padStart(16, '0')}`;
  vi.clearAllMocks();
  deadline.remainingMs = Number.POSITIVE_INFINITY;
  deadline.expired = false;
  interrupt.after = Number.POSITIVE_INFINITY;
  interrupt.reads = 0;
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
    // Unknowable whether the value behind the two masks moved: said, not sent.
    expect(logs.warn.mock.calls.flat().join('\n')).toContain(
      'both sides of the rollback record UserData as a stand-in'
    );
  });

  it('a key both sides lack is never cleared (drift --revert readback)', async () => {
    const { UserData: _a, ...readback } = BASE;
    await update(readback, readback, { removedProperties: new Set(), desiredFromAwsReadback: true });
    expect(mutatingCalls()).toEqual([]);
  });
});

describe('fix round (#5457 review)', () => {
  it('Ctrl-C during the stop wait passes the InterruptedWaitError through and names the start command', async () => {
    world.states = ['running', 'running', 'stopping'];
    interrupt.after = 0; // the first read inside the stop wait
    const err = await update({ ...BASE, InstanceType: 't3.micro' }).then(
      () => undefined,
      (e: unknown) => e
    );
    // The engine reads an interrupt through the cause chain; updateInstance
    // adds no wrap of its own (update()'s shared wrapper keeps the cause).
    expect(isInterruptedWaitError(err)).toBe(true);
    expect((err as Error).message).not.toContain('Failed to update EC2 Instance');
    expect(mutatingCalls().map((c) => c.name)).toEqual(['StopInstancesCommand']);
    expect(logs.warn.mock.calls.flat().join('\n')).toContain('aws ec2 start-instances');
  });

  it('a failed final start warns, and the rollback that follows starts the instance again', async () => {
    const id = 'i-0aaaaaaaaaaaaaaa1';
    const run = (d: Record<string, unknown>, p: Record<string, unknown>, c?: UpdateContext) =>
      new EC2Provider().update('Inst', id, 'AWS::EC2::Instance', d, p, c);
    world.states = ['running', 'running', 'stopped'];
    world.failStart = 1;
    await expect(run({ ...BASE, InstanceType: 't3.micro' }, BASE)).rejects.toThrow(
      /Insufficient capacity/
    );
    expect(logs.warn.mock.calls.flat().join('\n')).toMatch(
      /is stopped, with the new InstanceType already applied.*aws ec2 start-instances/
    );
    // The rollback revert reads it stopped; the stop was cdkd's, so it starts it.
    mockSend.mockClear();
    world.states = ['stopped', 'stopped', 'pending', 'running'];
    await run(BASE, { ...BASE, InstanceType: 't3.micro' }, { replayingState: true });
    expect(mutatingCalls().map((c) => c.name)).toEqual([
      'ModifyInstanceAttributeCommand',
      'StartInstancesCommand',
    ]);
  });

  it('an instance AWS stops right after the start fails the wait and is remembered', async () => {
    world.states = ['running', 'running', 'stopped', 'pending', 'stopped'];
    await expect(update({ ...BASE, InstanceType: 't3.micro' })).rejects.toThrow(
      /stopped again right after it was started/
    );
    expect(logs.warn.mock.calls.flat().join('\n')).toContain('aws ec2 start-instances');
  });

  it('a UserData failure after the InstanceType landed says the new type is applied', async () => {
    world.states = ['running', 'running', 'stopped'];
    world.failModify = (input) => (input['UserData'] ? new Error('bad user data') : undefined);
    await expect(
      update({ ...BASE, InstanceType: 't3.micro', UserData: B64('v2') })
    ).rejects.toThrow(/bad user data/);
    expect(logs.warn.mock.calls.flat().join('\n')).toContain(
      'started it again, with the new InstanceType already applied'
    );
  });

  it('a restart that fails too names the start command', async () => {
    world.states = ['running', 'running', 'stopped'];
    world.failModify = () => new Error('bad type');
    world.failStart = 1;
    await expect(update({ ...BASE, InstanceType: 't3.bogus' })).rejects.toThrow(/bad type/);
    expect(logs.warn.mock.calls.flat().join('\n')).toMatch(
      /starting it again failed too.*aws ec2 start-instances/
    );
  });

  it('starts from pending by waiting for running, then stops, modifies and starts', async () => {
    world.states = ['pending', 'pending', 'running', 'running', 'stopped', 'running'];
    await update({ ...BASE, InstanceType: 't3.micro' });
    expect(mutatingCalls().map((c) => c.name)).toEqual([
      'StopInstancesCommand',
      'ModifyInstanceAttributeCommand',
      'StartInstancesCommand',
    ]);
  });

  it('a stopping instance is modified and left stopped', async () => {
    world.states = ['stopping', 'stopping', 'stopped'];
    await update({ ...BASE, InstanceType: 't3.micro' });
    expect(mutatingCalls().map((c) => c.name)).toEqual(['ModifyInstanceAttributeCommand']);
  });

  it('refuses an instance that is shutting-down before any mutating call', async () => {
    world.states = ['shutting-down'];
    await expect(
      update({ ...BASE, InstanceType: 't3.micro', SecurityGroupIds: ['sg-b'], Tags: [{ Key: 'k', Value: 'v' }] })
    ).rejects.toThrow(/is shutting-down, so its InstanceType cannot be changed/);
    expect(mutatingCalls()).toEqual([]);
  });

  it('the instance-store refusal is a ResourceUpdateNotSupportedError, before tags and groups', async () => {
    world.rootDeviceType = 'instance-store';
    const err = await update({
      ...BASE,
      InstanceType: 't3.micro',
      SecurityGroupIds: ['sg-b'],
      Tags: [{ Key: 'k', Value: 'v' }],
    }).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect(mutatingCalls()).toEqual([]);
  });

  it('a stand-in is refused before tags and groups', async () => {
    await expect(
      update({ ...BASE, UserData: '***', SecurityGroupIds: ['sg-b'], Tags: [{ Key: 'k', Value: 'v' }] })
    ).rejects.toThrow(/recorded stand-in/);
    expect(mutatingCalls()).toEqual([]);
  });

  it('a rollback keeps a stand-in member and still reverts the others', async () => {
    await update(
      { ...BASE, UserData: '***', SecurityGroupIds: ['sg-b'] },
      { ...BASE, UserData: B64('v2') },
      { replayingState: true }
    );
    expect(mutatingCalls()).toEqual([
      { name: 'ModifyInstanceAttributeCommand', input: { InstanceId: ID, Groups: ['sg-b'] } },
    ]);
    expect(logs.warn.mock.calls.flat().join('\n')).toContain('records UserData as a stand-in');
  });

  it.each([
    ['no VpcId', { vpcId: null }],
    ['no default group', { defaultGroups: [] }],
  ])('a removed SecurityGroupIds with %s is refused before any mutating call', async (_n, w) => {
    Object.assign(world, w);
    const { SecurityGroupIds: _gone, ...rest } = BASE;
    await expect(
      update({ ...rest, Tags: [{ Key: 'k', Value: 'v' }] }, BASE, {
        removedProperties: new Set(['SecurityGroupIds']),
      })
    ).rejects.toSatisfy(
      (e: unknown) =>
        /default security group .* could not be found/.test((e as Error).message) &&
        isMarkedNonRetryable(e)
    );
    expect(mutatingCalls()).toEqual([]);
  });

  it('retries a profile association through IAM propagation', async () => {
    world.associateErrors = [
      Object.assign(new Error('Invalid IAM Instance Profile name'), { name: 'InvalidParameterValue' }),
    ];
    const { IamInstanceProfile: _none, ...rest } = BASE;
    await update({ ...BASE, IamInstanceProfile: 'profile-2' }, rest);
    expect(mutatingCalls().map((c) => c.name)).toEqual([
      'AssociateIamInstanceProfileCommand',
      'AssociateIamInstanceProfileCommand',
    ]);
  });

  it('a non-propagation association error is not retried', async () => {
    world.associateErrors = [Object.assign(new Error('access denied'), { name: 'UnauthorizedOperation' })];
    const { IamInstanceProfile: _none, ...rest } = BASE;
    await expect(update({ ...BASE, IamInstanceProfile: 'profile-2' }, rest)).rejects.toThrow();
    expect(mutatingCalls().map((c) => c.name)).toEqual(['AssociateIamInstanceProfileCommand']);
  });

  it('stops retrying propagation after ten attempts', async () => {
    world.associateErrors = Array.from({ length: 12 }, () =>
      Object.assign(new Error('Invalid IAM Instance Profile name'), { name: 'InvalidParameterValue' })
    );
    world.association = { AssociationId: 'iip-assoc-1', State: 'associated' };
    await expect(update({ ...BASE, IamInstanceProfile: 'profile-2' })).rejects.toThrow();
    expect(
      mutatingCalls().filter((c) => c.name === 'ReplaceIamInstanceProfileAssociationCommand')
    ).toHaveLength(10);
  });

  it.each([
    ['a non-string UserData', { UserData: 42 }, /UserData must be a base64 string/],
    ['an empty SecurityGroupIds', { SecurityGroupIds: [] }, /non-empty list of security group ids/],
    ['an unreadable IamInstanceProfile', { IamInstanceProfile: 7 }, /IamInstanceProfile is neither/],
  ])('refuses %s before any mutating call', async (_n, extra, re) => {
    await expect(update({ ...BASE, ...extra })).rejects.toThrow(re);
    expect(mutatingCalls()).toEqual([]);
  });

  it('DeleteOnTermination from absent to false flips it (absent means true)', async () => {
    const bdm = (ebs: Record<string, unknown>) => ({
      ...BASE,
      BlockDeviceMappings: [{ DeviceName: '/dev/sdf', Ebs: { VolumeSize: 8, ...ebs } }],
    });
    await update(bdm({ DeleteOnTermination: false }), bdm({}));
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
});

describe('fix round 2 (#5457 re-review)', () => {
  it('a stopped that persists after the start fails the wait even with no pending seen', async () => {
    world.states = ['running', 'running', 'stopped']; // stays stopped after the start
    await expect(update({ ...BASE, InstanceType: 't3.micro' })).rejects.toThrow(
      /stopped again right after it was started/
    );
    expect(logs.warn.mock.calls.flat().join('\n')).toContain('aws ec2 start-instances');
  });

  it('a rollback with no stop member still starts an instance cdkd left stopped', async () => {
    world.states = ['running', 'running', 'stopped'];
    world.failStart = 1;
    await expect(update({ ...BASE, InstanceType: 't3.micro' })).rejects.toThrow();
    mockSend.mockClear();
    world.states = ['stopped'];
    // The rollback's InstanceType is a stand-in (skipped), so no stop member.
    await update(
      { ...BASE, InstanceType: '***' },
      { ...BASE, InstanceType: 't3.micro' },
      { replayingState: true }
    );
    expect(mutatingCalls().map((c) => c.name)).toEqual(['StartInstancesCommand']);
  });
});

describe('parent review round (#5457)', () => {
  it('a user-stopped instance whose modify fails is neither started nor warned about', async () => {
    world.states = ['stopped'];
    world.failModify = () => new Error('bad type');
    await expect(update({ ...BASE, InstanceType: 't3.bogus' })).rejects.toThrow(/bad type/);
    expect(mutatingCalls().map((c) => c.name)).toEqual(['ModifyInstanceAttributeCommand']);
    expect(logs.warn).not.toHaveBeenCalled();
  });

  it('tolerates stale stopped reads right after the start (fewer than three)', async () => {
    world.states = ['running', 'running', 'stopped', 'stopped', 'stopped', 'pending', 'running'];
    await update({ ...BASE, InstanceType: 't3.micro' });
    expect(mutatingCalls().map((c) => c.name)).toEqual([
      'StopInstancesCommand',
      'ModifyInstanceAttributeCommand',
      'StartInstancesCommand',
    ]);
  });

  it('remembers an instance AWS stopped right after the start, so the rollback starts it', async () => {
    world.states = ['running', 'running', 'stopped', 'pending', 'stopped'];
    await expect(update({ ...BASE, InstanceType: 't3.micro' })).rejects.toThrow(
      /stopped again right after it was started/
    );
    mockSend.mockClear();
    world.states = ['stopped', 'stopped', 'pending', 'running'];
    await update(BASE, { ...BASE, InstanceType: 't3.micro' }, { replayingState: true });
    expect(mutatingCalls().map((c) => c.name)).toEqual([
      'ModifyInstanceAttributeCommand',
      'StartInstancesCommand',
    ]);
  });

  it('a modify failing at the deadline leaves the instance stopped and says so', async () => {
    world.states = ['running', 'running', 'stopped'];
    world.failModify = () => {
      deadline.expired = true;
      deadline.remainingMs = 0;
      return new Error('deadline hit');
    };
    await expect(update({ ...BASE, InstanceType: 't3.micro' })).rejects.toThrow(/deadline hit/);
    expect(mutatingCalls().map((c) => c.name)).toEqual([
      'StopInstancesCommand',
      'ModifyInstanceAttributeCommand',
    ]);
    expect(logs.warn.mock.calls.flat().join('\n')).toMatch(
      /is stopped, with its previous settings; cdkd did not start it again\. Start it with: aws ec2 start-instances/
    );
  });

  it('sends the no-interruption changes before the stop', async () => {
    world.states = ['running', 'running', 'stopped', 'running'];
    world.association = { AssociationId: 'iip-assoc-1', State: 'associated' };
    const bdm = (dot: boolean) => [{ DeviceName: '/dev/sdf', Ebs: { VolumeSize: 8, DeleteOnTermination: dot } }];
    await update(
      {
        ...BASE,
        InstanceType: 't3.micro',
        SecurityGroupIds: ['sg-b'],
        IamInstanceProfile: 'profile-2',
        BlockDeviceMappings: bdm(false),
      },
      { ...BASE, BlockDeviceMappings: bdm(true) }
    );
    expect(mutatingCalls().map((c) => c.name)).toEqual([
      'ModifyInstanceAttributeCommand', // Groups
      'ReplaceIamInstanceProfileAssociationCommand',
      'ModifyInstanceAttributeCommand', // BlockDeviceMappings
      'StopInstancesCommand',
      'ModifyInstanceAttributeCommand', // InstanceType
      'StartInstancesCommand',
    ]);
  });

  it('the restart warning names the changes already sent before the stop', async () => {
    world.states = ['running', 'running', 'stopped'];
    world.failModify = (input) => (input['InstanceType'] ? new Error('bad type') : undefined);
    await expect(
      update({ ...BASE, InstanceType: 't3.bogus', SecurityGroupIds: ['sg-b'] })
    ).rejects.toThrow(/bad type/);
    expect(logs.warn.mock.calls.flat().join('\n')).toContain(
      'cdkd started it again, with the new SecurityGroupIds already applied'
    );
  });

  it('a stop AWS refuses (stop protection) issues nothing more and warns nothing', async () => {
    world.states = ['running', 'running'];
    world.failStop = Object.assign(new Error('stop protection'), { name: 'OperationNotPermitted' });
    await expect(update({ ...BASE, InstanceType: 't3.micro' })).rejects.toThrow(/stop protection/);
    expect(mutatingCalls().map((c) => c.name)).toEqual(['StopInstancesCommand']);
    expect(logs.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['still stopping: waits, then starts', ['stopping', 'stopped'], ['StartInstancesCommand']],
    ['already running: leaves it', ['running'], []],
  ])(
    'a no-stop-member rollback of an instance cdkd left stopped, %s',
    async (_n, rollbackStates, expected) => {
      world.states = ['running', 'running', 'stopped'];
      world.failStart = 1;
      await expect(update({ ...BASE, InstanceType: 't3.micro' })).rejects.toThrow();
      mockSend.mockClear();
      world.states = [...rollbackStates];
      await update(
        { ...BASE, InstanceType: '***' },
        { ...BASE, InstanceType: 't3.micro' },
        { replayingState: true }
      );
      expect(mutatingCalls().map((c) => c.name)).toEqual(expected);
    }
  );

  it('waits out a disassociating association before associating', async () => {
    world.associationSeq = [[{ AssociationId: 'iip-old', State: 'disassociating' }], []];
    const { IamInstanceProfile: _none, ...rest } = BASE;
    await update({ ...BASE, IamInstanceProfile: 'profile-2' }, rest);
    expect(mutatingCalls().map((c) => c.name)).toEqual(['AssociateIamInstanceProfileCommand']);
    expect(
      mockSend.mock.calls.filter((c) => c[0] instanceof DescribeIamInstanceProfileAssociationsCommand)
    ).toHaveLength(2);
  });

  it.each([
    [
      'a removed InstanceType',
      () => {
        const { InstanceType: _g, ...rest } = BASE;
        return update(rest, BASE, { removedProperties: new Set(['InstanceType']) });
      },
    ],
    ['a stand-in', () => update({ ...BASE, UserData: '***' })],
    ['a malformed UserData', () => update({ ...BASE, UserData: 42 })],
    [
      'an instance-store root',
      () => {
        world.rootDeviceType = 'instance-store';
        return update({ ...BASE, InstanceType: 't3.micro' });
      },
    ],
    [
      'an unstoppable state',
      () => {
        world.states = ['shutting-down'];
        return update({ ...BASE, InstanceType: 't3.micro' });
      },
    ],
    [
      'a missing default group',
      () => {
        world.defaultGroups = [];
        const { SecurityGroupIds: _g, ...rest } = BASE;
        return update(rest, BASE, { removedProperties: new Set(['SecurityGroupIds']) });
      },
    ],
  ])('marks %s refused before applying', async (_n, run) => {
    const err = await run().then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Error);
    expect(isRefusedBeforeApplying(err, 'Inst')).toBe(true);
    expect(mutatingCalls()).toEqual([]);
  });

  it('a failure after a call was sent is NOT marked refused', async () => {
    world.states = ['running', 'running', 'stopped'];
    world.failModify = () => new Error('bad type');
    const err = await update({ ...BASE, InstanceType: 't3.bogus' }).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(isRefusedBeforeApplying(err, 'Inst')).toBe(false);
  });
});
