import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#4606: the live identity read a successful deploy asks before
// deleting a fix-forward's earlier VPC, subnet or security group. Only
// `'different'` lets it delete.

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

import {
  DeleteSecurityGroupCommand,
  DeleteSubnetCommand,
  DeleteVpcCommand,
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
} from '@aws-sdk/client-ec2';
import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';

const CTX = { expectedRegion: 'us-east-1' };

const awsError = (name: string, message = name): Error => Object.assign(new Error(message), { name });

/** No state: a security group is live whenever EC2 lists it. */
const STATELESS = '<stateless>';

interface TypeCase {
  readonly type: string;
  readonly a: string;
  readonly b: string;
  /** The `Describe*` command class and how to read the one id it asks for. */
  readonly describe: new (...args: never[]) => object;
  readonly askedId: (cmd: object) => unknown;
  /** The `Describe*` response listing one resource. */
  readonly listing: (id: string | undefined, state: string | undefined) => object;
  readonly empty: object;
  readonly notFound: string;
  readonly malformed: string;
  readonly liveStates: readonly string[];
  /** Listed, but not live: as a record that proves nothing. */
  readonly goneStates: readonly string[];
  /** The delete command and its not-found answer. */
  readonly del: new (...args: never[]) => object;
  readonly label: string;
}

const TYPES: readonly TypeCase[] = [
  {
    type: 'AWS::EC2::VPC',
    a: 'vpc-0aaaaaaaaaaaaaaa1',
    b: 'vpc-0bbbbbbbbbbbbbbb2',
    describe: DescribeVpcsCommand,
    askedId: (cmd) => (cmd as DescribeVpcsCommand).input.VpcIds,
    listing: (id, state) => ({ Vpcs: [{ VpcId: id, State: state }] }),
    empty: { Vpcs: [] },
    notFound: 'InvalidVpcID.NotFound',
    malformed: 'InvalidVpcID.Malformed',
    liveStates: ['pending', 'available'],
    goneStates: ['deleting'],
    del: DeleteVpcCommand,
    label: 'VPC',
  },
  {
    type: 'AWS::EC2::Subnet',
    a: 'subnet-0aaaaaaaaaaaaaaa1',
    b: 'subnet-0bbbbbbbbbbbbbbb2',
    describe: DescribeSubnetsCommand,
    askedId: (cmd) => (cmd as DescribeSubnetsCommand).input.SubnetIds,
    listing: (id, state) => ({ Subnets: [{ SubnetId: id, State: state }] }),
    empty: { Subnets: [] },
    notFound: 'InvalidSubnetID.NotFound',
    malformed: 'InvalidSubnetID.Malformed',
    liveStates: ['pending', 'available'],
    goneStates: ['failed', 'failed-insufficient-capacity', 'unavailable'],
    del: DeleteSubnetCommand,
    label: 'Subnet',
  },
  {
    type: 'AWS::EC2::SecurityGroup',
    a: 'sg-0aaaaaaaaaaaaaaa1',
    b: 'sg-0bbbbbbbbbbbbbbb2',
    describe: DescribeSecurityGroupsCommand,
    askedId: (cmd) => (cmd as DescribeSecurityGroupsCommand).input.GroupIds,
    listing: (id) => ({ SecurityGroups: [{ GroupId: id }] }),
    empty: { SecurityGroups: [] },
    notFound: 'InvalidGroup.NotFound',
    malformed: 'InvalidGroupId.Malformed',
    liveStates: [STATELESS],
    goneStates: [],
    del: DeleteSecurityGroupCommand,
    label: 'Security group',
  },
];

/**
 * The type's `Describe*` answers per id: its state (or `STATELESS`), gone,
 * or an error. The ids are labels only; the live probe in the `ec2-instance`
 * integ measures which never-existed id shape real EC2 answers NotFound.
 */
function live(t: TypeCase, entries: Record<string, string | 'gone' | Error>): void {
  mockSend.mockImplementation(async (cmd: object) => {
    if (!(cmd instanceof t.describe)) throw new Error('unexpected command');
    const id = (t.askedId(cmd) as string[])[0]!;
    const entry = entries[id];
    if (entry === undefined || entry === 'gone') throw awsError(t.notFound);
    if (entry instanceof Error) throw entry;
    return t.listing(id, entry === STATELESS ? undefined : entry);
  });
}

const readIds = (t: TypeCase): unknown[] => mockSend.mock.calls.map(([c]) => t.askedId(c as object));

const live1 = (t: TypeCase): string => t.liveStates[t.liveStates.length - 1]!;

let provider: EC2Provider;

beforeEach(() => {
  vi.clearAllMocks();
  clientRegion.value = 'us-east-1';
  provider = new EC2Provider();
});

describe.each(TYPES)('EC2Provider.isSameResource for $type (go-to-k/cdkd#4606)', (t) => {
  it('another live resource is different, after reading the record first, then the journaled one', async () => {
    live(t, { [t.a]: live1(t), [t.b]: live1(t) });
    expect(await provider.isSameResource(t.a, { physicalId: t.b }, t.type, CTX)).toBe(
      'different'
    );
    expect(readIds(t)).toEqual([[t.b], [t.a]]);
  });

  it.each([...t.liveStates, ...t.goneStates, 'gone'])(
    'a journaled resource %s is different once the record reads back live',
    async (journaled) => {
      live(t, { [t.a]: journaled, [t.b]: live1(t) });
      expect(await provider.isSameResource(t.a, { physicalId: t.b }, t.type, CTX)).toBe(
        'different'
      );
    }
  );

  it.each(t.liveStates)('a record resource %s counts as live', async (recorded) => {
    live(t, { [t.a]: live1(t), [t.b]: recorded });
    expect(await provider.isSameResource(t.a, { physicalId: t.b }, t.type, CTX)).toBe(
      'different'
    );
  });

  it.each([...t.goneStates, 'gone'])(
    'the record resource %s is unknown, not different, and the journaled one is not read',
    async (recorded) => {
      live(t, { [t.a]: live1(t), [t.b]: recorded });
      expect(await provider.isSameResource(t.a, { physicalId: t.b }, t.type, CTX)).toBe('unknown');
      expect(readIds(t)).toEqual([[t.b]]);
    }
  );

  it('equal ids are the same without a read', async () => {
    live(t, {});
    expect(await provider.isSameResource(t.a, { physicalId: t.a }, t.type, CTX)).toBe('same');
    expect(mockSend).not.toHaveBeenCalled();
  });

  // Defensive: EC2 cannot answer one id with another; the branch exists so a
  // read naming the record's resource never reads as 'different'.
  it('a journaled id reading back as the record resource is the same', async () => {
    mockSend.mockResolvedValue(t.listing(t.b, live1(t) === STATELESS ? undefined : live1(t)));
    expect(await provider.isSameResource(t.a, { physicalId: t.b }, t.type, CTX)).toBe('same');
  });

  it.each([
    ['an access denial', awsError('UnauthorizedOperation', 'denied')],
    ['a malformed-id error', awsError(t.malformed)],
    ['another resource kind not-found', awsError('InvalidInstanceID.NotFound')],
  ])('%s on the journaled read throws (the caller reads it as unknown)', async (_label, error) => {
    live(t, { [t.a]: error, [t.b]: live1(t) });
    await expect(provider.isSameResource(t.a, { physicalId: t.b }, t.type, CTX)).rejects.toThrow(
      error.message
    );
  });

  it('a malformed-id error on the record read throws, never reading as gone', async () => {
    live(t, { [t.a]: live1(t), [t.b]: awsError(t.malformed) });
    await expect(provider.isSameResource(t.a, { physicalId: t.b }, t.type, CTX)).rejects.toThrow(
      t.malformed
    );
  });

  it.each([
    ['no resource', () => t.empty],
    ['no list at all', () => ({})],
    [
      'two resources',
      () => {
        const one = t.listing(t.b, live1(t) === STATELESS ? undefined : live1(t)) as Record<
          string,
          unknown[]
        >;
        const key = Object.keys(one)[0]!;
        return { [key]: [...one[key]!, ...one[key]!] };
      },
    ],
    ['a resource with no id', () => t.listing(undefined, live1(t) === STATELESS ? undefined : live1(t))],
  ])('a response with %s throws rather than reading as gone', async (_label, response) => {
    mockSend.mockResolvedValue(response());
    await expect(provider.isSameResource(t.a, { physicalId: t.b }, t.type, CTX)).rejects.toThrow();
  });

  it.runIf(!t.liveStates.includes(STATELESS))(
    'a resource in no known state throws, as the record or the journaled one',
    async () => {
      live(t, { [t.a]: live1(t), [t.b]: 'some-new-state' });
      await expect(
        provider.isSameResource(t.a, { physicalId: t.b }, t.type, CTX)
      ).rejects.toThrow('no known state');
      live(t, { [t.a]: 'some-new-state', [t.b]: live1(t) });
      await expect(
        provider.isSameResource(t.a, { physicalId: t.b }, t.type, CTX)
      ).rejects.toThrow('no known state');
    }
  );

  it('a client in another region is unknown, with no read', async () => {
    clientRegion.value = 'eu-west-1';
    live(t, { [t.a]: live1(t), [t.b]: live1(t) });
    expect(await provider.isSameResource(t.a, { physicalId: t.b }, t.type, CTX)).toBe('unknown');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each([
    ['a journaled id with upper-case hex', t.a.replace(/[0-9a-f]+$/, (h) => h.toUpperCase()), t.b],
    ['an empty journaled id', '', t.b],
    ['a record id as an ARN', t.a, `arn:aws:ec2:us-east-1:123456789012:resource/${t.b}`],
    ['a journaled id of another EC2 type', 'i-0aaaaaaaaaaaaaaa1', t.b],
    ['a record id with a trailing segment', t.a, `${t.b}|x`],
  ])('%s is unknown, with no read', async (_label, journaled, rec) => {
    live(t, { [t.a]: live1(t), [t.b]: live1(t) });
    expect(await provider.isSameResource(journaled, { physicalId: rec }, t.type, CTX)).toBe(
      'unknown'
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("another network type's id is unknown, with no read", async () => {
    for (const other of TYPES.filter((x) => x.type !== t.type)) {
      expect(await provider.isSameResource(other.a, { physicalId: other.b }, t.type, CTX)).toBe(
        'unknown'
      );
    }
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe.each(TYPES)('EC2Provider.delete of a journaled $type already gone (go-to-k/cdkd#4606)', (t) => {
  it('names it once at info, since the settle then exits 0', async () => {
    mockSend.mockImplementation(async (cmd: object) => {
      if (cmd instanceof t.del) throw awsError(t.notFound, `The id '${t.a}' does not exist`);
      throw new Error('unexpected command');
    });
    await provider.delete('Orphan', t.a, t.type, {}, {
      expectedRegion: 'us-east-1',
      failedCreateOrphan: true,
    });
    const infos = providerLogger.info.mock.calls.map(([m]) => String(m));
    expect(infos).toHaveLength(1);
    expect(infos[0]).toContain(`${t.label} ${t.a} (Orphan)`);
    expect(infos[0]).toContain('already gone');

    // A record's own delete keeps the quiet debug line.
    providerLogger.info.mockClear();
    await provider.delete('Orphan', t.a, t.type, {}, { expectedRegion: 'us-east-1' });
    expect(providerLogger.info).not.toHaveBeenCalled();
  });

  it('a live orphan is deleted by its id, with no already-gone line', async () => {
    mockSend.mockResolvedValue({});
    await provider.delete('Orphan', t.a, t.type, {}, {
      expectedRegion: 'us-east-1',
      failedCreateOrphan: true,
    });
    const deletes = mockSend.mock.calls.filter(([c]) => c instanceof t.del);
    expect(deletes).toHaveLength(1);
    expect(JSON.stringify((deletes[0]![0] as { input: unknown }).input)).toContain(t.a);
    expect(providerLogger.info).not.toHaveBeenCalled();
  });
});
