import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#4606: the live identity read a successful deploy asks before
// deleting a fix-forward's earlier IAM user or group (only `'different'` lets
// it delete), and the `UserId` / `GroupId` a failed CREATE journals beside the
// orphan's name for the settle to compare, so one re-created under the name
// is never deleted as the orphan.

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

// Not an `IAMClient`, so `IamCreateClientCache` sends CreateUser / CreateGroup
// through this same double.
const sharedClient = vi.hoisted(() => ({
  send: mockSend,
  config: { region: () => Promise.resolve(clientRegion.value) },
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ iam: sharedClient }),
}));

import {
  AttachGroupPolicyCommand,
  AttachUserPolicyCommand,
  CreateGroupCommand,
  CreateUserCommand,
  DeleteGroupCommand,
  DeleteLoginProfileCommand,
  DeleteUserCommand,
  DeleteUserPermissionsBoundaryCommand,
  EntityAlreadyExistsException,
  GetGroupCommand,
  GetUserCommand,
  ListAttachedGroupPoliciesCommand,
  ListAttachedUserPoliciesCommand,
  ListGroupPoliciesCommand,
  ListGroupsForUserCommand,
  ListUserPoliciesCommand,
  NoSuchEntityException,
  PutGroupPolicyCommand,
  PutUserPolicyCommand,
  DetachGroupPolicyCommand,
  DetachUserPolicyCommand,
} from '@aws-sdk/client-iam';
import { IAMUserGroupProvider } from '../../../src/provisioning/providers/iam-user-group-provider.js';
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
const POLICY_ARN = 'arn:aws:iam::aws:policy/ReadOnlyAccess';

/** Everything a case needs to drive one of the two types the same way. */
interface Kind {
  type: 'AWS::IAM::User' | 'AWS::IAM::Group';
  noun: 'user' | 'group';
  idField: 'UserId' | 'GroupId';
  maxLength: number;
  ID_A: string;
  ID_A2: string;
  ID_B: string;
  /** The read command `isSameResource` / `resourceIdentity` send. */
  isRead: (cmd: unknown) => boolean;
  askedName: (cmd: unknown) => string | undefined;
  /** A successful read answering `name` with `id` (`undefined` = no id). */
  answer: (name: string, id: string | undefined) => unknown;
  /** A successful read answering `name` with an EMPTY id field. */
  answerEmptyId: (name: string) => unknown;
  isCreate: (cmd: unknown) => boolean;
  created: (name: string, id: string | undefined) => unknown;
  isAttach: (cmd: unknown) => boolean;
  /** The wiring call denied after a successful attach. */
  isFailingWire: (cmd: unknown) => boolean;
  isDelete: (cmd: unknown) => boolean;
  /** Cleanup calls that answer harmlessly. */
  cleanupAnswer: (cmd: unknown) => unknown;
  props: Record<string, unknown>;
}

const USER: Kind = {
  type: 'AWS::IAM::User',
  noun: 'user',
  idField: 'UserId',
  maxLength: 64,
  ID_A: 'AIDAAAAAAAAAAAAAAAAA1',
  ID_A2: 'AIDAAAAAAAAAAAAAAAAA2',
  ID_B: 'AIDABBBBBBBBBBBBBBBB1',
  isRead: (c) => c instanceof GetUserCommand,
  askedName: (c) => (c instanceof GetUserCommand ? c.input.UserName : undefined),
  answer: (name, id) => ({
    User: { UserName: name, Arn: `arn:aws:iam::1:user/${name}`, ...(id && { UserId: id }) },
  }),
  answerEmptyId: (name) => ({ User: { UserName: name, UserId: '' } }),
  isCreate: (c) => c instanceof CreateUserCommand,
  created: (name, id) => ({
    User: { UserName: name, Arn: `arn:aws:iam::1:user/${name}`, UserId: id },
  }),
  isAttach: (c) => c instanceof AttachUserPolicyCommand,
  isFailingWire: (c) => c instanceof PutUserPolicyCommand,
  isDelete: (c) => c instanceof DeleteUserCommand,
  cleanupAnswer: (c) => {
    if (c instanceof ListGroupsForUserCommand) return { Groups: [] };
    if (c instanceof ListAttachedUserPoliciesCommand) {
      return { AttachedPolicies: [{ PolicyArn: POLICY_ARN }] };
    }
    if (c instanceof DetachUserPolicyCommand) return {};
    if (c instanceof ListUserPoliciesCommand) return { PolicyNames: [] };
    if (c instanceof DeleteLoginProfileCommand || c instanceof DeleteUserPermissionsBoundaryCommand) {
      throw new NoSuchEntityException({ message: 'not found', $metadata: {} });
    }
    return undefined;
  },
  props: {
    UserName: 'name-a',
    ManagedPolicyArns: [POLICY_ARN],
    Policies: [{ PolicyName: 'inline', PolicyDocument: { Version: '2012-10-17', Statement: [] } }],
    Tags: [{ Key: 'k', Value: 'v' }],
  },
};

const GROUP: Kind = {
  type: 'AWS::IAM::Group',
  noun: 'group',
  idField: 'GroupId',
  maxLength: 128,
  ID_A: 'AGPAAAAAAAAAAAAAAAAA1',
  ID_A2: 'AGPAAAAAAAAAAAAAAAAA2',
  ID_B: 'AGPABBBBBBBBBBBBBBBB1',
  isRead: (c) => c instanceof GetGroupCommand,
  askedName: (c) => (c instanceof GetGroupCommand ? c.input.GroupName : undefined),
  answer: (name, id) => ({
    Group: { GroupName: name, Arn: `arn:aws:iam::1:group/${name}`, ...(id && { GroupId: id }) },
    Users: [],
  }),
  answerEmptyId: (name) => ({ Group: { GroupName: name, GroupId: '' }, Users: [] }),
  isCreate: (c) => c instanceof CreateGroupCommand,
  created: (name, id) => ({
    Group: { GroupName: name, Arn: `arn:aws:iam::1:group/${name}`, GroupId: id },
  }),
  isAttach: (c) => c instanceof AttachGroupPolicyCommand,
  isFailingWire: (c) => c instanceof PutGroupPolicyCommand,
  isDelete: (c) => c instanceof DeleteGroupCommand,
  cleanupAnswer: (c) => {
    if (c instanceof ListAttachedGroupPoliciesCommand) {
      return { AttachedPolicies: [{ PolicyArn: POLICY_ARN }] };
    }
    if (c instanceof DetachGroupPolicyCommand) return {};
    if (c instanceof ListGroupPoliciesCommand) return { PolicyNames: [] };
    return undefined;
  },
  props: {
    GroupName: 'name-a',
    ManagedPolicyArns: [POLICY_ARN],
    Policies: [{ PolicyName: 'inline', PolicyDocument: { Version: '2012-10-17', Statement: [] } }],
  },
};

const KINDS = [USER, GROUP] as const;

const notFound = (name: string): Error =>
  new NoSuchEntityException({
    message: `The entity with name ${name} cannot be found.`,
    $metadata: {},
  });

const denied = (op: string): Error =>
  Object.assign(new Error(`User is not authorized to perform: iam:${op}`), {
    name: 'AccessDenied',
  });

/**
 * One name's read answer: its id, gone, an error, a response naming another
 * entity, or one naming no id.
 */
type Entry = string | 'gone' | Error | { answeredAs: string } | 'no-id' | 'empty-id';

/** The kind's read answers per name, exactly as asked. */
function live(kind: Kind, entries: Record<string, Entry>): void {
  mockSend.mockImplementation(async (cmd: unknown) => {
    if (!kind.isRead(cmd)) throw new Error('unexpected command');
    const asked = kind.askedName(cmd)!;
    const entry = entries[asked];
    if (entry === undefined || entry === 'gone') throw notFound(asked);
    if (entry instanceof Error) throw entry;
    if (entry === 'no-id') return kind.answer(asked, undefined);
    if (entry === 'empty-id') return kind.answerEmptyId(asked);
    if (typeof entry === 'object') return kind.answer(entry.answeredAs, kind.ID_B);
    return kind.answer(asked, entry);
  });
}

const askedNames = (kind: Kind): Array<string | undefined> =>
  mockSend.mock.calls.map(([cmd]) => (kind.isRead(cmd) ? kind.askedName(cmd) : `<${String(cmd)}>`));

describe.each(KINDS)('IAMUserGroupProvider.isSameResource, $type (go-to-k/cdkd#4606)', (K) => {
  let provider: IAMUserGroupProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    clientRegion.value = 'us-east-1';
    provider = new IAMUserGroupProvider();
  });

  it('another live entity under another name is different', async () => {
    live(K, { 'name-a': K.ID_A, 'name-b': K.ID_B });
    await expect(provider.isSameResource('name-a', { physicalId: 'name-b' }, K.type, CTX)).resolves.toBe(
      'different'
    );
    // The record's entity is read first: it must exist for any verdict.
    expect(askedNames(K)).toEqual(['name-b', 'name-a']);
  });

  it('a journaled entity IAM reports gone is different once the record reads back', async () => {
    live(K, { 'name-b': K.ID_B });
    await expect(provider.isSameResource('name-a', { physicalId: 'name-b' }, K.type, CTX)).resolves.toBe(
      'different'
    );
  });

  it('two names reading back under one id are the same (the verdict rests on AWS)', async () => {
    live(K, { 'name-a': K.ID_B, 'name-b': K.ID_B });
    await expect(provider.isSameResource('name-a', { physicalId: 'name-b' }, K.type, CTX)).resolves.toBe(
      'same'
    );
  });

  it("the record's entity gone is unknown, not different, whatever the journaled one reads", async () => {
    for (const journaled of [K.ID_A, 'gone'] as const) {
      mockSend.mockReset();
      live(K, { 'name-a': journaled });
      await expect(
        provider.isSameResource('name-a', { physicalId: 'name-b' }, K.type, CTX)
      ).resolves.toBe('unknown');
      expect(askedNames(K)).toEqual(['name-b']);
    }
  });

  it('equal names are the same without a read, even from a client in another region', async () => {
    clientRegion.value = 'eu-west-1';
    await expect(provider.isSameResource('name-a', { physicalId: 'name-a' }, K.type, CTX)).resolves.toBe(
      'same'
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  // IAM user and group names are unique regardless of case: `Name-A` and
  // `name-a` would be one entity, and this check does not decide on IAM's
  // case rules.
  it('names differing only in case are unknown, with no read', async () => {
    await expect(provider.isSameResource('Name-A', { physicalId: 'name-a' }, K.type, CTX)).resolves.toBe(
      'unknown'
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('a read failing other than with NoSuchEntityException throws (the caller reads it as unknown)', async () => {
    live(K, { 'name-a': denied('Get'), 'name-b': K.ID_B });
    await expect(
      provider.isSameResource('name-a', { physicalId: 'name-b' }, K.type, CTX)
    ).rejects.toThrow(/not authorized/);
  });

  it("the record's read failing throws before the journaled one is read", async () => {
    live(K, { 'name-a': K.ID_A, 'name-b': denied('Get') });
    await expect(
      provider.isSameResource('name-a', { physicalId: 'name-b' }, K.type, CTX)
    ).rejects.toThrow(/not authorized/);
    expect(askedNames(K)).toEqual(['name-b']);
  });

  it('"cannot be found" in the message of another error class never reads as gone', async () => {
    const lookalike = Object.assign(new Error('The entity with name name-a cannot be found.'), {
      name: 'ServiceFailure',
    });
    live(K, { 'name-a': lookalike, 'name-b': K.ID_B });
    await expect(
      provider.isSameResource('name-a', { physicalId: 'name-b' }, K.type, CTX)
    ).rejects.toThrow(/cannot be found/);
  });

  it('a response naming another entity, or no id, throws rather than comparing it', async () => {
    live(K, { 'name-a': { answeredAs: 'name-x' }, 'name-b': K.ID_B });
    await expect(
      provider.isSameResource('name-a', { physicalId: 'name-b' }, K.type, CTX)
    ).rejects.toThrow(new RegExp(`another ${K.noun}`));
    mockSend.mockReset();
    live(K, { 'name-a': 'no-id', 'name-b': K.ID_B });
    await expect(
      provider.isSameResource('name-a', { physicalId: 'name-b' }, K.type, CTX)
    ).rejects.toThrow(new RegExp(`no ${K.idField}`));
    mockSend.mockReset();
    live(K, { 'name-a': K.ID_A, 'name-b': 'no-id' });
    await expect(
      provider.isSameResource('name-a', { physicalId: 'name-b' }, K.type, CTX)
    ).rejects.toThrow(new RegExp(`no ${K.idField}`));
    mockSend.mockReset();
    live(K, { 'name-a': 'empty-id', 'name-b': K.ID_B });
    await expect(
      provider.isSameResource('name-a', { physicalId: 'name-b' }, K.type, CTX)
    ).rejects.toThrow(new RegExp(`no ${K.idField}`));
  });

  it('a client in another region is unknown, with no read', async () => {
    clientRegion.value = 'eu-west-1';
    live(K, { 'name-a': K.ID_A, 'name-b': K.ID_B });
    await expect(provider.isSameResource('name-a', { physicalId: 'name-b' }, K.type, CTX)).resolves.toBe(
      'unknown'
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each([
    ['an ARN', `arn:aws:iam::123456789012:x/name-a`],
    ['a path-qualified name', 'svc/name-a'],
    ['an empty id', ''],
    ['a name one character too long', 'n'.repeat(K.maxLength + 1)],
    ['a name with a space', 'name a'],
  ])('%s on either side is unknown, with no read', async (_label, id) => {
    await expect(provider.isSameResource(id, { physicalId: 'name-b' }, K.type, CTX)).resolves.toBe(
      'unknown'
    );
    await expect(provider.isSameResource('name-a', { physicalId: id }, K.type, CTX)).resolves.toBe(
      'unknown'
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each(['AWS::IAM::UserToGroupAddition', 'AWS::IAM::Role'])(
    'another type (%s) is unknown, with no read',
    async (other) => {
      await expect(
        provider.isSameResource('name-a', { physicalId: 'name-b' }, other, CTX)
      ).resolves.toBe('unknown');
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it('the longest legal name, and one using every legal character class, are read', async () => {
    const longest = 'n'.repeat(K.maxLength);
    const every = 'Ab9+=,.@_-';
    live(K, { [longest]: K.ID_A, [every]: K.ID_B });
    await expect(provider.isSameResource(longest, { physicalId: every }, K.type, CTX)).resolves.toBe(
      'different'
    );
    expect(askedNames(K)).toEqual([every, longest]);
  });
});

describe('IAMUserGroupProvider name lengths differ by type (go-to-k/cdkd#4606)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    clientRegion.value = 'us-east-1';
  });

  // A 65-128 character name is a legal group name and never a legal user name.
  it('a 100-character name is read as a group, refused as a user', async () => {
    const name = 'n'.repeat(100);
    const provider = new IAMUserGroupProvider();
    await expect(provider.resourceIdentity(name, USER.type, CTX)).resolves.toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
    live(GROUP, { [name]: GROUP.ID_A });
    await expect(provider.resourceIdentity(name, GROUP.type, CTX)).resolves.toBe(GROUP.ID_A);
  });
});

describe.each(KINDS)('IAMUserGroupProvider.resourceIdentity, $type (go-to-k/cdkd#4606)', (K) => {
  let provider: IAMUserGroupProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    clientRegion.value = 'us-east-1';
    provider = new IAMUserGroupProvider();
  });

  it('is the live id, read under the name as written', async () => {
    live(K, { 'name-a': K.ID_A });
    await expect(provider.resourceIdentity('name-a', K.type, CTX)).resolves.toBe(K.ID_A);
    expect(askedNames(K)).toEqual(['name-a']);
    // A group read asks for one member page at most: the id is all it needs.
    const [[sent]] = mockSend.mock.calls as Array<[unknown]>;
    if (K.type === 'AWS::IAM::Group') {
      expect(sent).toBeInstanceOf(GetGroupCommand);
      expect((sent as GetGroupCommand).input).toEqual({ GroupName: 'name-a', MaxItems: 1 });
    } else {
      expect((sent as GetUserCommand).input).toEqual({ UserName: 'name-a' });
    }
  });

  it('one re-created under the name (another id) reads another token', async () => {
    live(K, { 'name-a': K.ID_A2 });
    const token = await provider.resourceIdentity('name-a', K.type, CTX);
    expect(token).toBe(K.ID_A2);
    expect(token).not.toBe(K.ID_A);
  });

  it('is RESOURCE_NOT_FOUND on NoSuchEntityException', async () => {
    live(K, {});
    await expect(provider.resourceIdentity('name-a', K.type, CTX)).resolves.toBe(RESOURCE_NOT_FOUND);
  });

  it('throws on any other failure, "cannot be found" in the message included (never gone)', async () => {
    live(K, { 'name-a': denied('Get') });
    await expect(provider.resourceIdentity('name-a', K.type, CTX)).rejects.toThrow(/not authorized/);
    mockSend.mockReset();
    live(K, {
      'name-a': Object.assign(new Error('The entity cannot be found.'), { name: 'ServiceFailure' }),
    });
    await expect(provider.resourceIdentity('name-a', K.type, CTX)).rejects.toThrow(/cannot be found/);
  });

  it('throws on a response naming no id, or another entity', async () => {
    live(K, { 'name-a': 'no-id' });
    await expect(provider.resourceIdentity('name-a', K.type, CTX)).rejects.toThrow(
      new RegExp(`no ${K.idField}`)
    );
    // An empty id field is no id: it never reads as a token.
    mockSend.mockReset();
    live(K, { 'name-a': 'empty-id' });
    await expect(provider.resourceIdentity('name-a', K.type, CTX)).rejects.toThrow(
      new RegExp(`no ${K.idField}`)
    );
    mockSend.mockReset();
    live(K, { 'name-a': { answeredAs: 'Name-A' } });
    await expect(provider.resourceIdentity('name-a', K.type, CTX)).rejects.toThrow(
      new RegExp(`another ${K.noun}`)
    );
  });

  it('is undefined, with no read, for a client in another region', async () => {
    clientRegion.value = 'eu-west-1';
    live(K, { 'name-a': K.ID_A });
    await expect(provider.resourceIdentity('name-a', K.type, CTX)).resolves.toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('is undefined, with no read, for an id that is not a name, or another type', async () => {
    live(K, { 'name-a': K.ID_A });
    await expect(
      provider.resourceIdentity(`arn:aws:iam::1:${K.noun}/name-a`, K.type, CTX)
    ).resolves.toBeUndefined();
    await expect(provider.resourceIdentity('', K.type, CTX)).resolves.toBeUndefined();
    await expect(
      provider.resourceIdentity('name-a', 'AWS::IAM::UserToGroupAddition', CTX)
    ).resolves.toBeUndefined();
    await expect(provider.resourceIdentity('name-a', 'AWS::IAM::Role', CTX)).resolves.toBeUndefined();
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
     * EntityAlreadyExists); the managed-policy attach succeeds, the inline
     * policy put is denied, and so is the cleanup's final delete unless
     * `cleanupSucceeds`.
     */
    function aws(opts: { id: string | undefined; cleanupSucceeds?: boolean }): void {
      let creates = 0;
      mockSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
        if (K.isCreate(cmd)) {
          if (creates++ > 0) {
            throw new EntityAlreadyExistsException({
              message: `${K.noun} with name name-a already exists.`,
              $metadata: {},
            });
          }
          return K.created('name-a', opts.id);
        }
        if (K.isAttach(cmd)) return {};
        if (K.isFailingWire(cmd)) throw denied('Put');
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

    it("a wiring failure after a successful attach whose cleanup fails marks the name and the create's id", async () => {
      aws({ id: K.ID_A });
      const error = await failureOf(new IAMUserGroupProvider().create('Orphan', K.type, K.props));
      expect(createdBeforeFailure(error, 'Orphan', K.type)).toBe('name-a');
      // The create response's id, never a later read's (none is sent).
      expect(createdResourceIdentityBeforeFailure(error, 'Orphan', K.type)).toBe(K.ID_A);
      expect(mockSend.mock.calls.some(([c]) => K.isRead(c))).toBe(false);
      expect(mockSend.mock.calls.some(([c]) => K.isAttach(c))).toBe(true);
      expect(mockSend.mock.calls.some(([c]) => K.isDelete(c))).toBe(true);
    });

    // The token the mark carries and the one `resourceIdentity` reads back
    // must be one spelling, or the settle never proves its own orphan.
    it('the marked token equals the live read of the same entity', async () => {
      aws({ id: K.ID_A });
      const provider = new IAMUserGroupProvider();
      const error = await failureOf(provider.create('Orphan', K.type, K.props));
      mockSend.mockReset();
      live(K, { 'name-a': K.ID_A });
      await expect(provider.resourceIdentity('name-a', K.type, CTX)).resolves.toBe(
        createdResourceIdentityBeforeFailure(error, 'Orphan', K.type)
      );
    });

    // The retry the failure may trigger replays the create, which fails with
    // EntityAlreadyExists: the error finally thrown keeps the FIRST attempt's
    // mark, identity included.
    it("a replay failing with EntityAlreadyExists keeps the first attempt's id", async () => {
      aws({ id: K.ID_A });
      const provider = new IAMUserGroupProvider();
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
      expect(createdBeforeFailure(error, 'Orphan', K.type)).toBe('name-a');
      expect(createdResourceIdentityBeforeFailure(error, 'Orphan', K.type)).toBe(K.ID_A);
      expect(attempts).toBeGreaterThan(1);
    });

    it.each([
      ['no id', undefined],
      ['an empty id', ''],
    ])('a create response with %s marks the name alone', async (_label, id) => {
      aws({ id });
      const error = await failureOf(new IAMUserGroupProvider().create('Orphan', K.type, K.props));
      expect(createdBeforeFailure(error, 'Orphan', K.type)).toBe('name-a');
      expect(createdResourceIdentityBeforeFailure(error, 'Orphan', K.type)).toBeUndefined();
    });

    it('a cleanup that deleted the entity marks nothing, identity included', async () => {
      aws({ id: K.ID_A, cleanupSucceeds: true });
      const error = await failureOf(new IAMUserGroupProvider().create('Orphan', K.type, K.props));
      expect(createdBeforeFailure(error, 'Orphan', K.type)).toBeUndefined();
      expect(createdResourceIdentityBeforeFailure(error, 'Orphan', K.type)).toBeUndefined();
    });
  }
);

describe.each(KINDS)(
  'IAMUserGroupProvider.delete of a journaled $type already gone (go-to-k/cdkd#4606)',
  (K) => {
    beforeEach(() => {
      vi.clearAllMocks();
      mockSend.mockReset();
      clientRegion.value = 'us-east-1';
    });

    const skipDebugLines = (): number =>
      providerLogger.debug.mock.calls.filter(([m]) => String(m).includes('does not exist, skipping'))
        .length;

    // The user delete reads GetUser first; the group delete's helpers each
    // return on not-found, so its DeleteGroup is what answers it.
    const goneEverywhere = (name: string): void => {
      mockSend.mockImplementation(async () => {
        throw notFound(name);
      });
    };

    it('names it once at info when IAM answers not found, since the settle then exits 0', async () => {
      goneEverywhere('orphan-x');
      const provider = new IAMUserGroupProvider();
      await provider.delete('Orphan', 'orphan-x', K.type, {}, {
        expectedRegion: 'us-east-1',
        failedCreateOrphan: true,
      });
      const infos = providerLogger.info.mock.calls.map(([m]) => String(m));
      expect(infos).toHaveLength(1);
      expect(infos[0]).toContain(`IAM ${K.noun} orphan-x (Orphan)`);
      expect(infos[0]).toContain('already gone');
      expect(skipDebugLines()).toBe(0);

      // A record's own delete keeps the quiet debug line, the flag absent or false.
      for (const context of [
        { expectedRegion: 'us-east-1' },
        { expectedRegion: 'us-east-1', failedCreateOrphan: false },
      ]) {
        providerLogger.info.mockClear();
        providerLogger.debug.mockClear();
        await provider.delete('Orphan', 'orphan-x', K.type, {}, context);
        expect(providerLogger.info).not.toHaveBeenCalled();
        expect(skipDebugLines()).toBe(1);
      }
    });

    // go-to-k/cdkd#3869: the settle, `cdkd rollback` and `cdkd destroy` bind a
    // printing bag holding a secret-derived name around this delete; the line
    // carries the name verbatim, so the logger's line masker removes it.
    it('the info line names a secret-derived name only where the bound printing bag masks it', async () => {
      const DERIVED = 'name-from-secret-x9';
      goneEverywhere(DERIVED);
      const bag = new Map<string, string>();
      recordLogOnlyValue(bag, DERIVED);
      let masked = '<not masked>';
      await withPrintingSecrets(bag, async () => {
        await new IAMUserGroupProvider().delete('Orphan', DERIVED, K.type, {}, {
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
  }
);

// The settle end to end with the real provider: the journaled orphan `name-a`
// carries its create response's id (ID_A).
describe.each(KINDS)('the success settle with IAMUserGroupProvider, $type (go-to-k/cdkd#4606)', (K) => {
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
    const provider = new IAMUserGroupProvider();
    const del = vi.spyOn(provider, 'delete').mockResolvedValue(undefined);
    live(K, {
      'name-a': liveEntry,
      ...(fixForward !== undefined && { 'name-b': fixForward.recordEntry }),
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
              physicalId: 'name-a',
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
              physicalId: 'name-b',
              resourceType: K.type,
              provisionedBy: 'sdk',
              properties: {},
              attributes: {},
            },
          }) as never,
      rollbackOrphans: undefined,
      newerOperations: (fixForward === undefined
        ? []
        : [
            { logicalId: 'Orphan', changeType: 'CREATE', resourceType: K.type, physicalId: 'name-b' },
          ]) as never,
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
    expect(r.del.mock.calls[0]?.[1]).toBe('name-a');
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

  it('the fix-forward: an earlier entity already gone is named, not deleted, and settles', async () => {
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

  it("the fix-forward: keeps it when the record's entity is gone", async () => {
    const r = await settle(K.ID_A, { recordEntry: 'gone' });
    expect(r.del).not.toHaveBeenCalled();
    expect(r.out.unaddressed).toBe(1);
  });

  // A journal an older cdkd wrote carries no identity: whatever the live reads
  // answer, nothing proves the entity under the name is the one its CREATE
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

  it('with no record under the id: deletes it when the name still reads back under the journaled id (control)', async () => {
    const r = await settle(K.ID_A);
    expect(r.del).toHaveBeenCalledTimes(1);
    expect(r.out.unaddressed).toBe(0);
  });

  it('with no record under the id: keeps it when the name now reads back under another id', async () => {
    const r = await settle(K.ID_A2);
    expect(r.del).not.toHaveBeenCalled();
    expect(r.warned).toContain('the resource now under its physical id is another one');
    expect(r.out.unaddressed).toBe(1);
  });
});
