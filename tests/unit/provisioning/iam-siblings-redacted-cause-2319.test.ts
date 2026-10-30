import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * The IAM user / group / UserToGroupAddition / inline policy / instance
 * profile wraps must not write the CALLER'S IDENTITY into a persisted store
 * (go-to-k/cdkd#2319).
 *
 * A thrown `ProvisioningError` message is captured into
 * `deployments/{runId}.jsonl`. IAM words an access denial as `User:
 * arn:aws:sts::<account>:assumed-role/<role>/<session> is not authorized to
 * perform: ...`. Each AWS fixture here carries that wording and the smithy
 * markers `describeAwsFailure` keys on. Both polarities: an AWS-authored
 * failure is named by its class with `cause` kept (so the retry classifiers
 * still read it), and a cdkd-authored or transport failure keeps its own text.
 */

const { mockSend, debugSpy, fakeClient, resolveSpy } = vi.hoisted(() => {
  const send = vi.fn();
  const client = () => ({
    send: (command: unknown) => send(command),
    config: {
      region: () => Promise.resolve('us-east-1'),
      retryStrategy: () => Promise.resolve(undefined),
    },
    middlewareStack: { add: vi.fn(), addRelativeTo: vi.fn() },
  });
  return { mockSend: send, debugSpy: vi.fn(), fakeClient: client, resolveSpy: vi.fn() };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ iam: fakeClient(), sts: fakeClient() }),
}));
// The secret-derived principal resolution a `cdkd destroy` opts a delete into
// (go-to-k/cdkd#4150), faked as `secret-principal-delete-4150.test.ts` does.
vi.mock('../../../src/deployment/intrinsic-function-resolver.js', async () => ({
  ...(await vi.importActual<Record<string, unknown>>(
    '../../../src/deployment/intrinsic-function-resolver.js'
  )),
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    resolveDynamicReferences: resolveSpy,
  })),
}));
vi.mock('../../../src/deployment/intrinsic-resolver/dynamic-refs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/deployment/intrinsic-resolver/dynamic-refs.js')>()),
  resolveDynamicReferences: vi.fn(
    (
      resolver: { resolveDynamicReferences: (v: string, c: unknown) => Promise<string> },
      value: string,
      context: unknown
    ) => resolver.resolveDynamicReferences(value, context)
  ),
}));
vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: debugSpy,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: debugSpy,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { IAMUserGroupProvider } from '../../../src/provisioning/providers/iam-user-group-provider.js';
import { IAMPolicyProvider } from '../../../src/provisioning/providers/iam-policy-provider.js';
import { IAMInstanceProfileProvider } from '../../../src/provisioning/providers/iam-instance-profile-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import {
  hasRedactedCause,
  isIamPropagationError,
  isNameCollisionErrorFrom,
  isRecreateRetryableError,
  isRetryableTransientError,
  retryClassificationText,
} from '../../../src/deployment/retryable-errors.js';
import { VERBOSE_POINTER } from '../../../src/utils/aws-failure-text.js';

const CALLER_ACCOUNT = '210987654321';
const CALLER_ROLE = 'cdkd-deploy-role';
const CALLER_SESSION = 'cdkd-session-8f21';
const CALLER_ARN = `arn:aws:sts::${CALLER_ACCOUNT}:assumed-role/${CALLER_ROLE}/${CALLER_SESSION}`;

/** An access denial as IAM words it, AWS-authored. */
function accessDenied(action: string): Error {
  return awsError(
    'AccessDenied',
    `User: ${CALLER_ARN} is not authorized to perform: ${action} on resource: ` +
      `arn:aws:iam::${CALLER_ACCOUNT}:x because no identity-based policy allows the ` +
      `${action} action`,
    403
  );
}

function awsError(name: string, message: string, status = 400): Error {
  return Object.assign(new Error(message), {
    name,
    $fault: status >= 500 ? 'server' : 'client',
    $metadata: { httpStatusCode: status },
  });
}

const commandName = (command: unknown): string =>
  (command as { constructor: { name: string } }).constructor.name;

/** Fail `failing` with `error`; every other command answers `answers[name]` or `{}`. */
function failOn(failing: string, error: unknown, answers: Record<string, unknown> = {}): void {
  mockSend.mockImplementation(async (command: unknown) => {
    const name = commandName(command);
    if (name === failing) throw error;
    return answers[name] ?? {};
  });
}

async function thrown(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the operation to throw');
}

const debugged = (): string => debugSpy.mock.calls.map((args) => String(args[0])).join('\n');

const SECRET = 'iam-sibling-secret';
const MASK = (text: string): string => text.split(SECRET).join('***');

const USER = 'AWS::IAM::User';
const GROUP = 'AWS::IAM::Group';
const UTGA = 'AWS::IAM::UserToGroupAddition';
const POLICY = 'AWS::IAM::Policy';
const PROFILE = 'AWS::IAM::InstanceProfile';
const DOC = {
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }],
};

type Mask = (text: string) => string;
type Site = {
  site: string;
  command: string;
  action: string;
  prefix: string;
  answers?: Record<string, unknown>;
  /** Runs the operation with `mask` threaded as the operation's `maskSecrets`. */
  run: (mask?: Mask) => Promise<unknown>;
};

const ctx = (mask?: Mask) => (mask ? { maskSecrets: mask } : undefined);
const ug = () => new IAMUserGroupProvider();

/** Every wrap this slice converts: create, update and delete of each type. */
const SITES: Site[] = [
  {
    site: 'IAM user create',
    command: 'CreateUserCommand',
    action: 'iam:CreateUser',
    prefix: 'Failed to create IAM user Res: ',
    run: (m) => ug().create('Res', USER, { UserName: 'u' }, ctx(m)),
  },
  {
    site: 'IAM user update',
    command: 'GetUserCommand',
    action: 'iam:GetUser',
    prefix: 'Failed to update IAM user Res: ',
    run: (m) => ug().update('Res', 'u', USER, { UserName: 'u' }, { UserName: 'u' }, ctx(m)),
  },
  {
    site: 'IAM user delete',
    command: 'DeleteUserCommand',
    action: 'iam:DeleteUser',
    prefix: 'Failed to delete IAM user Res: ',
    run: (m) => ug().delete('Res', 'u', USER, undefined, ctx(m)),
  },
  {
    site: 'IAM group create',
    command: 'CreateGroupCommand',
    action: 'iam:CreateGroup',
    prefix: 'Failed to create IAM group Res: ',
    run: (m) => ug().create('Res', GROUP, { GroupName: 'g' }, ctx(m)),
  },
  {
    site: 'IAM group update',
    command: 'GetGroupCommand',
    action: 'iam:GetGroup',
    prefix: 'Failed to update IAM group Res: ',
    run: (m) => ug().update('Res', 'g', GROUP, { GroupName: 'g' }, { GroupName: 'g' }, ctx(m)),
  },
  {
    site: 'IAM group delete',
    command: 'DeleteGroupCommand',
    action: 'iam:DeleteGroup',
    prefix: 'Failed to delete IAM group Res: ',
    run: (m) => ug().delete('Res', 'g', GROUP, undefined, ctx(m)),
  },
  {
    site: 'UserToGroupAddition create',
    command: 'AddUserToGroupCommand',
    action: 'iam:AddUserToGroup',
    prefix: 'Failed to create IAM UserToGroupAddition Res: ',
    run: (m) => ug().create('Res', UTGA, { GroupName: 'g', Users: ['u'] }, ctx(m)),
  },
  {
    site: 'UserToGroupAddition update',
    command: 'AddUserToGroupCommand',
    action: 'iam:AddUserToGroup',
    prefix: 'Failed to update IAM UserToGroupAddition Res: ',
    run: (m) =>
      ug().update(
        'Res',
        'm',
        UTGA,
        { GroupName: 'g', Users: ['u2'] },
        { GroupName: 'g', Users: ['u'] },
        ctx(m)
      ),
  },
  {
    site: 'UserToGroupAddition delete',
    command: 'RemoveUserFromGroupCommand',
    action: 'iam:RemoveUserFromGroup',
    prefix: 'Failed to delete IAM UserToGroupAddition Res: ',
    run: (m) => ug().delete('Res', 'm', UTGA, { GroupName: 'g', Users: ['u'] }, ctx(m)),
  },
  {
    site: 'inline policy create',
    command: 'PutRolePolicyCommand',
    action: 'iam:PutRolePolicy',
    prefix: 'Failed to create IAM policy Res: ',
    run: (m) =>
      new IAMPolicyProvider().create(
        'Res',
        POLICY,
        { PolicyName: 'p', PolicyDocument: DOC, Roles: ['r'] },
        ctx(m)
      ),
  },
  {
    site: 'inline policy update',
    command: 'PutRolePolicyCommand',
    action: 'iam:PutRolePolicy',
    prefix: 'Failed to update IAM policy Res: ',
    run: (m) =>
      new IAMPolicyProvider().update(
        'Res',
        'p',
        POLICY,
        { PolicyName: 'p', PolicyDocument: DOC, Roles: ['r'] },
        { PolicyName: 'p', PolicyDocument: DOC, Roles: ['r'] },
        ctx(m)
      ),
  },
  {
    site: 'inline policy delete',
    command: 'DeleteRolePolicyCommand',
    action: 'iam:DeleteRolePolicy',
    prefix: 'Failed to delete IAM policy Res: ',
    run: (m) =>
      new IAMPolicyProvider().delete(
        'Res',
        'p',
        POLICY,
        { PolicyName: 'p', PolicyDocument: DOC, Roles: ['r'] },
        ctx(m)
      ),
  },
  {
    site: 'instance profile create',
    command: 'CreateInstanceProfileCommand',
    action: 'iam:CreateInstanceProfile',
    prefix: 'Failed to create IAM instance profile Res: ',
    run: (m) =>
      new IAMInstanceProfileProvider().create('Res', PROFILE, { InstanceProfileName: 'ip' }, ctx(m)),
  },
  {
    site: 'instance profile update',
    command: 'AddRoleToInstanceProfileCommand',
    action: 'iam:AddRoleToInstanceProfile',
    prefix: 'Failed to update IAM instance profile Res: ',
    run: (m) =>
      new IAMInstanceProfileProvider().update(
        'Res',
        'ip',
        PROFILE,
        { InstanceProfileName: 'ip', Roles: ['r2'] },
        { InstanceProfileName: 'ip', Roles: [] },
        ctx(m)
      ),
  },
  {
    site: 'instance profile delete',
    command: 'DeleteInstanceProfileCommand',
    action: 'iam:DeleteInstanceProfile',
    prefix: 'Failed to delete IAM instance profile Res: ',
    run: (m) => new IAMInstanceProfileProvider().delete('Res', 'ip', PROFILE, undefined, ctx(m)),
  },
];

beforeEach(() => {
  mockSend.mockReset();
  debugSpy.mockReset();
});

describe('IAM sibling thrown wraps keep the caller identity out (go-to-k/cdkd#2319)', () => {
  it('covers every create / update / delete of the five types', () => {
    expect(SITES).toHaveLength(15);
  });

  describe.each(SITES)('$site', ({ command, action, prefix, answers, run }) => {
    it('names an AWS-authored failure by its class, keeps cause, and stays retryable', async () => {
      const original = accessDenied(action);
      failOn(command, original, answers);
      const failure = await thrown(run());

      // Non-vacuity: the rejection came from the site's own command.
      expect(mockSend.mock.calls.some(([c]) => commandName(c) === command)).toBe(true);
      expect(failure).toBeInstanceOf(ProvisioningError);
      expect(failure.message).toBe(`${prefix}AccessDenied. ${VERBOSE_POINTER}`);
      expect(failure.message).not.toContain(CALLER_ACCOUNT);
      expect(failure.message).not.toContain(CALLER_ROLE);
      expect(failure.message).not.toContain(CALLER_SESSION);
      expect(failure.cause).toBe(original);

      // The withheld `not authorized to perform` still reaches the classifier.
      expect(isRetryableTransientError(failure, failure.message)).toBe(false);
      expect(hasRedactedCause(failure)).toBe(true);
      expect(retryClassificationText(failure)).toContain('not authorized to perform');
      expect(isRetryableTransientError(failure, retryClassificationText(failure))).toBe(true);

      // AWS's own text is not discarded: it is logged at debug.
      expect(debugged()).toContain(CALLER_ARN);
    });

    it("masks AWS's text on the debug line through the operation's masker", async () => {
      failOn(command, awsError('ValidationException', `Invalid value '${SECRET}'`), answers);
      const failure = await thrown(run(MASK));

      expect(mockSend.mock.calls.some(([c]) => commandName(c) === command)).toBe(true);
      expect(failure.message).toContain(`ValidationException. ${VERBOSE_POINTER}`);
      expect(failure.message).not.toContain(SECRET);
      expect(debugged()).toContain("Invalid value '***'");
      expect(debugged()).not.toContain(SECRET);
    });

    it('keeps a non-Error throw as masked text, unstamped', async () => {
      failOn(command, `socket hang up ${SECRET}`, answers);
      const failure = await thrown(run(MASK));

      expect(mockSend.mock.calls.some(([c]) => commandName(c) === command)).toBe(true);
      expect(failure.message).toBe(`${prefix}socket hang up ***`);
      expect(failure.cause).toBeUndefined();
      expect(hasRedactedCause(failure)).toBe(false);
    });

    it('keeps a cdkd-authored or transport failure verbatim, unstamped', async () => {
      const original = new Error('connect ECONNREFUSED 10.0.0.1:443');
      failOn(command, original, answers);
      const failure = await thrown(run());

      expect(mockSend.mock.calls.some(([c]) => commandName(c) === command)).toBe(true);
      expect(failure.message).toBe(`${prefix}connect ECONNREFUSED 10.0.0.1:443`);
      expect(hasRedactedCause(failure)).toBe(false);
      expect(failure.cause).toBe(original);
    });
  });

  // The destroy and deploy-delete not-found matchers (`destroy-runner.ts`,
  // `deploy-engine/delete.ts`) read the thrown message for `NoSuchEntity`;
  // `update-in-place.ts`'s delete-first needles do not match it, so that path
  // still fails hard, as before. Only the user's `DeleteUser` lets
  // one reach the wrap, whose class name still carries it; every other delete
  // settles it as gone first (the SDK's `instanceof` matches by name).
  const deletes = SITES.filter((s) => s.site.endsWith(' delete'));
  const noSuchEntity = () =>
    awsError('NoSuchEntityException', 'The entity cannot be found.', 404);

  it('IAM user delete: a NoSuchEntityException reaching the wrap still names NoSuchEntity', async () => {
    const site = deletes.find((s) => s.site === 'IAM user delete')!;
    failOn(site.command, noSuchEntity(), site.answers);
    const failure = await thrown(site.run());

    expect(failure.message).toBe(`${site.prefix}NoSuchEntityException. ${VERBOSE_POINTER}`);
  });

  it.each(deletes.filter((s) => s.site !== 'IAM user delete'))(
    '$site: a NoSuchEntityException settles before the wrap',
    async ({ command, answers, run }) => {
      failOn(command, noSuchEntity(), answers);
      await expect(run()).resolves.toBeUndefined();
      expect(mockSend.mock.calls.some(([c]) => commandName(c) === command)).toBe(true);
    }
  );

  it('masks a secret profile name on the instance-profile not-found debug line', async () => {
    failOn('GetInstanceProfileCommand', awsError('NoSuchEntityException', 'gone', 404));
    await new IAMInstanceProfileProvider().delete('Res', `ip-${SECRET}`, PROFILE, undefined, {
      maskSecrets: MASK,
    });

    expect(debugged()).toContain('Instance profile ip-*** does not exist, skipping deletion');
    expect(debugged()).not.toContain(SECRET);
  });

  it('masks a secret profile name on every instance-profile delete debug line', async () => {
    failOn('DeleteInstanceProfileCommand', awsError('ValidationException', 'refused'), {
      GetInstanceProfileCommand: { InstanceProfile: { Roles: [{ RoleName: 'r' }] } },
    });
    await thrown(
      new IAMInstanceProfileProvider().delete('Res', `ip-${SECRET}`, PROFILE, undefined, {
        maskSecrets: MASK,
      })
    );

    expect(debugged()).toContain('Deleting IAM instance profile Res: ip-***');
    expect(debugged()).toContain('Removed role r from instance profile ip-***');
    expect(debugged()).not.toContain(SECRET);
  });

  it("masks cdkd's own prefix on the instance-profile delete line, which had no masker", async () => {
    failOn('DeleteInstanceProfileCommand', awsError('ValidationException', 'refused'));
    const failure = await thrown(
      new IAMInstanceProfileProvider().delete(`Res-${SECRET}`, 'ip', PROFILE, undefined, {
        maskSecrets: MASK,
      })
    );

    expect(failure.message).toBe(
      `Failed to delete IAM instance profile Res-***: ValidationException. ${VERBOSE_POINTER}`
    );
    const lines = debugSpy.mock.calls
      .map((args) => String(args[0]))
      .filter((line) => line.startsWith('Failed to delete IAM instance profile'));
    expect(lines).toEqual(['Failed to delete IAM instance profile Res-***: refused']);
  });
});

/**
 * Every classifier that reads one of these wraps returns the verdict it gave
 * the pre-#2319 wrap, which quoted AWS's text in full: same prefix, same
 * `cause`. The redacted wrap carries the class token and, for an "already
 * exists", the restated sentence; its stamp sends the retry classifiers to the
 * `cause` chain.
 */
describe('classifier verdicts match the pre-redaction message (go-to-k/cdkd#2319)', () => {
  const MESSAGES: ReadonlyArray<{ name: string; text: string; status?: number }> = [
    { name: 'AccessDenied', text: `User: ${CALLER_ARN} is not authorized to perform: iam:X`, status: 403 },
    { name: 'NoSuchEntityException', text: 'The role with name r cannot be found.', status: 404 },
    { name: 'EntityAlreadyExistsException', text: 'User with name u already exists.', status: 409 },
    { name: 'EntityAlreadyExistsException', text: 'One or more of the values is associated with another entity.', status: 409 },
    { name: 'EntityAlreadyExistsException', text: 'Instance Profile ip already exists.', status: 409 },
    { name: 'LimitExceededException', text: 'Cannot exceed quota for InstanceSessionsPerInstanceProfile: 1', status: 409 },
    { name: 'ConcurrentModificationException', text: 'Rate exceeded', status: 409 },
    { name: 'Throttling', text: 'Rate exceeded', status: 400 },
    { name: 'ServiceFailureException', text: 'Internal failure', status: 500 },
    {
      name: 'MalformedPolicyDocumentException',
      text: 'Invalid principal in policy: "AWS":"arn:aws:iam::111122223333:role/just-created"',
    },
    { name: 'DeleteConflictException', text: 'Cannot delete entity, must remove users from group first.', status: 409 },
  ];

  const verdicts = (error: Error) => ({
    collisionFrom: isNameCollisionErrorFrom(error, 'Res'),
    recreateRetryable: isRecreateRetryableError(retryClassificationText(error), error),
    transientRetryable: isRetryableTransientError(error, retryClassificationText(error)),
    iamPropagation: isIamPropagationError(retryClassificationText(error)),
  });

  // A delete settles a `NoSuchEntityException` as gone before any wrap, the
  // user's `DeleteUser` excepted (the not-found matrix below pins both).
  const settledBeforeWrap = (site: string, name: string): boolean =>
    name === 'NoSuchEntityException' && site.endsWith(' delete') && site !== 'IAM user delete';
  const cases = SITES.flatMap((site) =>
    MESSAGES.filter((m) => !settledBeforeWrap(site.site, m.name)).map((m) => ({ ...site, ...m }))
  );

  it.each(cases)('$site: $name "$text"', async ({ command, answers, prefix, run, name, text, status }) => {
    const aws = awsError(name, text, status);
    failOn(command, aws, answers);
    const after = await thrown(run());
    expect(after.message.startsWith(`${prefix}${name}. ${VERBOSE_POINTER}`)).toBe(true);
    const before = new ProvisioningError(`${prefix}${text}`, 'AWS::Any::Type', 'Res', undefined, aws);
    expect(verdicts(after)).toEqual(verdicts(before));
  });

  /**
   * A transcription of the not-found needles `deploy-engine/delete.ts` (and
   * its `destroy-runner.ts` twin) match on a delete failure's thrown message.
   * `update-in-place.ts`'s delete-first needles (`does not exist` / `not found`
   * / `NotFound`) match no `NoSuchEntityException.` token, so they are not here.
   */
  const NOT_FOUND = [
    'does not exist',
    'was not found',
    'not found',
    'No policy found',
    'NoSuchEntity',
    'NotFoundException',
    'ResourceNotFoundException',
  ];
  const readsAsGone = (message: string): boolean => NOT_FOUND.some((n) => message.includes(n));

  // The not-found verdict moves in two directions only, both away from
  // dropping a live resource from state: an IAM `NoSuchEntity` (wording
  // "cannot be found", which no needle matched) now reads as gone by its class,
  // as CloudFormation treats a delete of a missing entity; and prose saying
  // "does not exist" under any other class no longer does, so it fails loudly.
  it.each(
    SITES.filter((s) => s.site.endsWith(' delete')).flatMap((site) =>
      [...MESSAGES, { name: 'InvalidInputException', text: 'The entity does not exist.', status: 400 }].map(
        (m) => ({ ...site, ...m })
      )
    )
  )('$site not-found verdict: $name "$text"', async ({ command, answers, prefix, run, name, text, status }) => {
    failOn(command, awsError(name, text, status), answers);
    const result = await run().then(
      () => undefined,
      (e: unknown) => e as Error
    );
    if (result === undefined) {
      // Settled as gone inside the provider, before any wrap: every delete but
      // the user's, whose sub-steps settle it and whose `DeleteUser` does not.
      expect(name).toBe('NoSuchEntityException');
      expect(command).not.toBe('DeleteUserCommand');
      return;
    }
    const before = readsAsGone(`${prefix}${text}`);
    const after = readsAsGone(result.message);
    if (name === 'NoSuchEntityException') {
      expect(command).toBe('DeleteUserCommand');
      expect([before, after]).toEqual([false, true]);
    } else if (name === 'InvalidInputException') expect([before, after]).toEqual([true, false]);
    else expect(after).toBe(before);
  });

  it('pins the verdicts: a taken name is a collision at every create, a wiring one is not', async () => {
    const collision = () => awsError('EntityAlreadyExistsException', 'Entity x already exists.', 409);
    for (const site of SITES.filter((s) => s.site.endsWith(' create') && !s.site.startsWith('UserToGroup') && !s.site.startsWith('inline'))) {
      failOn(site.command, collision(), site.answers);
      const failure = await thrown(site.run());
      expect(failure.message).toContain('AWS reports that it already exists.');
      expect(isNameCollisionErrorFrom(failure, 'Res')).toBe(true);
    }

    // The profile exists by then: an "already exists" from attaching its role is
    // an auxiliary object's (`markAuxiliaryFailure`), and stays no collision. It
    // is not restated either: "it" would read as the profile itself.
    failOn('AddRoleToInstanceProfileCommand', collision(), {
      CreateInstanceProfileCommand: { InstanceProfile: { Arn: 'arn', InstanceProfileId: 'AIPA1' } },
    });
    const wiring = await thrown(
      new IAMInstanceProfileProvider().create('Res', PROFILE, { InstanceProfileName: 'ip', Roles: ['r'] })
    );
    expect(wiring.message).toContain('EntityAlreadyExistsException');
    expect(wiring.message).not.toContain('AWS reports that it already exists.');
    expect(isNameCollisionErrorFrom(wiring, 'Res')).toBe(false);
  });

  it('pins the retry verdicts the stamp keeps: IAM propagation and throttling stay retryable', async () => {
    failOn('PutRolePolicyCommand', awsError('MalformedPolicyDocumentException', MESSAGES[9]!.text));
    const propagation = await thrown(SITES[9]!.run());
    expect(isRetryableTransientError(propagation, retryClassificationText(propagation))).toBe(true);
    expect(isIamPropagationError(retryClassificationText(propagation))).toBe(true);

    failOn('CreateUserCommand', awsError('Throttling', 'Rate exceeded'));
    const throttled = await thrown(SITES[0]!.run());
    expect(isRetryableTransientError(throttled, retryClassificationText(throttled))).toBe(true);
  });
});

describe('the other marks a redacted wrap carries (go-to-k/cdkd#2319)', () => {
  /** Fail every command in `failing` with its error; the rest answer `{}`. */
  const failEach = (failing: Record<string, Error>, answers: Record<string, unknown> = {}) =>
    mockSend.mockImplementation(async (command: unknown) => {
      const name = commandName(command);
      if (failing[name]) throw failing[name];
      return answers[name] ?? {};
    });

  it.each([
    {
      site: 'instance profile',
      prefix: 'Failed to create IAM instance profile Res: ',
      type: PROFILE,
      name: 'ip',
      wiring: 'AddRoleToInstanceProfileCommand',
      cleanup: 'DeleteInstanceProfileCommand',
      answers: { CreateInstanceProfileCommand: { InstanceProfile: { Arn: 'a', InstanceProfileId: 'AIPA1' } } },
      run: () =>
        new IAMInstanceProfileProvider().create('Res', PROFILE, { InstanceProfileName: 'ip', Roles: ['r'] }),
    },
    {
      site: 'user',
      prefix: 'Failed to create IAM user Res: ',
      type: USER,
      name: 'u',
      wiring: 'AddUserToGroupCommand',
      cleanup: 'DeleteUserCommand',
      answers: { CreateUserCommand: { User: { Arn: 'a', UserId: 'AIDA1' } } },
      run: () => ug().create('Res', USER, { UserName: 'u', Groups: ['g'] }),
    },
    {
      site: 'group',
      prefix: 'Failed to create IAM group Res: ',
      type: GROUP,
      name: 'g',
      wiring: 'AttachGroupPolicyCommand',
      cleanup: 'DeleteGroupCommand',
      answers: { CreateGroupCommand: { Group: { Arn: 'a', GroupId: 'AGPA1' } } },
      run: () =>
        ug().create('Res', GROUP, {
          GroupName: 'g',
          ManagedPolicyArns: ['arn:aws:iam::aws:policy/ReadOnlyAccess'],
        }),
    },
  ])(
    '$site create: a wiring denial left behind keeps the created-before-failure mark',
    async ({ prefix, type, name, wiring, cleanup, answers, run }) => {
      failEach(
        { [wiring]: accessDenied('iam:Wire'), [cleanup]: accessDenied('iam:Delete') },
        answers
      );
      const failure = await thrown(run());

      expect(mockSend.mock.calls.some(([c]) => commandName(c) === cleanup)).toBe(true);
      expect(failure.message).toBe(`${prefix}AccessDenied. ${VERBOSE_POINTER}`);
      expect(failure.message).not.toContain(CALLER_ACCOUNT);
      expect(hasRedactedCause(failure)).toBe(true);
      expect(createdBeforeFailure(failure, 'Res', type)).toBe(name);
    }
  );
});

describe("a delete opted into resolving a secret-derived principal (go-to-k/cdkd#4150)", () => {
  const REF = '{{resolve:secretsmanager:sdp:SecretString:role::}}';
  const RESOLVED = 'secret-named-principal-0001';
  const OPT_IN = {
    expectedRegion: 'us-east-1',
    resolveSecretDerivedPrincipals: { importedProducerRegions: [] as string[] },
  };
  /** AWS's own text quoting the principal the secret resolved to. */
  const quoting = () =>
    awsError('AccessDenied', `User: ${CALLER_ARN} is not authorized on ${RESOLVED}`, 403);

  beforeEach(() => {
    resolveSpy.mockImplementation((leaf: string) =>
      leaf === REF ? Promise.resolve(RESOLVED) : Promise.reject(new Error(`cannot resolve ${leaf}`))
    );
  });

  it.each([
    {
      site: 'inline policy delete',
      command: 'DeleteRolePolicyCommand',
      prefix: 'Failed to delete IAM policy P: ',
      answers: {},
      run: () =>
        new IAMPolicyProvider().delete(
          'P',
          'pol',
          POLICY,
          { PolicyName: 'pol', PolicyDocument: {}, Roles: [REF] },
          OPT_IN
        ),
    },
    {
      site: 'UserToGroupAddition delete',
      command: 'RemoveUserFromGroupCommand',
      prefix: 'Failed to delete IAM UserToGroupAddition M: ',
      answers: { ListGroupsForUserCommand: { Groups: [{ GroupName: 'grp' }], IsTruncated: false } },
      run: () => ug().delete('M', 'M', UTGA, { GroupName: 'grp', Users: [REF] }, OPT_IN),
    },
  ])('$site: the debug line masks the resolved name, the clone keeps the stamp', async ({ command, prefix, answers, run }) => {
    failOn(command, quoting(), answers);
    const failure = await thrown(run());

    // Non-vacuity: the delete reached the resolved principal.
    expect(
      mockSend.mock.calls.some(
        ([c]) => commandName(c) === command && JSON.stringify((c as { input: unknown }).input).includes(RESOLVED)
      )
    ).toBe(true);
    expect(failure.message).toBe(`${prefix}AccessDenied. ${VERBOSE_POINTER}`);
    expect(hasRedactedCause(failure)).toBe(true);
    expect(debugged()).toContain('is not authorized on');
    expect(debugged()).not.toContain(RESOLVED);
  });
});
