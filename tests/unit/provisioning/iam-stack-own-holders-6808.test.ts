/**
 * go-to-k/cdkd#6808: a delete that may strip an IAM role's instance profiles
 * or a group's members (`stackHoldersStillAttached`: a same-name re-create's
 * delete-first, a rollback delete of what the run created) strips only the
 * stack's OWN holders, those the records bound around it name. Any other
 * holder is refused as on every other delete (go-to-k/cdkd#6750), as
 * CloudFormation's `DeleteConflict` does.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeleteConflictException } from '@aws-sdk/client-iam';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    iam: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn((): unknown => logger),
  };
  return { getLogger: () => logger };
});

import { IAMRoleProvider } from '../../../src/provisioning/providers/iam-role-provider.js';
import { IAMUserGroupProvider } from '../../../src/provisioning/providers/iam-user-group-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import {
  deployStackRecordsView,
  destroyStackRecordsView,
  replayStackRecordsView,
  withStackRecords,
  type StackRecordsView,
} from '../../../src/deployment/stack-records-scope.js';
import { isStackOwnHolder, stackOwnHolders } from '../../../src/provisioning/stack-own-holders.js';
import type { ResourceState } from '../../../src/types/state.js';

type Handler = (input: Record<string, unknown>) => unknown;
let sent: Array<{ name: string; input: Record<string, unknown> }>;

function drive(handlers: Record<string, Handler>): void {
  mockSend.mockImplementation(
    async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = command.constructor.name;
      sent.push({ name, input: command.input });
      const handler = handlers[name];
      return handler ? handler(command.input) : {};
    }
  );
}

const names = () => sent.map((call) => call.name);
const inputsOf = (name: string, key: string) =>
  sent.filter((call) => call.name === name).map((call) => call.input[key]);

const conflict = (): never => {
  throw new DeleteConflictException({ $metadata: {}, message: 'Cannot delete entity.' });
};

const record = (
  resourceType: string,
  physicalId: string,
  properties: Record<string, unknown>,
  attributes: Record<string, unknown> = {}
): ResourceState => ({ resourceType, physicalId, properties, attributes, dependencies: [] });

const view = (records: Record<string, ResourceState>): StackRecordsView =>
  destroyStackRecordsView(records);

const settle = <T>(promise: Promise<T>) =>
  promise.then(
    () => undefined,
    (e: unknown) => e as Error
  );

beforeEach(() => {
  vi.restoreAllMocks();
  mockSend.mockReset();
  sent = [];
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
    fn();
    return 0;
  }) as unknown as typeof setTimeout);
});

describe('stackOwnHolders reads the records bound around the delete', () => {
  it('no view bound: no holder, so the delete refuses rather than strips', () => {
    expect(stackOwnHolders('AWS::IAM::Role', 'my-role')).toEqual([]);
    expect(stackOwnHolders('AWS::IAM::Group', 'my-group')).toEqual([]);
  });

  it("a role's: the instance profiles whose Roles name it, by physical id and recorded id", () => {
    const holders = withStackRecords(
      view({
        Own: record(
          'AWS::IAM::InstanceProfile',
          'own-profile',
          { Roles: ['My-Role'] },
          { InstanceProfileId: 'AIPAOWN' }
        ),
        Legacy: record('AWS::IAM::InstanceProfile', 'legacy-profile', { Roles: ['my-role'] }),
        Other: record('AWS::IAM::InstanceProfile', 'other-profile', { Roles: ['other-role'] }),
        Masked: record('AWS::IAM::InstanceProfile', '***', { Roles: ['my-role'] }),
        NotAList: record('AWS::IAM::InstanceProfile', 'odd-profile', { Roles: 'my-role' }),
        // A user naming a group of the role's name is no holder of the role.
        User: record('AWS::IAM::User', 'u', { Groups: ['my-role'] }),
      }),
      () => stackOwnHolders('AWS::IAM::Role', 'my-role')
    );
    expect(holders).toEqual([{ name: 'own-profile', id: 'AIPAOWN' }, { name: 'legacy-profile' }]);
  });

  it("a group's: users whose Groups name it, and those a UserToGroupAddition naming it adds", () => {
    const holders = withStackRecords(
      view({
        Alice: record('AWS::IAM::User', 'alice', { Groups: ['MY-GROUP'] }, { UserId: 'AIDAALICE' }),
        Bob: record('AWS::IAM::User', 'bob', { Groups: ['other-group'] }),
        Addition: record('AWS::IAM::UserToGroupAddition', 'my-group-addition', {
          GroupName: 'my-group',
          Users: ['carol', '***'],
        }),
        OtherAddition: record('AWS::IAM::UserToGroupAddition', 'x', {
          GroupName: 'other-group',
          Users: ['dave'],
        }),
        Profile: record('AWS::IAM::InstanceProfile', 'p', { Roles: ['my-group'] }),
      }),
      () => stackOwnHolders('AWS::IAM::Group', 'my-group')
    );
    expect(holders).toEqual([{ name: 'alice', id: 'AIDAALICE' }, { name: 'carol' }]);
  });

  it("a replay's journaled failed writes count too: what the run attempted is the run's", () => {
    const replay = replayStackRecordsView({}, new Set(), [
      {
        resourceType: 'AWS::IAM::UserToGroupAddition',
        attemptedProperties: { GroupName: 'my-group', Users: ['u1'] },
      },
      {
        resourceType: 'AWS::IAM::InstanceProfile',
        physicalId: 'half-made-profile',
        attemptedProperties: { Roles: ['my-role'] },
      },
    ]);
    expect(withStackRecords(replay, () => stackOwnHolders('AWS::IAM::Group', 'my-group'))).toEqual(
      [{ name: 'u1' }]
    );
    expect(withStackRecords(replay, () => stackOwnHolders('AWS::IAM::Role', 'my-role'))).toEqual([
      { name: 'half-made-profile' },
    ]);
  });

  it("a deploy's view: a record whose update is in flight is not read", () => {
    const records = {
      Profile: record('AWS::IAM::InstanceProfile', 'p', { Roles: ['my-role'] }),
    };
    const settled = deployStackRecordsView(records, records, new Set());
    const inFlight = deployStackRecordsView(records, records, new Set(), () => true);
    expect(withStackRecords(settled, () => stackOwnHolders('AWS::IAM::Role', 'my-role'))).toEqual([
      { name: 'p' },
    ]);
    expect(withStackRecords(inFlight, () => stackOwnHolders('AWS::IAM::Role', 'my-role'))).toEqual(
      []
    );
  });

  it("a deploy's removal of a Retain holder: not the stack's to strip; a removal that deletes it still is", () => {
    const profile = (deletionPolicy?: 'Retain' | 'RetainExceptOnCreate' | 'Delete') => ({
      ...record('AWS::IAM::InstanceProfile', 'p', { Roles: ['my-role'] }),
      ...(deletionPolicy && { deletionPolicy }),
    });
    const user = (deletionPolicy?: 'Retain') => ({
      ...record('AWS::IAM::User', 'u', { Groups: ['my-group'] }),
      ...(deletionPolicy && { deletionPolicy }),
    });
    const leaving = (records: Record<string, ResourceState>) =>
      deployStackRecordsView(records, records, new Set(Object.keys(records)));
    const roleHolders = (p: ResourceState) =>
      withStackRecords(leaving({ P: p }), () => stackOwnHolders('AWS::IAM::Role', 'my-role'));
    const groupHolders = (u: ResourceState) =>
      withStackRecords(leaving({ U: u }), () => stackOwnHolders('AWS::IAM::Group', 'my-group'));
    expect(roleHolders(profile('Retain'))).toEqual([]);
    expect(roleHolders(profile('RetainExceptOnCreate'))).toEqual([]);
    expect(groupHolders(user('Retain'))).toEqual([]);
    expect(roleHolders(profile('Delete'))).toEqual([{ name: 'p' }]);
    expect(roleHolders(profile())).toEqual([{ name: 'p' }]);
    expect(groupHolders(user())).toEqual([{ name: 'u' }]);
    // Retain on a holder the deploy keeps: still the stack's.
    const kept = { P: profile('Retain') };
    expect(
      withStackRecords(deployStackRecordsView(kept, kept, new Set()), () =>
        stackOwnHolders('AWS::IAM::Role', 'my-role')
      )
    ).toEqual([{ name: 'p' }]);
  });

  it('a journaled failed create carries the identity it read back; one judged superseded names nothing', () => {
    const replay = replayStackRecordsView({}, new Set(), [
      {
        resourceType: 'AWS::IAM::User',
        physicalId: 'bob',
        attemptedProperties: { Groups: ['my-group'] },
        physicalIdRecoveredFromError: true,
        createdResourceIdentity: 'AIDABOB',
      },
      {
        resourceType: 'AWS::IAM::InstanceProfile',
        physicalId: 'half-made-profile',
        attemptedProperties: { Roles: ['my-role'] },
        createdResourceIdentity: 'AIPAHALF',
      },
      {
        resourceType: 'AWS::IAM::User',
        physicalId: 'superseded',
        attemptedProperties: { Groups: ['my-group'] },
        physicalIdRecoveredFromError: false,
      },
    ]);
    expect(withStackRecords(replay, () => stackOwnHolders('AWS::IAM::Group', 'my-group'))).toEqual(
      [{ name: 'bob', id: 'AIDABOB' }]
    );
    expect(withStackRecords(replay, () => stackOwnHolders('AWS::IAM::Role', 'my-role'))).toEqual([
      { name: 'half-made-profile', id: 'AIPAHALF' },
    ]);
  });

  it('isStackOwnHolder: by name ignoring case, and by the recorded id where one is', () => {
    const holders = [{ name: 'own', id: 'AIPAOWN' }, { name: 'legacy' }];
    expect(isStackOwnHolder(holders, 'OWN', 'AIPAOWN')).toBe(true);
    expect(isStackOwnHolder(holders, 'own', 'AIPASUCCESSOR')).toBe(false);
    expect(isStackOwnHolder(holders, 'own', undefined)).toBe(false);
    expect(isStackOwnHolder(holders, 'legacy', 'AIPAANY')).toBe(true);
    expect(isStackOwnHolder(holders, 'stranger', 'AIPAOWN')).toBe(false);
    // A second, id-less source of the same name (a UserToGroupAddition, a
    // journaled write) never waives the id another source recorded.
    const twice = [{ name: 'u', id: 'AIDAU' }, { name: 'U' }];
    expect(isStackOwnHolder(twice, 'u', 'AIDASTRANGER')).toBe(false);
    expect(isStackOwnHolder(twice, 'u', undefined)).toBe(false);
    expect(isStackOwnHolder(twice, 'u', 'AIDAU')).toBe(true);
  });
});

describe("IAM role delete-first: strips the stack's own profiles, refuses any other (#6808)", () => {
  const ownRecords = () =>
    view({
      Profile: record(
        'AWS::IAM::InstanceProfile',
        'stack-profile',
        { Roles: ['my-role'] },
        { InstanceProfileId: 'AIPASTACK' }
      ),
    });
  const listing =
    (...profiles: Array<[string, string]>): Handler =>
    () => ({
      InstanceProfiles: profiles.map(([InstanceProfileName, InstanceProfileId]) => ({
        InstanceProfileName,
        InstanceProfileId,
      })),
    });
  const base: Record<string, Handler> = {
    GetRoleCommand: () => ({ Role: { RoleName: 'my-role', RoleId: 'AROA' } }),
    ListAttachedRolePoliciesCommand: () => ({ AttachedPolicies: [] }),
    ListRolePoliciesCommand: () => ({ PolicyNames: [] }),
    GetInstanceProfileCommand: () => ({ InstanceProfile: { Roles: [{ RoleName: 'my-role' }] } }),
  };
  // `null`: no view bound at all.
  const deleteFirst = (records: StackRecordsView | null = ownRecords()) =>
    settle(
      withStackRecords(records ?? undefined, () =>
        new IAMRoleProvider().delete('Role', 'my-role', 'AWS::IAM::Role', undefined, {
          stackHoldersStillAttached: true,
          maskSecrets: (text: string) => text.replaceAll('outsider-profile', '***'),
        })
      )
    );

  it("an out-of-stack profile beside the stack's: refused by its masked name before anything is removed from either", async () => {
    drive({
      ...base,
      ListInstanceProfilesForRoleCommand: listing(
        ['stack-profile', 'AIPASTACK'],
        ['outsider-profile', 'AIPAOUT']
      ),
      ListAttachedRolePoliciesCommand: () => ({
        AttachedPolicies: [{ PolicyArn: 'arn:aws:iam::123456789012:policy/P' }],
      }),
      ListRolePoliciesCommand: () => ({ PolicyNames: ['inline'] }),
      DeleteRoleCommand: () => ({}),
    });

    const error = await deleteFirst();
    // Refused before anything changed: the role keeps its policies too.
    expect(names()).not.toContain('DetachRolePolicyCommand');
    expect(names()).not.toContain('DeleteRolePolicyCommand');

    expect(error).toBeInstanceOf(ProvisioningError);
    expect(error!.message).toContain(
      'role my-role is still in instance profile(s) ***, which this run did not delete'
    );
    expect(error!.message).not.toContain('outsider-profile');
    expect(error!.message).not.toContain('stack-profile');
    expect(isMarkedNonRetryable(error)).toBe(true);
    // The stack's own profile keeps the role its record says; no DeleteRole.
    expect(names()).not.toContain('RemoveRoleFromInstanceProfileCommand');
    expect(names()).not.toContain('DeleteRoleCommand');
    expect(inputsOf('GetInstanceProfileCommand', 'InstanceProfileName')).toEqual([
      'outsider-profile',
    ]);
  });

  it('an out-of-stack profile that drains during the settle is no refusal: the stack\'s is stripped, the role deleted', async () => {
    let listed = 0;
    drive({
      ...base,
      ListInstanceProfilesForRoleCommand: (input) =>
        listed++ === 0
          ? listing(['stack-profile', 'AIPASTACK'], ['deleted-profile', 'AIPAGONE'])(input)
          : listing(['stack-profile', 'AIPASTACK'])(input),
      DeleteRoleCommand: () => ({}),
    });

    expect(await deleteFirst()).toBeUndefined();
    expect(inputsOf('RemoveRoleFromInstanceProfileCommand', 'InstanceProfileName')).toEqual([
      'stack-profile',
    ]);
    expect(names().at(-1)).toBe('DeleteRoleCommand');
  });

  it("a listed outsider the confirm read shows no longer holding it: no refusal, and only the stack's profile is stripped", async () => {
    drive({
      ...base,
      ListInstanceProfilesForRoleCommand: listing(
        ['stack-profile', 'AIPASTACK'],
        ['lagging-profile', 'AIPALAG']
      ),
      // IAM's listing lags: the profile itself no longer holds the role.
      GetInstanceProfileCommand: () => ({ InstanceProfile: { Roles: [] } }),
      DeleteRoleCommand: () => ({}),
    });

    expect(await deleteFirst()).toBeUndefined();
    expect(inputsOf('RemoveRoleFromInstanceProfileCommand', 'InstanceProfileName')).toEqual([
      'stack-profile',
    ]);
  });

  it("a listing longer than one page is refused before anything changes, even when its first page is all the stack's", async () => {
    drive({
      ...base,
      ListInstanceProfilesForRoleCommand: () => ({
        InstanceProfiles: [{ InstanceProfileName: 'stack-profile', InstanceProfileId: 'AIPASTACK' }],
        IsTruncated: true,
      }),
      ListAttachedRolePoliciesCommand: () => ({
        AttachedPolicies: [{ PolicyArn: 'arn:aws:iam::123456789012:policy/P' }],
      }),
      DeleteRoleCommand: conflict,
    });

    const error = await deleteFirst();

    expect(names()).not.toContain('RemoveRoleFromInstanceProfileCommand');
    expect(names()).not.toContain('DetachRolePolicyCommand');
    expect(names()).not.toContain('DeleteRoleCommand');
    expect(error!.message).toContain(
      'still in instance profile(s) past the first page of the listing, which this run did not delete'
    );
  });

  it("the stack's profile gone by the settled listing is not stripped: the strip reads the LAST listing", async () => {
    let listed = 0;
    drive({
      ...base,
      ListInstanceProfilesForRoleCommand: (input) =>
        listed++ === 0
          ? listing(['stack-profile', 'AIPASTACK'], ['deleted-profile', 'AIPAGONE'])(input)
          : listing()(input),
      DeleteRoleCommand: () => ({}),
    });

    expect(await deleteFirst()).toBeUndefined();
    expect(names()).not.toContain('RemoveRoleFromInstanceProfileCommand');
  });

  it('a profile listing that fails (not NoSuchEntity) fails the delete before anything changes', async () => {
    const denied = Object.assign(new Error('not authorized'), { name: 'AccessDenied' });
    drive({
      ...base,
      ListInstanceProfilesForRoleCommand: () => {
        throw denied;
      },
      ListAttachedRolePoliciesCommand: () => ({
        AttachedPolicies: [{ PolicyArn: 'arn:aws:iam::123456789012:policy/P' }],
      }),
      DeleteRoleCommand: () => ({}),
    });

    const error = await deleteFirst();

    expect(error).toBeInstanceOf(ProvisioningError);
    expect(error!.message).not.toContain('which this run did not delete');
    expect(names()).not.toContain('DetachRolePolicyCommand');
    expect(names()).not.toContain('DeleteRoleCommand');
  });

  it("a refused removal from the stack's own profile is that failure, never a refusal naming it as outside the stack", async () => {
    const denied = Object.assign(new Error('not authorized'), { name: 'AccessDenied' });
    drive({
      ...base,
      ListInstanceProfilesForRoleCommand: listing(['stack-profile', 'AIPASTACK']),
      RemoveRoleFromInstanceProfileCommand: () => {
        throw denied;
      },
      DeleteRoleCommand: conflict,
    });

    const error = await deleteFirst();

    expect(error).toBeInstanceOf(ProvisioningError);
    expect(error!.message).not.toContain('which this run did not delete');
    expect(names()).not.toContain('DeleteRoleCommand');
  });

  it("a Retain profile the same deploy removes is no profile of the stack's: refused, never stripped", async () => {
    const leavingProfile = {
      Profile: {
        ...record(
          'AWS::IAM::InstanceProfile',
          'stack-profile',
          { Roles: ['my-role'] },
          { InstanceProfileId: 'AIPASTACK' }
        ),
        deletionPolicy: 'Retain' as const,
      },
    };
    drive({
      ...base,
      ListInstanceProfilesForRoleCommand: listing(['stack-profile', 'AIPASTACK']),
      DeleteRoleCommand: conflict,
    });

    const error = await deleteFirst(
      deployStackRecordsView(leavingProfile, leavingProfile, new Set(['Profile']))
    );

    expect(names()).not.toContain('RemoveRoleFromInstanceProfileCommand');
    expect(names()).not.toContain('DeleteRoleCommand');
    expect(error!.message).toContain(
      'instance profile(s) stack-profile, which this run did not delete (a profile created outside the stack, or retained by a DeletionPolicy)'
    );
  });

  it('a profile under the recorded name with another InstanceProfileId is not the stack\'s: refused, never stripped', async () => {
    drive({
      ...base,
      ListInstanceProfilesForRoleCommand: listing(['stack-profile', 'AIPASUCCESSOR']),
      DeleteRoleCommand: conflict,
    });

    const error = await deleteFirst();

    expect(names()).not.toContain('RemoveRoleFromInstanceProfileCommand');
    expect(names()).not.toContain('DeleteRoleCommand');
    expect(error!.message).toContain('instance profile(s) stack-profile, which this run did not');
  });

  it('no records bound: nothing is the stack\'s, so the profile is refused, never stripped', async () => {
    drive({
      ...base,
      ListInstanceProfilesForRoleCommand: listing(['stack-profile', 'AIPASTACK']),
      DeleteRoleCommand: conflict,
    });

    const error = await deleteFirst(null);

    expect(names()).not.toContain('RemoveRoleFromInstanceProfileCommand');
    expect(error!.message).toContain('which this run did not delete');
  });

  it("the stack's profile alone: stripped and deleted, with no settle", async () => {
    drive({
      ...base,
      ListInstanceProfilesForRoleCommand: listing(['stack-profile', 'AIPASTACK']),
      DeleteRoleCommand: () => ({}),
    });

    expect(await deleteFirst()).toBeUndefined();
    expect(inputsOf('RemoveRoleFromInstanceProfileCommand', 'InstanceProfileName')).toEqual([
      'stack-profile',
    ]);
    expect(names().filter((n) => n === 'ListInstanceProfilesForRoleCommand')).toHaveLength(1);
    expect(names().at(-1)).toBe('DeleteRoleCommand');
  });
});

describe("IAM group delete-first: strips the stack's own members, refuses any other (#6808)", () => {
  const ownRecords = () =>
    view({
      Alice: record('AWS::IAM::User', 'alice', { Groups: ['my-group'] }, { UserId: 'AIDAALICE' }),
      Addition: record('AWS::IAM::UserToGroupAddition', 'add', {
        GroupName: 'my-group',
        Users: ['carol'],
      }),
    });
  const group = (...users: Array<[string, string]>) => ({
    Group: { GroupName: 'my-group', GroupId: 'AGPA' },
    Users: users.map(([UserName, UserId]) => ({ UserName, UserId })),
  });
  const base: Record<string, Handler> = {
    ListAttachedGroupPoliciesCommand: () => ({ AttachedPolicies: [] }),
    ListGroupPoliciesCommand: () => ({ PolicyNames: [] }),
    ListGroupsForUserCommand: () => ({ Groups: [{ GroupName: 'my-group' }] }),
  };
  // `null`: no view bound at all.
  const deleteFirst = (records: StackRecordsView | null = ownRecords()) =>
    settle(
      withStackRecords(records ?? undefined, () =>
        new IAMUserGroupProvider().delete('Group', 'my-group', 'AWS::IAM::Group', undefined, {
          stackHoldersStillAttached: true,
          maskSecrets: (text: string) => text.replaceAll('outsider', '***'),
        })
      )
    );

  it("an out-of-stack user beside the stack's: refused by its masked name before any member is removed", async () => {
    drive({
      ...base,
      GetGroupCommand: () =>
        group(['alice', 'AIDAALICE'], ['carol', 'AIDACAROL'], ['outsider', 'AIDAOUT']),
      ListAttachedGroupPoliciesCommand: () => ({
        AttachedPolicies: [{ PolicyArn: 'arn:aws:iam::123456789012:policy/P' }],
      }),
      ListGroupPoliciesCommand: () => ({ PolicyNames: ['inline'] }),
      DeleteGroupCommand: () => ({}),
    });

    const error = await deleteFirst();
    // Refused before anything changed: the group keeps its policies too.
    expect(names()).not.toContain('DetachGroupPolicyCommand');
    expect(names()).not.toContain('DeleteGroupPolicyCommand');

    expect(error).toBeInstanceOf(ProvisioningError);
    expect(error!.message).toContain(
      'group my-group still has user(s) ***, whose membership this run did not remove'
    );
    expect(error!.message).not.toContain('outsider');
    expect(error!.message).not.toMatch(/alice|carol/);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(names()).not.toContain('RemoveUserFromGroupCommand');
    expect(names()).not.toContain('DeleteGroupCommand');
    expect(inputsOf('ListGroupsForUserCommand', 'UserName')).toEqual(['outsider']);
  });

  it("an out-of-stack user that drains during the settle is no refusal: the stack's are removed, the group deleted", async () => {
    let reads = 0;
    drive({
      ...base,
      GetGroupCommand: () =>
        reads++ === 0
          ? group(['alice', 'AIDAALICE'], ['gone-user', 'AIDAGONE'])
          : group(['alice', 'AIDAALICE']),
      DeleteGroupCommand: () => ({}),
    });

    expect(await deleteFirst()).toBeUndefined();
    expect(inputsOf('RemoveUserFromGroupCommand', 'UserName')).toEqual(['alice']);
    expect(names().at(-1)).toBe('DeleteGroupCommand');
  });

  it("a listed outsider ListGroupsForUser shows already out: no refusal, and only the stack's members are removed", async () => {
    drive({
      ...base,
      GetGroupCommand: () => group(['alice', 'AIDAALICE'], ['lagging', 'AIDALAG']),
      ListGroupsForUserCommand: () => ({ Groups: [] }),
      DeleteGroupCommand: () => ({}),
    });

    expect(await deleteFirst()).toBeUndefined();
    expect(inputsOf('RemoveUserFromGroupCommand', 'UserName')).toEqual(['alice']);
  });

  it("a member list longer than one page is refused before anything changes, even when its first page is all the stack's", async () => {
    drive({
      ...base,
      GetGroupCommand: () => ({ ...group(['alice', 'AIDAALICE']), IsTruncated: true }),
      ListAttachedGroupPoliciesCommand: () => ({
        AttachedPolicies: [{ PolicyArn: 'arn:aws:iam::123456789012:policy/P' }],
      }),
      DeleteGroupCommand: conflict,
    });

    const error = await deleteFirst();

    expect(names()).not.toContain('RemoveUserFromGroupCommand');
    expect(names()).not.toContain('DetachGroupPolicyCommand');
    expect(names()).not.toContain('DeleteGroupCommand');
    expect(error!.message).toContain(
      'still has user(s) past the first page of the listing, whose membership this run did not remove'
    );
  });

  it("the stack's member gone by the settled read is not removed: the removal reads the LAST read", async () => {
    let reads = 0;
    drive({
      ...base,
      GetGroupCommand: () =>
        reads++ === 0 ? group(['alice', 'AIDAALICE'], ['gone-user', 'AIDAGONE']) : group(),
      DeleteGroupCommand: () => ({}),
    });

    expect(await deleteFirst()).toBeUndefined();
    expect(names()).not.toContain('RemoveUserFromGroupCommand');
  });

  it("a Retain user the same deploy removes is no member of the stack's: refused, never removed", async () => {
    const leavingUser = {
      Alice: {
        ...record('AWS::IAM::User', 'alice', { Groups: ['my-group'] }, { UserId: 'AIDAALICE' }),
        deletionPolicy: 'Retain' as const,
      },
    };
    drive({ ...base, GetGroupCommand: () => group(['alice', 'AIDAALICE']), DeleteGroupCommand: conflict });

    const error = await deleteFirst(
      deployStackRecordsView(leavingUser, leavingUser, new Set(['Alice']))
    );

    expect(names()).not.toContain('RemoveUserFromGroupCommand');
    expect(names()).not.toContain('DeleteGroupCommand');
    expect(error!.message).toContain('still has user(s) alice, whose membership this run did not');
  });

  it("a journaled failed user beside a live same-named stranger: the stranger's UserId is not the journaled one, so refused", async () => {
    const replay = replayStackRecordsView({}, new Set(), [
      {
        resourceType: 'AWS::IAM::User',
        physicalId: 'bob',
        attemptedProperties: { Groups: ['my-group'] },
        physicalIdRecoveredFromError: true,
        createdResourceIdentity: 'AIDABOB',
      },
    ]);
    drive({ ...base, GetGroupCommand: () => group(['bob', 'AIDASTRANGER']), DeleteGroupCommand: conflict });

    const error = await deleteFirst(replay);

    expect(names()).not.toContain('RemoveUserFromGroupCommand');
    expect(error!.message).toContain('still has user(s) bob, whose membership this run did not');
  });

  it("a user under the stack user's name with another UserId is not the stack's: refused, never removed", async () => {
    drive({
      ...base,
      GetGroupCommand: () => group(['alice', 'AIDASUCCESSOR']),
      DeleteGroupCommand: conflict,
    });

    const error = await deleteFirst();

    expect(names()).not.toContain('RemoveUserFromGroupCommand');
    expect(names()).not.toContain('DeleteGroupCommand');
    expect(error!.message).toContain('still has user(s) alice, whose membership this run did not');
  });

  it("no records bound: nothing is the stack's, so the member is refused, never removed", async () => {
    drive({ ...base, GetGroupCommand: () => group(['alice', 'AIDAALICE']), DeleteGroupCommand: conflict });

    const error = await deleteFirst(null);

    expect(names()).not.toContain('RemoveUserFromGroupCommand');
    expect(error!.message).toContain('whose membership this run did not remove');
  });

  it("the stack's members alone: removed and deleted, with no settle", async () => {
    drive({
      ...base,
      GetGroupCommand: () => group(['alice', 'AIDAALICE'], ['carol', 'AIDACAROL']),
      DeleteGroupCommand: () => ({}),
    });

    expect(await deleteFirst()).toBeUndefined();
    expect(inputsOf('RemoveUserFromGroupCommand', 'UserName')).toEqual(['alice', 'carol']);
    expect(names().filter((n) => n === 'GetGroupCommand')).toHaveLength(1);
    expect(names().at(-1)).toBe('DeleteGroupCommand');
  });
});
