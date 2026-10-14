import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#4606: the live identity read a successful deploy asks before
// deleting a fix-forward's earlier IAM instance profile or managed policy
// (only `'different'` lets it delete), and the `InstanceProfileId` /
// `PolicyId` a failed CREATE journals beside the orphan's physical id for the
// settle to compare, so one re-created under the name is never deleted as the
// orphan.

const mockSend = vi.hoisted(() => vi.fn());
const clientRegion = vi.hoisted(() => ({ value: 'us-east-1' }));
const providerLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ ...providerLogger, child: () => providerLogger }),
}));

// Not an `IAMClient`, so `IamCreateClientCache` sends CreateInstanceProfile /
// CreatePolicy through this same double.
const sharedClient = vi.hoisted(() => ({
  send: mockSend,
  config: { region: () => Promise.resolve(clientRegion.value) },
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ iam: sharedClient }),
}));

import {
  AddRoleToInstanceProfileCommand,
  AttachGroupPolicyCommand,
  AttachRolePolicyCommand,
  CreateInstanceProfileCommand,
  CreatePolicyCommand,
  DeleteInstanceProfileCommand,
  DeletePolicyCommand,
  DetachGroupPolicyCommand,
  EntityAlreadyExistsException,
  GetInstanceProfileCommand,
  GetPolicyCommand,
  ListEntitiesForPolicyCommand,
  ListPolicyVersionsCommand,
  NoSuchEntityException,
} from '@aws-sdk/client-iam';
import { IAMInstanceProfileProvider } from '../../../src/provisioning/providers/iam-instance-profile-provider.js';
import { IAMManagedPolicyProvider } from '../../../src/provisioning/providers/iam-managed-policy-provider.js';
import {
  createdBeforeFailure,
  createdResourceIdentityBeforeFailure,
} from '../../../src/provisioning/auxiliary-failure.js';
import { withRetry } from '../../../src/deployment/retry.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import { settleJournaledOrphansOnSuccess } from '../../../src/deployment/rollback-executor/journaled-orphans.js';
import type { RollbackExecutorContext } from '../../../src/deployment/rollback-executor.js';
import { withPrintingSecrets } from '../../../src/deployment/resource-secrets-scope.js';
import { recordLogOnlyValue, SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import { currentLogLineMasker } from '../../../src/utils/log-line-masker.js';

const CTX = { expectedRegion: 'us-east-1' };
const ACCOUNT = '123456789012';
const policyArn = (name: string, path = '/'): string =>
  `arn:aws:iam::${ACCOUNT}:policy${path}${name}`;

type Provider = IAMInstanceProfileProvider | IAMManagedPolicyProvider;

/** Everything a case needs to drive one of the two types the same way. */
interface Kind {
  type: 'AWS::IAM::InstanceProfile' | 'AWS::IAM::ManagedPolicy';
  noun: 'instance profile' | 'managed policy';
  idField: 'InstanceProfileId' | 'PolicyId';
  make: () => Provider;
  /** The physical id this provider records for the name `name`. */
  pid: (name: string) => string;
  ID_A: string;
  ID_A2: string;
  ID_B: string;
  /** The read command `isSameResource` / `resourceIdentity` send. */
  isRead: (cmd: unknown) => boolean;
  /** The physical id the read asked for. */
  asked: (cmd: unknown) => string | undefined;
  /** A successful read answering physical id `pid` with `id` (`undefined` = no id). */
  answer: (pid: string, id: string | undefined) => unknown;
  /** A successful read answering `pid` with an EMPTY id field. */
  answerEmptyId: (pid: string) => unknown;
  /** The input the read sends for `pid`. */
  readInput: (pid: string) => unknown;
  isCreate: (cmd: unknown) => boolean;
  created: (name: string, id: string | undefined) => unknown;
  /** A wiring call that succeeds before the failing one (none for a profile). */
  isWireOk: (cmd: unknown) => boolean;
  /** The wiring call denied. */
  isFailingWire: (cmd: unknown) => boolean;
  isDelete: (cmd: unknown) => boolean;
  /** Cleanup calls that answer harmlessly. */
  cleanupAnswer: (cmd: unknown) => unknown;
  props: Record<string, unknown>;
  /** Ids this provider never records, each refused with no read. */
  refused: Array<[string, string]>;
}

const PROFILE: Kind = {
  type: 'AWS::IAM::InstanceProfile',
  noun: 'instance profile',
  idField: 'InstanceProfileId',
  make: () => new IAMInstanceProfileProvider(),
  pid: (name) => name,
  ID_A: 'AIPAAAAAAAAAAAAAAAAA1',
  ID_A2: 'AIPAAAAAAAAAAAAAAAAA2',
  ID_B: 'AIPABBBBBBBBBBBBBBBB1',
  isRead: (c) => c instanceof GetInstanceProfileCommand,
  asked: (c) => (c instanceof GetInstanceProfileCommand ? c.input.InstanceProfileName : undefined),
  answer: (pid, id) => ({
    InstanceProfile: {
      InstanceProfileName: pid,
      Arn: `arn:aws:iam::${ACCOUNT}:instance-profile/${pid}`,
      Path: '/',
      Roles: [],
      ...(id && { InstanceProfileId: id }),
    },
  }),
  answerEmptyId: (pid) => ({
    InstanceProfile: { InstanceProfileName: pid, InstanceProfileId: '', Roles: [] },
  }),
  readInput: (pid) => ({ InstanceProfileName: pid }),
  isCreate: (c) => c instanceof CreateInstanceProfileCommand,
  created: (name, id) => ({
    InstanceProfile: {
      InstanceProfileName: name,
      Arn: `arn:aws:iam::${ACCOUNT}:instance-profile/${name}`,
      InstanceProfileId: id,
      Roles: [],
    },
  }),
  isWireOk: () => false,
  isFailingWire: (c) => c instanceof AddRoleToInstanceProfileCommand,
  isDelete: (c) => c instanceof DeleteInstanceProfileCommand,
  cleanupAnswer: () => undefined,
  props: { InstanceProfileName: 'name-a', Roles: ['role-x'] },
  refused: [
    ['an ARN', `arn:aws:iam::${ACCOUNT}:instance-profile/name-a`],
    ['a path-qualified name', 'svc/name-a'],
    ['an empty id', ''],
    ['a name one character too long', 'n'.repeat(129)],
    ['a name with a space', 'name a'],
  ],
};

const POLICY: Kind = {
  type: 'AWS::IAM::ManagedPolicy',
  noun: 'managed policy',
  idField: 'PolicyId',
  make: () => new IAMManagedPolicyProvider(),
  pid: (name) => policyArn(name),
  ID_A: 'ANPAAAAAAAAAAAAAAAAA1',
  ID_A2: 'ANPAAAAAAAAAAAAAAAAA2',
  ID_B: 'ANPABBBBBBBBBBBBBBBB1',
  isRead: (c) => c instanceof GetPolicyCommand,
  asked: (c) => (c instanceof GetPolicyCommand ? c.input.PolicyArn : undefined),
  answer: (pid, id) => ({
    Policy: {
      PolicyName: pid.slice(pid.lastIndexOf('/') + 1),
      Arn: pid,
      DefaultVersionId: 'v1',
      ...(id && { PolicyId: id }),
    },
  }),
  answerEmptyId: (pid) => ({ Policy: { Arn: pid, PolicyId: '' } }),
  readInput: (pid) => ({ PolicyArn: pid }),
  isCreate: (c) => c instanceof CreatePolicyCommand,
  created: (name, id) => ({
    Policy: { PolicyName: name, Arn: policyArn(name), PolicyId: id, DefaultVersionId: 'v1' },
  }),
  isWireOk: (c) => c instanceof AttachGroupPolicyCommand,
  isFailingWire: (c) => c instanceof AttachRolePolicyCommand,
  isDelete: (c) => c instanceof DeletePolicyCommand,
  cleanupAnswer: (c) => {
    if (c instanceof ListEntitiesForPolicyCommand) {
      return { PolicyGroups: [{ GroupName: 'group-x' }], PolicyRoles: [], PolicyUsers: [] };
    }
    if (c instanceof DetachGroupPolicyCommand) return {};
    if (c instanceof ListPolicyVersionsCommand) {
      return { Versions: [{ VersionId: 'v1', IsDefaultVersion: true }] };
    }
    return undefined;
  },
  props: {
    ManagedPolicyName: 'name-a',
    PolicyDocument: { Version: '2012-10-17', Statement: [] },
    Groups: ['group-x'],
    Roles: ['role-x'],
  },
  refused: [
    ['a bare policy name', 'name-a'],
    ['an AWS-managed policy ARN', 'arn:aws:iam::aws:policy/ReadOnlyAccess'],
    ['a role ARN', `arn:aws:iam::${ACCOUNT}:role/name-a`],
    ['an ARN with no account', 'arn:aws:iam:::policy/name-a'],
    ['an empty id', ''],
    ['a name one character too long', policyArn('n'.repeat(129))],
    ['a name with a space', policyArn('name a')],
    ['a path missing its trailing slash', `arn:aws:iam::${ACCOUNT}:policyname-a`],
  ],
};

const KINDS = [PROFILE, POLICY] as const;

const notFound = (id: string): Error =>
  new NoSuchEntityException({
    message: `The entity ${id} cannot be found.`,
    $metadata: {},
  });

const denied = (op: string): Error =>
  Object.assign(new Error(`User is not authorized to perform: iam:${op}`), {
    name: 'AccessDenied',
  });

/**
 * One physical id's read answer: its id, gone, an error, a response naming
 * another resource, or one naming no id.
 */
type Entry = string | 'gone' | Error | { answeredAs: string } | 'no-id' | 'empty-id';

/** The kind's read answers per physical id, exactly as asked. */
function live(kind: Kind, entries: Record<string, Entry>): void {
  mockSend.mockImplementation(async (cmd: unknown) => {
    if (!kind.isRead(cmd)) throw new Error('unexpected command');
    const asked = kind.asked(cmd)!;
    const entry = entries[asked];
    if (entry === undefined || entry === 'gone') throw notFound(asked);
    if (entry instanceof Error) throw entry;
    if (entry === 'no-id') return kind.answer(asked, undefined);
    if (entry === 'empty-id') return kind.answerEmptyId(asked);
    if (typeof entry === 'object') return kind.answer(entry.answeredAs, kind.ID_B);
    return kind.answer(asked, entry);
  });
}

const askedIds = (kind: Kind): Array<string | undefined> =>
  mockSend.mock.calls.map(([cmd]) => (kind.isRead(cmd) ? kind.asked(cmd) : `<${String(cmd)}>`));

describe.each(KINDS)('isSameResource, $type (go-to-k/cdkd#4606)', (K) => {
  let provider: Provider;
  const A = K.pid('name-a');
  const B = K.pid('name-b');

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    clientRegion.value = 'us-east-1';
    provider = K.make();
  });

  it('another live resource under another name is different', async () => {
    live(K, { [A]: K.ID_A, [B]: K.ID_B });
    await expect(provider.isSameResource(A, { physicalId: B }, K.type, CTX)).resolves.toBe(
      'different'
    );
    // The record's resource is read first: it must exist for any verdict.
    expect(askedIds(K)).toEqual([B, A]);
    const [[sent]] = mockSend.mock.calls as Array<[{ input: unknown }]>;
    expect(sent.input).toEqual(K.readInput(B));
  });

  it('a journaled resource IAM reports gone is different once the record reads back', async () => {
    live(K, { [B]: K.ID_B });
    await expect(provider.isSameResource(A, { physicalId: B }, K.type, CTX)).resolves.toBe(
      'different'
    );
  });

  it('two ids reading back under one identity are the same (the verdict rests on AWS)', async () => {
    live(K, { [A]: K.ID_B, [B]: K.ID_B });
    await expect(provider.isSameResource(A, { physicalId: B }, K.type, CTX)).resolves.toBe('same');
  });

  it("the record's resource gone is unknown, not different, whatever the journaled one reads", async () => {
    for (const journaled of [K.ID_A, 'gone'] as const) {
      mockSend.mockReset();
      live(K, { [A]: journaled });
      await expect(provider.isSameResource(A, { physicalId: B }, K.type, CTX)).resolves.toBe(
        'unknown'
      );
      expect(askedIds(K)).toEqual([B]);
    }
  });

  it('equal ids are the same without a read, even from a client in another region', async () => {
    clientRegion.value = 'eu-west-1';
    await expect(provider.isSameResource(A, { physicalId: A }, K.type, CTX)).resolves.toBe('same');
    expect(mockSend).not.toHaveBeenCalled();
  });

  // IAM instance profile and policy names are unique regardless of case:
  // `Name-A` and `name-a` would be one resource, and this check does not
  // decide on IAM's case rules.
  it('names differing only in case are unknown, with no read', async () => {
    await expect(
      provider.isSameResource(K.pid('Name-A'), { physicalId: A }, K.type, CTX)
    ).resolves.toBe('unknown');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('a read failing other than with NoSuchEntityException throws (the caller reads it as unknown)', async () => {
    live(K, { [A]: denied('Get'), [B]: K.ID_B });
    await expect(provider.isSameResource(A, { physicalId: B }, K.type, CTX)).rejects.toThrow(
      /not authorized/
    );
  });

  it("the record's read failing throws before the journaled one is read", async () => {
    live(K, { [A]: K.ID_A, [B]: denied('Get') });
    await expect(provider.isSameResource(A, { physicalId: B }, K.type, CTX)).rejects.toThrow(
      /not authorized/
    );
    expect(askedIds(K)).toEqual([B]);
  });

  it('"cannot be found" in the message of another error class never reads as gone', async () => {
    const lookalike = Object.assign(new Error('The entity name-a cannot be found.'), {
      name: 'ServiceFailure',
    });
    live(K, { [A]: lookalike, [B]: K.ID_B });
    await expect(provider.isSameResource(A, { physicalId: B }, K.type, CTX)).rejects.toThrow(
      /cannot be found/
    );
  });

  it('a response naming another resource, or no id, throws rather than comparing it', async () => {
    live(K, { [A]: { answeredAs: K.pid('name-x') }, [B]: K.ID_B });
    await expect(provider.isSameResource(A, { physicalId: B }, K.type, CTX)).rejects.toThrow(
      new RegExp(`another ${K.noun}`)
    );
    for (const [journaled, recorded] of [
      ['no-id', K.ID_B],
      [K.ID_A, 'no-id'],
      ['empty-id', K.ID_B],
    ] as const) {
      mockSend.mockReset();
      live(K, { [A]: journaled, [B]: recorded });
      await expect(provider.isSameResource(A, { physicalId: B }, K.type, CTX)).rejects.toThrow(
        new RegExp(`no ${K.idField}`)
      );
    }
  });

  it('a client in another region is unknown, with no read', async () => {
    clientRegion.value = 'eu-west-1';
    live(K, { [A]: K.ID_A, [B]: K.ID_B });
    await expect(provider.isSameResource(A, { physicalId: B }, K.type, CTX)).resolves.toBe(
      'unknown'
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each(K.refused)('%s on either side is unknown, with no read', async (_label, id) => {
    await expect(provider.isSameResource(id, { physicalId: B }, K.type, CTX)).resolves.toBe(
      'unknown'
    );
    await expect(provider.isSameResource(A, { physicalId: id }, K.type, CTX)).resolves.toBe(
      'unknown'
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each(['AWS::IAM::Role', 'AWS::IAM::User', 'AWS::IAM::Policy'])(
    'another type (%s) is unknown, with no read',
    async (other) => {
      await expect(provider.isSameResource(A, { physicalId: B }, other, CTX)).resolves.toBe(
        'unknown'
      );
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it('the longest legal name, and one using every legal character class, are read', async () => {
    const longest = K.pid('n'.repeat(128));
    const every = K.pid('Ab9+=,.@_-');
    live(K, { [longest]: K.ID_A, [every]: K.ID_B });
    await expect(provider.isSameResource(longest, { physicalId: every }, K.type, CTX)).resolves.toBe(
      'different'
    );
    expect(askedIds(K)).toEqual([every, longest]);
  });
});

describe('IAMManagedPolicyProvider.isSameResource, ARN shape (go-to-k/cdkd#4606)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    clientRegion.value = 'us-east-1';
  });

  it('path-qualified ARNs of two names are read as written', async () => {
    const a = policyArn('name-a', '/svc/team/');
    const b = policyArn('name-b', '/');
    live(POLICY, { [a]: POLICY.ID_A, [b]: POLICY.ID_B });
    await expect(
      new IAMManagedPolicyProvider().isSameResource(a, { physicalId: b }, POLICY.type, CTX)
    ).resolves.toBe('different');
    expect(askedIds(POLICY)).toEqual([b, a]);
  });

  it('an ARN in another partition is read, its own partition on both sides', async () => {
    const a = `arn:aws-us-gov:iam::${ACCOUNT}:policy/name-a`;
    const b = `arn:aws-us-gov:iam::${ACCOUNT}:policy/name-b`;
    live(POLICY, { [a]: POLICY.ID_A, [b]: POLICY.ID_B });
    await expect(
      new IAMManagedPolicyProvider().isSameResource(a, { physicalId: b }, POLICY.type, CTX)
    ).resolves.toBe('different');
  });

  // A policy name is unique per account whatever its path: one name under two
  // paths is never compared.
  it.each([
    ['the same name under another path', policyArn('name-a', '/svc/'), policyArn('name-a')],
    ['the name in another case under another path', policyArn('NAME-A', '/svc/'), policyArn('name-a')],
    ['another account', `arn:aws:iam::210987654321:policy/name-a`, policyArn('name-b')],
    ['another partition', `arn:aws-cn:iam::${ACCOUNT}:policy/name-a`, policyArn('name-b')],
  ])('%s is unknown, with no read', async (_label, journaled, recorded) => {
    live(POLICY, { [journaled]: POLICY.ID_A, [recorded]: POLICY.ID_B });
    await expect(
      new IAMManagedPolicyProvider().isSameResource(
        journaled,
        { physicalId: recorded },
        POLICY.type,
        CTX
      )
    ).resolves.toBe('unknown');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('a response naming the ARN in another case is another policy, and throws', async () => {
    const a = policyArn('name-a');
    const b = policyArn('name-b');
    live(POLICY, { [a]: { answeredAs: policyArn('Name-A') }, [b]: POLICY.ID_B });
    await expect(
      new IAMManagedPolicyProvider().isSameResource(a, { physicalId: b }, POLICY.type, CTX)
    ).rejects.toThrow(/another managed policy/);
  });
});

describe.each(KINDS)('resourceIdentity, $type (go-to-k/cdkd#4606)', (K) => {
  let provider: Provider;
  const A = K.pid('name-a');

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    clientRegion.value = 'us-east-1';
    provider = K.make();
  });

  it('is the live id, read under the physical id as written', async () => {
    live(K, { [A]: K.ID_A });
    await expect(provider.resourceIdentity(A, K.type, CTX)).resolves.toBe(K.ID_A);
    expect(askedIds(K)).toEqual([A]);
    const [[sent]] = mockSend.mock.calls as Array<[{ input: unknown }]>;
    expect(sent.input).toEqual(K.readInput(A));
  });

  it('one re-created under the name (another id) reads another token', async () => {
    live(K, { [A]: K.ID_A2 });
    const token = await provider.resourceIdentity(A, K.type, CTX);
    expect(token).toBe(K.ID_A2);
    expect(token).not.toBe(K.ID_A);
  });

  it('is RESOURCE_NOT_FOUND on NoSuchEntityException', async () => {
    live(K, {});
    await expect(provider.resourceIdentity(A, K.type, CTX)).resolves.toBe(RESOURCE_NOT_FOUND);
  });

  it('throws on any other failure, "cannot be found" in the message included (never gone)', async () => {
    live(K, { [A]: denied('Get') });
    await expect(provider.resourceIdentity(A, K.type, CTX)).rejects.toThrow(/not authorized/);
    mockSend.mockReset();
    live(K, {
      [A]: Object.assign(new Error('The entity cannot be found.'), { name: 'ServiceFailure' }),
    });
    await expect(provider.resourceIdentity(A, K.type, CTX)).rejects.toThrow(/cannot be found/);
  });

  it('throws on a response naming no id, an empty one, or another resource', async () => {
    for (const entry of ['no-id', 'empty-id'] as const) {
      mockSend.mockReset();
      live(K, { [A]: entry });
      await expect(provider.resourceIdentity(A, K.type, CTX)).rejects.toThrow(
        new RegExp(`no ${K.idField}`)
      );
    }
    mockSend.mockReset();
    live(K, { [A]: { answeredAs: K.pid('Name-A') } });
    await expect(provider.resourceIdentity(A, K.type, CTX)).rejects.toThrow(
      new RegExp(`another ${K.noun}`)
    );
  });

  it('is undefined, with no read, for a client in another region', async () => {
    clientRegion.value = 'eu-west-1';
    live(K, { [A]: K.ID_A });
    await expect(provider.resourceIdentity(A, K.type, CTX)).resolves.toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('is undefined, with no read, for an id it never records, or another type', async () => {
    live(K, { [A]: K.ID_A });
    for (const [, id] of K.refused) {
      await expect(provider.resourceIdentity(id, K.type, CTX)).resolves.toBeUndefined();
    }
    await expect(provider.resourceIdentity(A, 'AWS::IAM::Role', CTX)).resolves.toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe.each(KINDS)(
  "the created-before-failure mark carries the create response's id, $type (go-to-k/cdkd#4606)",
  (K) => {
    beforeEach(() => {
      vi.clearAllMocks();
      mockSend.mockReset();
      clientRegion.value = 'us-east-1';
    });

    /**
     * The create answers `id` on the first call (a later one
     * EntityAlreadyExists); a policy's group attach succeeds, the role
     * attach (a policy's) or role add (a profile's) is denied, and so is the
     * cleanup's final delete unless `cleanupSucceeds`.
     */
    function aws(opts: { id: string | undefined; cleanupSucceeds?: boolean }): void {
      let creates = 0;
      mockSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
        if (K.isCreate(cmd)) {
          if (creates++ > 0) {
            throw new EntityAlreadyExistsException({
              message: `${K.noun} name-a already exists.`,
              $metadata: {},
            });
          }
          return K.created('name-a', opts.id);
        }
        if (K.isWireOk(cmd)) return {};
        if (K.isFailingWire(cmd)) throw denied('Attach');
        if (K.isDelete(cmd)) {
          if (opts.cleanupSucceeds === true) return {};
          throw denied('Delete');
        }
        const answer = K.cleanupAnswer(cmd);
        if (answer !== undefined) return answer;
        throw new Error(`unexpected command ${cmd.constructor.name}`);
      });
    }

    const failureOf = async (p: Promise<unknown>): Promise<unknown> =>
      p.then(
        () => {
          throw new Error('the create succeeded');
        },
        (e: unknown) => e
      );

    it("a wiring failure whose cleanup fails marks the physical id and the create's id", async () => {
      aws({ id: K.ID_A });
      const error = await failureOf(K.make().create('Orphan', K.type, K.props));
      expect(createdBeforeFailure(error, 'Orphan', K.type)).toBe(K.pid('name-a'));
      // The create response's id, never a later read's (none is sent).
      expect(createdResourceIdentityBeforeFailure(error, 'Orphan', K.type)).toBe(K.ID_A);
      expect(mockSend.mock.calls.some(([c]) => K.isRead(c))).toBe(false);
      expect(mockSend.mock.calls.some(([c]) => K.isFailingWire(c))).toBe(true);
      expect(mockSend.mock.calls.some(([c]) => K.isDelete(c))).toBe(true);
      if (K === POLICY) {
        expect(mockSend.mock.calls.some(([c]) => K.isWireOk(c))).toBe(true);
      }
    });

    // The token the mark carries and the one `resourceIdentity` reads back
    // must be one spelling, or the settle never proves its own orphan.
    it('the marked token equals the live read of the same resource', async () => {
      aws({ id: K.ID_A });
      const provider = K.make();
      const error = await failureOf(provider.create('Orphan', K.type, K.props));
      mockSend.mockReset();
      live(K, { [K.pid('name-a')]: K.ID_A });
      await expect(provider.resourceIdentity(K.pid('name-a'), K.type, CTX)).resolves.toBe(
        createdResourceIdentityBeforeFailure(error, 'Orphan', K.type)
      );
    });

    // The retry the failure may trigger replays the create, which fails with
    // EntityAlreadyExists: the error finally thrown keeps the FIRST attempt's
    // mark, identity included.
    it("a replay failing with EntityAlreadyExists keeps the first attempt's id", async () => {
      aws({ id: K.ID_A });
      const provider = K.make();
      let attempts = 0;
      const error = await failureOf(
        withRetry(
          () => {
            attempts++;
            return provider.create('Orphan', K.type, K.props);
          },
          'Orphan',
          { sleep: async () => {}, maxRetries: 2, initialDelayMs: 1, maxDelayMs: 1 }
        )
      );
      expect(createdBeforeFailure(error, 'Orphan', K.type)).toBe(K.pid('name-a'));
      expect(createdResourceIdentityBeforeFailure(error, 'Orphan', K.type)).toBe(K.ID_A);
      expect(attempts).toBeGreaterThan(1);
    });

    it.each([
      ['no id', undefined],
      ['an empty id', ''],
    ])('a create response with %s marks the physical id alone', async (_label, id) => {
      aws({ id });
      const error = await failureOf(K.make().create('Orphan', K.type, K.props));
      expect(createdBeforeFailure(error, 'Orphan', K.type)).toBe(K.pid('name-a'));
      expect(createdResourceIdentityBeforeFailure(error, 'Orphan', K.type)).toBeUndefined();
    });

    it('a cleanup that deleted the resource marks nothing, identity included', async () => {
      aws({ id: K.ID_A, cleanupSucceeds: true });
      const error = await failureOf(K.make().create('Orphan', K.type, K.props));
      expect(createdBeforeFailure(error, 'Orphan', K.type)).toBeUndefined();
      expect(createdResourceIdentityBeforeFailure(error, 'Orphan', K.type)).toBeUndefined();
    });
  }
);

describe.each(KINDS)('delete of a journaled $type already gone (go-to-k/cdkd#4606)', (K) => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    clientRegion.value = 'us-east-1';
  });

  const skipDebugLines = (): number =>
    providerLogger.debug.mock.calls.filter(([m]) => String(m).includes('does not exist, skipping'))
      .length;

  // Each delete reads the resource first, and returns on its not-found.
  const goneEverywhere = (id: string): void => {
    mockSend.mockImplementation(async () => {
      throw notFound(id);
    });
  };

  it('names it once at info when IAM answers not found, since the settle then exits 0', async () => {
    const pid = K.pid('orphan-x');
    goneEverywhere(pid);
    const provider = K.make();
    await provider.delete('Orphan', pid, K.type, {}, {
      expectedRegion: 'us-east-1',
      failedCreateOrphan: true,
    });
    const infos = providerLogger.info.mock.calls.map(([m]) => String(m));
    expect(infos).toHaveLength(1);
    expect(infos[0]).toContain(`IAM ${K.noun} ${pid} (Orphan)`);
    expect(infos[0]).toContain('already gone');
    expect(skipDebugLines()).toBe(0);
    expect(mockSend.mock.calls.some(([c]) => K.isDelete(c))).toBe(false);

    // A record's own delete keeps the quiet debug line, the flag absent or false.
    for (const context of [
      { expectedRegion: 'us-east-1' },
      { expectedRegion: 'us-east-1', failedCreateOrphan: false },
    ]) {
      providerLogger.info.mockClear();
      providerLogger.debug.mockClear();
      await provider.delete('Orphan', pid, K.type, {}, context);
      expect(providerLogger.info).not.toHaveBeenCalled();
      expect(skipDebugLines()).toBe(1);
    }
  });

  it('the not-found arm still refuses a client in another region than the record', async () => {
    const pid = K.pid('orphan-x');
    goneEverywhere(pid);
    clientRegion.value = 'eu-west-1';
    await expect(
      K.make().delete('Orphan', pid, K.type, {}, {
        expectedRegion: 'us-east-1',
        failedCreateOrphan: true,
      })
    ).rejects.toThrow(/does not match stack state region us-east-1/);
    expect(providerLogger.info).not.toHaveBeenCalled();
  });

  // A resource that read back but was gone by the delete call (a concurrent
  // delete) is the same not-found arm, said once at info under the flag.
  it('a delete call answering not found after a successful read is the same arm', async () => {
    const pid = K.pid('orphan-x');
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (K.isRead(cmd)) return K.answer(pid, K.ID_A);
      if (K.isDelete(cmd)) throw notFound(pid);
      const answer = K.cleanupAnswer(cmd);
      if (answer !== undefined) return answer;
      throw new Error('unexpected command');
    });
    const provider = K.make();
    await provider.delete('Orphan', pid, K.type, {}, {
      expectedRegion: 'us-east-1',
      failedCreateOrphan: true,
    });
    const infos = providerLogger.info.mock.calls.map(([m]) => String(m));
    expect(infos).toHaveLength(1);
    expect(infos[0]).toContain(`IAM ${K.noun} ${pid} (Orphan)`);
    expect(infos[0]).toContain('already gone');
    expect(mockSend.mock.calls.some(([c]) => K.isDelete(c))).toBe(true);

    // Without the flag it is the quiet debug line; in another region, refused.
    providerLogger.info.mockClear();
    providerLogger.debug.mockClear();
    await provider.delete('Orphan', pid, K.type, {}, { expectedRegion: 'us-east-1' });
    expect(providerLogger.info).not.toHaveBeenCalled();
    expect(skipDebugLines()).toBe(1);
    clientRegion.value = 'eu-west-1';
    await expect(
      provider.delete('Orphan', pid, K.type, {}, { expectedRegion: 'us-east-1' })
    ).rejects.toThrow(/does not match stack state region us-east-1/);
  });

  // go-to-k/cdkd#3869: the settle, `cdkd rollback` and `cdkd destroy` bind a
  // printing bag holding a secret-derived name around this delete; the line
  // carries the physical id verbatim, so the logger's line masker removes it.
  it('the info line names a secret-derived name only where the bound printing bag masks it', async () => {
    const DERIVED = 'name-from-secret-x9';
    const pid = K.pid(DERIVED);
    goneEverywhere(pid);
    const bag = new Map<string, string>();
    recordLogOnlyValue(bag, DERIVED);
    let masked = '<not masked>';
    await withPrintingSecrets(bag, async () => {
      await K.make().delete('Orphan', pid, K.type, {}, {
        expectedRegion: 'us-east-1',
        failedCreateOrphan: true,
      });
      const mask = currentLogLineMasker();
      const line = String(providerLogger.info.mock.calls[0]?.[0]);
      expect(line).toContain(DERIVED);
      masked = mask === undefined ? '<no masker bound>' : mask(line);
    });
    expect(masked).not.toContain(DERIVED);
    expect(masked).toContain(SECRET_MASK);
    expect(masked).toContain('already gone');
  });
});

// The settle end to end with the real provider: the journaled orphan `name-a`
// carries its create response's id (ID_A).
describe.each(KINDS)('the success settle with the real provider, $type (go-to-k/cdkd#4606)', (K) => {
  const A = K.pid('name-a');
  const B = K.pid('name-b');

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    clientRegion.value = 'us-east-1';
  });

  /**
   * `fixForward`: the fix-forward's record under the orphan's logical id holds
   * `name-b` (this deploy's CREATE), read live as `recordEntry`.
   */
  async function settle(
    liveEntry: Entry,
    fixForward?: { recordEntry: Entry },
    opts: { journaledIdentity: boolean } = { journaledIdentity: true }
  ) {
    const provider = K.make();
    const del = vi.spyOn(provider, 'delete').mockResolvedValue(undefined);
    live(K, {
      [A]: liveEntry,
      ...(fixForward !== undefined && { [B]: fixForward.recordEntry }),
    });
    const journal = {
      journalVersion: 1,
      stackName: 'S',
      region: 'us-east-1',
      segments: [
        {
          timestamp: 1,
          reason: 'no-rollback-failure',
          initialDeploy: false,
          operations: [],
          failedOperations: [
            {
              logicalId: 'Orphan',
              changeType: 'CREATE',
              resourceType: K.type,
              physicalId: A,
              provisionedBy: 'sdk',
              physicalIdRecoveredFromError: true,
              deletionPolicy: 'Delete',
              ...(opts.journaledIdentity && { createdResourceIdentity: K.ID_A }),
              attemptedProperties: {},
            },
          ],
        },
      ],
    };
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const ctx = {
      providerRegistry: {
        getProviderFor: vi.fn(() => ({ provider, provisionedBy: 'sdk' })),
        getProvider: vi.fn(() => provider),
      },
      region: 'us-east-1',
      logger,
    } as unknown as RollbackExecutorContext;
    const backend = {
      loadRollbackJournal: vi.fn(async () => structuredClone(journal)),
      reduceRollbackJournalToFailedOperations: vi.fn().mockResolvedValue(1),
      markRollbackJournalSuperseded: vi.fn().mockResolvedValue(undefined),
      dropRollbackJournalFailedOperations: vi.fn().mockResolvedValue(1),
    };
    const out = await settleJournaledOrphansOnSuccess({
      stateBackend: backend as never,
      stackName: 'S',
      region: 'us-east-1',
      stateResources: (fixForward === undefined
        ? {}
        : {
            Orphan: {
              physicalId: B,
              resourceType: K.type,
              provisionedBy: 'sdk',
              properties: {},
              attributes: {},
            },
          }) as never,
      rollbackOrphans: undefined,
      newerOperations: (fixForward === undefined
        ? []
        : [{ logicalId: 'Orphan', changeType: 'CREATE', resourceType: K.type, physicalId: B }]) as never,
      foreignHolder: vi.fn(async () => undefined),
      ctx,
      logger: logger as never,
    });
    return {
      out,
      del,
      backend,
      warned: logger.warn.mock.calls.map((m) => String(m[0])).join('\n'),
      infos: logger.info.mock.calls.map((m) => String(m[0])).join('\n'),
    };
  }

  it('the fix-forward: deletes `name-a` when the record `name-b` reads back', async () => {
    const r = await settle(K.ID_A, { recordEntry: K.ID_B });
    expect(r.del).toHaveBeenCalledTimes(1);
    expect(r.del.mock.calls[0]?.[1]).toBe(A);
    expect(r.del.mock.calls[0]?.[2]).toBe(K.type);
    // The delete is told it acts on a failed CREATE's orphan (the info line
    // for one already gone rests on it).
    expect(r.del.mock.calls[0]?.[4]).toMatchObject({ failedCreateOrphan: true });
    expect(r.out.unaddressed).toBe(0);
    expect(r.out.keepJournal).toBe(false);
    expect(r.backend.reduceRollbackJournalToFailedOperations).not.toHaveBeenCalled();
    expect(r.backend.dropRollbackJournalFailedOperations).not.toHaveBeenCalled();
  });

  it('the fix-forward: keeps it when `name-a` was re-created (another id) before the settle', async () => {
    const r = await settle(K.ID_A2, { recordEntry: K.ID_B });
    expect(r.del).not.toHaveBeenCalled();
    expect(r.warned).toContain('the resource now under its physical id is another one');
    expect(r.out.unaddressed).toBe(1);
  });

  it('the fix-forward: an earlier resource already gone is named, not deleted, and settles', async () => {
    const r = await settle('gone', { recordEntry: K.ID_B });
    expect(r.del).not.toHaveBeenCalled();
    expect(r.out.unaddressed).toBe(0);
    expect(r.infos).toContain(`Orphan (${K.type})`);
    expect(r.infos).toContain('is already gone: nothing to delete');
    expect(r.warned).toBe('');
  });

  // A read that cannot answer never reads as `'different'` or gone: the
  // provider throws, the settle reads the throw as unproven, and the orphan is
  // kept with a warning (exit 2), no delete sent.
  it.each([
    ['a throttle', () => Object.assign(new Error('Rate exceeded'), { name: 'Throttling' })],
    ['AccessDenied', () => denied('Get')],
  ])('the fix-forward: keeps it when the identity read fails with %s', async (_label, failure) => {
    const r = await settle(failure(), { recordEntry: K.ID_B });
    expect(r.del).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalled();
    expect(mockSend.mock.calls.every(([cmd]) => K.isRead(cmd))).toBe(true);
    expect(r.out.unaddressed).toBe(1);
    expect(r.warned).toContain(`Orphan (${K.type})`);
    expect(r.infos).not.toContain('already gone');
  });

  it("the fix-forward: keeps it when the record's own read fails, whatever the journaled one reads", async () => {
    const r = await settle(K.ID_A, { recordEntry: denied('Get') });
    expect(r.del).not.toHaveBeenCalled();
    expect(r.out.unaddressed).toBe(1);
    expect(r.warned).toContain(`Orphan (${K.type})`);
  });

  it("the fix-forward: keeps it when the record's resource is gone", async () => {
    const r = await settle(K.ID_A, { recordEntry: 'gone' });
    expect(r.del).not.toHaveBeenCalled();
    expect(r.out.unaddressed).toBe(1);
  });

  // A journal an older cdkd wrote carries no identity: whatever the live reads
  // answer, nothing proves the resource under the id is the one its CREATE
  // made, so it is kept with a warning and no delete is sent.
  it.each([
    ['the fix-forward', { recordEntry: K.ID_B }],
    ['with no record under the id', undefined],
  ] as const)(
    '%s: an entry with no journaled identity (an older journal) is kept',
    async (_label, fixForward) => {
      const r = await settle(K.ID_A, fixForward, { journaledIdentity: false });
      expect(r.del).not.toHaveBeenCalled();
      expect(mockSend.mock.calls.some(([c]) => K.isDelete(c))).toBe(false);
      expect(r.out.unaddressed).toBe(1);
      expect(r.warned).toContain(`Orphan (${K.type})`);
    }
  );

  it('with no record under the id: deletes it when it still reads back under the journaled id (control)', async () => {
    const r = await settle(K.ID_A);
    expect(r.del).toHaveBeenCalledTimes(1);
    expect(r.out.unaddressed).toBe(0);
  });

  it('with no record under the id: keeps it when it now reads back under another id', async () => {
    const r = await settle(K.ID_A2);
    expect(r.del).not.toHaveBeenCalled();
    expect(r.warned).toContain('the resource now under its physical id is another one');
    expect(r.out.unaddressed).toBe(1);
  });
});
