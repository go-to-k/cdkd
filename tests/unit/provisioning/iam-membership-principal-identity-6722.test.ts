/**
 * go-to-k/cdkd#6722: a membership is written by the principals' NAMES
 * (`AddRoleToInstanceProfile` / `RemoveRoleFromInstanceProfile`,
 * `AddUserToGroup` / `RemoveUserFromGroup`), so a same-named role, group or
 * user re-created out of band would join cdkd's profile or group, or be
 * removed from it. Every in-stack principal holding a usable recorded id is
 * compared first: an add held by another id refuses with nothing written; a
 * removal held by another id is warned about and skipped on an update, and
 * refuses the whole delete. Engine-fresh records, legacy (no id) records and
 * principals outside the stack read nothing.
 *
 * Every case drives a provider's real create / update / delete against a
 * mocked IAM client, inside the stack-records scope a deploy / destroy /
 * rollback binds.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { NoSuchEntityException } from '@aws-sdk/client-iam';

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

import { IAMInstanceProfileProvider } from '../../../src/provisioning/providers/iam-instance-profile-provider.js';
import { IAMUserGroupProvider } from '../../../src/provisioning/providers/iam-user-group-provider.js';
import { IAMPolicyProvider } from '../../../src/provisioning/providers/iam-policy-provider.js';
import { IAMManagedPolicyProvider } from '../../../src/provisioning/providers/iam-managed-policy-provider.js';
import {
  InlinePolicyAttachMismatchError,
  InlinePolicyPrincipalMismatchError,
  InlinePolicyPrincipalReadDeniedError,
} from '../../../src/provisioning/providers/iam-policy/principal-identity.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import {
  RECORDED_IDENTITY_REREAD_DELAY_MS,
  RecordedIdentityError,
} from '../../../src/provisioning/recorded-identity.js';
import {
  deployStackRecordsView,
  destroyStackRecordsView,
  replayStackRecordsView,
  withStackRecords,
  type StackRecordsView,
} from '../../../src/deployment/stack-records-scope.js';
import { isMarkedNotGone } from '../../../src/provisioning/not-gone.js';
import { stateOrphanRecordRemedy } from '../../../src/provisioning/state-orphan-remedy.js';
import type { ResourceState } from '../../../src/types/state.js';
import { getLogger } from '../../../src/utils/logger.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

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

const names = (): string[] => sent.map((s) => s.name);
const principalReads = (): string[] =>
  names().filter((n) => /^Get(Role|Group|User)Command$/.test(n));
const MEMBERSHIP_WRITE =
  /^(AddRoleToInstanceProfile|RemoveRoleFromInstanceProfile|AddUserToGroup|RemoveUserFromGroup)Command$/;
const membershipWrites = (): Array<Record<string, unknown>> =>
  sent.filter((s) => MEMBERSHIP_WRITE.test(s.name)).map((s) => ({ op: s.name, ...s.input }));
/** Every command other than a read or a list. */
const writes = (): string[] => names().filter((n) => !/^(Get|List)/.test(n));
const warned = (): string =>
  (getLogger().child('x').warn as unknown as ReturnType<typeof vi.fn>).mock.calls
    .map((c) => String(c[0]))
    .join('\n');

function record(
  resourceType: string,
  physicalId: string,
  attributes: Record<string, unknown> = {}
): ResourceState {
  return { resourceType, physicalId, properties: {}, attributes, dependencies: [] } as ResourceState;
}

const RECORDED = 'ID-recorded';
const SUCCESSOR = 'ID-successor';

/** Live ids by principal name, answered by every Get{Role,Group,User}. */
function liveIds(ids: Record<string, string | Error>): Record<string, Handler> {
  const answer = (name: unknown, wrap: (id: string) => unknown) => {
    const id = ids[String(name)];
    if (id === undefined) throw new NoSuchEntityException({ message: 'gone', $metadata: {} });
    if (id instanceof Error) throw id;
    return wrap(id);
  };
  return {
    GetRoleCommand: (i) => answer(i['RoleName'], (RoleId) => ({ Role: { RoleId } })),
    GetGroupCommand: (i) => answer(i['GroupName'], (GroupId) => ({ Group: { GroupId } })),
    GetUserCommand: (i) =>
      answer(i['UserName'], (UserId) => ({ User: { UserId, Arn: `arn:user/${String(UserId)}` } })),
  };
}

const settledDeploy = (records: Record<string, ResourceState>): StackRecordsView =>
  deployStackRecordsView(records, records, new Set(), undefined, undefined, () => false);
const freshDeploy = (records: Record<string, ResourceState>, fresh: string[]): StackRecordsView =>
  deployStackRecordsView(records, records, new Set(), undefined, undefined, (lid) =>
    fresh.includes(lid)
  );

/** Settles `promise`, letting every compare's re-read wait elapse (two may run in turn). */
async function settled(promise: Promise<unknown>): Promise<{ value?: unknown; error?: Error }> {
  const outcome = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error: error as Error })
  );
  await vi.advanceTimersByTimeAsync(RECORDED_IDENTITY_REREAD_DELAY_MS);
  await vi.advanceTimersByTimeAsync(RECORDED_IDENTITY_REREAD_DELAY_MS);
  return outcome;
}

async function thrownBy(promise: Promise<unknown>): Promise<Error> {
  const { error } = await settled(promise);
  if (error === undefined) throw new Error('expected a refusal');
  return error;
}

const denied = (): Error =>
  Object.assign(new Error('User arn:aws:iam::123:user/me is not authorized'), {
    name: 'AccessDenied',
    $metadata: { httpStatusCode: 403 },
  });

const role = record('AWS::IAM::Role', 'my-role', { RoleId: RECORDED });
const group = record('AWS::IAM::Group', 'my-group', { GroupId: RECORDED });
const user = record('AWS::IAM::User', 'my-user', { UserId: RECORDED });

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockReset();
  sent = [];
  vi.useFakeTimers({ toFake: ['setTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('AWS::IAM::InstanceProfile Roles (go-to-k/cdkd#6722)', () => {
  const PROFILE = {
    InstanceProfile: {
      InstanceProfileName: 'my-profile',
      InstanceProfileId: 'AIPA-profile',
      Arn: 'arn:aws:iam::1:instance-profile/my-profile',
      Roles: [],
    },
  };
  const profileHandlers = (ids: Record<string, string | Error>): Record<string, Handler> => ({
    ...liveIds(ids),
    CreateInstanceProfileCommand: () => PROFILE,
    GetInstanceProfileCommand: () => PROFILE,
  });
  const create = (view: StackRecordsView, roles: string[]) =>
    withStackRecords(view, () =>
      new IAMInstanceProfileProvider().create('IP', 'AWS::IAM::InstanceProfile', {
        InstanceProfileName: 'my-profile',
        Roles: roles,
      })
    );
  const update = (view: StackRecordsView, previous: string[], desired: string[]) =>
    withStackRecords(view, () =>
      new IAMInstanceProfileProvider().update(
        'IP',
        'my-profile',
        'AWS::IAM::InstanceProfile',
        { InstanceProfileName: 'my-profile', Roles: desired },
        { InstanceProfileName: 'my-profile', Roles: previous },
        {}
      )
    );

  it('create: an in-stack role carrying its RoleId is read before the profile is created', async () => {
    drive(profileHandlers({ 'my-role': RECORDED }));
    const { error } = await settled(create(settledDeploy({ R: role }), ['my-role']));
    expect(error).toBeUndefined();
    expect(names().slice(0, 3)).toEqual([
      'GetRoleCommand',
      'CreateInstanceProfileCommand',
      'AddRoleToInstanceProfileCommand',
    ]);
  });

  it('create: another RoleId refuses with nothing created, non-retryably, no values', async () => {
    drive(profileHandlers({ 'my-role': SUCCESSOR }));
    const error = await thrownBy(create(settledDeploy({ R: role }), ['my-role']));
    expect(writes()).toEqual([]);
    expect(error).toBeInstanceOf(InlinePolicyAttachMismatchError);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(isMarkedNotGone(error)).toBe(true);
    expect((error as RecordedIdentityError).resourceType).toBe('AWS::IAM::InstanceProfile');
    expect(error.message).toContain(
      'Cannot attach IAM instance profile IP to IAM role R (its RoleId differs)'
    );
    expect(error.message).toContain('added no membership (granting nothing)');
    expect(error.message).not.toContain(SUCCESSOR);
    expect(error.message).not.toContain(RECORDED);
  });

  it('create: a role this deploy created, a legacy record or an external role reads nothing', async () => {
    drive(profileHandlers({}));
    const legacy = record('AWS::IAM::Role', 'legacy-role');
    const { error } = await settled(
      create(freshDeploy({ R: role, L: legacy }, ['R']), ['my-role', 'legacy-role', 'external'])
    );
    expect(error).toBeUndefined();
    expect(principalReads()).toEqual([]);
    expect(membershipWrites().map((w) => w['RoleName'])).toEqual([
      'my-role',
      'legacy-role',
      'external',
    ]);
  });

  it('update: a role respelled only in case reads and writes nothing (go-to-k/cdkd#6774)', async () => {
    drive(profileHandlers({ 'my-role': SUCCESSOR, 'My-Role': SUCCESSOR }));
    const { error } = await settled(update(settledDeploy({ R: role }), ['my-role'], ['My-Role']));
    expect(error).toBeUndefined();
    expect(principalReads()).toEqual([]);
    expect(membershipWrites()).toEqual([]);
  });

  it('a template spelling the recorded name in another case is compared (IAM names ignore case)', async () => {
    drive(profileHandlers({ 'My-Role': SUCCESSOR }));
    const error = await thrownBy(create(settledDeploy({ R: role }), ['My-Role']));
    // Read (and re-read, as any mismatch is) by the template's spelling.
    expect(principalReads().length).toBeGreaterThan(0);
    expect(sent.filter((s) => s.name === 'GetRoleCommand').map((s) => s.input['RoleName'])).toEqual(
      principalReads().map(() => 'My-Role')
    );
    expect(writes()).toEqual([]);
    expect(error).toBeInstanceOf(InlinePolicyAttachMismatchError);
  });

  it('create: a failing role read (not a denial) is the provider\'s masked create failure', async () => {
    const throttle = Object.assign(new Error('Rate exceeded'), {
      name: 'Throttling',
      $metadata: { httpStatusCode: 400 },
    });
    drive(profileHandlers({ 'my-role': throttle }));
    const error = await thrownBy(create(settledDeploy({ R: role }), ['my-role']));
    expect(writes()).toEqual([]);
    expect(error).toBeInstanceOf(ProvisioningError);
    expect(error.message).toContain('Failed to create IAM instance profile IP');
  });

  it('update: an added role held by another RoleId refuses before any role write', async () => {
    drive(profileHandlers({ 'my-role': SUCCESSOR, 'old-role': RECORDED }));
    const old = record('AWS::IAM::Role', 'old-role', { RoleId: RECORDED });
    const error = await thrownBy(update(settledDeploy({ R: role, O: old }), ['old-role'], ['my-role']));
    expect(membershipWrites()).toEqual([]);
    expect(error).toBeInstanceOf(InlinePolicyAttachMismatchError);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(error.message).toContain('Cannot attach IAM instance profile IP to IAM role R');
  });

  it('update: a leaving role held by another RoleId is warned about and sent no removal', async () => {
    drive(profileHandlers({ 'my-role': SUCCESSOR }));
    const { error } = await settled(update(settledDeploy({ R: role }), ['my-role'], ['new-role']));
    expect(error).toBeUndefined();
    expect(membershipWrites()).toEqual([
      { op: 'AddRoleToInstanceProfileCommand', InstanceProfileName: 'my-profile', RoleName: 'new-role' },
    ]);
    expect(warned()).toContain(
      'IAM instance profile IP: the IAM role R leaving it is not the one cdkd created'
    );
    expect(warned()).not.toContain(SUCCESSOR);
  });

  it('update: a leaving role still the recorded one is removed after its read', async () => {
    drive(profileHandlers({ 'my-role': RECORDED }));
    const { error } = await settled(update(settledDeploy({ R: role }), ['my-role'], []));
    expect(error).toBeUndefined();
    expect(principalReads()).toEqual(['GetRoleCommand']);
    expect(membershipWrites().map((w) => w['op'])).toEqual(['RemoveRoleFromInstanceProfileCommand']);
  });

  it('update: a rollback replay re-adding a role held by another RoleId is refused', async () => {
    drive(profileHandlers({ 'my-role': SUCCESSOR }));
    const error = await thrownBy(update(replayStackRecordsView({ R: role }), [], ['my-role']));
    expect(membershipWrites()).toEqual([]);
    expect(error).toBeInstanceOf(InlinePolicyAttachMismatchError);
  });

  it('update: a denied role read refuses non-retryably, naming what to allow, without AWS text', async () => {
    drive(profileHandlers({ 'my-role': denied() }));
    const error = await thrownBy(update(settledDeploy({ R: role }), [], ['my-role']));
    expect(membershipWrites()).toEqual([]);
    expect(error).toBeInstanceOf(InlinePolicyPrincipalReadDeniedError);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(error.message).toContain(
      'Allow iam:GetRole for the identity running cdkd (an IAM policy, permission boundary, ' +
        'SCP or VPC endpoint policy may deny it)'
    );
    expect(error.message).not.toContain('Grant');
    expect(error.message).not.toContain('not authorized');
  });

  it('update: an expired token is not read as a missing permission', async () => {
    const expired = Object.assign(new Error('token expired'), {
      name: 'ExpiredToken',
      $metadata: { httpStatusCode: 403 },
    });
    drive(profileHandlers({ 'my-role': expired }));
    const error = await thrownBy(update(settledDeploy({ R: role }), [], ['my-role']));
    expect(membershipWrites()).toEqual([]);
    expect(error).not.toBeInstanceOf(InlinePolicyPrincipalReadDeniedError);
  });

  it('delete: removes the roles the live profile holds without reading any role', async () => {
    drive({
      ...liveIds({ 'my-role': SUCCESSOR }),
      GetInstanceProfileCommand: () => ({
        InstanceProfile: { ...PROFILE.InstanceProfile, Roles: [{ RoleName: 'my-role' }] },
      }),
    });
    const { error } = await settled(
      withStackRecords(destroyStackRecordsView({ R: role }), () =>
        new IAMInstanceProfileProvider().delete(
          'IP',
          'my-profile',
          'AWS::IAM::InstanceProfile',
          {},
          { recordedAttributes: { InstanceProfileId: 'AIPA-profile' } }
        )
      )
    );
    expect(error).toBeUndefined();
    expect(principalReads()).toEqual([]);
    expect(writes()).toEqual(['RemoveRoleFromInstanceProfileCommand', 'DeleteInstanceProfileCommand']);
  });
});

describe('AWS::IAM::UserToGroupAddition (go-to-k/cdkd#6722)', () => {
  const T = 'AWS::IAM::UserToGroupAddition';
  // A new bag per run: the per-run match cache is keyed by it.
  const records = (): Record<string, ResourceState> => ({ G: group, U: user });
  const create = (view: StackRecordsView, groupName: string, users: string[]) =>
    withStackRecords(view, () =>
      new IAMUserGroupProvider().create('UTG', T, { GroupName: groupName, Users: users })
    );
  const update = (
    view: StackRecordsView,
    previous: Record<string, unknown>,
    desired: Record<string, unknown>
  ) =>
    withStackRecords(view, () =>
      new IAMUserGroupProvider().update('UTG', 'UTG', T, desired, previous, {})
    );
  const remove = (view: StackRecordsView, properties: Record<string, unknown>) =>
    withStackRecords(view, () => new IAMUserGroupProvider().delete('UTG', 'UTG', T, properties, {}));

  it('create: the group and user both still the recorded ones: each read, then added', async () => {
    drive(liveIds({ 'my-group': RECORDED, 'my-user': RECORDED }));
    const { error } = await settled(create(settledDeploy(records()), 'my-group', ['my-user']));
    expect(error).toBeUndefined();
    expect(principalReads().sort()).toEqual(['GetGroupCommand', 'GetUserCommand']);
    expect(membershipWrites()).toEqual([
      { op: 'AddUserToGroupCommand', GroupName: 'my-group', UserName: 'my-user' },
    ]);
  });

  it.each([
    ['group', { 'my-group': SUCCESSOR, 'my-user': RECORDED }, 'IAM group G (its GroupId differs)'],
    ['user', { 'my-group': RECORDED, 'my-user': SUCCESSOR }, 'IAM user U (its UserId differs)'],
  ])('create: the %s held by another id refuses before any add', async (_kind, ids, named) => {
    drive(liveIds(ids));
    const error = await thrownBy(create(settledDeploy(records()), 'my-group', ['my-user']));
    expect(membershipWrites()).toEqual([]);
    expect(error).toBeInstanceOf(InlinePolicyAttachMismatchError);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect((error as RecordedIdentityError).resourceType).toBe(T);
    expect(error.message).toContain(`Cannot attach IAM UserToGroupAddition UTG to ${named}`);
    expect(error.message).toContain('added no membership');
    expect(error.message).not.toContain(SUCCESSOR);
  });

  it('create: a group and user this deploy created read nothing; the run caches a match', async () => {
    drive(liveIds({ 'my-group': RECORDED, 'my-user': RECORDED }));
    const fresh = freshDeploy(records(), ['G', 'U']);
    expect((await settled(create(fresh, 'my-group', ['my-user']))).error).toBeUndefined();
    expect(principalReads()).toEqual([]);
    const view = settledDeploy(records());
    sent = [];
    expect((await settled(create(view, 'my-group', ['my-user']))).error).toBeUndefined();
    expect((await settled(create(view, 'my-group', ['my-user']))).error).toBeUndefined();
    expect(principalReads().sort()).toEqual(['GetGroupCommand', 'GetUserCommand']);
  });

  it('update: a GroupName and user respelled only in case read and write nothing (go-to-k/cdkd#6774)', async () => {
    drive(liveIds({ 'my-group': SUCCESSOR, 'my-user': SUCCESSOR }));
    const { error } = await settled(
      update(
        settledDeploy(records()),
        { GroupName: 'my-group', Users: ['my-user'] },
        { GroupName: 'My-Group', Users: ['My-User'] }
      )
    );
    expect(error).toBeUndefined();
    expect(principalReads()).toEqual([]);
    expect(membershipWrites()).toEqual([]);
  });

  it('update: an added user held by another id refuses before any write', async () => {
    drive(liveIds({ 'my-group': RECORDED, 'my-user': SUCCESSOR }));
    const error = await thrownBy(
      update(
        settledDeploy(records()),
        { GroupName: 'my-group', Users: ['other'] },
        { GroupName: 'my-group', Users: ['other', 'my-user'] }
      )
    );
    expect(membershipWrites()).toEqual([]);
    expect(error).toBeInstanceOf(InlinePolicyAttachMismatchError);
  });

  it('update: a leaving user held by another id is warned about and kept in the group', async () => {
    drive(liveIds({ 'my-group': RECORDED, 'my-user': SUCCESSOR }));
    const { error } = await settled(
      update(
        settledDeploy(records()),
        { GroupName: 'my-group', Users: ['my-user', 'other'] },
        { GroupName: 'my-group', Users: ['new'] }
      )
    );
    expect(error).toBeUndefined();
    expect(membershipWrites()).toEqual([
      { op: 'AddUserToGroupCommand', GroupName: 'my-group', UserName: 'new' },
      { op: 'RemoveUserFromGroupCommand', GroupName: 'my-group', UserName: 'other' },
    ]);
    expect(warned()).toContain(
      'IAM UserToGroupAddition UTG: the IAM user U leaving it is not the one cdkd created'
    );
  });

  it('update: a moved group compares the old group for removals and the new one for adds', async () => {
    const newGroup = record('AWS::IAM::Group', 'new-group', { GroupId: RECORDED });
    drive(liveIds({ 'my-group': SUCCESSOR, 'new-group': RECORDED, other: 'x' }));
    const { error } = await settled(
      update(
        settledDeploy({ G: group, N: newGroup }),
        { GroupName: 'my-group', Users: ['other'] },
        { GroupName: 'new-group', Users: ['other'] }
      )
    );
    expect(error).toBeUndefined();
    expect(membershipWrites()).toEqual([
      { op: 'AddUserToGroupCommand', GroupName: 'new-group', UserName: 'other' },
    ]);
    expect(warned()).toContain('the IAM group G leaving it is not the one cdkd created');
  });

  it('delete: a user held by another id refuses before any removal, the record kept', async () => {
    drive(liveIds({ 'my-group': RECORDED, 'my-user': SUCCESSOR, other: 'x' }));
    const error = await thrownBy(
      remove(destroyStackRecordsView(records()), { GroupName: 'my-group', Users: ['other', 'my-user'] })
    );
    expect(membershipWrites()).toEqual([]);
    expect(error).toBeInstanceOf(InlinePolicyPrincipalMismatchError);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(isMarkedNotGone(error)).toBe(true);
    expect((error as RecordedIdentityError).resourceType).toBe(T);
    expect(error.message).toContain(
      'Cannot delete IAM UserToGroupAddition UTG from IAM user U (its UserId differs)'
    );
    expect(error.message).toContain('(its membership went with it)');
    expect(error.message).toContain(stateOrphanRecordRemedy({}, 'UTG'));
    expect(error.message).not.toContain(SUCCESSOR);
  });

  it('delete: a group held by another id refuses as well', async () => {
    drive(liveIds({ 'my-group': SUCCESSOR, 'my-user': RECORDED }));
    const error = await thrownBy(
      remove(destroyStackRecordsView(records()), { GroupName: 'my-group', Users: ['my-user'] })
    );
    expect(membershipWrites()).toEqual([]);
    expect(error).toBeInstanceOf(InlinePolicyPrincipalMismatchError);
    expect(error.message).toContain('from IAM group G (its GroupId differs)');
  });

  it('delete: both still the recorded ones, or gone: removed as before', async () => {
    drive(liveIds({ 'my-user': RECORDED }));
    const { error, value } = await settled(
      remove(destroyStackRecordsView(records()), { GroupName: 'my-group', Users: ['my-user'] })
    );
    expect(error).toBeUndefined();
    expect(value).toBeUndefined();
    expect(membershipWrites()).toEqual([
      { op: 'RemoveUserFromGroupCommand', GroupName: 'my-group', UserName: 'my-user' },
    ]);
  });

  it('delete: a denied read refuses non-retryably before any removal', async () => {
    drive(liveIds({ 'my-group': denied(), 'my-user': RECORDED }));
    const error = await thrownBy(
      remove(destroyStackRecordsView(records()), { GroupName: 'my-group', Users: ['my-user'] })
    );
    expect(membershipWrites()).toEqual([]);
    expect(error).toBeInstanceOf(InlinePolicyPrincipalReadDeniedError);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(error.message).toContain('Allow iam:GetGroup for the identity running cdkd');
  });
});

describe('AWS::IAM::User Groups (go-to-k/cdkd#6722)', () => {
  const T = 'AWS::IAM::User';
  const userHandlers = (ids: Record<string, string | Error>): Record<string, Handler> => ({
    ...liveIds(ids),
    CreateUserCommand: () => ({ User: { UserName: 'my-user', UserId: 'AIDA-new', Arn: 'arn' } }),
  });

  it('create: a group held by another GroupId refuses before CreateUser', async () => {
    drive(userHandlers({ 'my-group': SUCCESSOR }));
    const error = await thrownBy(
      withStackRecords(settledDeploy({ G: group }), () =>
        new IAMUserGroupProvider().create('NU', T, { UserName: 'my-user', Groups: ['my-group'] })
      )
    );
    expect(writes()).toEqual([]);
    expect(error).toBeInstanceOf(InlinePolicyAttachMismatchError);
    expect(error.message).toContain('Cannot attach IAM user NU to IAM group G (its GroupId differs)');
  });

  it('create: a failing group read (not a denial) is the provider\'s masked create failure', async () => {
    const throttle = Object.assign(new Error('Rate exceeded'), {
      name: 'Throttling',
      $metadata: { httpStatusCode: 400 },
    });
    drive(userHandlers({ 'my-group': throttle }));
    const error = await thrownBy(
      withStackRecords(settledDeploy({ G: group }), () =>
        new IAMUserGroupProvider().create('NU', T, { UserName: 'my-user', Groups: ['my-group'] })
      )
    );
    expect(writes()).toEqual([]);
    expect(error).toBeInstanceOf(ProvisioningError);
    expect(error.message).toContain('Failed to create IAM user NU');
  });

  it('create: a group still the recorded one is read, then joined', async () => {
    drive(userHandlers({ 'my-group': RECORDED }));
    const { error } = await settled(
      withStackRecords(settledDeploy({ G: group }), () =>
        new IAMUserGroupProvider().create('NU', T, { UserName: 'my-user', Groups: ['my-group'] })
      )
    );
    expect(error).toBeUndefined();
    expect(names()[0]).toBe('GetGroupCommand');
    expect(membershipWrites()).toEqual([
      { op: 'AddUserToGroupCommand', UserName: 'my-user', GroupName: 'my-group' },
    ]);
  });

  const update = (previous: string[], desired: string[]) =>
    withStackRecords(settledDeploy({ G: group }), () =>
      new IAMUserGroupProvider().update(
        'NU',
        'my-user',
        T,
        { UserName: 'my-user', Groups: desired },
        { UserName: 'my-user', Groups: previous },
        {}
      )
    );

  it('update: a joined group held by another GroupId refuses before any write', async () => {
    drive(userHandlers({ 'my-group': SUCCESSOR, 'my-user': 'AIDA' }));
    const error = await thrownBy(update([], ['my-group']));
    expect(writes()).toEqual([]);
    expect(error).toBeInstanceOf(InlinePolicyAttachMismatchError);
  });

  it('update: a group respelled only in case reads and writes nothing (go-to-k/cdkd#6774)', async () => {
    drive(userHandlers({ 'my-group': SUCCESSOR, 'my-user': 'AIDA' }));
    const { error } = await settled(update(['my-group'], ['My-Group']));
    expect(error).toBeUndefined();
    expect(principalReads().filter((n) => n !== 'GetUserCommand')).toEqual([]);
    expect(membershipWrites()).toEqual([]);
  });

  it('update: a left group listed in two spellings, held by another GroupId, loses neither (go-to-k/cdkd#6774)', async () => {
    drive(userHandlers({ 'my-group': SUCCESSOR, 'my-user': 'AIDA' }));
    const { error } = await settled(update(['my-group', 'MY-GROUP'], []));
    expect(error).toBeUndefined();
    expect(membershipWrites()).toEqual([]);
    expect(warned()).toContain('IAM user NU: the IAM group G leaving it is not the one cdkd created');
  });

  it('update: a left group held by another GroupId is warned about and sent no removal', async () => {
    drive(userHandlers({ 'my-group': SUCCESSOR, 'my-user': 'AIDA' }));
    const { error } = await settled(update(['my-group', 'other'], []));
    expect(error).toBeUndefined();
    expect(membershipWrites()).toEqual([
      { op: 'RemoveUserFromGroupCommand', UserName: 'my-user', GroupName: 'other' },
    ]);
    expect(warned()).toContain('IAM user NU: the IAM group G leaving it is not the one cdkd created');
  });
});

describe('principal names compare ignoring case (go-to-k/cdkd#6722)', () => {
  it('an inline policy put on `My-Role` compares the role recorded as `my-role`', async () => {
    drive(liveIds({ 'My-Role': SUCCESSOR }));
    const error = await thrownBy(
      withStackRecords(settledDeploy({ R: role }), () =>
        new IAMPolicyProvider().create('P', 'AWS::IAM::Policy', {
          PolicyName: 'inline',
          PolicyDocument: { Version: '2012-10-17', Statement: [] },
          Roles: ['My-Role'],
        })
      )
    );
    expect(writes()).toEqual([]);
    expect(error).toBeInstanceOf(InlinePolicyAttachMismatchError);
  });

  it('a managed policy whose Roles change only in case compares nothing, as it sends nothing', async () => {
    // go-to-k/cdkd#6774: `My-Role` is the attached `my-role`, so
    // `updatePrincipals` sends it no attach and no detach, and the compare
    // reads nothing: no write is left for another holder to receive.
    drive(liveIds({ 'My-Role': SUCCESSOR, 'my-role': SUCCESSOR }));
    const { value, error } = await settled(
      withStackRecords(settledDeploy({ R: role }), () =>
        new IAMManagedPolicyProvider().comparePrincipalChanges(
          'MP',
          'arn:aws:iam::1:policy/mp',
          { Roles: ['My-Role'] },
          { Roles: ['my-role'] },
          {
            debug: vi.fn(),
            warn: vi.fn(),
            mask: (t: string) => t,
            value: (t: unknown) => String(t),
          } as never
        )
      )
    );
    expect(error).toBeUndefined();
    expect([...(value as ReadonlySet<string>)]).toEqual([]);
    expect(principalReads()).toEqual([]);
  });

  it('a managed policy whose Roles name another role still compares the attach', async () => {
    drive(liveIds({ 'other-role': SUCCESSOR }));
    const error = await thrownBy(
      withStackRecords(
        settledDeploy({ R: role, O: record('AWS::IAM::Role', 'other-role', { RoleId: RECORDED }) }),
        () =>
          new IAMManagedPolicyProvider().comparePrincipalChanges(
            'MP',
            'arn:aws:iam::1:policy/mp',
            { Roles: ['other-role'] },
            { Roles: ['my-role'] },
            {
              debug: vi.fn(),
              warn: vi.fn(),
              mask: (t: string) => t,
              value: (t: unknown) => String(t),
            } as never
          )
      )
    );
    expect(error).toBeInstanceOf(InlinePolicyAttachMismatchError);
    expect(error.message).toContain('Cannot attach IAM managed policy MP to IAM role O');
  });
});
