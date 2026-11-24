import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  GetUserCommand,
  GetLoginProfileCommand,
  GetUserPolicyCommand,
  GetGroupCommand,
  GetGroupPolicyCommand,
  ListAttachedUserPoliciesCommand,
  ListGroupsForUserCommand,
  ListUserPoliciesCommand,
  ListAttachedGroupPoliciesCommand,
  ListGroupPoliciesCommand,
  NoSuchEntityException,
} from '@aws-sdk/client-iam';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    iam: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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

import { IAMUserGroupProvider } from '../../../src/provisioning/providers/iam-user-group-provider.js';
import { RESOURCE_NOT_FOUND, type ResourceNotFound } from '../../../src/types/resource.js';
/** Narrow a `readCurrentState` result to its property bag; fails on `RESOURCE_NOT_FOUND`. */
function bagOf(
  r: Record<string, unknown> | ResourceNotFound | undefined
): Record<string, unknown> | undefined {
  expect(r).not.toBe(RESOURCE_NOT_FOUND);
  return r as Record<string, unknown> | undefined;
}

describe('IAMUserGroupProvider.readCurrentState', () => {
  let provider: IAMUserGroupProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new IAMUserGroupProvider();
  });

  describe('AWS::IAM::User', () => {
    it('returns CFn-shaped properties (happy path)', async () => {
      mockSend.mockResolvedValueOnce({
        User: {
          UserName: 'alice',
          Path: '/team/',
          PermissionsBoundary: { PermissionsBoundaryArn: 'arn:aws:iam::aws:policy/Boundary' },
          Arn: 'arn:aws:iam::123:user/alice',
        },
      });
      // GetLoginProfile: no console login (go-to-k/cdkd#6755).
      mockSend.mockRejectedValueOnce(new NoSuchEntityException({ message: 'none', $metadata: {} }));
      mockSend.mockResolvedValueOnce({
        AttachedPolicies: [
          { PolicyArn: 'arn:aws:iam::aws:policy/ReadOnlyAccess', PolicyName: 'ro' },
        ],
      });
      mockSend.mockResolvedValueOnce({
        Groups: [{ GroupName: 'engineers' }, { GroupName: 'admins' }],
      });
      // ListUserPolicies — no inline.
      mockSend.mockResolvedValueOnce({ PolicyNames: [], IsTruncated: false });

      const result = await provider.readCurrentState('alice', 'Logical', 'AWS::IAM::User');

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetUserCommand);
      expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(GetLoginProfileCommand);
      expect(mockSend.mock.calls[2]?.[0]).toBeInstanceOf(ListAttachedUserPoliciesCommand);
      expect(mockSend.mock.calls[3]?.[0]).toBeInstanceOf(ListGroupsForUserCommand);
      expect(mockSend.mock.calls[4]?.[0]).toBeInstanceOf(ListUserPoliciesCommand);
      expect(result).toEqual({
        UserName: 'alice',
        Path: '/team/',
        PermissionsBoundary: 'arn:aws:iam::aws:policy/Boundary',
        ManagedPolicyArns: ['arn:aws:iam::aws:policy/ReadOnlyAccess'],
        LoginProfile: null,
        Groups: ['engineers', 'admins'],
        Policies: [],
      });
    });

    it('emits PermissionsBoundary placeholder when AWS reports none', async () => {
      // Always-emit guard (PR #145 pattern): without the placeholder a
      // console-side ADD on a user deployed without a boundary would
      // never enter observedProperties and the drift comparator would
      // silently ignore it.
      mockSend.mockResolvedValueOnce({
        User: { UserName: 'alice', Path: '/' },
      });
      // GetLoginProfile: no console login (go-to-k/cdkd#6755).
      mockSend.mockRejectedValueOnce(new NoSuchEntityException({ message: 'none', $metadata: {} }));
      mockSend.mockResolvedValueOnce({ AttachedPolicies: [] });
      mockSend.mockResolvedValueOnce({ Groups: [] });
      mockSend.mockResolvedValueOnce({ PolicyNames: [], IsTruncated: false });

      const result = bagOf(await provider.readCurrentState('alice', 'Logical', 'AWS::IAM::User'));
      expect(result?.PermissionsBoundary).toBe('');
    });

    it('surfaces inline Policies with parsed PolicyDocument bodies and reconciles order against state', async () => {
      const docA = { V: 'a' };
      const docB = { V: 'b' };
      mockSend.mockResolvedValueOnce({
        User: { UserName: 'alice', Path: '/' },
      });
      // GetLoginProfile: no console login (go-to-k/cdkd#6755).
      mockSend.mockRejectedValueOnce(new NoSuchEntityException({ message: 'none', $metadata: {} }));
      mockSend.mockResolvedValueOnce({ AttachedPolicies: [] });
      mockSend.mockResolvedValueOnce({ Groups: [] });
      // AWS returns lex order ['A', 'B']; state has order (B, A).
      mockSend.mockResolvedValueOnce({
        PolicyNames: ['A', 'B'],
        IsTruncated: false,
      });
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof GetUserPolicyCommand) {
          const input = (cmd as GetUserPolicyCommand).input;
          return Promise.resolve({
            UserName: 'alice',
            PolicyName: input.PolicyName,
            PolicyDocument: encodeURIComponent(
              JSON.stringify(input.PolicyName === 'A' ? docA : docB)
            ),
          });
        }
        return Promise.resolve({});
      });

      const result = bagOf(await provider.readCurrentState('alice', 'Logical', 'AWS::IAM::User', {
        Policies: [
          { PolicyName: 'B', PolicyDocument: docB },
          { PolicyName: 'A', PolicyDocument: docA },
        ],
      }));

      // Order should match state's (B, A) so positional compare passes.
      expect(result?.Policies).toEqual([
        { PolicyName: 'B', PolicyDocument: docB },
        { PolicyName: 'A', PolicyDocument: docA },
      ]);
    });

    it('returns RESOURCE_NOT_FOUND when user gone', async () => {
      mockSend.mockRejectedValueOnce(
        new NoSuchEntityException({ message: 'gone', $metadata: {} })
      );

      const result = await provider.readCurrentState('alice', 'Logical', 'AWS::IAM::User');
      expect(result).toBe(RESOURCE_NOT_FOUND);
    });
  });

  describe('AWS::IAM::Group', () => {
    it('returns CFn-shaped properties (happy path)', async () => {
      mockSend.mockResolvedValueOnce({
        Group: { GroupName: 'engineers', Path: '/', Arn: 'arn:aws:iam::123:group/engineers' },
      });
      mockSend.mockResolvedValueOnce({
        AttachedPolicies: [
          { PolicyArn: 'arn:aws:iam::aws:policy/AmazonS3FullAccess', PolicyName: 's3' },
        ],
      });
      // ListGroupPolicies — no inline.
      mockSend.mockResolvedValueOnce({ PolicyNames: [], IsTruncated: false });

      const result = await provider.readCurrentState(
        'engineers',
        'Logical',
        'AWS::IAM::Group'
      );

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetGroupCommand);
      expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(ListAttachedGroupPoliciesCommand);
      expect(mockSend.mock.calls[2]?.[0]).toBeInstanceOf(ListGroupPoliciesCommand);
      expect(result).toEqual({
        GroupName: 'engineers',
        Path: '/',
        ManagedPolicyArns: ['arn:aws:iam::aws:policy/AmazonS3FullAccess'],
        Policies: [],
      });
    });

    it('surfaces inline Policies for groups via GetGroupPolicy', async () => {
      const doc = { V: 1 };
      mockSend.mockResolvedValueOnce({
        Group: { GroupName: 'engineers', Path: '/' },
      });
      mockSend.mockResolvedValueOnce({ AttachedPolicies: [] });
      mockSend.mockResolvedValueOnce({
        PolicyNames: ['Inline1'],
        IsTruncated: false,
      });
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof GetGroupPolicyCommand) {
          return Promise.resolve({
            GroupName: 'engineers',
            PolicyName: 'Inline1',
            PolicyDocument: encodeURIComponent(JSON.stringify(doc)),
          });
        }
        return Promise.resolve({});
      });

      const result = bagOf(await provider.readCurrentState('engineers', 'Logical', 'AWS::IAM::Group'));
      expect(result?.Policies).toEqual([{ PolicyName: 'Inline1', PolicyDocument: doc }]);
    });

    it('returns RESOURCE_NOT_FOUND when group gone', async () => {
      mockSend.mockRejectedValueOnce(
        new NoSuchEntityException({ message: 'gone', $metadata: {} })
      );

      const result = await provider.readCurrentState(
        'engineers',
        'Logical',
        'AWS::IAM::Group'
      );
      expect(result).toBe(RESOURCE_NOT_FOUND);
    });
  });

  describe('issue #323: filter inline policies managed by sibling AWS::IAM::Policy', () => {
    it('User: excludes inline policy whose name matches sibling AWS::IAM::Policy.Users', async () => {
      mockSend.mockResolvedValueOnce({
        User: { UserName: 'alice', Path: '/' },
      });
      // GetLoginProfile: no console login (go-to-k/cdkd#6755).
      mockSend.mockRejectedValueOnce(new NoSuchEntityException({ message: 'none', $metadata: {} }));
      mockSend.mockResolvedValueOnce({ AttachedPolicies: [] });
      mockSend.mockResolvedValueOnce({ Groups: [] });
      mockSend.mockResolvedValueOnce({
        PolicyNames: ['SiblingManagedPolicy'],
        IsTruncated: false,
      });
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof GetUserPolicyCommand) {
          return Promise.resolve({
            UserName: 'alice',
            PolicyName: 'SiblingManagedPolicy',
            PolicyDocument: encodeURIComponent(JSON.stringify({ Doc: 'managed' })),
          });
        }
        return Promise.resolve({ Tags: [], IsTruncated: false });
      });

      const result = bagOf(await provider.readCurrentState(
        'alice',
        'User',
        'AWS::IAM::User',
        { Policies: [] },
        {
          siblings: {
            SiblingPolicy: {
              resourceType: 'AWS::IAM::Policy',
              properties: { PolicyName: 'SiblingManagedPolicy', Users: ['alice'] },
            },
          },
        }
      ));

      expect(result?.Policies).toEqual([]);
    });

    it('Group: excludes inline policy whose name matches sibling AWS::IAM::Policy.Groups', async () => {
      mockSend.mockResolvedValueOnce({
        Group: { GroupName: 'engineers', Path: '/' },
      });
      mockSend.mockResolvedValueOnce({ AttachedPolicies: [] });
      mockSend.mockResolvedValueOnce({
        PolicyNames: ['SiblingGroupPolicy'],
        IsTruncated: false,
      });
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof GetGroupPolicyCommand) {
          return Promise.resolve({
            GroupName: 'engineers',
            PolicyName: 'SiblingGroupPolicy',
            PolicyDocument: encodeURIComponent(JSON.stringify({ Doc: 'managed' })),
          });
        }
        return Promise.resolve({ Tags: [], IsTruncated: false });
      });

      const result = bagOf(await provider.readCurrentState(
        'engineers',
        'Group',
        'AWS::IAM::Group',
        { Policies: [] },
        {
          siblings: {
            SiblingPolicy: {
              resourceType: 'AWS::IAM::Policy',
              properties: { PolicyName: 'SiblingGroupPolicy', Groups: ['engineers'] },
            },
          },
        }
      ));

      expect(result?.Policies).toEqual([]);
    });

    it('User: cross-target sibling (Users for a different user) is NOT filtered out', async () => {
      mockSend.mockResolvedValueOnce({
        User: { UserName: 'alice', Path: '/' },
      });
      // GetLoginProfile: no console login (go-to-k/cdkd#6755).
      mockSend.mockRejectedValueOnce(new NoSuchEntityException({ message: 'none', $metadata: {} }));
      mockSend.mockResolvedValueOnce({ AttachedPolicies: [] });
      mockSend.mockResolvedValueOnce({ Groups: [] });
      mockSend.mockResolvedValueOnce({
        PolicyNames: ['MyPolicy'],
        IsTruncated: false,
      });
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof GetUserPolicyCommand) {
          return Promise.resolve({
            UserName: 'alice',
            PolicyName: 'MyPolicy',
            PolicyDocument: encodeURIComponent(JSON.stringify({ Doc: 'mine' })),
          });
        }
        return Promise.resolve({ Tags: [], IsTruncated: false });
      });

      const result = bagOf(await provider.readCurrentState(
        'alice',
        'User',
        'AWS::IAM::User',
        { Policies: [{ PolicyName: 'MyPolicy', PolicyDocument: { Doc: 'mine' } }] },
        {
          siblings: {
            UnrelatedPolicy: {
              // Same PolicyName but attached to a different user — must NOT
              // be considered a match for alice.
              resourceType: 'AWS::IAM::Policy',
              properties: { PolicyName: 'MyPolicy', Users: ['bob'] },
            },
          },
        }
      ));

      expect(result?.Policies).toEqual([
        { PolicyName: 'MyPolicy', PolicyDocument: { Doc: 'mine' } },
      ]);
    });
  });

  // go-to-k/cdkd#6324: a sibling AWS::IAM::ManagedPolicy attaching itself via
  // `Users` / `Groups` is that resource's, not the principal's.
  describe('a sibling AWS::IAM::ManagedPolicy attached via Users / Groups', () => {
    const MP = 'arn:aws:iam::123456789012:policy/Stack-Mp-ABC';
    const OWN = 'arn:aws:iam::aws:policy/ReadOnlyAccess';
    const OOB = 'arn:aws:iam::aws:policy/AWSDenyAll';
    function routeSend(attached: string[]): void {
      mockSend.mockReset();
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof GetUserCommand) return Promise.resolve({ User: { UserName: 'alice', Path: '/' } });
        if (cmd instanceof GetGroupCommand) return Promise.resolve({ Group: { GroupName: 'devs', Path: '/' } });
        if (cmd instanceof ListAttachedUserPoliciesCommand || cmd instanceof ListAttachedGroupPoliciesCommand) {
          return Promise.resolve({ AttachedPolicies: attached.map((PolicyArn) => ({ PolicyArn })) });
        }
        if (cmd instanceof ListGroupsForUserCommand) return Promise.resolve({ Groups: [] });
        return Promise.resolve({ PolicyNames: [], IsTruncated: false });
      });
    }
    const sibling = (field: string, names: string[]) => ({
      siblings: {
        Mp: { resourceType: 'AWS::IAM::ManagedPolicy', physicalId: MP, properties: { [field]: names } },
      },
    });

    it.each([
      ['AWS::IAM::User', 'alice', 'Users'],
      ['AWS::IAM::Group', 'devs', 'Groups'],
    ])('%s: excludes its ARN, keeping the declared and out-of-band ones', async (type, name, field) => {
      routeSend([MP, OWN, OOB]);
      const r = bagOf(
        await provider.readCurrentState(name, 'P', type, { ManagedPolicyArns: [OWN] }, sibling(field, [name]))
      );
      expect(r?.['ManagedPolicyArns']).toEqual([OWN, OOB]);
    });

    it.each([
      ['AWS::IAM::User', 'alice', 'Users'],
      ['AWS::IAM::Group', 'devs', 'Groups'],
    ])('%s: keeps its ARN when the principal ALSO declares it', async (type, name, field) => {
      routeSend([MP, OWN]);
      const r = bagOf(
        await provider.readCurrentState(name, 'P', type, { ManagedPolicyArns: [MP, OWN] }, sibling(field, [name]))
      );
      expect(r?.['ManagedPolicyArns']).toEqual([MP, OWN]);
    });

    it.each([
      // The other principal kind's list, and another principal of this kind.
      ['AWS::IAM::User', 'alice', sibling('Groups', ['alice'])],
      ['AWS::IAM::User', 'alice', sibling('Users', ['bob'])],
      ['AWS::IAM::Group', 'devs', sibling('Users', ['devs'])],
      ['AWS::IAM::Group', 'devs', sibling('Groups', ['ops'])],
    ])('%s: keeps its ARN for a sibling that does not list it', async (type, name, context) => {
      routeSend([MP, OWN]);
      const r = bagOf(
        await provider.readCurrentState(name, 'P', type, { ManagedPolicyArns: [OWN] }, context)
      );
      expect(r?.['ManagedPolicyArns']).toEqual([MP, OWN]);
    });
  });

  // go-to-k/cdkd#6328: a group a sibling AWS::IAM::UserToGroupAddition adds the
  // user to is that resource's membership.
  describe('a sibling AWS::IAM::UserToGroupAddition', () => {
    function readGroups(live: string[], properties: Record<string, unknown>, siblings: Record<string, unknown>) {
      mockSend.mockReset();
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof GetUserCommand) return Promise.resolve({ User: { UserName: 'alice', Path: '/' } });
        if (cmd instanceof ListAttachedUserPoliciesCommand) return Promise.resolve({ AttachedPolicies: [] });
        if (cmd instanceof ListGroupsForUserCommand) {
          return Promise.resolve({ Groups: live.map((GroupName) => ({ GroupName })) });
        }
        return Promise.resolve({ PolicyNames: [], IsTruncated: false });
      });
      return provider
        .readCurrentState('alice', 'U', 'AWS::IAM::User', properties, { siblings } as never)
        .then((r) => bagOf(r)?.['Groups']);
    }
    const addition = (group: unknown, users: unknown) => ({
      A: { resourceType: 'AWS::IAM::UserToGroupAddition', properties: { GroupName: group, Users: users } },
    });

    it('excludes the group it adds the user to, keeping declared and out-of-band ones', async () => {
      expect(await readGroups(['own', 'added', 'oob'], { Groups: ['own'] }, addition('added', ['alice']))).toEqual(['own', 'oob']);
    });

    it('keeps a group the user ALSO declares', async () => {
      expect(await readGroups(['both'], { Groups: ['both'] }, addition('both', ['alice']))).toEqual(['both']);
    });

    // IAM group and user names are case-insensitive.
    it('matches the group and the user name case-insensitively', async () => {
      expect(await readGroups(['own', 'Added'], { Groups: ['own'] }, addition('ADDED', ['Alice']))).toEqual(['own']);
      expect(await readGroups(['Both'], { Groups: ['BOTH'] }, addition('both', ['alice']))).toEqual(['Both']);
    });

    it.each([
      ['adding ANOTHER user', addition('added', ['bob'])],
      ['with a non-string GroupName', addition({ Ref: 'G' }, ['alice'])],
      ['with a non-list Users', addition('added', 'alice')],
      ['of another type', { A: { resourceType: 'AWS::IAM::Policy', properties: { GroupName: 'added', Users: ['alice'] } } }],
    ])('keeps the group for a sibling %s', async (_l, siblings) => {
      expect(await readGroups(['added'], {}, siblings)).toEqual(['added']);
    });
  });

  // go-to-k/cdkd#6769: the membership is read back per recorded user.
  describe('AWS::IAM::UserToGroupAddition', () => {
    const TYPE = 'AWS::IAM::UserToGroupAddition';
    /** `membership[user]` = the groups IAM lists for it, or `'gone'`. */
    function mockIam(
      membership: Record<string, string[] | 'gone'>,
      opts: { groupGone?: boolean; listError?: Error } = {}
    ): void {
      mockSend.mockReset();
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof ListGroupsForUserCommand) {
          if (opts.listError) return Promise.reject(opts.listError);
          const groups = membership[cmd.input.UserName!];
          if (groups === 'gone' || groups === undefined) {
            return Promise.reject(
              new NoSuchEntityException({ message: 'no user', $metadata: {} })
            );
          }
          return Promise.resolve({ Groups: groups.map((GroupName) => ({ GroupName })), IsTruncated: false });
        }
        if (cmd instanceof GetGroupCommand) {
          if (opts.groupGone) {
            return Promise.reject(new NoSuchEntityException({ message: 'no group', $metadata: {} }));
          }
          return Promise.resolve({ Group: { GroupName: cmd.input.GroupName, GroupId: 'AGPAEXAMPLE1234567890' }, Users: [] });
        }
        return Promise.reject(new Error(`unexpected ${String(cmd)}`));
      });
    }
    const read = (properties: Record<string, unknown>, context?: unknown) =>
      provider.readCurrentState('Addition', 'Addition', TYPE, properties, context as never);

    it('reads a clean membership back as the recorded GroupName and Users', async () => {
      mockIam({ alice: ['devs', 'other'], bob: ['devs'] });
      expect(await read({ GroupName: 'devs', Users: ['alice', 'bob'] })).toEqual({
        GroupName: 'devs',
        Users: ['alice', 'bob'],
      });
    });

    it('drops a user removed from the group out of band', async () => {
      mockIam({ alice: ['devs'], bob: ['other'] });
      expect(await read({ GroupName: 'devs', Users: ['alice', 'bob'] })).toEqual({
        GroupName: 'devs',
        Users: ['alice'],
      });
    });

    it('matches the group name case-insensitively, as IAM does', async () => {
      mockIam({ alice: ['Devs'] });
      expect(bagOf(await read({ GroupName: 'devs', Users: ['alice'] }))?.['Users']).toEqual(['alice']);
    });

    it('follows ListGroupsForUser pagination', async () => {
      mockSend.mockReset();
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof ListGroupsForUserCommand) {
          return Promise.resolve(
            cmd.input.Marker === 'm1'
              ? { Groups: [{ GroupName: 'devs' }], IsTruncated: false }
              : { Groups: [{ GroupName: 'x' }], IsTruncated: true, Marker: 'm1' }
          );
        }
        return Promise.reject(new Error('unexpected'));
      });
      expect(bagOf(await read({ GroupName: 'devs', Users: ['alice'] }))?.['Users']).toEqual(['alice']);
    });

    it('reads a user IAM no longer has as no member', async () => {
      mockIam({ alice: ['devs'], bob: 'gone' });
      expect(bagOf(await read({ GroupName: 'devs', Users: ['alice', 'bob'] }))?.['Users']).toEqual(['alice']);
    });

    it('reads every user removed from a group still there as Users: []', async () => {
      mockIam({ alice: [] });
      expect(await read({ GroupName: 'devs', Users: ['alice'] })).toEqual({ GroupName: 'devs', Users: [] });
    });

    it('is RESOURCE_NOT_FOUND when no user is in the group and the group is gone', async () => {
      mockIam({ alice: [] }, { groupGone: true });
      expect(await read({ GroupName: 'devs', Users: ['alice'] })).toBe(RESOURCE_NOT_FOUND);
    });

    it('throws a GetGroup failure other than not-found', async () => {
      const denied = Object.assign(new Error('denied'), { name: 'AccessDenied' });
      mockSend.mockReset();
      mockSend.mockImplementation((cmd: unknown) =>
        cmd instanceof ListGroupsForUserCommand
          ? Promise.resolve({ Groups: [], IsTruncated: false })
          : Promise.reject(denied)
      );
      await expect(read({ GroupName: 'devs', Users: ['alice'] })).rejects.toBe(denied);
    });

    it('reads Users: [] when GetGroup answers the group in another case', async () => {
      mockSend.mockReset();
      mockSend.mockImplementation((cmd: unknown) =>
        cmd instanceof ListGroupsForUserCommand
          ? Promise.resolve({ Groups: [], IsTruncated: false })
          : Promise.resolve({ Group: { GroupName: 'Devs', GroupId: 'AGPAEXAMPLE1234567890' }, Users: [] })
      );
      expect(await read({ GroupName: 'devs', Users: ['alice'] })).toEqual({ GroupName: 'devs', Users: [] });
    });

    it('reads a declared Users: [] with no call', async () => {
      mockIam({});
      expect(await read({ GroupName: 'devs', Users: [] })).toEqual({ GroupName: 'devs', Users: [] });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('throws a ListGroupsForUser failure other than not-found', async () => {
      const denied = Object.assign(new Error('denied'), { name: 'AccessDenied' });
      mockIam({}, { listError: denied });
      await expect(read({ GroupName: 'devs', Users: ['alice'] })).rejects.toBe(denied);
    });

    it.each([
      ['a redacted user', { GroupName: 'devs', Users: ['***'] }],
      ['a secret-derived user', { GroupName: 'devs', Users: ['{{resolve:secretsmanager:s}}'] }],
      ['a redacted group', { GroupName: '***', Users: ['alice'] }],
      ['no Users', { GroupName: 'devs' }],
      ['no properties', undefined],
    ])('is drift unknown, with no call, for %s', async (_label, properties) => {
      mockIam({ alice: ['devs'] });
      expect(
        await provider.readCurrentState('Addition', 'Addition', TYPE, properties as never)
      ).toBeUndefined();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('re-reads a declared user not listed yet on the capture after its own write', async () => {
      provider.ownWriteRereadDelaysMs = [0, 0];
      let calls = 0;
      mockSend.mockReset();
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof ListGroupsForUserCommand) {
          calls++;
          return Promise.resolve({ Groups: calls > 1 ? [{ GroupName: 'devs' }] : [], IsTruncated: false });
        }
        if (cmd instanceof GetGroupCommand) {
          return Promise.resolve({ Group: { GroupName: 'devs', GroupId: 'AGPAEXAMPLE1234567890' }, Users: [] });
        }
        return Promise.reject(new Error('unexpected'));
      });
      expect(
        bagOf(await read({ GroupName: 'devs', Users: ['alice'] }, { afterOwnWrite: true }))?.['Users']
      ).toEqual(['alice']);
      expect(calls).toBe(2);
    });
  });
});
