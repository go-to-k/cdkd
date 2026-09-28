/**
 * Issue #2177 — the IAM family's masked log sinks.
 *
 * `AWS::IAM::Role`, `User`, `Group`, `UserToGroupAddition`, `Policy`,
 * `ManagedPolicy`, `InstanceProfile` and `AccessKey` interpolate names read off
 * the RESOLVED `properties` bag into their own log lines, which reach no engine
 * sink, and into paste-ready `aws iam ...` remediation commands. Each provider
 * now builds ONE sink set per operation (`createMaskedLogSinks`) from the
 * context's masker, masks every bag-derived value RAW before interpolating it,
 * and renders every command through `pasteableAwsCommand` with that masker.
 *
 * Every case asserts over the WHOLE transcript (every debug and warn line), not
 * one known line: the sink's promise is that a line added later is masked by
 * construction. Two secrets are used on purpose — a long one the message-level
 * mask alone would catch, and a THREE-character one it would not (the
 * substring arm's `MIN_NEEDLE_LENGTH` floor), which only the RAW value mask
 * reaches.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend, warnSpy, debugSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  warnSpy: vi.fn(),
  debugSpy: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    iam: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: debugSpy,
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: debugSpy,
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import { IAMRoleProvider } from '../../../src/provisioning/providers/iam-role-provider.js';
import { IAMUserGroupProvider } from '../../../src/provisioning/providers/iam-user-group-provider.js';
import { IAMPolicyProvider } from '../../../src/provisioning/providers/iam-policy-provider.js';
import { IAMManagedPolicyProvider } from '../../../src/provisioning/providers/iam-managed-policy-provider.js';
import { IAMInstanceProfileProvider } from '../../../src/provisioning/providers/iam-instance-profile-provider.js';
import { IAMAccessKeyProvider } from '../../../src/provisioning/providers/iam-access-key-provider.js';
import {
  createMaskedLogSinks,
  withDerivedNameMasks,
} from '../../../src/provisioning/masked-retry-logger.js';
import {
  generateResourceNameWithFallback,
  withStackName,
} from '../../../src/provisioning/resource-name.js';
import { WITHHELD_AWS_COMMAND } from '../../../src/provisioning/replacement-protection-advice.js';
import { NoSuchEntityException } from '@aws-sdk/client-iam';
import { createSecretMasker, SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import type { RecordedSecretValues } from '../../../src/deployment/secret-redaction.js';

/** A name-safe secret, long enough for the message-level substring arm. */
const SECRET = 'app-secret-name';
/** A secret BELOW the substring arm's floor: only a RAW value mask catches it. */
const SHORT = 'q7z';
/** A second long secret, for a replacement's OLD name. */
const OLD_SECRET = 'old-secret-name';
const SECRET_ARN = 'arn:aws:iam::111122223333:policy/secret-boundary';

function bagOf(...values: string[]): RecordedSecretValues {
  return new Map(values.map((v) => [v, `{{resolve:secretsmanager:${v}}}`]));
}

const maskSecrets = createSecretMasker(bagOf(SECRET, SHORT, OLD_SECRET, SECRET_ARN));
const PLAINTEXTS = [SECRET, SHORT, OLD_SECRET, SECRET_ARN];

const DOC = { Version: '2012-10-17', Statement: [] };

function allLines(): string {
  return [...warnSpy.mock.calls, ...debugSpy.mock.calls].map((c) => String(c[0])).join('\n');
}

/** Every plaintext is gone from the transcript, and the mask is there instead. */
function expectTranscriptMasked(): void {
  const lines = allLines();
  for (const plaintext of PLAINTEXTS) expect(lines).not.toContain(plaintext);
  expect(lines).toContain(SECRET_MASK);
}

/**
 * A plausible answer per IAM command, with the ARN built from the NAME the
 * request carried -- so a managed policy's ARN embeds the secret name exactly
 * as AWS's would. `failOn` rejects the named commands instead.
 */
function answerIam(
  failOn: Record<string, Error> = {},
  responses: Record<string, unknown> = {}
): void {
  mockSend.mockImplementation((command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = command.constructor.name;
    if (failOn[name]) return Promise.reject(failOn[name]);
    if (name in responses) {
      const answer = responses[name];
      return Promise.resolve(typeof answer === 'function' ? (answer as () => unknown)() : answer);
    }
    const input = command.input;
    switch (name) {
      case 'CreateRoleCommand':
      case 'GetRoleCommand':
        return Promise.resolve({
          Role: { Arn: `arn:aws:iam::111122223333:role/${String(input['RoleName'])}`, RoleId: 'AROA1' },
        });
      case 'CreateUserCommand':
      case 'GetUserCommand':
        return Promise.resolve({
          User: { Arn: `arn:aws:iam::111122223333:user/${String(input['UserName'])}` },
        });
      case 'CreateGroupCommand':
      case 'GetGroupCommand':
        return Promise.resolve({
          Group: { Arn: `arn:aws:iam::111122223333:group/${String(input['GroupName'])}` },
          Users: [],
        });
      case 'CreatePolicyCommand':
        return Promise.resolve({
          Policy: { Arn: `arn:aws:iam::111122223333:policy/${String(input['PolicyName'])}` },
        });
      case 'CreateInstanceProfileCommand':
      case 'GetInstanceProfileCommand':
        return Promise.resolve({
          InstanceProfile: {
            Arn: `arn:aws:iam::111122223333:instance-profile/${String(input['InstanceProfileName'])}`,
          },
        });
      case 'CreateAccessKeyCommand':
        return Promise.resolve({
          AccessKey: { AccessKeyId: 'AKIAEXAMPLEKEY', SecretAccessKey: 'not-the-secret-under-test' },
        });
      case 'ListAccessKeysCommand':
        return Promise.resolve({ AccessKeyMetadata: [] });
      case 'ListPolicyVersionsCommand':
        return Promise.resolve({ Versions: [] });
      default:
        return Promise.resolve({});
    }
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockReset();
});

describe('createMaskedLogSinks (issue #2177)', () => {
  it('masks a value RAW, which is the only arm that reaches a secret below the substring floor', () => {
    const log = createMaskedLogSinks({ debug: debugSpy, warn: warnSpy }, maskSecrets);
    // The premise: the finished-message mask alone leaves the short secret.
    expect(maskSecrets(`user ${SHORT} added`)).toContain(SHORT);
    log.debug(`user ${log.value(SHORT)} added`);
    expect(String(debugSpy.mock.calls[0]?.[0])).toBe(`user ${SECRET_MASK} added`);
  });

  it('renders a non-string value as `${value}` would, instead of throwing inside the masker', () => {
    const log = createMaskedLogSinks({ debug: debugSpy, warn: warnSpy }, maskSecrets);
    expect(log.value(42)).toBe('42');
    expect(log.value(undefined)).toBe('undefined');
  });

  it('routes both sinks through the masker, and is the identity when no masker was supplied', () => {
    const masked = createMaskedLogSinks({ debug: debugSpy, warn: warnSpy }, maskSecrets);
    masked.warn(`name ${SECRET}`);
    masked.debug(`name ${SECRET}`);
    expect(allLines()).not.toContain(SECRET);

    vi.clearAllMocks();
    const plain = createMaskedLogSinks({ debug: debugSpy, warn: warnSpy }, undefined);
    plain.warn(`name ${SECRET}`);
    expect(plain.value(SHORT)).toBe(SHORT);
    expect(allLines()).toContain(SECRET);
  });
});

describe('IAMRoleProvider (issue #2177)', () => {
  const TYPE = 'AWS::IAM::Role';

  it('masks the name, attached ARNs and inline policy names on every create() line', async () => {
    answerIam();
    await new IAMRoleProvider().create(
      'MyRole',
      TYPE,
      {
        RoleName: SECRET,
        AssumeRolePolicyDocument: DOC,
        ManagedPolicyArns: [SECRET_ARN],
        Policies: [{ PolicyName: SHORT, PolicyDocument: DOC }],
        Tags: [{ Key: 'k', Value: 'v' }],
      },
      { maskSecrets }
    );
    expectTranscriptMasked();
  });

  it('masks the AWS message it wraps, and keeps the unmasked cause for the retry classifiers', async () => {
    // An AWS SENTENCE never equals the plaintext, so this reaches only the
    // substring arm: a long secret is the one it can cover (see the SSM
    // provider's note on the same site).
    const original = new Error(`Role name ${SECRET} is invalid`);
    answerIam({ CreateRoleCommand: original });
    const error = await new IAMRoleProvider()
      .create('MyRole', TYPE, { RoleName: SECRET, AssumeRolePolicyDocument: DOC }, { maskSecrets })
      .then(
        () => {
          throw new Error('expected create() to reject');
        },
        (e: unknown) => e as Error & { cause?: unknown }
      );
    expect(error.message).toContain('Failed to create IAM role MyRole');
    expect(error.message).not.toContain(SECRET);
    expect(error.cause).toBe(original);
  });

  it('WITHHOLDS the cleanup commands for a secret-bearing name, and renders them for an ordinary one', async () => {
    answerIam({
      TagRoleCommand: new Error('TagRole boom'),
      ListAttachedRolePoliciesCommand: new Error('cleanup failed'),
    });
    await expect(
      new IAMRoleProvider().create(
        'MyRole',
        TYPE,
        { RoleName: SECRET, AssumeRolePolicyDocument: DOC, Tags: [{ Key: 'k', Value: 'v' }] },
        { maskSecrets }
      )
    ).rejects.toThrow('TagRole boom');
    const warnMsg = String(warnSpy.mock.calls[0]?.[0]);
    expect(warnMsg).toContain(WITHHELD_AWS_COMMAND);
    expect(warnMsg).not.toContain('aws iam delete-role');
    expectTranscriptMasked();

    // Control: the withholding is caused by the MASK, not by the code path.
    vi.clearAllMocks();
    await expect(
      new IAMRoleProvider().create(
        'MyRole',
        TYPE,
        { RoleName: 'ordinary-role', AssumeRolePolicyDocument: DOC, Tags: [{ Key: 'k', Value: 'v' }] },
        { maskSecrets }
      )
    ).rejects.toThrow('TagRole boom');
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('aws iam delete-role --role-name ordinary-role');
  });

  it('masks every in-place update() line', async () => {
    answerIam();
    await new IAMRoleProvider().update(
      'MyRole',
      SECRET,
      TYPE,
      {
        RoleName: SECRET,
        AssumeRolePolicyDocument: DOC,
        PermissionsBoundary: SECRET_ARN,
        ManagedPolicyArns: [SECRET_ARN],
        Policies: [{ PolicyName: SHORT, PolicyDocument: DOC }],
        Tags: [{ Key: 'k', Value: 'v' }],
      },
      {
        RoleName: SECRET,
        AssumeRolePolicyDocument: { Version: '2008-10-17', Statement: [] },
        ManagedPolicyArns: [],
        Policies: [{ PolicyName: 'gone', PolicyDocument: DOC }],
        Tags: [{ Key: 'old', Value: 'v' }],
      },
      { maskSecrets }
    );
    expectTranscriptMasked();
  });

  it('forwards the masker into the replacement create(), and masks the persisted orphan reason', async () => {
    answerIam();
    const provider = new IAMRoleProvider();
    // The OLD role's delete fails with AWS quoting its name back. Stubbed
    // rather than driven: `delete()` has no masker to receive (issue #2007),
    // so its OWN lines are that issue's residual, not this one's.
    vi.spyOn(provider, 'delete').mockRejectedValue(new Error(`cannot read role ${OLD_SECRET}`));
    const result = await provider.update(
      'MyRole',
      OLD_SECRET,
      TYPE,
      { RoleName: SECRET, AssumeRolePolicyDocument: DOC, ManagedPolicyArns: [SECRET_ARN] },
      { RoleName: OLD_SECRET, AssumeRolePolicyDocument: DOC },
      { maskSecrets }
    );
    expect(result.wasReplaced).toBe(true);
    expect(result.outcome).toBe('partial');
    // Positive marker first: the reason still says what survived.
    expect(result.reason).toContain('could not be deleted');
    expect(result.reason).not.toContain(OLD_SECRET);
    expectTranscriptMasked();
  });

  it('behaves exactly as before when no context is supplied -- the back-compatible default', async () => {
    answerIam();
    await new IAMRoleProvider().create('MyRole', TYPE, {
      RoleName: SECRET,
      AssumeRolePolicyDocument: DOC,
    });
    expect(allLines()).toContain(SECRET);
  });
});

describe('IAMUserGroupProvider (issue #2177)', () => {
  it('masks every AWS::IAM::User create() line, and withholds its cleanup commands', async () => {
    answerIam({
      PutUserPolicyCommand: new Error('PutUserPolicy boom'),
      ListGroupsForUserCommand: new Error('cleanup failed'),
    });
    await expect(
      new IAMUserGroupProvider().create(
        'MyUser',
        'AWS::IAM::User',
        {
          UserName: SECRET,
          PermissionsBoundary: SECRET_ARN,
          ManagedPolicyArns: [SECRET_ARN],
          Groups: [SHORT],
          Policies: [{ PolicyName: OLD_SECRET, PolicyDocument: DOC }],
        },
        { maskSecrets }
      )
    ).rejects.toThrow('PutUserPolicy boom');
    const warnMsg = String(warnSpy.mock.calls[0]?.[0]);
    expect(warnMsg).toContain(WITHHELD_AWS_COMMAND);
    expect(warnMsg).not.toContain('aws iam delete-user');
    expectTranscriptMasked();
  });

  it('masks every AWS::IAM::User update() line', async () => {
    answerIam();
    await new IAMUserGroupProvider().update(
      'MyUser',
      SECRET,
      'AWS::IAM::User',
      {
        UserName: SECRET,
        PermissionsBoundary: SECRET_ARN,
        LoginProfile: { Password: 'pw' },
        ManagedPolicyArns: [SECRET_ARN],
        Groups: [SHORT],
        Policies: [{ PolicyName: OLD_SECRET, PolicyDocument: DOC }],
        Tags: [{ Key: 'k', Value: 'v' }],
      },
      { UserName: SECRET, Tags: [{ Key: 'old', Value: 'v' }] },
      { maskSecrets }
    );
    expectTranscriptMasked();
  });

  it('masks every AWS::IAM::Group create() line, and withholds its cleanup command', async () => {
    answerIam({
      PutGroupPolicyCommand: new Error('PutGroupPolicy boom'),
      ListAttachedGroupPoliciesCommand: new Error('cleanup failed'),
    });
    await expect(
      new IAMUserGroupProvider().create(
        'MyGroup',
        'AWS::IAM::Group',
        {
          GroupName: SECRET,
          ManagedPolicyArns: [SECRET_ARN],
          Policies: [{ PolicyName: SHORT, PolicyDocument: DOC }],
        },
        { maskSecrets }
      )
    ).rejects.toThrow('PutGroupPolicy boom');
    const warnMsg = String(warnSpy.mock.calls[0]?.[0]);
    expect(warnMsg).toContain(WITHHELD_AWS_COMMAND);
    expect(warnMsg).not.toContain('aws iam delete-group');
    expectTranscriptMasked();
  });

  it('masks every AWS::IAM::Group update() line', async () => {
    answerIam();
    await new IAMUserGroupProvider().update(
      'MyGroup',
      SECRET,
      'AWS::IAM::Group',
      { GroupName: SECRET, ManagedPolicyArns: [SECRET_ARN], Policies: [{ PolicyName: SHORT, PolicyDocument: DOC }] },
      { GroupName: SECRET, ManagedPolicyArns: [], Policies: [{ PolicyName: OLD_SECRET, PolicyDocument: DOC }] },
      { maskSecrets }
    );
    expectTranscriptMasked();
  });

  it('masks every AWS::IAM::UserToGroupAddition create() and update() line', async () => {
    answerIam();
    const provider = new IAMUserGroupProvider();
    await provider.create(
      'Membership',
      'AWS::IAM::UserToGroupAddition',
      { GroupName: SHORT, Users: [SECRET] },
      { maskSecrets }
    );
    await provider.update(
      'Membership',
      'Membership',
      'AWS::IAM::UserToGroupAddition',
      { GroupName: SHORT, Users: [OLD_SECRET] },
      { GroupName: SHORT, Users: [SECRET] },
      { maskSecrets }
    );
    expectTranscriptMasked();
  });
});

describe('IAMPolicyProvider (issue #2177)', () => {
  const TYPE = 'AWS::IAM::Policy';

  it('masks the policy name and every principal on create() and update()', async () => {
    answerIam();
    const provider = new IAMPolicyProvider();
    // Principals are IAM NAMES: an ARN-shaped entry is refused before any call
    // since go-to-k/cdkd#3878, so every principal here is a name.
    await provider.create(
      'MyPolicy',
      TYPE,
      { PolicyName: SECRET, PolicyDocument: DOC, Roles: [SHORT], Groups: [OLD_SECRET], Users: [SECRET] },
      { maskSecrets }
    );
    await provider.update(
      'MyPolicy',
      SECRET,
      TYPE,
      { PolicyName: SECRET, PolicyDocument: DOC, Roles: [SHORT] },
      { PolicyName: SECRET, PolicyDocument: DOC, Roles: [OLD_SECRET], Groups: [SHORT], Users: [SECRET] },
      { maskSecrets }
    );
    expectTranscriptMasked();
  });
});

describe('IAMManagedPolicyProvider (issue #2177)', () => {
  const TYPE = 'AWS::IAM::ManagedPolicy';

  it('masks the ARN embedding the secret name, and withholds its cleanup commands', async () => {
    answerIam({
      AttachRolePolicyCommand: new Error('AttachRolePolicy boom'),
      ListEntitiesForPolicyCommand: new Error('cleanup failed'),
    });
    await expect(
      new IAMManagedPolicyProvider().create(
        'MyManaged',
        TYPE,
        { ManagedPolicyName: SECRET, PolicyDocument: DOC, Groups: [SHORT], Roles: [OLD_SECRET] },
        { maskSecrets }
      )
    ).rejects.toThrow('AttachRolePolicy boom');
    const warnMsg = String(warnSpy.mock.calls[0]?.[0]);
    expect(warnMsg).toContain(WITHHELD_AWS_COMMAND);
    expect(warnMsg).not.toContain('aws iam delete-policy --policy-arn');
    expectTranscriptMasked();
  });

  it('masks every in-place update() line', async () => {
    const arn = `arn:aws:iam::111122223333:policy/${SECRET}`;
    answerIam();
    await new IAMManagedPolicyProvider().update(
      'MyManaged',
      arn,
      TYPE,
      { ManagedPolicyName: SECRET, PolicyDocument: DOC, Groups: [SHORT], Users: [OLD_SECRET] },
      {
        ManagedPolicyName: SECRET,
        PolicyDocument: { Version: '2008-10-17', Statement: [] },
        Groups: [],
        Roles: [SECRET_ARN],
      },
      { maskSecrets }
    );
    expectTranscriptMasked();
  });

  it('forwards the masker into the replacement create(), and masks the persisted orphan reason', async () => {
    const oldArn = `arn:aws:iam::111122223333:policy/${OLD_SECRET}`;
    answerIam();
    const provider = new IAMManagedPolicyProvider();
    // Stubbed for the reason the role case gives (issue #2007).
    vi.spyOn(provider, 'delete').mockRejectedValue(new Error(`cannot read ${oldArn}`));
    const result = await provider.update(
      'MyManaged',
      oldArn,
      TYPE,
      { ManagedPolicyName: SECRET, PolicyDocument: DOC, Roles: [SHORT] },
      { ManagedPolicyName: OLD_SECRET, PolicyDocument: DOC },
      { maskSecrets }
    );
    expect(result.outcome).toBe('partial');
    expect(result.reason).toContain('could not be deleted');
    expect(result.reason).not.toContain(OLD_SECRET);
    expectTranscriptMasked();
  });
});

describe('IAMInstanceProfileProvider (issue #2177)', () => {
  const TYPE = 'AWS::IAM::InstanceProfile';

  it('masks every create() line, and withholds its cleanup commands', async () => {
    answerIam({
      AddRoleToInstanceProfileCommand: new Error('AddRole boom'),
      DeleteInstanceProfileCommand: new Error('cleanup failed'),
    });
    await expect(
      new IAMInstanceProfileProvider().create(
        'MyProfile',
        TYPE,
        { InstanceProfileName: SECRET, Roles: [SHORT] },
        { maskSecrets }
      )
    ).rejects.toThrow('AddRole boom');
    const warnMsg = String(warnSpy.mock.calls[0]?.[0]);
    expect(warnMsg).toContain(WITHHELD_AWS_COMMAND);
    expect(warnMsg).not.toContain('aws iam delete-instance-profile');
    expectTranscriptMasked();
  });

  it('masks every update() line', async () => {
    answerIam();
    await new IAMInstanceProfileProvider().update(
      'MyProfile',
      SECRET,
      TYPE,
      { InstanceProfileName: SECRET, Roles: [SHORT] },
      { InstanceProfileName: SECRET, Roles: [OLD_SECRET] },
      { maskSecrets }
    );
    expectTranscriptMasked();
  });
});

describe('IAMAccessKeyProvider (issue #2177)', () => {
  const TYPE = 'AWS::IAM::AccessKey';

  it('masks the user name on every create() line, and withholds the list-access-keys command', async () => {
    answerIam({ ListAccessKeysCommand: new Error(`no access to ${SECRET}`) });
    await new IAMAccessKeyProvider().create('MyKey', TYPE, { UserName: SECRET }, { maskSecrets });
    const warnMsg = String(warnSpy.mock.calls[0]?.[0]);
    // Positive marker first: the warning fired and still says what to check.
    expect(warnMsg).toContain('Orphan detection is DISABLED');
    expect(warnMsg).toContain(WITHHELD_AWS_COMMAND);
    expect(warnMsg).not.toContain('aws iam list-access-keys');
    expectTranscriptMasked();
  });

  it('masks a SHORT user name too, which only the raw value mask reaches', async () => {
    answerIam({ ListAccessKeysCommand: new Error('AccessDenied') });
    await new IAMAccessKeyProvider().create('MyKey', TYPE, { UserName: SHORT }, { maskSecrets });
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('Orphan detection is DISABLED');
    expectTranscriptMasked();
  });

  it('masks the AWS message update() wraps, and every update() line', async () => {
    answerIam({ UpdateAccessKeyCommand: new Error(`user ${SECRET} not found`) });
    const error = await new IAMAccessKeyProvider()
      .update('MyKey', SHORT, TYPE, { UserName: SECRET }, { UserName: SECRET }, { maskSecrets })
      .then(
        () => {
          throw new Error('expected update() to reject');
        },
        (e: unknown) => e as Error
      );
    expect(error.message).toContain('Failed to update IAM access key MyKey');
    expect(error.message).not.toContain(SECRET);
    expectTranscriptMasked();
  });
});

/**
 * The names `generateResourceNameWithFallback` REWRITES (security review of
 * this change). A secret spelled outside `[A-Za-z0-9-]`, or longer than the
 * type's `maxLength`, reaches the log lines only in its derived form -- the
 * stack prefix, `-` for every other character, a truncation plus hash -- which
 * the literal masker cannot recognise by itself.
 */
describe('derived physical names (issue #2177 security review)', () => {
  const STACK = 'MyStack';
  /** A secret whose charset the name generator folds. */
  const FOLDED = 'alice@example.com';
  /** A secret longer than every IAM name's `maxLength`, so it is truncated and hashed. */
  const LONG = `Tok3n!${'x9'.repeat(70)}`;
  const derivedMasker = createSecretMasker(bagOf(FOLDED, LONG, SECRET_ARN));

  function derived(raw: string, maxLength: number): string {
    return withStackName(STACK, () =>
      generateResourceNameWithFallback(raw, 'Logical', { maxLength })
    );
  }

  it('adds a derived name as a needle ONLY when its raw value is a secret', () => {
    const base = createMaskedLogSinks({ debug: debugSpy, warn: warnSpy }, derivedMasker);
    const log = withDerivedNameMasks({ debug: debugSpy, warn: warnSpy }, base, [
      [FOLDED, 'MyStack-alice-example-com'],
      ['ordinary@example.com', 'MyStack-ordinary-example-com'],
    ]);
    log.debug('a MyStack-alice-example-com b MyStack-ordinary-example-com');
    expect(String(debugSpy.mock.calls[0]?.[0])).toBe(
      `a ${SECRET_MASK} b MyStack-ordinary-example-com`
    );
    // The extended masker is the one a pasteable command gets.
    expect(log.mask('arn:aws:iam::1:role/MyStack-alice-example-com')).toBe(
      `arn:aws:iam::1:role/${SECRET_MASK}`
    );
  });

  it.each([
    ['a folded', FOLDED],
    ['a truncated', LONG],
  ])('masks %s RoleName on every create() line and withholds its cleanup commands', async (_label, raw) => {
    const roleName = derived(raw, 64);
    expect(roleName).not.toBe(raw); // premise: the name really is rewritten
    answerIam({
      TagRoleCommand: new Error('TagRole boom'),
      ListAttachedRolePoliciesCommand: new Error('cleanup failed'),
    });
    await expect(
      withStackName(STACK, () =>
        new IAMRoleProvider().create(
          'MyRole',
          'AWS::IAM::Role',
          { RoleName: raw, AssumeRolePolicyDocument: DOC, Tags: [{ Key: 'k', Value: 'v' }] },
          { maskSecrets: derivedMasker }
        )
      )
    ).rejects.toThrow('TagRole boom');
    const lines = allLines();
    expect(lines).toContain('Created IAM role');
    expect(lines).not.toContain(roleName);
    expect(lines).not.toContain(raw);
    expect(lines).toContain(WITHHELD_AWS_COMMAND);
  });

  it('leaves an ordinary folded RoleName visible -- negative control', async () => {
    answerIam();
    await withStackName(STACK, () =>
      new IAMRoleProvider().create(
        'MyRole',
        'AWS::IAM::Role',
        { RoleName: 'ordinary@example.com', AssumeRolePolicyDocument: DOC },
        { maskSecrets: derivedMasker }
      )
    );
    expect(allLines()).toContain('MyStack-ordinary-example-com');
  });

  it('masks the derived name on the role update() path too', async () => {
    const roleName = derived(FOLDED, 64);
    answerIam();
    await withStackName(STACK, () =>
      new IAMRoleProvider().update(
        'MyRole',
        roleName,
        'AWS::IAM::Role',
        { RoleName: FOLDED, AssumeRolePolicyDocument: DOC, ManagedPolicyArns: [SECRET_ARN] },
        { RoleName: FOLDED, AssumeRolePolicyDocument: DOC },
        { maskSecrets: derivedMasker }
      )
    );
    expect(allLines()).toContain('Updating IAM role');
    expect(allLines()).not.toContain(roleName);
  });

  it.each([
    ['AWS::IAM::User', 'UserName', 64],
    ['AWS::IAM::Group', 'GroupName', 128],
  ] as const)('masks a derived %s name on create() and update()', async (type, key, maxLength) => {
    const name = derived(FOLDED, maxLength);
    answerIam();
    const provider = new IAMUserGroupProvider();
    await withStackName(STACK, async () => {
      await provider.create('Principal', type, { [key]: FOLDED, ManagedPolicyArns: [SECRET_ARN] }, {
        maskSecrets: derivedMasker,
      });
      await provider.update(
        'Principal',
        name,
        type,
        { [key]: FOLDED, ManagedPolicyArns: [SECRET_ARN] },
        { [key]: FOLDED, ManagedPolicyArns: [] },
        { maskSecrets: derivedMasker }
      );
    });
    expect(allLines()).toContain('Attached managed policy');
    expect(allLines()).not.toContain(name);
  });

  it('masks a derived instance-profile name on create() and update()', async () => {
    const name = derived(FOLDED, 128);
    answerIam();
    const provider = new IAMInstanceProfileProvider();
    await withStackName(STACK, async () => {
      await provider.create(
        'MyProfile',
        'AWS::IAM::InstanceProfile',
        { InstanceProfileName: FOLDED, Roles: ['r1'] },
        { maskSecrets: derivedMasker }
      );
      await provider.update(
        'MyProfile',
        name,
        'AWS::IAM::InstanceProfile',
        { InstanceProfileName: FOLDED, Roles: ['r2'] },
        { InstanceProfileName: FOLDED, Roles: ['r1'] },
        { maskSecrets: derivedMasker }
      );
    });
    expect(allLines()).toContain('Added role r2');
    expect(allLines()).not.toContain(name);
  });

  it('replaces the LONGER of two nested needles whole', () => {
    const base = createMaskedLogSinks({ debug: debugSpy, warn: warnSpy }, derivedMasker);
    const log = withDerivedNameMasks({ debug: debugSpy, warn: warnSpy }, base, [
      [FOLDED, 'MyStack-alice'],
      [LONG, 'MyStack-alice-example-com'],
    ]);
    // Shorter first would leave `***-example-com`.
    expect(log.mask('x MyStack-alice-example-com y')).toBe(`x ${SECRET_MASK} y`);
  });

  /**
   * ONE side secret-derived. The previous bag is what state holds: a secret
   * leaf is persisted as its `{{resolve:...}}` REFERENCE, and after a rotation
   * or a re-pointed reference its OLD plaintext is not in this deploy's bag.
   */
  const OLD_REF = '{{resolve:secretsmanager:old-name}}';
  const OLD_PLAIN = 'old.user@example.com';

  it.each([
    [
      'IAMRoleProvider',
      () => new IAMRoleProvider(),
      'AWS::IAM::Role',
      'RoleName',
      64,
      (name: string) => name,
      { AssumeRolePolicyDocument: DOC },
    ],
    [
      'IAMManagedPolicyProvider',
      () => new IAMManagedPolicyProvider(),
      'AWS::IAM::ManagedPolicy',
      'ManagedPolicyName',
      128,
      (name: string) => `arn:aws:iam::111122223333:policy/${name}`,
      { PolicyDocument: DOC },
    ],
  ] as const)(
    '%s masks the OLD derived name when only the PREVIOUS value is secret (a state reference)',
    async (_n, make, type, key, maxLength, physicalOf, rest) => {
      const oldName = derived(OLD_PLAIN, maxLength);
      answerIam();
      const provider = make();
      vi.spyOn(provider, 'delete').mockRejectedValue(new Error(`cannot delete ${oldName}`));
      const result = await withStackName(STACK, () =>
        provider.update(
          'Res',
          physicalOf(oldName),
          type,
          { [key]: 'ordinary-name', ...rest },
          { [key]: OLD_REF, ...rest },
          { maskSecrets: derivedMasker }
        )
      );
      // Premise: the masker cannot see the old plaintext at all.
      expect(derivedMasker(OLD_PLAIN)).toBe(OLD_PLAIN);
      expect(allLines()).toContain('replacing');
      expect(allLines()).toContain('MyStack-ordinary-name');
      expect(allLines()).not.toContain(oldName);
      expect(result.reason).not.toContain(oldName);
    }
  );

  it.each([
    ['IAMRoleProvider', () => new IAMRoleProvider(), 'AWS::IAM::Role', 'RoleName', 64, (n: string) => n, { AssumeRolePolicyDocument: DOC }],
    [
      'IAMManagedPolicyProvider',
      () => new IAMManagedPolicyProvider(),
      'AWS::IAM::ManagedPolicy',
      'ManagedPolicyName',
      128,
      (n: string) => `arn:aws:iam::111122223333:policy/${n}`,
      { PolicyDocument: DOC },
    ],
  ] as const)(
    '%s masks the NEW derived name when only the DESIRED value is secret',
    async (_n, make, type, key, maxLength, physicalOf, rest) => {
      const newName = derived(FOLDED, maxLength);
      answerIam();
      const provider = make();
      vi.spyOn(provider, 'delete').mockResolvedValue(undefined);
      await withStackName(STACK, () =>
        provider.update(
          'Res',
          physicalOf('MyStack-ordinary-name'),
          type,
          { [key]: FOLDED, ...rest },
          { [key]: 'ordinary-name', ...rest },
          { maskSecrets: derivedMasker }
        )
      );
      expect(allLines()).toContain('replacing');
      expect(allLines()).toContain('MyStack-ordinary-name');
      expect(allLines()).not.toContain(newName);
    }
  );

  it('masks a derived managed-policy name on an in-place update(), inside the ARN', async () => {
    const name = derived(FOLDED, 128);
    answerIam();
    await withStackName(STACK, () =>
      new IAMManagedPolicyProvider().update(
        'MyManaged',
        `arn:aws:iam::111122223333:policy/${name}`,
        'AWS::IAM::ManagedPolicy',
        { ManagedPolicyName: FOLDED, PolicyDocument: DOC, Roles: ['r1'] },
        { ManagedPolicyName: OLD_REF, PolicyDocument: { Version: '2008-10-17', Statement: [] } },
        { maskSecrets: derivedMasker }
      )
    );
    expect(allLines()).toContain('Updating IAM managed policy');
    expect(allLines()).not.toContain(name);
  });

  it('masks a derived managed-policy name on an in-place update() whose previous record names none', async () => {
    // e.g. an imported record: only the DESIRED pair can supply the needle.
    const name = derived(FOLDED, 128);
    answerIam();
    await withStackName(STACK, () =>
      new IAMManagedPolicyProvider().update(
        'MyManaged',
        `arn:aws:iam::111122223333:policy/${name}`,
        'AWS::IAM::ManagedPolicy',
        { ManagedPolicyName: FOLDED, PolicyDocument: DOC },
        { PolicyDocument: { Version: '2008-10-17', Statement: [] } },
        { maskSecrets: derivedMasker }
      )
    );
    expect(allLines()).toContain('Updated PolicyDocument');
    expect(allLines()).not.toContain(name);
  });

  it.each([
    ['AWS::IAM::User', 'UserName', 64],
    ['AWS::IAM::Group', 'GroupName', 128],
  ] as const)('masks a %s name recorded from a state REFERENCE on update()', async (type, key, maxLength) => {
    const name = derived(OLD_PLAIN, maxLength);
    answerIam();
    await withStackName(STACK, () =>
      new IAMUserGroupProvider().update(
        'Principal',
        name,
        type,
        { [key]: 'ordinary-name', ManagedPolicyArns: ['arn:aws:iam::aws:policy/X'] },
        { [key]: OLD_REF, ManagedPolicyArns: [] },
        { maskSecrets: derivedMasker }
      )
    );
    expect(allLines()).toContain('Attached managed policy');
    expect(allLines()).not.toContain(name);
  });

  it.each([
    ['AWS::IAM::User', 'UserName', 64],
    ['AWS::IAM::Group', 'GroupName', 128],
  ] as const)('masks a %s name from the DESIRED value when the previous record names none', async (type, key, maxLength) => {
    // Only the desired pair can supply this needle (an imported record, say).
    const name = derived(FOLDED, maxLength);
    answerIam();
    await withStackName(STACK, () =>
      new IAMUserGroupProvider().update(
        'Principal',
        name,
        type,
        { [key]: FOLDED, ManagedPolicyArns: ['arn:aws:iam::aws:policy/X'] },
        { ManagedPolicyArns: [] },
        { maskSecrets: derivedMasker }
      )
    );
    expect(allLines()).toContain('Attached managed policy');
    expect(allLines()).not.toContain(name);
  });

  it('masks an instance-profile name from the DESIRED value when the previous record names none', async () => {
    const name = derived(FOLDED, 128);
    answerIam();
    await withStackName(STACK, () =>
      new IAMInstanceProfileProvider().update(
        'MyProfile',
        name,
        'AWS::IAM::InstanceProfile',
        { InstanceProfileName: FOLDED, Roles: ['r2'] },
        { Roles: ['r1'] },
        { maskSecrets: derivedMasker }
      )
    );
    expect(allLines()).toContain('Added role r2');
    expect(allLines()).not.toContain(name);
  });

  it('masks an instance-profile name recorded from a state REFERENCE on update()', async () => {
    const name = derived(OLD_PLAIN, 128);
    answerIam();
    await withStackName(STACK, () =>
      new IAMInstanceProfileProvider().update(
        'MyProfile',
        name,
        'AWS::IAM::InstanceProfile',
        { InstanceProfileName: 'ordinary-name', Roles: ['r2'] },
        { InstanceProfileName: OLD_REF, Roles: ['r1'] },
        { maskSecrets: derivedMasker }
      )
    );
    expect(allLines()).toContain('Added role r2');
    expect(allLines()).not.toContain(name);
  });

  it.each([
    ['AWS::IAM::User', 'UserName', 64],
    ['AWS::IAM::Group', 'GroupName', 128],
  ] as const)('masks a TRUNCATED %s name, derived with the create arm\'s own maxLength', async (type, key, maxLength) => {
    const name = derived(LONG, maxLength);
    expect(name.length).toBe(maxLength); // premise: truncated to exactly this type's cap
    answerIam();
    await withStackName(STACK, () =>
      new IAMUserGroupProvider().create('Principal', type, { [key]: LONG, ManagedPolicyArns: [SECRET_ARN] }, {
        maskSecrets: derivedMasker,
      })
    );
    expect(allLines()).toContain('Attached managed policy');
    expect(allLines()).not.toContain(name);
    // A needle built at the OTHER type's cap would be a different spelling.
    expect(name).not.toBe(derived(LONG, maxLength === 64 ? 128 : 64));
  });

  it('masks a derived managed-policy name, including inside its ARN', async () => {
    const name = derived(FOLDED, 128);
    answerIam();
    await withStackName(STACK, () =>
      new IAMManagedPolicyProvider().create(
        'MyManaged',
        'AWS::IAM::ManagedPolicy',
        { ManagedPolicyName: FOLDED, PolicyDocument: DOC, Roles: ['r1'] },
        { maskSecrets: derivedMasker }
      )
    );
    expect(allLines()).toContain('Created IAM managed policy: arn:aws:iam::111122223333:policy/');
    expect(allLines()).not.toContain(name);
  });
});

/**
 * The cleanup helpers' OWN lines (test-review gap): the cleanup-failure cases
 * above fail the FIRST list call, so the per-item lines never run.
 */
describe('partial-create cleanup that SUCCEEDS (issue #2177)', () => {
  it('masks every AWS::IAM::Role cleanup line', async () => {
    answerIam(
      { TagRoleCommand: new Error('TagRole boom') },
      {
        ListAttachedRolePoliciesCommand: { AttachedPolicies: [{ PolicyArn: SECRET_ARN }] },
        ListRolePoliciesCommand: { PolicyNames: [SHORT] },
      }
    );
    await expect(
      new IAMRoleProvider().create(
        'MyRole',
        'AWS::IAM::Role',
        { RoleName: SECRET, AssumeRolePolicyDocument: DOC, Tags: [{ Key: 'k', Value: 'v' }] },
        { maskSecrets }
      )
    ).rejects.toThrow('TagRole boom');
    expect(allLines()).toContain('Detached managed policy');
    expect(allLines()).toContain('Deleted inline policy');
    expectTranscriptMasked();
  });

  it('masks every AWS::IAM::User cleanup line', async () => {
    answerIam(
      { PutUserPolicyCommand: new Error('PutUserPolicy boom') },
      {
        ListGroupsForUserCommand: { Groups: [{ GroupName: SHORT }] },
        ListAttachedUserPoliciesCommand: { AttachedPolicies: [{ PolicyArn: SECRET_ARN }] },
        ListUserPoliciesCommand: { PolicyNames: [OLD_SECRET] },
      }
    );
    await expect(
      new IAMUserGroupProvider().create(
        'MyUser',
        'AWS::IAM::User',
        { UserName: SECRET, Policies: [{ PolicyName: 'p', PolicyDocument: DOC }] },
        { maskSecrets }
      )
    ).rejects.toThrow('PutUserPolicy boom');
    expect(allLines()).toContain('Removed user');
    expect(allLines()).toContain('Detached managed policy');
    expect(allLines()).toContain('Deleted inline policy');
    expectTranscriptMasked();
  });

  it('masks every AWS::IAM::Group cleanup line', async () => {
    answerIam(
      { PutGroupPolicyCommand: new Error('PutGroupPolicy boom') },
      {
        ListAttachedGroupPoliciesCommand: { AttachedPolicies: [{ PolicyArn: SECRET_ARN }] },
        ListGroupPoliciesCommand: { PolicyNames: [SHORT] },
      }
    );
    await expect(
      new IAMUserGroupProvider().create(
        'MyGroup',
        'AWS::IAM::Group',
        { GroupName: SECRET, Policies: [{ PolicyName: 'p', PolicyDocument: DOC }] },
        { maskSecrets }
      )
    ).rejects.toThrow('PutGroupPolicy boom');
    expect(allLines()).toContain('Detached managed policy');
    expect(allLines()).toContain('Deleted inline policy');
    expectTranscriptMasked();
  });
});

describe('IAMAccessKeyProvider paste-ready commands (issue #2177)', () => {
  const TYPE = 'AWS::IAM::AccessKey';

  function expectCommandsWithheld(marker: string): void {
    const warns = warnSpy.mock.calls.map((c) => String(c[0]));
    const line = warns.find((w) => w.includes(marker));
    expect(line, `a warning containing "${marker}"`).toBeDefined();
    expect(line).toContain(WITHHELD_AWS_COMMAND);
    expect(line).not.toContain('aws iam delete-access-key');
    // No `***` marker is owed here: on these arms the user name appears ONLY
    // inside the command, which is withheld whole.
    for (const plaintext of PLAINTEXTS) expect(allLines()).not.toContain(plaintext);
  }

  it('withholds the command after a partial CreateAccessKey response', async () => {
    answerIam(
      { DeleteAccessKeyCommand: new Error('delete failed') },
      { CreateAccessKeyCommand: { AccessKey: { AccessKeyId: 'AKIAPARTIAL' } } }
    );
    await expect(
      new IAMAccessKeyProvider().create('MyKey', TYPE, { UserName: SECRET }, { maskSecrets })
    ).rejects.toThrow('Failed to create IAM access key');
    expectCommandsWithheld('minted by a partial CreateAccessKey response');
  });

  it('withholds the command after the Inactive status wiring fails', async () => {
    answerIam({
      UpdateAccessKeyCommand: new Error('UpdateAccessKey boom'),
      // AWS quotes the user name back, so the cleanup-failure detail carries it.
      DeleteAccessKeyCommand: new Error(`The user with name ${SECRET} cannot be found.`),
    });
    await expect(
      new IAMAccessKeyProvider().create(
        'MyKey',
        TYPE,
        { UserName: SECRET, Status: 'Inactive' },
        { maskSecrets }
      )
    ).rejects.toThrow('UpdateAccessKey boom');
    expectCommandsWithheld('Failed to clean up partially-created IAM access key');
  });

  it('withholds the orphan-reconcile commands, on both the minted and the unattributable arm', async () => {
    let lists = 0;
    answerIam(
      {
        CreateAccessKeyCommand: new Error('response lost'),
        DeleteAccessKeyCommand: new Error('delete failed'),
      },
      {
        ListAccessKeysCommand: () =>
          ++lists === 1
            ? { AccessKeyMetadata: [] }
            : {
                AccessKeyMetadata: [
                  { AccessKeyId: 'AKIAMINTED', CreateDate: new Date() },
                  { AccessKeyId: 'AKIAOLDKEY', CreateDate: new Date(0) },
                ],
              },
      }
    );
    await expect(
      new IAMAccessKeyProvider().create('MyKey', TYPE, { UserName: SECRET }, { maskSecrets })
    ).rejects.toThrow('response lost');
    expectCommandsWithheld('Failed to delete the orphaned IAM access key AKIAMINTED');
    expectCommandsWithheld('IAM access key AKIAOLDKEY appeared on user');
  });
});

describe('the replacement create() context (issue #2177)', () => {
  it.each([
    [
      'IAMRoleProvider',
      () => new IAMRoleProvider(),
      'AWS::IAM::Role',
      'old-role',
      { RoleName: 'new-role', AssumeRolePolicyDocument: DOC },
      { RoleName: 'old-role', AssumeRolePolicyDocument: DOC },
    ],
    [
      'IAMManagedPolicyProvider',
      () => new IAMManagedPolicyProvider(),
      'AWS::IAM::ManagedPolicy',
      'arn:aws:iam::111122223333:policy/old-policy',
      { ManagedPolicyName: 'new-policy', PolicyDocument: DOC },
      { ManagedPolicyName: 'old-policy', PolicyDocument: DOC },
    ],
  ] as const)(
    '%s forwards ONLY the masker, never replayingState, even on a replay',
    async (_name, make, type, physicalId, desired, previous) => {
      answerIam();
      const provider = make();
      const createSpy = vi.spyOn(provider, 'create');
      vi.spyOn(provider, 'delete').mockResolvedValue(undefined);
      await provider.update('Res', physicalId, type, desired, previous, {
        maskSecrets,
        replayingState: true,
      });
      expect(createSpy).toHaveBeenCalledTimes(1);
      const forwarded = createSpy.mock.calls[0]?.[3] as Record<string, unknown>;
      expect(Object.keys(forwarded)).toEqual(['maskSecrets']);
      expect(typeof forwarded['maskSecrets']).toBe('function');
    }
  );

  it.each([
    ['IAMRoleProvider', () => new IAMRoleProvider(), 'AWS::IAM::Role', { RoleName: 'new-role', AssumeRolePolicyDocument: DOC }],
    [
      'IAMManagedPolicyProvider',
      () => new IAMManagedPolicyProvider(),
      'AWS::IAM::ManagedPolicy',
      { ManagedPolicyName: 'new-policy', PolicyDocument: DOC },
    ],
  ] as const)('%s masks the SKIPPED-delete orphan reason raw', async (_name, make, type, desired) => {
    answerIam();
    const provider = make();
    // The skip reason carries a long secret: only the WHOLE-reason mask reaches
    // it, since it is interpolated without the raw value mask.
    vi.spyOn(provider, 'delete').mockResolvedValue({
      outcome: 'skipped',
      reason: `held by ${OLD_SECRET}`,
    });
    // A SHORT old physical id: only the raw value mask reaches it.
    const result = await provider.update('Res', SHORT, type, desired, {}, { maskSecrets });
    expect(result.outcome).toBe('partial');
    expect(result.reason).toContain('was not deleted: held by');
    expect(result.reason).not.toContain(SHORT);
    expect(result.reason).not.toContain(OLD_SECRET);
    expectTranscriptMasked();
  });
});

describe('the wrapped AWS message on every IAM type (issue #2177)', () => {
  it.each([
    ['AWS::IAM::Policy', () => new IAMPolicyProvider(), 'PutRolePolicyCommand', { PolicyName: 'p', PolicyDocument: DOC, Roles: ['r'] }],
    ['AWS::IAM::InstanceProfile', () => new IAMInstanceProfileProvider(), 'CreateInstanceProfileCommand', { InstanceProfileName: 'ip' }],
    ['AWS::IAM::ManagedPolicy', () => new IAMManagedPolicyProvider(), 'CreatePolicyCommand', { ManagedPolicyName: 'mp', PolicyDocument: DOC }],
    ['AWS::IAM::User', () => new IAMUserGroupProvider(), 'CreateUserCommand', { UserName: 'u' }],
    ['AWS::IAM::Group', () => new IAMUserGroupProvider(), 'CreateGroupCommand', { GroupName: 'g' }],
    ['AWS::IAM::UserToGroupAddition', () => new IAMUserGroupProvider(), 'AddUserToGroupCommand', { GroupName: 'g', Users: ['u'] }],
  ] as const)('%s create() masks the message it wraps', async (type, make, command, properties) => {
    answerIam({ [command]: new Error(`quoted ${SECRET} back`) });
    const error = await make()
      .create('Res', type, { ...properties }, { maskSecrets })
      .then(
        () => {
          throw new Error('expected create() to reject');
        },
        (e: unknown) => e as Error
      );
    expect(error.message).toContain('quoted');
    expect(error.message).not.toContain(SECRET);
  });
});

describe('IAMManagedPolicyProvider version pruning (issue #2177)', () => {
  it('masks the prune line ensureVersionCapacity writes at the five-version cap', async () => {
    const arn = `arn:aws:iam::111122223333:policy/${SECRET}`;
    answerIam(
      {},
      {
        ListPolicyVersionsCommand: {
          Versions: [
            { VersionId: 'v1', IsDefaultVersion: false, CreateDate: new Date(1) },
            { VersionId: 'v2', IsDefaultVersion: false, CreateDate: new Date(2) },
            { VersionId: 'v3', IsDefaultVersion: false, CreateDate: new Date(3) },
            { VersionId: 'v4', IsDefaultVersion: false, CreateDate: new Date(4) },
            { VersionId: 'v5', IsDefaultVersion: true, CreateDate: new Date(5) },
          ],
        },
      }
    );
    await new IAMManagedPolicyProvider().update(
      'MyManaged',
      arn,
      'AWS::IAM::ManagedPolicy',
      { ManagedPolicyName: SECRET, PolicyDocument: DOC },
      { ManagedPolicyName: SECRET, PolicyDocument: { Version: '2008-10-17', Statement: [] } },
      { maskSecrets }
    );
    expect(allLines()).toContain('Pruned oldest non-default version v1');
    expectTranscriptMasked();
  });
});

/** An IAM "gone" error, which the helpers treat as already-done. */
const gone = (): NoSuchEntityException =>
  new NoSuchEntityException({ message: 'gone', $metadata: {} });

/** The recorded inputs of every `send` call for one SDK command name. */
function inputsOf(command: string): Array<Record<string, unknown>> {
  return mockSend.mock.calls
    .map((c) => c[0] as { constructor: { name: string }; input: Record<string, unknown> })
    .filter((c) => c.constructor.name === command)
    .map((c) => c.input);
}

describe('the wrapped AWS message on every IAM update() (issue #2177 review)', () => {
  const ARN = 'arn:aws:iam::111122223333:policy/mp';
  it.each([
    ['AWS::IAM::Role', () => new IAMRoleProvider(), 'UpdateRoleCommand', 'r', { RoleName: 'r', AssumeRolePolicyDocument: DOC }, { RoleName: 'r', AssumeRolePolicyDocument: DOC }],
    ['AWS::IAM::User', () => new IAMUserGroupProvider(), 'GetUserCommand', 'u', { UserName: 'u' }, { UserName: 'u' }],
    ['AWS::IAM::Group', () => new IAMUserGroupProvider(), 'GetGroupCommand', 'g', { GroupName: 'g' }, { GroupName: 'g' }],
    ['AWS::IAM::UserToGroupAddition', () => new IAMUserGroupProvider(), 'AddUserToGroupCommand', 'm', { GroupName: 'g', Users: ['u2'] }, { GroupName: 'g', Users: ['u'] }],
    ['AWS::IAM::Policy', () => new IAMPolicyProvider(), 'PutRolePolicyCommand', 'p', { PolicyName: 'p', PolicyDocument: DOC, Roles: ['r'] }, { PolicyName: 'p', PolicyDocument: DOC, Roles: ['r'] }],
    ['AWS::IAM::ManagedPolicy', () => new IAMManagedPolicyProvider(), 'ListPolicyVersionsCommand', ARN, { ManagedPolicyName: 'mp', PolicyDocument: DOC }, { ManagedPolicyName: 'mp', PolicyDocument: { Version: '2008-10-17', Statement: [] } }],
    ['AWS::IAM::InstanceProfile', () => new IAMInstanceProfileProvider(), 'GetInstanceProfileCommand', 'ip', { InstanceProfileName: 'ip' }, { InstanceProfileName: 'ip' }],
    ['AWS::IAM::AccessKey', () => new IAMAccessKeyProvider(), 'UpdateAccessKeyCommand', 'AKIAX', { UserName: 'u' }, { UserName: 'u' }],
  ] as const)('%s update() masks the message it wraps', async (type, make, command, physicalId, desired, previous) => {
    answerIam({ [command]: new Error(`quoted ${SECRET} back`) });
    const error = await make()
      .update('Res', physicalId, type, { ...desired }, { ...previous }, { maskSecrets })
      .then(
        () => {
          throw new Error('expected update() to reject');
        },
        (e: unknown) => e as Error
      );
    expect(inputsOf(command).length).toBeGreaterThan(0); // premise: the failing call ran
    expect(error.message).toContain('quoted');
    expect(error.message).not.toContain(SECRET);
  });

  it('AWS::IAM::AccessKey create() masks the message it wraps', async () => {
    answerIam({ CreateAccessKeyCommand: new Error(`quoted ${SECRET} back`) });
    const error = await new IAMAccessKeyProvider()
      .create('Res', 'AWS::IAM::AccessKey', { UserName: 'u' }, { maskSecrets })
      .then(
        () => {
          throw new Error('expected create() to reject');
        },
        (e: unknown) => e as Error
      );
    expect(error.message).toContain('quoted');
    expect(error.message).not.toContain(SECRET);
  });
});

/**
 * Masking changes what is LOGGED, never what is SENT or RECORDED: with a
 * masker that knows the names, every AWS request and every physical id must
 * still carry the PLAINTEXT (review of this change).
 */
describe('masking leaves the wire and the recorded ids alone (issue #2177 review)', () => {
  it('IAMRoleProvider create() and update()', async () => {
    answerIam();
    const provider = new IAMRoleProvider();
    const created = await provider.create(
      'MyRole',
      'AWS::IAM::Role',
      {
        RoleName: SECRET,
        AssumeRolePolicyDocument: DOC,
        ManagedPolicyArns: [SECRET_ARN],
        Policies: [{ PolicyName: SHORT, PolicyDocument: DOC }],
      },
      { maskSecrets }
    );
    expect(created.physicalId).toBe(SECRET);
    expect(inputsOf('CreateRoleCommand')[0]?.['RoleName']).toBe(SECRET);
    expect(inputsOf('AttachRolePolicyCommand')[0]).toMatchObject({ RoleName: SECRET, PolicyArn: SECRET_ARN });
    expect(inputsOf('PutRolePolicyCommand')[0]).toMatchObject({ RoleName: SECRET, PolicyName: SHORT });

    mockSend.mockClear();
    const updated = await provider.update(
      'MyRole',
      SECRET,
      'AWS::IAM::Role',
      { RoleName: SECRET, AssumeRolePolicyDocument: DOC, ManagedPolicyArns: [SECRET_ARN] },
      { RoleName: SECRET, AssumeRolePolicyDocument: DOC },
      { maskSecrets }
    );
    expect(updated.physicalId).toBe(SECRET);
    expect(inputsOf('AttachRolePolicyCommand')[0]).toMatchObject({ RoleName: SECRET, PolicyArn: SECRET_ARN });
  });

  it.each([
    ['AWS::IAM::User', 'UserName', 'CreateUserCommand'],
    ['AWS::IAM::Group', 'GroupName', 'CreateGroupCommand'],
  ] as const)('IAMUserGroupProvider %s create()', async (type, key, command) => {
    answerIam();
    const created = await new IAMUserGroupProvider().create('P', type, { [key]: SECRET }, { maskSecrets });
    expect(created.physicalId).toBe(SECRET);
    expect(inputsOf(command)[0]?.[key]).toBe(SECRET);
  });

  it('IAMInstanceProfileProvider create()', async () => {
    answerIam();
    const created = await new IAMInstanceProfileProvider().create(
      'IP',
      'AWS::IAM::InstanceProfile',
      { InstanceProfileName: SECRET, Roles: [SHORT] },
      { maskSecrets }
    );
    expect(created.physicalId).toBe(SECRET);
    expect(inputsOf('CreateInstanceProfileCommand')[0]?.['InstanceProfileName']).toBe(SECRET);
    expect(inputsOf('AddRoleToInstanceProfileCommand')[0]).toMatchObject({
      InstanceProfileName: SECRET,
      RoleName: SHORT,
    });
  });

  it('IAMManagedPolicyProvider and IAMPolicyProvider create()', async () => {
    answerIam();
    const managed = await new IAMManagedPolicyProvider().create(
      'MP',
      'AWS::IAM::ManagedPolicy',
      { ManagedPolicyName: SECRET, PolicyDocument: DOC, Roles: [SHORT] },
      { maskSecrets }
    );
    expect(managed.physicalId).toBe(`arn:aws:iam::111122223333:policy/${SECRET}`);
    expect(inputsOf('CreatePolicyCommand')[0]?.['PolicyName']).toBe(SECRET);
    const inline = await new IAMPolicyProvider().create(
      'P',
      'AWS::IAM::Policy',
      { PolicyName: SECRET, PolicyDocument: DOC, Roles: [SHORT] },
      { maskSecrets }
    );
    expect(inline.physicalId).toBe(SECRET);
    expect(inputsOf('PutRolePolicyCommand')[0]).toMatchObject({ RoleName: SHORT, PolicyName: SECRET });
  });

  it('IAMAccessKeyProvider deletes the orphan by its PLAINTEXT user name', async () => {
    let lists = 0;
    answerIam(
      { CreateAccessKeyCommand: new Error('response lost') },
      {
        ListAccessKeysCommand: () =>
          ++lists === 1
            ? { AccessKeyMetadata: [] }
            : { AccessKeyMetadata: [{ AccessKeyId: 'AKIAMINTED', CreateDate: new Date() }] },
      }
    );
    await expect(
      new IAMAccessKeyProvider().create('K', 'AWS::IAM::AccessKey', { UserName: SECRET }, { maskSecrets })
    ).rejects.toThrow('response lost');
    expect(inputsOf('DeleteAccessKeyCommand')[0]).toMatchObject({
      UserName: SECRET,
      AccessKeyId: 'AKIAMINTED',
    });
  });
});

/**
 * Every remaining masked line, driven with a secret in the value it names
 * (review of this change). Each line is also covered by the message-level
 * sink, so these pin that the line RUNS through a masked sink at all.
 */
describe('the remaining masked lines, each with a secret (issue #2177 review)', () => {
  it('IAMRoleProvider update(): boundary removal, detach and inline-policy delete', async () => {
    answerIam();
    await new IAMRoleProvider().update(
      'MyRole',
      SECRET,
      'AWS::IAM::Role',
      { RoleName: SECRET, AssumeRolePolicyDocument: DOC },
      {
        RoleName: SECRET,
        AssumeRolePolicyDocument: DOC,
        PermissionsBoundary: SECRET_ARN,
        ManagedPolicyArns: [SECRET_ARN],
        Policies: [{ PolicyName: SHORT, PolicyDocument: DOC }],
      },
      { maskSecrets }
    );
    for (const line of ['Removed permissions boundary', 'Detached managed policy', 'Deleted inline policy']) {
      expect(allLines()).toContain(line);
    }
    expectTranscriptMasked();
  });

  it('IAMRoleProvider cleanup: empty lists, already-detached, already-deleted and role-gone arms', async () => {
    // Pass 1: both lists empty.
    answerIam(
      { TagRoleCommand: new Error('boom') },
      { ListAttachedRolePoliciesCommand: { AttachedPolicies: [] }, ListRolePoliciesCommand: { PolicyNames: [] } }
    );
    const tagged = { RoleName: SECRET, AssumeRolePolicyDocument: DOC, Tags: [{ Key: 'k', Value: 'v' }] };
    await expect(new IAMRoleProvider().create('R', 'AWS::IAM::Role', tagged, { maskSecrets })).rejects.toThrow('boom');
    expect(allLines()).toContain('No managed policies attached');
    expect(allLines()).toContain('No inline policies on role');
    // Pass 2: each item is already gone.
    answerIam(
      { TagRoleCommand: new Error('boom'), DetachRolePolicyCommand: gone(), DeleteRolePolicyCommand: gone() },
      {
        ListAttachedRolePoliciesCommand: { AttachedPolicies: [{ PolicyArn: SECRET_ARN }] },
        ListRolePoliciesCommand: { PolicyNames: [SHORT] },
      }
    );
    await expect(new IAMRoleProvider().create('R', 'AWS::IAM::Role', tagged, { maskSecrets })).rejects.toThrow('boom');
    expect(allLines()).toContain('already detached from role');
    expect(allLines()).toContain('already deleted from role');
    // Pass 3: the role itself is gone when listing.
    answerIam({
      TagRoleCommand: new Error('boom'),
      ListAttachedRolePoliciesCommand: gone(),
      ListRolePoliciesCommand: gone(),
    });
    await expect(new IAMRoleProvider().create('R', 'AWS::IAM::Role', tagged, { maskSecrets })).rejects.toThrow('boom');
    expect(allLines()).toContain('not found when detaching managed policies');
    expect(allLines()).toContain('not found when deleting inline policies');
    expectTranscriptMasked();
  });

  it('IAMUserGroupProvider User create(): login profile and inline policy', async () => {
    answerIam();
    await new IAMUserGroupProvider().create(
      'U',
      'AWS::IAM::User',
      {
        UserName: SECRET,
        LoginProfile: { Password: 'pw' },
        Policies: [{ PolicyName: SHORT, PolicyDocument: DOC }],
      },
      { maskSecrets }
    );
    expect(allLines()).toContain('Created login profile');
    expect(allLines()).toContain('Added inline policy');
    expectTranscriptMasked();
  });

  it('IAMUserGroupProvider User update(): boundary removal, login profile update / delete, detach, group removal, inline delete', async () => {
    answerIam();
    const provider = new IAMUserGroupProvider();
    await provider.update(
      'U',
      SECRET,
      'AWS::IAM::User',
      { UserName: SECRET, LoginProfile: { Password: 'new' } },
      {
        UserName: SECRET,
        LoginProfile: { Password: 'old' },
        PermissionsBoundary: SECRET_ARN,
        ManagedPolicyArns: [SECRET_ARN],
        Groups: [SHORT],
        Policies: [{ PolicyName: OLD_SECRET, PolicyDocument: DOC }],
      },
      { maskSecrets }
    );
    await provider.update(
      'U',
      SECRET,
      'AWS::IAM::User',
      { UserName: SECRET },
      { UserName: SECRET, LoginProfile: { Password: 'old' } },
      { maskSecrets }
    );
    for (const line of [
      'Removed permissions boundary from user',
      'Updated login profile',
      'Deleted login profile',
      'Detached managed policy',
      'Removed user',
      'Deleted inline policy',
    ]) {
      expect(allLines()).toContain(line);
    }
    expectTranscriptMasked();
  });

  it('IAMUserGroupProvider Group create() and update(): inline add, detach', async () => {
    answerIam();
    const provider = new IAMUserGroupProvider();
    await provider.create(
      'G',
      'AWS::IAM::Group',
      { GroupName: SECRET, Policies: [{ PolicyName: SHORT, PolicyDocument: DOC }] },
      { maskSecrets }
    );
    await provider.update(
      'G',
      SECRET,
      'AWS::IAM::Group',
      { GroupName: SECRET },
      { GroupName: SECRET, ManagedPolicyArns: [SECRET_ARN] },
      { maskSecrets }
    );
    expect(allLines()).toContain('Added inline policy');
    expect(allLines()).toContain('Detached managed policy');
    expectTranscriptMasked();
  });

  it('IAMPolicyProvider update(): removal from old groups and users', async () => {
    answerIam();
    await new IAMPolicyProvider().update(
      'P',
      SECRET,
      'AWS::IAM::Policy',
      { PolicyName: SECRET, PolicyDocument: DOC, Roles: ['r'] },
      { PolicyName: SECRET, PolicyDocument: DOC, Groups: [SHORT], Users: [OLD_SECRET] },
      { maskSecrets }
    );
    expect(allLines()).toContain('Removed inline policy');
    expect(allLines()).toContain('from group');
    expect(allLines()).toContain('from user');
    expectTranscriptMasked();
  });

  it('IAMManagedPolicyProvider: cleanup success, user attach, group and user detach', async () => {
    answerIam(
      { AttachUserPolicyCommand: new Error('boom') },
      { ListEntitiesForPolicyCommand: { PolicyGroups: [], PolicyRoles: [], PolicyUsers: [] } }
    );
    // Cleanup that SUCCEEDS, after the user attach fails.
    await expect(
      new IAMManagedPolicyProvider().create(
        'MP',
        'AWS::IAM::ManagedPolicy',
        { ManagedPolicyName: SECRET, PolicyDocument: DOC, Users: [SHORT] },
        { maskSecrets }
      )
    ).rejects.toThrow('boom');
    expect(allLines()).toContain('Cleaned up partially-created managed policy');
    answerIam();
    await new IAMManagedPolicyProvider().create(
      'MP',
      'AWS::IAM::ManagedPolicy',
      { ManagedPolicyName: SECRET, PolicyDocument: DOC, Users: [SHORT] },
      { maskSecrets }
    );
    expect(allLines()).toContain('to user');
    await new IAMManagedPolicyProvider().update(
      'MP',
      `arn:aws:iam::111122223333:policy/${SECRET}`,
      'AWS::IAM::ManagedPolicy',
      { ManagedPolicyName: SECRET, PolicyDocument: DOC },
      { ManagedPolicyName: SECRET, PolicyDocument: DOC, Groups: [OLD_SECRET], Users: [SHORT] },
      { maskSecrets }
    );
    expect(allLines()).toContain('from group');
    expect(allLines()).toContain('from user');
    expectTranscriptMasked();
  });

  it('IAMInstanceProfileProvider: cleanup success and the already-removed role arm', async () => {
    answerIam({ AddRoleToInstanceProfileCommand: new Error('boom') });
    await expect(
      new IAMInstanceProfileProvider().create(
        'IP',
        'AWS::IAM::InstanceProfile',
        { InstanceProfileName: SECRET, Roles: [SHORT] },
        { maskSecrets }
      )
    ).rejects.toThrow('boom');
    expect(allLines()).toContain('Cleaned up partially-created IAM instance profile');
    answerIam({ RemoveRoleFromInstanceProfileCommand: gone() });
    await new IAMInstanceProfileProvider().update(
      'IP',
      SECRET,
      'AWS::IAM::InstanceProfile',
      { InstanceProfileName: SECRET, Roles: [] },
      { InstanceProfileName: SECRET, Roles: [SHORT] },
      { maskSecrets }
    );
    expect(allLines()).toContain('already removed from instance profile');
    expectTranscriptMasked();
  });

  it('IAMAccessKeyProvider update(): the state-borne malformed Status warning goes through the masked sink', async () => {
    // The refusal text is value-free by construction (`describe` names a
    // TYPE, never the value), so no template value can put a secret in it;
    // this pins that the line RUNS on the masked sink, with the id masked
    // beside it in the transcript.
    answerIam();
    await new IAMAccessKeyProvider().update(
      'K',
      SHORT,
      'AWS::IAM::AccessKey',
      { UserName: SECRET, Status: 42 },
      { UserName: SECRET, Status: 'Active' },
      { maskSecrets, replayingState: true }
    );
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('AWS::IAM::AccessKey Status');
    expectTranscriptMasked();
  });
});

describe('IAMPolicyProvider rotated-name update (issue #2177 review)', () => {
  it('masks the OLD policy name when the previous PolicyName is a state reference', async () => {
    // The desired name is the NEW secret, resolved and in the bag; the recorded
    // name is the OLD plaintext, which no bag of this deploy holds.
    const OLD_PLAINTEXT = 'old-rotated-secret-plaintext';
    expect(maskSecrets(OLD_PLAINTEXT)).toBe(OLD_PLAINTEXT); // premise
    answerIam();
    await new IAMPolicyProvider().update(
      'P',
      OLD_PLAINTEXT,
      'AWS::IAM::Policy',
      { PolicyName: SECRET, PolicyDocument: DOC, Roles: ['r1'] },
      { PolicyName: '{{resolve:secretsmanager:policy-name}}', PolicyDocument: DOC, Roles: ['r2'] },
      { maskSecrets }
    );
    expect(allLines()).toContain('Removed inline policy');
    expect(allLines()).not.toContain(OLD_PLAINTEXT);
    expectTranscriptMasked();
  });

  it('masks the NEW groups and users update() attaches the policy to', async () => {
    answerIam();
    await new IAMPolicyProvider().update(
      'P',
      'plain-policy',
      'AWS::IAM::Policy',
      { PolicyName: 'plain-policy', PolicyDocument: DOC, Groups: [SHORT], Users: [OLD_SECRET] },
      { PolicyName: 'plain-policy', PolicyDocument: DOC, Roles: ['r'] },
      { maskSecrets }
    );
    expect(allLines()).toContain('Attached inline policy plain-policy to group');
    expect(allLines()).toContain('Attached inline policy plain-policy to user');
    expectTranscriptMasked();
  });

  it('masks an OLD name recorded in the legacy `name:role` physical id shape', async () => {
    const OLD_PLAINTEXT = 'old-rotated-secret-plaintext';
    answerIam();
    await new IAMPolicyProvider().update(
      'P',
      `${OLD_PLAINTEXT}:legacy-role`,
      'AWS::IAM::Policy',
      { PolicyName: SECRET, PolicyDocument: DOC, Roles: ['r1'] },
      { PolicyName: '{{resolve:secretsmanager:policy-name}}', PolicyDocument: DOC, Roles: ['r2'] },
      { maskSecrets }
    );
    expect(allLines()).toContain('Updating IAM policy');
    expect(allLines()).not.toContain(OLD_PLAINTEXT);
  });
});

describe('withDerivedNameMasks input guards (issue #2177 review)', () => {
  it('ignores a pair whose derived name is EMPTY, which would otherwise split every character', () => {
    const base = createMaskedLogSinks({ debug: debugSpy, warn: warnSpy }, maskSecrets);
    const log = withDerivedNameMasks({ debug: debugSpy, warn: warnSpy }, base, [[SECRET, '']]);
    expect(log.mask('plain text')).toBe('plain text');
  });
});
