/**
 * go-to-k/cdkd#6722: an in-place update of an `AWS::IAM::Role`, `User`,
 * `Group` or `InstanceProfile` writes to it BY NAME (`UpdateRole`,
 * `Put*Policy`, `Attach*Policy`, tags, boundary, `UpdateUser` /
 * `UpdateGroup`, `AddRoleToInstanceProfile`, ...). A same-named one
 * re-created out of band would receive cdkd's change. With a usable recorded
 * identity id the update's own attribute read moves BEFORE its first write
 * and is compared: a mismatch refuses with nothing written; a record this
 * deploy created or replaced, a legacy record and a masked id read nothing
 * before the writes (the attribute read stays after them, as before).
 *
 * Every case drives the provider's real `update()` against a mocked IAM
 * client, inside the stack-records scope a deploy / rollback binds.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

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

import { IAMRoleProvider } from '../../../src/provisioning/providers/iam-role-provider.js';
import { IAMUserGroupProvider } from '../../../src/provisioning/providers/iam-user-group-provider.js';
import { IAMInstanceProfileProvider } from '../../../src/provisioning/providers/iam-instance-profile-provider.js';
import { IAMPolicyProvider } from '../../../src/provisioning/providers/iam-policy-provider.js';
import { OwnIdentityUpdateRefusal } from '../../../src/provisioning/providers/iam-policy/principal-identity.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import {
  RECORDED_IDENTITY_REREAD_DELAY_MS,
  RecordedIdentityError,
  reAdoptRemedy,
} from '../../../src/provisioning/recorded-identity.js';
import {
  deployStackRecordsView,
  replayStackRecordsView,
  withStackRecords,
  type StackRecordsView,
} from '../../../src/deployment/stack-records-scope.js';
import { isMarkedNotGone } from '../../../src/provisioning/not-gone.js';
import { stateOrphanRecordRemedy } from '../../../src/provisioning/state-orphan-remedy.js';
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

const names = (): string[] => sent.map((s) => s.name);
const READ = /^Get(Role|User|Group|InstanceProfile)Command$/;
/** The commands sent before the first write, and whether any write was sent. */
function readsBeforeFirstWrite(): string[] {
  const first = names().findIndex((n) => !READ.test(n) && !/^List/.test(n));
  return (first === -1 ? names() : names().slice(0, first)).filter((n) => READ.test(n));
}
const writes = (): string[] => names().filter((n) => !READ.test(n) && !/^List/.test(n));

const RECORDED = 'ID-recorded';
const SUCCESSOR = 'ID-successor';

function record(
  resourceType: string,
  physicalId: string,
  attributes: Record<string, unknown>
): ResourceState {
  return { resourceType, physicalId, properties: {}, attributes, dependencies: [] } as ResourceState;
}

const settledDeploy = (records: Record<string, ResourceState>): StackRecordsView =>
  deployStackRecordsView(records, records, new Set(), undefined, undefined, () => false);
const freshDeploy = (records: Record<string, ResourceState>, fresh: string[]): StackRecordsView =>
  deployStackRecordsView(records, records, new Set(), undefined, undefined, (lid) =>
    fresh.includes(lid)
  );

async function settled(promise: Promise<unknown>): Promise<{ value?: unknown; error?: Error }> {
  const outcome = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error: error as Error })
  );
  await vi.advanceTimersByTimeAsync(RECORDED_IDENTITY_REREAD_DELAY_MS);
  return outcome;
}

const DOC = { Version: '2012-10-17', Statement: [] };

interface Site {
  title: string;
  resourceType: string;
  attribute: string;
  label: string;
  permission: string;
  readCommand: string;
  /** The answer of the site's read for `id`. */
  answer: (id: string | undefined) => unknown;
  /** The attribute the update returns from that read. */
  returned: (attributes: Record<string, unknown> | undefined) => unknown;
  run: (recordedAttributes: Record<string, unknown> | undefined) => Promise<unknown>;
}

const SITES: Site[] = [
  {
    title: 'IAM role',
    resourceType: 'AWS::IAM::Role',
    attribute: 'RoleId',
    label: 'IAM role',
    permission: 'iam:GetRole',
    readCommand: 'GetRoleCommand',
    answer: (id) => ({ Role: { RoleId: id, Arn: 'arn:aws:iam::1:role/my-role' } }),
    returned: (a) => a?.['RoleId'],
    run: (recordedAttributes) =>
      new IAMRoleProvider().update(
        'R',
        'my-role',
        'AWS::IAM::Role',
        {
          RoleName: 'my-role',
          AssumeRolePolicyDocument: DOC,
          Description: 'v2',
          ManagedPolicyArns: ['arn:aws:iam::aws:policy/B'],
          Policies: [{ PolicyName: 'p', PolicyDocument: DOC }],
        },
        { RoleName: 'my-role', AssumeRolePolicyDocument: DOC, Description: 'v1' },
        recordedAttributes ? { recordedAttributes } : {}
      ),
  },
  {
    title: 'IAM user',
    resourceType: 'AWS::IAM::User',
    attribute: 'UserId',
    label: 'IAM user',
    permission: 'iam:GetUser',
    readCommand: 'GetUserCommand',
    answer: (id) => ({ User: { UserId: id, Arn: 'arn:aws:iam::1:user/my-user' } }),
    returned: (a) => a?.['UserId'],
    run: (recordedAttributes) =>
      new IAMUserGroupProvider().update(
        'U',
        'my-user',
        'AWS::IAM::User',
        {
          UserName: 'my-user',
          ManagedPolicyArns: ['arn:aws:iam::aws:policy/B'],
          Tags: [{ Key: 'k', Value: 'v2' }],
        },
        { UserName: 'my-user', Tags: [{ Key: 'k', Value: 'v1' }] },
        recordedAttributes ? { recordedAttributes } : {}
      ),
  },
  {
    title: 'IAM group',
    resourceType: 'AWS::IAM::Group',
    attribute: 'GroupId',
    label: 'IAM group',
    permission: 'iam:GetGroup',
    readCommand: 'GetGroupCommand',
    answer: (id) => ({ Group: { GroupId: id, Arn: 'arn:aws:iam::1:group/my-group' } }),
    returned: (a) => a?.['GroupId'],
    run: (recordedAttributes) =>
      new IAMUserGroupProvider().update(
        'G',
        'my-group',
        'AWS::IAM::Group',
        { GroupName: 'my-group', ManagedPolicyArns: ['arn:aws:iam::aws:policy/B'] },
        { GroupName: 'my-group' },
        recordedAttributes ? { recordedAttributes } : {}
      ),
  },
  {
    title: 'IAM instance profile',
    resourceType: 'AWS::IAM::InstanceProfile',
    attribute: 'InstanceProfileId',
    label: 'IAM instance profile',
    permission: 'iam:GetInstanceProfile',
    readCommand: 'GetInstanceProfileCommand',
    answer: (id) => ({
      InstanceProfile: {
        InstanceProfileName: 'my-profile',
        InstanceProfileId: id,
        Arn: 'arn:aws:iam::1:instance-profile/my-profile',
      },
    }),
    returned: (a) => a?.['InstanceProfileId'],
    run: (recordedAttributes) =>
      new IAMInstanceProfileProvider().update(
        'IP',
        'my-profile',
        'AWS::IAM::InstanceProfile',
        { InstanceProfileName: 'my-profile', Roles: ['role-b'] },
        { InstanceProfileName: 'my-profile', Roles: ['role-a'] },
        recordedAttributes ? { recordedAttributes } : {}
      ),
  },
];

const LOGICAL: Record<string, string> = {
  'AWS::IAM::Role': 'R',
  'AWS::IAM::User': 'U',
  'AWS::IAM::Group': 'G',
  'AWS::IAM::InstanceProfile': 'IP',
};
const PHYSICAL: Record<string, string> = {
  'AWS::IAM::Role': 'my-role',
  'AWS::IAM::User': 'my-user',
  'AWS::IAM::Group': 'my-group',
  'AWS::IAM::InstanceProfile': 'my-profile',
};

beforeEach(() => {
  sent = [];
  mockSend.mockReset();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe.each(SITES)('$title in-place update (go-to-k/cdkd#6722)', (site) => {
  const lid = LOGICAL[site.resourceType]!;
  const recorded = { [site.attribute]: RECORDED };
  const records = (): Record<string, ResourceState> => ({
    [lid]: record(site.resourceType, PHYSICAL[site.resourceType]!, recorded),
  });
  const live = (id: string | undefined | Error): void =>
    drive({
      [site.readCommand]: () => {
        if (id instanceof Error) throw id;
        return site.answer(id);
      },
    });

  it('a matching holder: one read, before the first write, and its answer is the result (no read added)', async () => {
    live(RECORDED);
    const { value, error } = await settled(
      withStackRecords(settledDeploy(records()), () => site.run(recorded))
    );
    expect(error).toBeUndefined();
    expect(readsBeforeFirstWrite()).toEqual([site.readCommand]);
    expect(names().filter((n) => n === site.readCommand)).toHaveLength(1);
    expect(writes().length).toBeGreaterThan(0);
    expect(site.returned((value as { attributes?: Record<string, unknown> }).attributes)).toBe(
      RECORDED
    );
  });

  it('another holder of the name: refused non-retryably with nothing written, the attribute named and no value', async () => {
    live(SUCCESSOR);
    const { error } = await settled(
      withStackRecords(settledDeploy(records()), () => site.run(recorded))
    );
    expect(error).toBeInstanceOf(OwnIdentityUpdateRefusal);
    expect(writes()).toEqual([]);
    // The read, then the re-read after the delay.
    expect(names()).toEqual([site.readCommand, site.readCommand]);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(isMarkedNotGone(error)).toBe(true);
    expect(error!.message).toContain(`Cannot update ${site.label} ${lid}:`);
    expect(error!.message).toContain(`its ${site.attribute} differs`);
    expect(error!.message).toContain(reAdoptRemedy(lid));
    expect(error!.message).toContain(stateOrphanRecordRemedy(undefined, lid));
    expect(error!.message).not.toContain(RECORDED);
    expect(error!.message).not.toContain(SUCCESSOR);
  });

  it('a rollback replay compares too (its view has no fresh records)', async () => {
    live(SUCCESSOR);
    const { error } = await settled(
      withStackRecords(replayStackRecordsView(records()), () => site.run(recorded))
    );
    expect(error).toBeInstanceOf(OwnIdentityUpdateRefusal);
    expect(writes()).toEqual([]);
  });

  it('no bound scope (drift --revert) still compares the recorded id', async () => {
    live(SUCCESSOR);
    const { error } = await settled(site.run(recorded));
    expect(error).toBeInstanceOf(OwnIdentityUpdateRefusal);
    expect(writes()).toEqual([]);
  });

  it('a record this deploy created or replaced: no read before the writes', async () => {
    live(SUCCESSOR);
    const { error } = await settled(
      withStackRecords(freshDeploy(records(), [lid]), () => site.run(recorded))
    );
    expect(error).toBeUndefined();
    expect(readsBeforeFirstWrite()).toEqual([]);
    expect(names().filter((n) => n === site.readCommand)).toHaveLength(1);
  });

  it.each([
    ['a legacy record (no id)', undefined],
    ['a masked id', { [site.attribute]: '***' }],
    ['a secret-reference id', { [site.attribute]: '{{resolve:ssm:x}}' }],
  ])('%s: by name as before, no read before the writes', async (_title, attributes) => {
    live(SUCCESSOR);
    const { error } = await settled(
      withStackRecords(settledDeploy(records()), () => site.run(attributes))
    );
    expect(error).toBeUndefined();
    expect(readsBeforeFirstWrite()).toEqual([]);
    expect(writes().length).toBeGreaterThan(0);
  });

  it('a denied read: refused non-retryably naming the permission and the error class, nothing written', async () => {
    const denied = Object.assign(new Error('User: arn:aws:sts::1:assumed-role/x is not authorized'), {
      name: 'AccessDenied',
      $metadata: { httpStatusCode: 403 },
    });
    live(denied);
    const { error } = await settled(
      withStackRecords(settledDeploy(records()), () => site.run(recorded))
    );
    expect(error).toBeInstanceOf(OwnIdentityUpdateRefusal);
    expect(writes()).toEqual([]);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(error!.message).toContain(site.permission);
    expect(error!.message).toContain('(AccessDenied)');
    expect(error!.message).not.toContain('assumed-role');
  });

  it('a credential or clock 403 is no permission refusal: the read failure is thrown as before, nothing written', async () => {
    const expired = Object.assign(new Error('The security token included in the request is expired'), {
      name: 'ExpiredToken',
      $metadata: { httpStatusCode: 403 },
    });
    live(expired);
    const { error } = await settled(
      withStackRecords(settledDeploy(records()), () => site.run(recorded))
    );
    expect(error).toBeDefined();
    expect(error).not.toBeInstanceOf(OwnIdentityUpdateRefusal);
    expect(error!.message).not.toContain(site.permission);
    expect(isMarkedNonRetryable(error)).toBe(false);
    expect(writes()).toEqual([]);
  });

  it('an answer without the id: a retryable refusal, nothing written', async () => {
    live(undefined);
    const { error } = await settled(
      withStackRecords(settledDeploy(records()), () => site.run(recorded))
    );
    expect(error).toBeInstanceOf(RecordedIdentityError);
    expect(writes()).toEqual([]);
    expect(isMarkedNonRetryable(error)).toBe(false);
    expect(error!.message).toContain(`Cannot update ${site.label} ${lid}:`);
  });

  it('a second update in the same run reads nothing before its writes (per-run cache)', async () => {
    live(RECORDED);
    const view = settledDeploy(records());
    await settled(withStackRecords(view, () => site.run(recorded)));
    sent = [];
    const { error } = await settled(withStackRecords(view, () => site.run(recorded)));
    expect(error).toBeUndefined();
    expect(readsBeforeFirstWrite()).toEqual([]);
  });

  it('a rejected compare is not cached: the next attempt reads again', async () => {
    live(SUCCESSOR);
    const view = settledDeploy(records());
    await settled(withStackRecords(view, () => site.run(recorded)));
    live(RECORDED);
    sent = [];
    const { error } = await settled(withStackRecords(view, () => site.run(recorded)));
    expect(error).toBeUndefined();
    expect(readsBeforeFirstWrite()).toEqual([site.readCommand]);
  });
});

describe('the cache is shared with the policy attach compare (go-to-k/cdkd#6722)', () => {
  it('a role compared by its own update is not read again by a policy put on it', async () => {
    drive({ GetRoleCommand: () => ({ Role: { RoleId: RECORDED, Arn: 'arn' } }) });
    const records = { R: record('AWS::IAM::Role', 'my-role', { RoleId: RECORDED }) };
    const view = settledDeploy(records);
    await settled(withStackRecords(view, () => SITES[0]!.run({ RoleId: RECORDED })));
    sent = [];
    const { error } = await settled(
      withStackRecords(view, () =>
        new IAMPolicyProvider().create('P', 'AWS::IAM::Policy', {
          PolicyName: 'inline',
          PolicyDocument: DOC,
          Roles: ['my-role'],
        })
      )
    );
    expect(error).toBeUndefined();
    expect(names()).toEqual(['PutRolePolicyCommand']);
  });

  it("a role update's rejected compare is dropped: a later policy put reads the role again", async () => {
    let id = SUCCESSOR;
    drive({ GetRoleCommand: () => ({ Role: { RoleId: id, Arn: 'arn' } }) });
    const records = { R: record('AWS::IAM::Role', 'my-role', { RoleId: RECORDED }) };
    const view = settledDeploy(records);
    const refused = await settled(withStackRecords(view, () => SITES[0]!.run({ RoleId: RECORDED })));
    expect(refused.error).toBeInstanceOf(OwnIdentityUpdateRefusal);
    id = RECORDED;
    sent = [];
    const { error } = await settled(
      withStackRecords(view, () =>
        new IAMPolicyProvider().create('P', 'AWS::IAM::Policy', {
          PolicyName: 'inline',
          PolicyDocument: DOC,
          Roles: ['my-role'],
        })
      )
    );
    expect(error).toBeUndefined();
    expect(names()).toEqual(['GetRoleCommand', 'PutRolePolicyCommand']);
  });
});

describe('a moved Path changes the Arn (go-to-k/cdkd#6722)', () => {
  it.each([
    ['AWS::IAM::User', 'U', 'my-user', 'UserName', 'UserId', 'GetUserCommand', 'User'],
    ['AWS::IAM::Group', 'G', 'my-group', 'GroupName', 'GroupId', 'GetGroupCommand', 'Group'],
  ])(
    '%s: compared before the move, then read again for the Arn after it',
    async (type, lid, name, nameKey, attribute, readCommand, member) => {
      let path = '/a/';
      drive({
        [readCommand]: () => ({
          [member]: { [attribute]: RECORDED, Arn: `arn:aws:iam::1:x${path}${name}` },
        }),
        UpdateUserCommand: () => {
          path = '/b/';
          return {};
        },
        UpdateGroupCommand: () => {
          path = '/b/';
          return {};
        },
      });
      const recorded = { [attribute]: RECORDED };
      const records = { [lid]: record(type, name, recorded) };
      const { value, error } = await settled(
        withStackRecords(settledDeploy(records), () =>
          new IAMUserGroupProvider().update(
            lid,
            name,
            type,
            { [nameKey]: name, Path: '/b/' },
            { [nameKey]: name, Path: '/a/' },
            { recordedAttributes: recorded }
          )
        )
      );
      expect(error).toBeUndefined();
      expect(readsBeforeFirstWrite()).toEqual([readCommand]);
      expect(names().filter((n) => n === readCommand)).toHaveLength(2);
      expect((value as { attributes: Record<string, unknown> }).attributes['Arn']).toBe(
        `arn:aws:iam::1:x/b/${name}`
      );
    }
  );
});

describe('an instance profile read answering for another profile (go-to-k/cdkd#6722)', () => {
  const recorded = { InstanceProfileId: RECORDED };
  const records = { IP: record('AWS::IAM::InstanceProfile', 'my-profile', recorded) };
  const answering = (name: string): void =>
    drive({
      GetInstanceProfileCommand: () => ({
        InstanceProfile: { InstanceProfileName: name, InstanceProfileId: RECORDED, Arn: 'arn' },
      }),
    });

  it('another name: no id of this profile, a retryable refusal with nothing written', async () => {
    answering('other-profile');
    const { error } = await settled(
      withStackRecords(settledDeploy(records), () => SITES[3]!.run(recorded))
    );
    expect(error).toBeInstanceOf(RecordedIdentityError);
    expect(isMarkedNonRetryable(error)).toBe(false);
    expect(writes()).toEqual([]);
  });

  it('the same name in another case names this profile: compared and written', async () => {
    answering('My-Profile');
    const { error } = await settled(
      withStackRecords(settledDeploy(records), () => SITES[3]!.run(recorded))
    );
    expect(error).toBeUndefined();
    expect(writes().length).toBeGreaterThan(0);
  });
});

describe('a policy put meeting a credential 403 on its principal read (go-to-k/cdkd#6722)', () => {
  it('is not refused as a missing permission', async () => {
    const expired = Object.assign(new Error('expired'), {
      name: 'ExpiredToken',
      $metadata: { httpStatusCode: 403 },
    });
    drive({
      GetRoleCommand: () => {
        throw expired;
      },
    });
    const records = { R: record('AWS::IAM::Role', 'my-role', { RoleId: RECORDED }) };
    const { error } = await settled(
      withStackRecords(settledDeploy(records), () =>
        new IAMPolicyProvider().create('P', 'AWS::IAM::Policy', {
          PolicyName: 'inline',
          PolicyDocument: DOC,
          Roles: ['my-role'],
        })
      )
    );
    expect(error).toBeDefined();
    expect(error!.message).not.toContain('iam:GetRole');
    expect(isMarkedNonRetryable(error)).toBe(false);
    expect(names()).not.toContain('PutRolePolicyCommand');
  });
});
