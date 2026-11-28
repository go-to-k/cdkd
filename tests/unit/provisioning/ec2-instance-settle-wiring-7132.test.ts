import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  DescribeIamInstanceProfileAssociationsCommand,
  DescribeInstancesCommand,
  DisassociateIamInstanceProfileCommand,
  ModifyInstanceMetadataOptionsCommand,
  MonitorInstancesCommand,
  ReplaceIamInstanceProfileAssociationCommand,
  UnmonitorInstancesCommand,
} from '@aws-sdk/client-ec2';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors/marks.js';

/**
 * go-to-k/cdkd#7132: an AWS::EC2::Instance update returned while
 * MonitorInstances / UnmonitorInstances, ModifyInstanceMetadataOptions and
 * the IAM instance profile association calls were still transitional, so the
 * drift baseline read right after it recorded the old value. These pin that
 * each send site waits for the settled state before the update returns, and
 * only when it sent the call.
 */

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

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
    child: vi.fn(function (this: unknown) {
      return this;
    }),
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

// Every poll sleeps min(poll interval, deadline remaining): 1 ms here.
vi.mock('../../../src/deployment/resource-deadline.js', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  enclosingDeadlineRemainingMs: () => 1,
}));

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';

const ID = 'i-0123456789abcdef0';
const PROFILE_ARN = 'arn:aws:iam::123456789012:instance-profile/profile-2';

interface World {
  monitoring: string[]; // successive Monitoring.State answers (last repeats)
  metadata: Array<Record<string, unknown>>; // successive MetadataOptions answers
  associations: Array<Array<Record<string, unknown>>>; // successive association lists
}
let world: World;

function next<T>(list: T[]): T {
  return list.length > 1 ? list.shift()! : list[0]!;
}

beforeEach(() => {
  mockSend.mockReset();
  delete process.env['CDKD_NO_WAIT'];
  world = {
    monitoring: ['disabled'],
    metadata: [{ State: 'applied' }],
    associations: [[]],
  };
  mockSend.mockImplementation((cmd: unknown) => {
    if (cmd instanceof DescribeInstancesCommand) {
      return Promise.resolve({
        Reservations: [
          {
            Instances: [
              {
                InstanceId: ID,
                State: { Name: 'running' },
                Monitoring: { State: next(world.monitoring) },
                MetadataOptions: next(world.metadata),
              },
            ],
          },
        ],
      });
    }
    if (cmd instanceof DescribeIamInstanceProfileAssociationsCommand) {
      return Promise.resolve({ IamInstanceProfileAssociations: next(world.associations) });
    }
    if (cmd instanceof ReplaceIamInstanceProfileAssociationCommand) {
      return Promise.resolve({
        IamInstanceProfileAssociation: { AssociationId: 'iip-new', State: 'associating' },
      });
    }
    return Promise.resolve({});
  });
});

afterEach(() => {
  delete process.env['CDKD_NO_WAIT'];
});

const calls = () => mockSend.mock.calls.map((c) => (c[0] as object).constructor.name);
const describesAfter = (name: string, describe = 'DescribeInstancesCommand') =>
  calls()
    .slice(calls().indexOf(name) + 1)
    .filter((n) => n === describe).length;

function update(
  desired: Record<string, unknown>,
  previous: Record<string, unknown>,
  removed?: string[]
) {
  return new EC2Provider().update(
    'Web',
    ID,
    'AWS::EC2::Instance',
    { ImageId: 'ami-1', ...desired },
    { ImageId: 'ami-1', ...previous },
    removed ? { removedProperties: new Set(removed) } : undefined
  );
}

describe('AWS::EC2::Instance update waits for its asynchronous changes (#7132)', () => {
  it('MonitorInstances: reads past the stale disabled and pending until enabled', async () => {
    world.monitoring = ['disabled', 'pending', 'enabled'];
    await update({ Monitoring: true }, { Monitoring: false });
    expect(calls()).toContain(MonitorInstancesCommand.name);
    // three wait reads, then the attribute refresh
    expect(describesAfter(MonitorInstancesCommand.name)).toBe(4);
  });

  it('UnmonitorInstances: reads past the stale enabled until disabled', async () => {
    world.monitoring = ['enabled', 'disabling', 'disabled'];
    await update({ Monitoring: false }, { Monitoring: true });
    expect(describesAfter(UnmonitorInstancesCommand.name)).toBe(4);
  });

  it('ModifyInstanceMetadataOptions: reads past pending until applied', async () => {
    world.metadata = [
      { State: 'pending', HttpTokens: 'required' },
      { State: 'applied', HttpTokens: 'required' },
    ];
    await update(
      { MetadataOptions: { HttpTokens: 'required' } },
      { MetadataOptions: { HttpTokens: 'optional' } }
    );
    expect(describesAfter(ModifyInstanceMetadataOptionsCommand.name)).toBe(3);
  });

  it('a monitoring that never settles fails the update non-retryably, never as applied', async () => {
    world.monitoring = ['pending'];
    const err = await update({ Monitoring: true }, { Monitoring: false }).catch((e: unknown) => e);
    expect(String(err)).toMatch(/still pending .*not confirmed/);
    expect(isMarkedNonRetryable(err)).toBe(true);
  });

  it('--no-wait skips the waits: only the attribute refresh reads the instance', async () => {
    process.env['CDKD_NO_WAIT'] = 'true';
    world.monitoring = ['pending'];
    await update({ Monitoring: true }, { Monitoring: false });
    expect(describesAfter(MonitorInstancesCommand.name)).toBe(1);
  });

  it('an update touching neither setting makes no new read', async () => {
    await update({ Monitoring: true, Tags: [] }, { Monitoring: true, Tags: [] });
    expect(calls().filter((n) => n === 'DescribeInstancesCommand')).toHaveLength(1);
  });

  it('ReplaceIamInstanceProfileAssociation: waits for the new association to read associated', async () => {
    const old = { AssociationId: 'iip-old', State: 'associated' };
    world.associations = [
      [old],
      [
        { ...old, State: 'disassociating' },
        { AssociationId: 'iip-new', State: 'associating' },
      ],
      [{ AssociationId: 'iip-new', State: 'associated', IamInstanceProfile: { Arn: PROFILE_ARN } }],
    ];
    await update({ IamInstanceProfile: 'profile-2' }, { IamInstanceProfile: 'profile-1' });
    expect(
      describesAfter(
        ReplaceIamInstanceProfileAssociationCommand.name,
        'DescribeIamInstanceProfileAssociationsCommand'
      )
    ).toBe(2);
  });

  it('a new association that ends disassociated fails the update non-retryably', async () => {
    world.associations = [
      [{ AssociationId: 'iip-old', State: 'associated' }],
      [{ AssociationId: 'iip-new', State: 'disassociated' }],
    ];
    const err = await update(
      { IamInstanceProfile: 'profile-2' },
      { IamInstanceProfile: 'profile-1' }
    ).catch((e: unknown) => e);
    expect(String(err)).toContain('settled as disassociated, expected associated');
    expect(isMarkedNonRetryable(err)).toBe(true);
  });

  it('DisassociateIamInstanceProfile: waits until the association is gone', async () => {
    const old = { AssociationId: 'iip-old', State: 'associated' };
    world.associations = [[old], [{ ...old, State: 'disassociating' }], []];
    await update({}, { IamInstanceProfile: 'profile-1' }, ['IamInstanceProfile']);
    expect(calls()).toContain(DisassociateIamInstanceProfileCommand.name);
    expect(
      describesAfter(
        DisassociateIamInstanceProfileCommand.name,
        'DescribeIamInstanceProfileAssociationsCommand'
      )
    ).toBe(2);
  });
});
