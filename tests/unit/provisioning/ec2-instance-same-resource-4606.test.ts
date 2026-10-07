import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#4606: the live identity read a successful deploy asks before
// deleting a fix-forward's earlier EC2 instance. Only `'different'` lets it
// delete.

const { mockSend, clientRegion, providerLogger } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  clientRegion: { value: 'us-east-1' },
  providerLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  },
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend, config: { region: () => Promise.resolve(clientRegion.value) } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ ...providerLogger, child: () => providerLogger }),
}));

vi.mock('@aws-sdk/client-ec2', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, waitUntilInstanceTerminated: vi.fn().mockResolvedValue({}) };
});

import { DescribeInstancesCommand, TerminateInstancesCommand } from '@aws-sdk/client-ec2';
import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';

const INSTANCE = 'AWS::EC2::Instance';
const CTX = { expectedRegion: 'us-east-1' };
const I_A = 'i-0aaaaaaaaaaaaaaa1';
const I_B = 'i-0bbbbbbbbbbbbbbb2';

const awsError = (name: string, message = name): Error => Object.assign(new Error(message), { name });

/** `DescribeInstances` answers per instance id: its state name, gone, or an error. */
function instances(live: Record<string, string | 'gone' | Error>): void {
  mockSend.mockImplementation(async (cmd: unknown) => {
    if (!(cmd instanceof DescribeInstancesCommand)) throw new Error('unexpected command');
    const id = cmd.input.InstanceIds![0]!;
    const entry = live[id];
    if (entry === undefined || entry === 'gone') throw awsError('InvalidInstanceID.NotFound');
    if (entry instanceof Error) throw entry;
    return { Reservations: [{ Instances: [{ InstanceId: id, State: { Name: entry } }] }] };
  });
}

const readIds = (): unknown[] =>
  mockSend.mock.calls.map(([c]) => (c as DescribeInstancesCommand).input.InstanceIds);

let provider: EC2Provider;

beforeEach(() => {
  vi.clearAllMocks();
  clientRegion.value = 'us-east-1';
  provider = new EC2Provider();
});

describe('EC2Provider.isSameResource for AWS::EC2::Instance (go-to-k/cdkd#4606)', () => {
  it('another live instance is different, after reading the record first, then the journaled one', async () => {
    instances({ [I_A]: 'running', [I_B]: 'running' });
    expect(await provider.isSameResource(I_A, { physicalId: I_B }, INSTANCE, CTX)).toBe(
      'different'
    );
    expect(readIds()).toEqual([[I_B], [I_A]]);
  });

  it.each(['pending', 'running', 'stopping', 'stopped', 'shutting-down', 'terminated', 'gone'])(
    'a journaled instance %s is different once the record reads back live',
    async (journaled) => {
      instances({ [I_A]: journaled, [I_B]: 'running' });
      expect(await provider.isSameResource(I_A, { physicalId: I_B }, INSTANCE, CTX)).toBe(
        'different'
      );
    }
  );

  it.each(['pending', 'stopping', 'stopped'])(
    'a record instance %s counts as live',
    async (recorded) => {
      instances({ [I_A]: 'running', [I_B]: recorded });
      expect(await provider.isSameResource(I_A, { physicalId: I_B }, INSTANCE, CTX)).toBe(
        'different'
      );
    }
  );

  it.each(['shutting-down', 'terminated', 'gone'])(
    'the record instance %s is unknown, not different, and the journaled one is not read',
    async (recorded) => {
      instances({ [I_A]: 'running', [I_B]: recorded });
      expect(await provider.isSameResource(I_A, { physicalId: I_B }, INSTANCE, CTX)).toBe(
        'unknown'
      );
      expect(readIds()).toEqual([[I_B]]);
    }
  );

  it('equal ids are the same without a read', async () => {
    instances({});
    expect(await provider.isSameResource(I_A, { physicalId: I_A }, INSTANCE, CTX)).toBe('same');
    expect(mockSend).not.toHaveBeenCalled();
  });

  // Defensive: EC2 cannot answer one instance id with another; the branch
  // exists so a read naming the record's instance never reads as 'different'.
  it('a journaled id reading back as the record instance is the same', async () => {
    mockSend.mockResolvedValue({
      Reservations: [{ Instances: [{ InstanceId: I_B, State: { Name: 'running' } }] }],
    });
    expect(await provider.isSameResource(I_A, { physicalId: I_B }, INSTANCE, CTX)).toBe('same');
  });

  it('a read that fails other than not-found throws (the caller reads it as unknown)', async () => {
    instances({ [I_A]: awsError('UnauthorizedOperation', 'denied'), [I_B]: 'running' });
    await expect(
      provider.isSameResource(I_A, { physicalId: I_B }, INSTANCE, CTX)
    ).rejects.toThrow('denied');
  });

  it('a malformed-id error is not read as gone', async () => {
    instances({ [I_A]: awsError('InvalidInstanceID.Malformed'), [I_B]: 'running' });
    await expect(
      provider.isSameResource(I_A, { physicalId: I_B }, INSTANCE, CTX)
    ).rejects.toThrow('InvalidInstanceID.Malformed');
  });

  it('a not-found error of another resource kind is not read as gone', async () => {
    instances({ [I_A]: awsError('InvalidVpcID.NotFound'), [I_B]: 'running' });
    await expect(
      provider.isSameResource(I_A, { physicalId: I_B }, INSTANCE, CTX)
    ).rejects.toThrow('InvalidVpcID.NotFound');
  });

  it.each([
    ['no reservation', { Reservations: [] }],
    ['an empty reservation', { Reservations: [{ Instances: [] }] }],
    [
      'two instances',
      {
        Reservations: [
          { Instances: [{ InstanceId: I_B, State: { Name: 'running' } }] },
          { Instances: [{ InstanceId: I_A, State: { Name: 'running' } }] },
        ],
      },
    ],
    ['an instance with no id', { Reservations: [{ Instances: [{ State: { Name: 'running' } }] }] }],
    [
      'an instance with no state',
      { Reservations: [{ Instances: [{ InstanceId: I_B }] }] },
    ],
  ])('a response with %s throws rather than reading as gone', async (_label, response) => {
    mockSend.mockResolvedValue(response);
    await expect(
      provider.isSameResource(I_A, { physicalId: I_B }, INSTANCE, CTX)
    ).rejects.toThrow();
  });

  it('a client in another region is unknown, with no read', async () => {
    clientRegion.value = 'eu-west-1';
    instances({ [I_A]: 'running', [I_B]: 'running' });
    expect(await provider.isSameResource(I_A, { physicalId: I_B }, INSTANCE, CTX)).toBe('unknown');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each([
    ['a journaled id', 'i-ZZZ', I_B],
    ['a record id', I_A, 'arn:aws:ec2:us-east-1:123456789012:instance/i-0bbbbbbbbbbbbbbb2'],
    ['an empty journaled id', '', I_B],
    ['a NAT-shaped id', 'nat-0aaaaaaaaaaaaaaa1', I_B],
  ])('%s that is not an instance id is unknown, with no read', async (_label, journaled, rec) => {
    instances({ [I_A]: 'running', [I_B]: 'running' });
    expect(await provider.isSameResource(journaled, { physicalId: rec }, INSTANCE, CTX)).toBe(
      'unknown'
    );
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('EC2Provider.delete of a journaled EC2 instance already gone (go-to-k/cdkd#4606)', () => {
  it('names it once at info, since the settle then exits 0', async () => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof TerminateInstancesCommand) {
        throw awsError('InvalidInstanceID.NotFound', `The instance ID '${I_A}' does not exist`);
      }
      throw new Error('unexpected command');
    });
    await provider.delete('Orphan', I_A, INSTANCE, {}, {
      expectedRegion: 'us-east-1',
      failedCreateOrphan: true,
    });
    const infos = providerLogger.info.mock.calls.map(([m]) => String(m));
    expect(infos).toHaveLength(1);
    expect(infos[0]).toContain(I_A);
    expect(infos[0]).toContain('already gone');

    // A record's own delete keeps the quiet debug line.
    providerLogger.info.mockClear();
    await provider.delete('Orphan', I_A, INSTANCE, {}, { expectedRegion: 'us-east-1' });
    expect(providerLogger.info).not.toHaveBeenCalled();
  });
});
