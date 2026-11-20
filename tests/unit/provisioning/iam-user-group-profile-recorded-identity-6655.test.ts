/**
 * go-to-k/cdkd#6655: an IAM user / group / instance profile is addressed BY
 * NAME, so a same-named successor (the name deleted and taken again) answers
 * every call. Each now records its AWS-minted id (`UserId` / `GroupId` /
 * `InstanceProfileId`) at create, update and import, and the delete compares
 * it on the read it already makes (`GetUser` / `GetGroup` /
 * `GetInstanceProfile`) before ANY write: a differing id refuses.
 *
 * Every case drives the provider's real methods against a mocked IAM client
 * and reads the commands it sent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { NoSuchEntityException } from '@aws-sdk/client-iam';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    iam: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

import { IAMUserGroupProvider } from '../../../src/provisioning/providers/iam-user-group-provider.js';
import { IAMInstanceProfileProvider } from '../../../src/provisioning/providers/iam-instance-profile-provider.js';
import {
  isMarkedNonRetryable,
  isRetryableTransientError,
} from '../../../src/deployment/retryable-errors.js';
import {
  RECORDED_IDENTITY_REREAD_DELAY_MS,
  RecordedIdentityMismatchError,
} from '../../../src/provisioning/recorded-identity.js';
import {
  SURVIVOR_IDENTITY_ATTRIBUTES,
  attributesAfterUpdate,
} from '../../../src/deployment/recorded-identity-attributes.js';
import type { DeleteContext } from '../../../src/provisioning/region-check.js';
import { isMarkedNotGone } from '../../../src/provisioning/not-gone.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';

type Handler = (input: Record<string, unknown>) => unknown;

let sent: string[];
let inputs: Array<{ name: string; input: Record<string, unknown> }>;

function drive(handlers: Record<string, Handler>): void {
  mockSend.mockImplementation(
    async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = command.constructor.name;
      sent.push(name);
      inputs.push({ name, input: command.input });
      const handler = handlers[name];
      return handler ? handler(command.input) : {};
    }
  );
}

/** Settle `promise`, advancing past the mismatch re-read's wait. */
async function settled(promise: Promise<unknown>): Promise<{ error?: Error }> {
  const outcome = promise.then(
    () => ({}),
    (error: unknown) => ({ error: error as Error })
  );
  await vi.advanceTimersByTimeAsync(RECORDED_IDENTITY_REREAD_DELAY_MS);
  return outcome;
}

async function thrownBy(promise: Promise<unknown>): Promise<Error> {
  const { error } = await settled(promise);
  if (error === undefined) throw new Error('expected the delete to throw');
  return error;
}

function throttled(): Error {
  return Object.assign(new Error('Rate exceeded'), {
    name: 'Throttling',
    $metadata: { httpStatusCode: 400 },
  });
}

const gone = (): never => {
  throw new NoSuchEntityException({ $metadata: {}, message: 'gone' });
};

const NAME = 'my-entity';
const RECORDED = 'AIDARECORDED';
const SUCCESSOR = 'AIDASUCCESSOR';

/** Every IAM command that changes something: none may be sent on a refusal. */
const WRITES = /^(Delete|Detach|Remove|Put|Attach|Add|Create|Update)/;

interface TypeCase {
  type: 'AWS::IAM::User' | 'AWS::IAM::Group' | 'AWS::IAM::InstanceProfile';
  key: 'UserId' | 'GroupId' | 'InstanceProfileId';
  label: string;
  provider: () => IAMUserGroupProvider | IAMInstanceProfileProvider;
  read: string;
  deleteCommand: string;
  /** What the delete's read answers for a holder with `id`, with one member to strip. */
  live: (id: string | undefined, member?: string) => Record<string, Handler>;
  /** The strip whose target the delete's own read lists (none for the user). */
  strip?: { command: string; key: string };
  /** The exact commands an ordinary delete sends, in order (unchanged by #6655 but for order). */
  ordinary: string[];
  createProperties: Record<string, unknown>;
  createCommand: string;
  created: (id: string) => unknown;
}

const CASES: TypeCase[] = [
  {
    type: 'AWS::IAM::User',
    key: 'UserId',
    label: 'IAM user',
    provider: () => new IAMUserGroupProvider(),
    read: 'GetUserCommand',
    deleteCommand: 'DeleteUserCommand',
    live: (id) => ({
      GetUserCommand: () => ({ User: { UserName: NAME, UserId: id, Arn: `arn:user/${NAME}` } }),
      ListGroupsForUserCommand: () => ({ Groups: [{ GroupName: 'g' }] }),
      ListAttachedUserPoliciesCommand: () => ({ AttachedPolicies: [] }),
      ListUserPoliciesCommand: () => ({ PolicyNames: [] }),
      ListAccessKeysCommand: () => ({ AccessKeyMetadata: [] }),
    }),
    ordinary: [
      'GetUserCommand',
      'ListGroupsForUserCommand',
      'RemoveUserFromGroupCommand',
      'ListAttachedUserPoliciesCommand',
      'ListUserPoliciesCommand',
      'DeleteLoginProfileCommand',
      'ListAccessKeysCommand',
      'DeleteUserPermissionsBoundaryCommand',
      'DeleteUserCommand',
    ],
    createProperties: { UserName: NAME },
    createCommand: 'CreateUserCommand',
    created: (id) => ({ User: { UserName: NAME, UserId: id, Arn: `arn:user/${NAME}` } }),
  },
  {
    type: 'AWS::IAM::Group',
    key: 'GroupId',
    label: 'IAM group',
    provider: () => new IAMUserGroupProvider(),
    read: 'GetGroupCommand',
    deleteCommand: 'DeleteGroupCommand',
    live: (id, member = 'member') => ({
      GetGroupCommand: () => ({
        Group: { GroupName: NAME, GroupId: id, Arn: `arn:group/${NAME}` },
        Users: [{ UserName: member }],
      }),
      ListAttachedGroupPoliciesCommand: () => ({ AttachedPolicies: [] }),
      ListGroupPoliciesCommand: () => ({ PolicyNames: [] }),
    }),
    // `GetGroup` moved first (#6655); still ONE read, its members removed.
    strip: { command: 'RemoveUserFromGroupCommand', key: 'UserName' },
    ordinary: [
      'GetGroupCommand',
      'ListAttachedGroupPoliciesCommand',
      'ListGroupPoliciesCommand',
      'RemoveUserFromGroupCommand',
      'DeleteGroupCommand',
    ],
    createProperties: { GroupName: NAME },
    createCommand: 'CreateGroupCommand',
    created: (id) => ({ Group: { GroupName: NAME, GroupId: id, Arn: `arn:group/${NAME}` } }),
  },
  {
    type: 'AWS::IAM::InstanceProfile',
    key: 'InstanceProfileId',
    label: 'IAM instance profile',
    provider: () => new IAMInstanceProfileProvider(),
    read: 'GetInstanceProfileCommand',
    deleteCommand: 'DeleteInstanceProfileCommand',
    live: (id, member = 'r') => ({
      GetInstanceProfileCommand: () => ({
        InstanceProfile: {
          InstanceProfileName: NAME,
          InstanceProfileId: id,
          Arn: `arn:instance-profile/${NAME}`,
          Roles: [{ RoleName: member }],
        },
      }),
    }),
    strip: { command: 'RemoveRoleFromInstanceProfileCommand', key: 'RoleName' },
    ordinary: [
      'GetInstanceProfileCommand',
      'RemoveRoleFromInstanceProfileCommand',
      'DeleteInstanceProfileCommand',
    ],
    createProperties: { InstanceProfileName: NAME },
    createCommand: 'CreateInstanceProfileCommand',
    created: (id) => ({
      InstanceProfile: {
        InstanceProfileName: NAME,
        InstanceProfileId: id,
        Arn: `arn:instance-profile/${NAME}`,
      },
    }),
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockReset();
  sent = [];
  inputs = [];
  vi.useFakeTimers({ toFake: ['setTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe.each(CASES)('$type delete compares the recorded $key (go-to-k/cdkd#6655)', (t) => {
  const del = (context?: DeleteContext) =>
    t.provider().delete('E', NAME, t.type, undefined, context);
  const recorded = (value: unknown): DeleteContext => ({ recordedAttributes: { [t.key]: value } });

  it('the live holder carries the recorded id: deleted as before, the same calls', async () => {
    drive(t.live(RECORDED));
    await del(recorded(RECORDED));
    expect(sent).toEqual(t.ordinary);
  });

  it('another id under the name: refused, non-retryable, nothing written', async () => {
    drive(t.live(SUCCESSOR));
    const error = await thrownBy(del(recorded(RECORDED)));
    expect(error).toBeInstanceOf(RecordedIdentityMismatchError);
    expect(isMarkedNonRetryable(error)).toBe(true);
    // The read, and the one re-read after the wait: nothing else.
    expect(sent).toEqual([t.read, t.read]);
    expect(sent.some((name) => WRITES.test(name))).toBe(false);
    expect(error.message).toContain(`Cannot delete ${t.label} E`);
    expect(error.message).toContain(`${t.key} differs`);
    expect(error.message).toContain('kept the record');
    expect(error.message).toContain('cdkd state orphan');
    expect(error.message).toContain('--resource E');
    expect(error.message).not.toContain(RECORDED);
    expect(error.message).not.toContain(SUCCESSOR);
    // None of the already-deleted classifiers' needles.
    expect(error.message).not.toMatch(/does not exist|not found|NoSuchEntity/i);
  });

  it('a first read still answering the previous holder: the re-read decides, and it is deleted', async () => {
    let reads = 0;
    const first = t.live(SUCCESSOR)[t.read]!;
    const second = t.live(RECORDED)[t.read]!;
    drive({
      ...t.live(RECORDED),
      [t.read]: (input) => (++reads === 1 ? first(input) : second(input)),
    });
    const { error } = await settled(del(recorded(RECORDED)));
    expect(error).toBeUndefined();
    expect(sent.slice(0, 2)).toEqual([t.read, t.read]);
    expect(sent.at(-1)).toBe(t.deleteCommand);
  });

  it('gone by the re-read: the idempotent arm, nothing written', async () => {
    let reads = 0;
    const first = t.live(SUCCESSOR)[t.read]!;
    drive({ ...t.live(SUCCESSOR), [t.read]: (input) => (++reads === 1 ? first(input) : gone()) });
    const { error } = await settled(del({ ...recorded(RECORDED), expectedRegion: 'us-east-1' }));
    expect(error).toBeUndefined();
    expect(sent).toEqual([t.read, t.read]);
  });

  it('no id recorded (a legacy record): the by-name delete as before', async () => {
    drive(t.live(SUCCESSOR));
    await del({ recordedAttributes: { Arn: 'arn:x' } });
    expect(sent).toEqual(t.ordinary);
    sent = [];
    await del();
    expect(sent).toEqual(t.ordinary);
  });

  it.each(['***', 'AIDA-***-x', '{{resolve:secretsmanager:s}}', ''])(
    'a recorded %j is no id: the by-name delete as before',
    async (value) => {
      drive(t.live(SUCCESSOR));
      await del(recorded(value));
      expect(sent).toEqual(t.ordinary);
    }
  );

  it('the read throttled: thrown for the retry classifier, never a by-name delete', async () => {
    drive({ ...t.live(RECORDED), [t.read]: () => Promise.reject(throttled()) });
    const error = await thrownBy(del(recorded(RECORDED)));
    expect(isMarkedNonRetryable(error)).toBe(false);
    expect(isRetryableTransientError(error, error.message)).toBe(true);
    expect(sent).toEqual([t.read]);
  });

  it('the read answering without an id while one is recorded: thrown, nothing written', async () => {
    drive(t.live(undefined));
    const error = await thrownBy(del(recorded(RECORDED)));
    expect(error).not.toBeInstanceOf(RecordedIdentityMismatchError);
    expect(error.message).toContain(`without its ${t.key}`);
    expect(isMarkedNotGone(error)).toBe(true);
    expect(sent).toEqual([t.read]);
  });

  it('gone: the idempotent arm as before', async () => {
    drive({ [t.read]: gone });
    await del({ ...recorded(RECORDED), expectedRegion: 'us-east-1' });
    expect(sent).toEqual([t.read]);
    // A legacy record too: the one read, nothing else.
    sent = [];
    await del({ expectedRegion: 'us-east-1' });
    expect(sent).toEqual([t.read]);
  });

  it('a record holding the name in another case (an import): matched, deleted as before', async () => {
    drive(t.live(RECORDED));
    await t
      .provider()
      .delete('E', NAME.toUpperCase(), t.type, undefined, recorded(RECORDED));
    expect(sent.at(-1)).toBe(t.deleteCommand);
    expect(sent.filter((name) => name === t.read)).toHaveLength(1);
  });

  it('gone in another region than the recorded one: refused, not read as deleted', async () => {
    drive({ [t.read]: gone });
    await expect(del({ ...recorded(RECORDED), expectedRegion: 'eu-west-1' })).rejects.toThrow();
    expect(sent).toEqual([t.read]);
  });

  it('a read answering for another name while an id is recorded: thrown, nothing written', async () => {
    const live = t.live(RECORDED)[t.read]!;
    const renamed = (input: Record<string, unknown>) =>
      JSON.parse(JSON.stringify(live(input)).replaceAll(`"${NAME}"`, '"someone-else"')) as unknown;
    drive({ ...t.live(RECORDED), [t.read]: renamed });
    const error = await thrownBy(del(recorded(RECORDED)));
    expect(error.message).toContain(`without its ${t.key}`);
    expect(sent).toEqual([t.read]);
  });

  it.runIf(t.strip !== undefined)(
    'after a re-read, strips what the RE-READ listed, never the first holder\'s',
    async () => {
      let reads = 0;
      const first = t.live(SUCCESSOR, 'stranger-member')[t.read]!;
      const second = t.live(RECORDED, 'own-member')[t.read]!;
      drive({
        ...t.live(RECORDED),
        [t.read]: (input) => (++reads === 1 ? first(input) : second(input)),
      });
      const { error } = await settled(del(recorded(RECORDED)));
      expect(error).toBeUndefined();
      const stripped = inputs
        .filter((call) => call.name === t.strip!.command)
        .map((call) => call.input[t.strip!.key]);
      expect(stripped).toEqual(['own-member']);
    }
  );
});

describe.each(CASES)('$type records its $key (go-to-k/cdkd#6655)', (t) => {
  it('is listed for the delete compare and the rollback survivor check', () => {
    expect(SURVIVOR_IDENTITY_ATTRIBUTES[t.type]).toBe(t.key);
  });

  it('create records the id the create call answered with, from that response alone', async () => {
    drive({ [t.createCommand]: () => t.created(RECORDED) });
    const result = await t.provider().create('E', t.type, t.createProperties);
    expect(result.attributes?.[t.key]).toBe(RECORDED);
    // No read was added to the create.
    expect(sent).toEqual([t.createCommand]);
  });

  it('the recorded value is the resourceIdentity token, raw', async () => {
    drive({ [t.createCommand]: () => t.created(RECORDED), ...t.live(RECORDED) });
    const result = await t.provider().create('E', t.type, t.createProperties);
    const token = await t
      .provider()
      .resourceIdentity!(NAME, t.type, { expectedRegion: 'us-east-1' });
    expect(token).not.toBe(RESOURCE_NOT_FOUND);
    expect(token).toBe(result.attributes?.[t.key]);
  });

  it('a create answering no id records none (absent, never empty)', async () => {
    drive({ [t.createCommand]: () => t.created('') });
    const result = await t.provider().create('E', t.type, t.createProperties);
    expect(result.attributes !== undefined && Object.hasOwn(result.attributes, t.key)).toBe(false);
  });

  it('import records the id of the holder it verified', async () => {
    drive(t.live(RECORDED));
    const result = await t.provider().import!({
      logicalId: 'E',
      resourceType: t.type,
      stackName: 'S',
      region: 'us-east-1',
      properties: t.createProperties,
      knownPhysicalId: NAME,
    });
    expect(result?.attributes?.[t.key]).toBe(RECORDED);
  });

  it('update answers the id from the read it already makes; a legacy record acquires it, a recorded one is kept', async () => {
    drive(t.live(SUCCESSOR));
    const result = await t
      .provider()
      .update('E', NAME, t.type, t.createProperties, t.createProperties);
    expect(result.attributes?.[t.key]).toBe(SUCCESSOR);
    expect(sent.filter((name) => name === t.read)).toHaveLength(1);
    // Trust on first use: a record without the id takes the returned one.
    expect(attributesAfterUpdate(t.type, { Arn: 'arn:x' }, result)?.[t.key]).toBe(SUCCESSOR);
    // A recorded id is never replaced, and the difference is reported.
    const differing: string[] = [];
    const kept = attributesAfterUpdate(t.type, { [t.key]: RECORDED }, result, (attribute) =>
      differing.push(attribute)
    );
    expect(kept?.[t.key]).toBe(RECORDED);
    expect(differing).toEqual([t.key]);
  });
});
