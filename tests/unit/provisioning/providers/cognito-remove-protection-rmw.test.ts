/**
 * The Cognito `--remove-protection` flip and its compensating re-enable are a
 * READ-MODIFY-WRITE `UpdateUserPool` (issue #4066): `UpdateUserPool` resets
 * members a call omits -- measured: the Lambda triggers, advanced security,
 * `AutoVerifiedAttributes` and more -- so a `DeletionProtection`-only write on
 * a pool whose delete then fails leaves it live with its auth triggers gone.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const cognitoSend = vi.fn();

vi.mock('@aws-sdk/client-cognito-identity-provider', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    CognitoIdentityProviderClient: vi.fn().mockImplementation(() => ({
      send: cognitoSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

const childLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn().mockReturnThis(),
};
vi.mock('../../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    child: () => childLogger,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { ResourceNotFoundException } from '@aws-sdk/client-cognito-identity-provider';
import {
  CognitoUserPoolProvider,
  REFUSED_ECHO_ERRORS,
  USER_POOL_ECHO_MEMBERS,
  USER_POOL_KEPT_ON_OMISSION,
  userPoolDeletionProtectionUpdate,
} from '../../../../src/provisioning/providers/cognito-provider.js';
import { isRetryableTransientError } from '../../../../src/deployment/retryable-errors.js';

const POOL = 'us-east-1_abc';
const TRIGGER = 'arn:aws:lambda:us-east-1:123456789012:function:pre-auth';
const CTX = { removeProtection: true, expectedRegion: 'us-east-1' };

type Cmd = { constructor: { name: string }; input: Record<string, unknown> };

/**
 * A DescribeUserPool answer carrying every UpdateUserPool member -- the echoed
 * ones and the measured-KEPT ones, which must NOT be sent -- plus read-only /
 * create-only ones (`Id`, `Arn`, `Name`, `Domain`, `SchemaAttributes`, ...)
 * that `UpdateUserPool` does not take.
 */
function livePool(deletionProtection: 'ACTIVE' | 'INACTIVE'): Record<string, unknown> {
  return {
    Id: POOL,
    Name: 'pool',
    Arn: `arn:aws:cognito-idp:us-east-1:123456789012:userpool/${POOL}`,
    Domain: 'my-domain',
    SchemaAttributes: [{ Name: 'email' }],
    UsernameAttributes: ['email'],
    Status: 'Enabled',
    EstimatedNumberOfUsers: 3,
    DeletionProtection: deletionProtection,
    Policies: { PasswordPolicy: { MinimumLength: 10 } },
    LambdaConfig: { PreAuthentication: TRIGGER },
    AutoVerifiedAttributes: ['email'],
    SmsVerificationMessage: 'sms {####}',
    EmailVerificationMessage: 'email {####}',
    EmailVerificationSubject: 'subject',
    VerificationMessageTemplate: { DefaultEmailOption: 'CONFIRM_WITH_LINK' },
    SmsAuthenticationMessage: 'auth {####}',
    UserAttributeUpdateSettings: { AttributesRequireVerificationBeforeUpdate: ['email'] },
    MfaConfiguration: 'OFF',
    DeviceConfiguration: { ChallengeRequiredOnNewDevice: true },
    EmailConfiguration: { EmailSendingAccount: 'COGNITO_DEFAULT' },
    SmsConfiguration: { SnsCallerArn: 'arn:aws:iam::123456789012:role/sms', ExternalId: 'x' },
    UserPoolTags: { team: 'a' },
    AdminCreateUserConfig: { AllowAdminCreateUserOnly: true, UnusedAccountValidityDays: 7 },
    UserPoolAddOns: { AdvancedSecurityMode: 'AUDIT' },
    AccountRecoverySetting: { RecoveryMechanisms: [{ Name: 'verified_email', Priority: 1 }] },
    UserPoolTier: 'PLUS',
    KeyConfiguration: { KeyType: 'AWS_OWNED_KEY' },
    IssuerConfiguration: { Type: 'ORIGINAL' },
    AcrConfiguration: {
      Level1: { AcrValue: 'urn:example:level1' },
      Level2: { AcrValue: 'urn:cognito:loa:2' },
      Level3: { AcrValue: 'urn:cognito:loa:3' },
      Level4: { AcrValue: 'urn:cognito:loa:4' },
    },
  };
}

/** An AWS-authored service error, as the SDK throws it (`$metadata.httpStatusCode` set). */
function named(name: string, message: string): Error {
  const e = new Error(message) as Error & { $metadata: { httpStatusCode: number } };
  e.name = name;
  e.$metadata = { httpStatusCode: 400 };
  return e;
}

/** A terminal delete refusal (a hosted-UI domain still attached). */
const domainRefusal = (): Error =>
  named(
    'InvalidParameterException',
    'User pool cannot be deleted. It has a domain configured that should be deleted first.'
  );
/** A validation refusal of the echo: AWS re-validated a member and rejected it. */
const echoRefusal = (): Error =>
  named('InvalidParameterException', 'Invalid value for UserAttributeUpdateSettings.');
const throttle = (): Error => named('TooManyRequestsException', 'Rate exceeded');
/** A server error on a read, with the status AWS sends for InternalErrorException. */
const fiveHundredRead = (): Error =>
  Object.assign(named('InternalErrorException', 'read failed'), { $metadata: { httpStatusCode: 500 } });

type Dp = 'ACTIVE' | 'INACTIVE';
interface Script {
  /** What each DescribeUserPool answers, in order (the last one repeats); `null` = no UserPool. */
  reads?: Array<Record<string, unknown> | Error | null>;
  /** Fails an ECHOED (member-carrying) UpdateUserPool with this value. */
  echoError?: { INACTIVE?: Error; ACTIVE?: Error };
  /** Fails a BARE UpdateUserPool with this value. */
  bareError?: { INACTIVE?: Error; ACTIVE?: Error };
  /** The write LANDS server-side, then the call fails with this (a timeout, a 5xx). */
  echoLandedError?: { INACTIVE?: Error };
  bareLandedError?: { INACTIVE?: Error };
  /** DeleteUserPool outcomes, in order (the last one repeats); undefined = accepted. */
  dels?: Array<Error | undefined>;
}

function script(s: Script): void {
  let read = 0;
  let deleted = 0;
  // Without explicit `reads`, the fake pool is STATEFUL: it starts ACTIVE and
  // a landed UpdateUserPool sets what later reads report.
  let liveDp: Dp = 'ACTIVE';
  const dels = s.dels ?? [undefined];
  cognitoSend.mockImplementation(async (cmd: Cmd) => {
    const name = cmd.constructor.name;
    if (name === 'DescribeUserPoolCommand') {
      if (!s.reads) return { UserPool: livePool(liveDp) };
      const r = s.reads[Math.min(read++, s.reads.length - 1)];
      if (r instanceof Error) throw r;
      return r === null ? {} : { UserPool: r };
    }
    if (name === 'UpdateUserPoolCommand') {
      const echoed = Object.keys(cmd.input).length > 2;
      const dp = cmd.input['DeletionProtection'] as Dp;
      const err = echoed ? s.echoError?.[dp] : s.bareError?.[dp];
      if (err) throw err;
      liveDp = dp;
      const landed = echoed ? s.echoLandedError?.[dp as 'INACTIVE'] : s.bareLandedError?.[dp as 'INACTIVE'];
      if (landed) throw landed;
      return {};
    }
    if (name === 'DeleteUserPoolCommand') {
      const err = dels[Math.min(deleted++, dels.length - 1)];
      if (err) throw err;
      return {};
    }
    throw new Error(`unexpected ${name}`);
  });
}

const commands = (): Cmd[] => cognitoSend.mock.calls.map((c) => c[0] as Cmd);
const updates = (): Array<Record<string, unknown>> =>
  commands()
    .filter((c) => c.constructor.name === 'UpdateUserPoolCommand')
    .map((c) => c.input);
const isEcho = (u: Record<string, unknown>): boolean => Object.keys(u).length > 2;
const deleteCalls = (): number =>
  commands().filter((c) => c.constructor.name === 'DeleteUserPoolCommand').length;

const del = (
  context: Record<string, unknown> = CTX,
  provider: CognitoUserPoolProvider = new CognitoUserPoolProvider()
) => provider.delete('Pool', POOL, 'AWS::Cognito::UserPool', undefined, context);

beforeEach(() => {
  vi.clearAllMocks();
  cognitoSend.mockReset();
});

describe('userPoolDeletionProtectionUpdate', () => {
  it('echoes exactly the reset-prone members, and never a measured-KEPT or read-only one', () => {
    const pool = livePool('ACTIVE');
    const input = userPoolDeletionProtectionUpdate(POOL, pool as never, 'INACTIVE');
    const expected: Record<string, unknown> = { UserPoolId: POOL, DeletionProtection: 'INACTIVE' };
    for (const m of USER_POOL_ECHO_MEMBERS) expected[m] = pool[m];
    // Only the CUSTOM ACR level travels; the default-named ones are dropped.
    expected.AcrConfiguration = { Level1: { AcrValue: 'urn:example:level1' } };
    expect(input).toEqual(expected);
    // The measured-KEPT members are refusal triggers with nothing to protect:
    // SmsConfiguration and EmailConfiguration are re-validated on write.
    for (const kept of USER_POOL_KEPT_ON_OMISSION) expect(input).not.toHaveProperty(kept);
    for (const readOnly of ['Id', 'Name', 'Arn', 'Domain', 'SchemaAttributes', 'Status']) {
      expect(input).not.toHaveProperty(readOnly);
    }
  });

  it('sends no AcrConfiguration when every level carries its default name (a Lite pool reads back all four)', () => {
    const input = userPoolDeletionProtectionUpdate(
      POOL,
      {
        Id: POOL,
        AcrConfiguration: Object.fromEntries(
          [1, 2, 3, 4].map((n) => [`Level${n}`, { AcrValue: `urn:cognito:loa:${n}` }])
        ),
      } as never,
      'INACTIVE'
    );
    expect(input).not.toHaveProperty('AcrConfiguration');
  });

  it('keeps a level whose custom name is another level\'s default', () => {
    const input = userPoolDeletionProtectionUpdate(
      POOL,
      {
        Id: POOL,
        AcrConfiguration: {
          Level1: { AcrValue: 'urn:cognito:loa:2' },
          Level2: { AcrValue: 'urn:example:two' },
          Level3: { AcrValue: 'urn:cognito:loa:3' },
          Level4: { AcrValue: 'urn:cognito:loa:4' },
        },
      } as never,
      'INACTIVE'
    );
    expect(input.AcrConfiguration).toEqual({
      Level1: { AcrValue: 'urn:cognito:loa:2' },
      Level2: { AcrValue: 'urn:example:two' },
    });
  });

  it('omits a member the read did not carry, rather than sending it as undefined', () => {
    const input = userPoolDeletionProtectionUpdate(
      POOL,
      { Id: POOL, DeletionProtection: 'ACTIVE', AutoVerifiedAttributes: ['email'] } as never,
      'INACTIVE'
    );
    expect(Object.keys(input).sort()).toEqual(
      ['AutoVerifiedAttributes', 'DeletionProtection', 'UserPoolId'].sort()
    );
  });

  it('addresses the caller physical id, never the id the read reported', () => {
    const input = userPoolDeletionProtectionUpdate(POOL, { Id: 'us-east-1_other' } as never, 'ACTIVE');
    expect(input.UserPoolId).toBe(POOL);
  });

  it('partitions every UpdateUserPool member: echoed, measured-KEPT, the guard, or update-only (an SDK bump adding one fails here)', () => {
    // Read both shapes from the SDK the provider is compiled against, so a new
    // member -- which UpdateUserPool may RESET by omission -- has to be
    // classified before it ships.
    const require = createRequire(import.meta.url);
    const typesDir = join(
      dirname(require.resolve('@aws-sdk/client-cognito-identity-provider')),
      '..',
      'dist-types',
      'models'
    );
    const members = (iface: string): Set<string> => {
      for (const file of ['models_0.d.ts', 'models_1.d.ts']) {
        const src = readFileSync(join(typesDir, file), 'utf8');
        const start = src.indexOf(`export interface ${iface} {`);
        if (start < 0) continue;
        const body = src.slice(start, src.indexOf('\n}', start));
        return new Set([...body.matchAll(/^ {4}(\w+)\??:/gm)].map((m) => m[1]!));
      }
      throw new Error(`${iface} not found in ${typesDir}`);
    };
    const update = members('UpdateUserPoolRequest');
    const read = members('UserPoolType');
    // Floors: the parse really saw both interfaces.
    expect(update.size).toBeGreaterThanOrEqual(20);
    expect(read.size).toBeGreaterThanOrEqual(30);
    // Update-only members: what DescribeUserPool cannot give back to echo.
    expect([...update].filter((m) => !read.has(m)).sort()).toEqual(['PoolName', 'UserPoolId']);
    const parts = [
      ...USER_POOL_ECHO_MEMBERS,
      ...USER_POOL_KEPT_ON_OMISSION,
      'DeletionProtection',
      'PoolName',
      'UserPoolId',
    ];
    // Disjoint, and together exactly the request.
    expect(new Set(parts).size).toBe(parts.length);
    expect([...parts].sort()).toEqual([...update].sort());
  });
});

describe('CognitoUserPoolProvider.delete --remove-protection: read-modify-write (#4066)', () => {
  it('flips the guard off with the reset-prone members echoed back, Lambda triggers included', async () => {
    script({});
    await del();
    const [flip] = updates();
    expect(flip).toEqual(userPoolDeletionProtectionUpdate(POOL, livePool('ACTIVE') as never, 'INACTIVE'));
    expect(flip).toMatchObject({
      DeletionProtection: 'INACTIVE',
      LambdaConfig: { PreAuthentication: TRIGGER },
      UserPoolAddOns: { AdvancedSecurityMode: 'AUDIT' },
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    });
    expect(updates()).toHaveLength(1);
  });

  it('the compensating re-enable reads the pool AFRESH and echoes it back with the guard on', async () => {
    // The fresh read differs from the pre-flip one, so an echo built from the
    // wrong read is caught: the re-enable must carry what the pool holds NOW.
    const later = { ...livePool('INACTIVE'), SmsAuthenticationMessage: 'later {####}' };
    script({ reads: [livePool('ACTIVE'), later], dels: [domainRefusal()] });
    await expect(del()).rejects.toThrow('domain configured');
    const [, reEnable] = updates();
    expect(reEnable).toEqual(userPoolDeletionProtectionUpdate(POOL, later as never, 'ACTIVE'));
    expect(childLogger.warn).toHaveBeenCalledWith(expect.stringContaining(`re-enabled on ${POOL}`));
    expect(childLogger.error).not.toHaveBeenCalled();
  });

  it('the echo and the measured-KEPT sets are pinned literally', () => {
    // A member moved between them is a behaviour change (echoed or not) that
    // the partition fence alone would accept.
    expect([...USER_POOL_ECHO_MEMBERS].sort()).toEqual([
      'AcrConfiguration',
      'AdminCreateUserConfig',
      'AutoVerifiedAttributes',
      'DeviceConfiguration',
      'EmailVerificationMessage',
      'EmailVerificationSubject',
      'LambdaConfig',
      'SmsAuthenticationMessage',
      'SmsVerificationMessage',
      'UserAttributeUpdateSettings',
      'UserPoolAddOns',
      'VerificationMessageTemplate',
    ]);
    expect([...USER_POOL_KEPT_ON_OMISSION].sort()).toEqual([
      'AccountRecoverySetting',
      'EmailConfiguration',
      'IssuerConfiguration',
      'KeyConfiguration',
      'MfaConfiguration',
      'Policies',
      'SmsConfiguration',
      'UserPoolTags',
      'UserPoolTier',
    ]);
  });

  it('echoes a DEVELOPER (SES) EmailConfiguration -- measured to RESET on omission (#4149) -- but not a COGNITO_DEFAULT one', () => {
    const ses = {
      EmailSendingAccount: 'DEVELOPER',
      SourceArn: 'arn:aws:ses:us-east-1:123456789012:identity/example.com',
    };
    expect(
      userPoolDeletionProtectionUpdate(POOL, { ...livePool('ACTIVE'), EmailConfiguration: ses } as never, 'INACTIVE')
        .EmailConfiguration
    ).toEqual(ses);
    expect(
      userPoolDeletionProtectionUpdate(POOL, livePool('ACTIVE') as never, 'INACTIVE')
    ).not.toHaveProperty('EmailConfiguration');
  });

  it('the fallback set is exactly the validation refusals', () => {
    // Pinned literally: the it.each below iterates the set itself, so a name
    // dropped from it would only drop a case.
    expect([...REFUSED_ECHO_ERRORS].sort()).toEqual([
      'InvalidEmailRoleAccessPolicyException',
      'InvalidParameterException',
      'InvalidSmsRoleAccessPolicyException',
      'InvalidSmsRoleTrustRelationshipException',
    ]);
  });

  it.each([...REFUSED_ECHO_ERRORS])(
    'falls back to the bare flip, at warn, when the echo is refused with %s',
    async (errorName) => {
      script({ echoError: { INACTIVE: named(errorName, 'refused') } });
      await del();
      const [echoFlip, bareFlip] = updates();
      expect(isEcho(echoFlip!)).toBe(true);
      expect(bareFlip).toEqual({ UserPoolId: POOL, DeletionProtection: 'INACTIVE' });
      expect(childLogger.warn).toHaveBeenCalledWith(
        expect.stringMatching(/refused the pool's own configuration.*self sign-up, Lambda triggers/)
      );
      expect(deleteCalls()).toBe(1);
    }
  );

  it.each([
    ['access denied', named('AccessDeniedException', 'User is not authorized')],
    ['an unlisted validation-shaped error', named('InvalidLambdaResponseException', 'x')],
    ['a tagging refusal', named('UserPoolTaggingException', 'x')],
  ])('does NOT fall back when the echo fails with %s: the guard stays on, at warn', async (_l, err) => {
    script({ echoError: { INACTIVE: err }, dels: [named('InvalidParameterException', 'deletion protection is activated')] });
    await expect(del()).rejects.toThrow('deletion protection is activated');
    // Only the echoed flip: no settings-resetting bare write.
    expect(updates()).toHaveLength(1);
    expect(isEcho(updates()[0]!)).toBe(true);
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`DeletionProtection was left on, because UpdateUserPool refused to turn it off (${err.name}`)
    );
  });

  it('an echo that got NO answer and did NOT land: no "left on" claim, and the re-enable still writes the guard back', async () => {
    const timeout = Object.assign(new Error('socket hang up'), { name: 'TimeoutError' });
    script({ echoError: { INACTIVE: timeout }, dels: [domainRefusal()] });
    await expect(del()).rejects.toThrow();
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /failed without an answer from AWS.*whether DeletionProtection was turned off is unknown\. Its other settings were not reset\. If the delete then fails, cdkd turns the guard back on/
      )
    );
    expect(childLogger.warn).not.toHaveBeenCalledWith(expect.stringContaining('was left on'));
    // The fresh read says ON, but a read can lag: the echoed ACTIVE is
    // written anyway (idempotent, resets nothing), and the narration says so.
    expect(updates().map((u) => [isEcho(u), u['DeletionProtection']])).toEqual([
      [true, 'INACTIVE'],
      [true, 'ACTIVE'],
    ]);
    expect(childLogger.warn).toHaveBeenCalledWith(expect.stringContaining('already read it on, and cdkd wrote it back (AWS accepted the write)'));
    expect(childLogger.warn).not.toHaveBeenCalledWith(expect.stringContaining('re-enabled on'));
    expect(childLogger.error).not.toHaveBeenCalled();
  });

  it('an echo that got NO answer but DID land is re-enabled with an echo, reporting no reset', async () => {
    const timeout = Object.assign(new Error('socket hang up'), { name: 'TimeoutError' });
    script({ echoLandedError: { INACTIVE: timeout }, dels: [domainRefusal()] });
    await expect(del()).rejects.toThrow('domain configured');
    expect(updates().map((u) => [isEcho(u), u['DeletionProtection']])).toEqual([
      [true, 'INACTIVE'],
      [true, 'ACTIVE'],
    ]);
    expect(childLogger.warn).toHaveBeenCalledWith(expect.stringContaining(`re-enabled on ${POOL}`));
    expect(childLogger.error).not.toHaveBeenCalled();
  });

  it.each([
    ['a throttle', throttle()],
    ['a 5xx', Object.assign(named('InternalErrorException', 'boom'), { $metadata: { httpStatusCode: 500 } })],
  ])('an echo failing with %s retries the whole delete: no bare flip, no DeleteUserPool, no warn', async (_l, err) => {
    script({ echoError: { INACTIVE: err } });
    const thrown = await del()
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(isRetryableTransientError(thrown, (thrown as Error).message)).toBe(true);
    expect(updates()).toHaveLength(1);
    expect(deleteCalls()).toBe(0);
    expect(childLogger.warn).not.toHaveBeenCalled();
  });

  it('a bare fallback failing with a throttle retries the whole delete too', async () => {
    script({ echoError: { INACTIVE: echoRefusal() }, bareError: { INACTIVE: throttle() } });
    const thrown = await del()
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(isRetryableTransientError(thrown, (thrown as Error).message)).toBe(true);
    expect(updates()).toHaveLength(2);
    expect(deleteCalls()).toBe(0);
    // A retry is coming: no "left on" claim for a write that will be re-sent.
    expect(childLogger.warn).not.toHaveBeenCalledWith(expect.stringContaining('left on'));
  });

  it('names cognito-idp:UpdateUserPool when the echo is access-denied', async () => {
    script({ echoError: { INACTIVE: named('AccessDeniedException', 'no') }, dels: [domainRefusal()] });
    await expect(del()).rejects.toThrow();
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/left on.*The caller needs cognito-idp:UpdateUserPool\./)
    );
  });

  it('when the bare fallback fails too, warns the guard was left on, naming BOTH refusals', async () => {
    script({
      echoError: { INACTIVE: echoRefusal() },
      bareError: { INACTIVE: named('ConcurrentModificationException', 'busy') },
      dels: [named('InvalidParameterException', 'deletion protection is activated')],
    });
    await expect(del()).rejects.toThrow('deletion protection is activated');
    expect(updates()).toHaveLength(2);
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /left on, because UpdateUserPool refused to turn it off \(ConcurrentModificationException.*sent back were refused first \(InvalidParameterException/
      )
    );
    // Never the "turned off alone" line: the bare write did not land.
    expect(childLogger.warn).not.toHaveBeenCalledWith(expect.stringContaining('turned off alone'));
  });

  it('does not fall back when the echo answers not-found: the delete reports the pool gone', async () => {
    const gone = new ResourceNotFoundException({ $metadata: {}, message: 'gone' });
    script({ echoError: { INACTIVE: gone }, dels: [gone] });
    await expect(del()).resolves.toBeUndefined();
    expect(updates()).toHaveLength(1);
    expect(childLogger.warn).not.toHaveBeenCalled();
  });

  it('leaves the guard ON, at warn, when the pre-flip read is DENIED: no blind flip, and no retry budget burned', async () => {
    // The real IAM refusal shape. Its message matches retryable-errors.ts's
    // IAM-propagation pattern (`not authorized to perform`), which must NOT
    // turn a missing permission into a retry loop.
    script({
      reads: [
        named(
          'AccessDeniedException',
          'User: arn:aws:sts::123456789012:assumed-role/r/s is not authorized to perform: cognito-idp:DescribeUserPool on resource: arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_abc'
        ),
      ],
      dels: [named('InvalidParameterException', 'deletion protection is activated')],
    });
    await expect(del()).rejects.toThrow('deletion protection is activated');
    expect(updates()).toHaveLength(0);
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /DeletionProtection was left on.*could not be read first.*self sign-up.*cognito-idp:DescribeUserPool/
      )
    );
    expect(deleteCalls()).toBe(1);
  });

  it('a TRANSIENT pre-flip read failure throws a retryable error before any DeleteUserPool', async () => {
    script({ reads: [throttle()] });
    const thrown = await del()
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(Error);
    expect(deleteCalls()).toBe(0);
    expect(updates()).toHaveLength(0);
    // The outer destroy loop re-enters on exactly this classification.
    expect(isRetryableTransientError(thrown, (thrown as Error).message)).toBe(true);
    // A retry is coming: nothing to warn about yet.
    expect(childLogger.warn).not.toHaveBeenCalled();
  });

  it('a read that returned no pool is not flipped either, and the warn says so plainly', async () => {
    script({ reads: [null], dels: [named('InvalidParameterException', 'deletion protection is activated')] });
    await expect(del()).rejects.toThrow('deletion protection is activated');
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('could not be read first (DescribeUserPool returned no pool)')
    );
    // Asserted directly: the mock's throw on an UpdateUserPool would be swallowed
    // by the flip's own catch and keep this case green.
    expect(updates()).toHaveLength(0);
  });

  it('a pool that read not-found is neither flipped nor warned about: the delete reports it gone', async () => {
    const gone = new ResourceNotFoundException({ $metadata: {}, message: 'gone' });
    script({ reads: [gone], dels: [gone] });
    await expect(del()).resolves.toBeUndefined();
    expect(updates()).toHaveLength(0);
    expect(childLogger.warn).not.toHaveBeenCalled();
  });

  it('after a BARE flip, a refused echo on the re-enable falls back to the bare re-enable, and the reset is reported at ERROR', async () => {
    script({
      echoError: { INACTIVE: echoRefusal(), ACTIVE: echoRefusal() },
      dels: [domainRefusal()],
    });
    await expect(del()).rejects.toThrow('domain configured');
    expect(updates().map((u) => [isEcho(u), u['DeletionProtection']])).toEqual([
      [true, 'INACTIVE'],
      [false, 'INACTIVE'],
      [true, 'ACTIVE'],
      [false, 'ACTIVE'],
    ]);
    expect(childLogger.warn).toHaveBeenCalledWith(expect.stringContaining(`re-enabled on ${POOL}`));
    // Restored guard or not, the pool is LIVE with its settings reset: say so,
    // with what it held, since a redeploy will not diff.
    expect(childLogger.error).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(
          `${POOL} is LIVE with its self sign-up, Lambda triggers and advanced security reset.*` +
            `AllowAdminCreateUserOnly=true, LambdaConfig\\.PreAuthentication=${TRIGGER}, AdvancedSecurityMode=AUDIT.*` +
            `will NOT restore them`
        )
      )
    );
  });

  it('the ERROR report names a DEVELOPER EmailConfiguration the bare flip reset (#4149), without its SourceArn', async () => {
    const ses = { EmailSendingAccount: 'DEVELOPER', SourceArn: 'arn:aws:ses:us-east-1:123456789012:identity/sender@example.com' };
    script({
      reads: [{ ...livePool('ACTIVE'), EmailConfiguration: ses }],
      echoError: { INACTIVE: echoRefusal(), ACTIVE: echoRefusal() },
      dels: [domainRefusal()],
    });
    await expect(del()).rejects.toThrow('domain configured');
    // Flip: echo with SES, echo without it, then bare -- all before the delete.
    expect(
      updates()
        .filter((u) => u['DeletionProtection'] === 'INACTIVE')
        .map((u) => [isEcho(u), u['EmailConfiguration'] !== undefined])
    ).toEqual([
      [true, true],
      [true, false],
      [false, false],
    ]);
    const errors = childLogger.error.mock.calls.map((c) => String(c[0]));
    expect(errors).toContainEqual(
      expect.stringContaining('AdvancedSecurityMode=AUDIT, EmailConfiguration.EmailSendingAccount=DEVELOPER (SES).')
    );
    // The bare report names the SES sender in its state line too, and no
    // separate SES ERROR repeats it.
    expect(errors).toContainEqual(
      expect.stringContaining('is LIVE with its self sign-up, Lambda triggers, advanced security and SES email configuration reset')
    );
    expect(errors.join('\n')).not.toContain('is LIVE with its SES email configuration reset');
    expect(errors.join('\n')).not.toContain('sender@example.com');
  });

  it('the ERROR report lists EVERY trigger slot sharing one function', async () => {
    const shared = 'arn:aws:lambda:us-east-1:123456789012:function:shared';
    script({
      reads: [
        { ...livePool('ACTIVE'), LambdaConfig: { PreSignUp: shared, PostConfirmation: shared } },
        { ...livePool('INACTIVE'), LambdaConfig: {} },
      ],
      echoError: { INACTIVE: echoRefusal(), ACTIVE: echoRefusal() },
      dels: [domainRefusal()],
    });
    await expect(del()).rejects.toThrow('domain configured');
    expect(childLogger.error).toHaveBeenCalledWith(
      expect.stringContaining(`LambdaConfig.PreSignUp=${shared}, LambdaConfig.PostConfirmation=${shared}`)
    );
  });

  it('a BARE flip that timed out but LANDED is reported as a definite reset, and re-enabled', async () => {
    const timeout = Object.assign(new Error('socket hang up'), { name: 'TimeoutError' });
    script({
      echoError: { INACTIVE: echoRefusal() },
      bareLandedError: { INACTIVE: timeout },
      dels: [domainRefusal()],
    });
    await expect(del()).rejects.toThrow('domain configured');
    // The fresh read shows the guard OFF after a bare attempt: it landed.
    expect(childLogger.error).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(`${POOL} is LIVE with its self sign-up, Lambda triggers and advanced security reset.*AllowAdminCreateUserOnly=true`)
      )
    );
    expect(childLogger.warn).toHaveBeenCalledWith(expect.stringContaining(`re-enabled on ${POOL}`));
  });

  it('a BARE flip that answered 5xx but LANDED: retried, then the stale echo is refused again and the bare re-enable restores the guard', async () => {
    const provider = new CognitoUserPoolProvider();
    const fiveHundred = Object.assign(named('ServiceUnavailableException', 'boom'), {
      $metadata: { httpStatusCode: 503 },
    });
    script({ echoError: { INACTIVE: echoRefusal() }, bareLandedError: { INACTIVE: fiveHundred } });
    await expect(del(CTX, provider)).rejects.toThrow();
    expect(deleteCalls()).toBe(0);
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/if that write landed, the pool's self sign-up, Lambda triggers and advanced security were reset/)
    );
    // The retry: the pool reads INACTIVE (the write landed), so no flip; the
    // delete fails terminally; the re-enable's echo hits the same stale member.
    cognitoSend.mockReset();
    script({
      reads: [livePool('INACTIVE')],
      echoError: { ACTIVE: echoRefusal() },
      dels: [domainRefusal()],
    });
    await expect(del(CTX, provider)).rejects.toThrow('domain configured');
    expect(updates().map((u) => [isEcho(u), u['DeletionProtection']])).toEqual([
      [true, 'ACTIVE'],
      [false, 'ACTIVE'],
    ]);
    expect(childLogger.warn).toHaveBeenCalledWith(expect.stringContaining(`re-enabled on ${POOL}`));
    expect(childLogger.error).toHaveBeenCalledWith(
      expect.stringContaining(`${POOL} is LIVE with its self sign-up, Lambda triggers and advanced security reset`)
    );
  });

  it('a BARE flip that timed out and did NOT land: a "MAY" report (reads can lag), only an ECHOED write-back, no false "still off" claim', async () => {
    const timeout = Object.assign(new Error('socket hang up'), { name: 'TimeoutError' });
    script({
      echoError: { INACTIVE: echoRefusal(), ACTIVE: echoRefusal() },
      bareError: { INACTIVE: timeout },
      dels: [named('InvalidParameterException', 'deletion protection is activated')],
    });
    await expect(del()).rejects.toThrow('deletion protection is activated');
    // The pool read ACTIVE (settings possibly intact): never a bare write,
    // even though the echo is refused.
    const reEnables = updates().filter((u) => u['DeletionProtection'] === 'ACTIVE');
    expect(reEnables).toHaveLength(1);
    expect(isEcho(reEnables[0]!)).toBe(true);
    expect(childLogger.error).not.toHaveBeenCalledWith(expect.stringContaining('is LIVE with its self sign-up'));
    // The pool reads ON, but a read can lag: the bare write MAY have landed.
    expect(childLogger.error).toHaveBeenCalledWith(expect.stringContaining('MAY have been reset'));
    // The guard read ON: the refused write-back is NOT reported as "still off"
    // (whose pasted bare restore command would itself reset the pool).
    expect(childLogger.error).not.toHaveBeenCalledWith(expect.stringContaining('still off'));
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/read it on afterwards, but writing it back failed.*Check with: aws cognito-idp describe-user-pool/)
    );
  });

  it('an ambiguous bare flip that a later attempt observes as OFF becomes definite (it landed)', async () => {
    const provider = new CognitoUserPoolProvider();
    const fiveHundred = Object.assign(named('ServiceUnavailableException', 'boom'), {
      $metadata: { httpStatusCode: 503 },
    });
    // Attempt 1: the bare flip answers 503 -> ambiguous, retried.
    script({ echoError: { INACTIVE: echoRefusal() }, bareError: { INACTIVE: fiveHundred } });
    await expect(del(CTX, provider)).rejects.toThrow();
    // Attempt 2 observes INACTIVE (so the bare write DID land), the delete
    // fails, and the re-enable's read FAILS: only the record can tell, and it
    // must say "reset", not "MAY".
    cognitoSend.mockReset();
    script({
      reads: [livePool('INACTIVE'), fiveHundredRead()],
      dels: [domainRefusal()],
    });
    await expect(del(CTX, provider)).rejects.toThrow('domain configured');
    expect(childLogger.error).toHaveBeenCalledWith(expect.stringContaining('advanced security reset:'));
    expect(childLogger.error).not.toHaveBeenCalledWith(expect.stringContaining('MAY have been reset'));
  });

  it('an ambiguous bare flip whose re-enable cannot read the pool, in the SAME attempt, stays "MAY"', async () => {
    const timeout = Object.assign(new Error('socket hang up'), { name: 'TimeoutError' });
    script({
      echoError: { INACTIVE: echoRefusal() },
      bareError: { INACTIVE: timeout },
      reads: [livePool('ACTIVE'), fiveHundredRead()],
      dels: [domainRefusal()],
    });
    await expect(del()).rejects.toThrow('domain configured');
    expect(childLogger.error).toHaveBeenCalledWith(expect.stringContaining('MAY have been reset'));
  });

  it('a no-answer bare write after an EARLIER definite reset does not downgrade the report', async () => {
    const provider = new CognitoUserPoolProvider();
    // Attempt 1: echo refused, bare flip lands (definite), retryable delete failure.
    script({ echoError: { INACTIVE: echoRefusal() }, dels: [throttle()] });
    await expect(del(CTX, provider)).rejects.toThrow('Rate exceeded');
    // Out of band the guard is turned back on. Attempt 2: echo refused again,
    // the bare write times out; the delete fails; the re-enable read fails.
    cognitoSend.mockReset();
    const timeout = Object.assign(new Error('socket hang up'), { name: 'TimeoutError' });
    script({
      echoError: { INACTIVE: echoRefusal() },
      bareError: { INACTIVE: timeout },
      reads: [livePool('ACTIVE'), fiveHundredRead()],
      dels: [domainRefusal()],
    });
    await expect(del(CTX, provider)).rejects.toThrow('domain configured');
    expect(childLogger.error).toHaveBeenCalledWith(expect.stringContaining('advanced security reset:'));
    expect(childLogger.error).not.toHaveBeenCalledWith(expect.stringContaining('MAY have been reset'));
  });

  it('a re-enable read with NO pool after a bare flip still reports the reset', async () => {
    script({
      echoError: { INACTIVE: echoRefusal() },
      reads: [livePool('ACTIVE'), null],
      dels: [domainRefusal()],
    });
    await expect(del()).rejects.toThrow('domain configured');
    expect(childLogger.error).toHaveBeenCalledWith(
      expect.stringContaining(`${POOL} is LIVE with its self sign-up, Lambda triggers and advanced security reset`)
    );
    expect(childLogger.error).toHaveBeenCalledWith(expect.stringContaining('could NOT re-enable DeletionProtection'));
  });

  it('a stale ACTIVE read on the re-enable after a 5xx bare flip that LANDED still writes the echoed ACTIVE', async () => {
    const provider = new CognitoUserPoolProvider();
    const fiveHundred = Object.assign(named('ServiceUnavailableException', 'boom'), {
      $metadata: { httpStatusCode: 503 },
    });
    script({ echoError: { INACTIVE: echoRefusal() }, bareLandedError: { INACTIVE: fiveHundred } });
    await expect(del(CTX, provider)).rejects.toThrow();
    // Re-entry observes INACTIVE (it landed); the delete fails; the re-enable
    // read lags and says ACTIVE.
    cognitoSend.mockReset();
    script({ reads: [livePool('INACTIVE'), livePool('ACTIVE')], dels: [domainRefusal()] });
    await expect(del(CTX, provider)).rejects.toThrow('domain configured');
    const reEnables = updates().filter((u) => u['DeletionProtection'] === 'ACTIVE');
    expect(reEnables).toHaveLength(1);
    expect(isEcho(reEnables[0]!)).toBe(true);
    // Observed OFF on re-entry made it definite, so the reset is reported.
    expect(childLogger.error).toHaveBeenCalledWith(expect.stringContaining('advanced security reset:'));
  });

  it('a bare flip timing out warns that the reset is unknown, not that the settings were kept', async () => {
    const timeout = Object.assign(new Error('socket hang up'), { name: 'TimeoutError' });
    script({ echoError: { INACTIVE: echoRefusal() }, bareError: { INACTIVE: timeout }, dels: [domainRefusal()] });
    await expect(del()).rejects.toThrow('domain configured');
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/whether DeletionProtection was turned off ALONE is unknown; if it was, the pool's self sign-up/)
    );
    expect(childLogger.warn).not.toHaveBeenCalledWith(expect.stringContaining('not reset'));
  });

  it('the ERROR report names each trigger function once, and not the KMS key', async () => {
    const tokenFn = 'arn:aws:lambda:us-east-1:123456789012:function:pre-token';
    const pool = {
      ...livePool('ACTIVE'),
      LambdaConfig: {
        PreAuthentication: TRIGGER,
        PreTokenGeneration: tokenFn,
        PreTokenGenerationConfig: { LambdaArn: tokenFn, LambdaVersion: 'V2_0' },
        KMSKeyID: 'arn:aws:kms:us-east-1:123456789012:key/k',
      },
    };
    script({
      reads: [pool, { ...pool, DeletionProtection: 'INACTIVE' }],
      echoError: { INACTIVE: echoRefusal(), ACTIVE: echoRefusal() },
      dels: [domainRefusal()],
    });
    await expect(del()).rejects.toThrow('domain configured');
    const report = childLogger.error.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes('is LIVE with'))!;
    expect(report).toContain(
      `LambdaConfig.PreAuthentication=${TRIGGER}, LambdaConfig.PreTokenGenerationConfig=${tokenFn}, AdvancedSecurityMode=AUDIT`
    );
    expect(report).not.toContain('KMSKeyID');
    expect(report).not.toContain('LambdaConfig.PreTokenGeneration=');
  });

  it('after a BARE flip, the reset is reported even when the re-enable fails', async () => {
    script({
      echoError: { INACTIVE: echoRefusal() },
      reads: [livePool('ACTIVE'), fiveHundredRead()],
      dels: [domainRefusal()],
    });
    await expect(del()).rejects.toThrow('domain configured');
    expect(childLogger.error).toHaveBeenCalledWith(expect.stringContaining(`${POOL} is LIVE with its self sign-up`));
    expect(childLogger.error).toHaveBeenCalledWith(expect.stringContaining('could NOT re-enable DeletionProtection'));
  });

  it('after a BARE flip, a NON-refusal re-enable failure (a throttle) makes exactly one echoed attempt, no bare one', async () => {
    script({
      echoError: { INACTIVE: echoRefusal(), ACTIVE: throttle() },
      dels: [domainRefusal()],
    });
    await expect(del()).rejects.toThrow('domain configured');
    const reEnables = updates().filter((u) => u['DeletionProtection'] === 'ACTIVE');
    expect(reEnables).toHaveLength(1);
    expect(isEcho(reEnables[0]!)).toBe(true);
    expect(childLogger.error).toHaveBeenCalledWith(expect.stringContaining('could NOT re-enable DeletionProtection'));
  });

  it('the definite bare-flip record (preFlipPools, the only carrier) survives an outer-loop re-entry: attempt 2 observes the guard off and still re-enables bare', async () => {
    const provider = new CognitoUserPoolProvider();
    // Attempt 1: refused echo -> bare flip -> a RETRYABLE delete failure.
    script({ echoError: { INACTIVE: echoRefusal() }, dels: [throttle()] });
    await expect(del(CTX, provider)).rejects.toThrow('Rate exceeded');
    expect(updates().filter((u) => u['DeletionProtection'] === 'ACTIVE')).toHaveLength(0);

    // Attempt 2: the pool reads INACTIVE (attempt 1 turned it off) -> no flip;
    // the delete fails terminally -> the re-enable's echo is refused again ->
    // the latch from attempt 1 licenses the bare re-enable.
    cognitoSend.mockReset();
    script({
      reads: [livePool('INACTIVE')],
      echoError: { ACTIVE: echoRefusal() },
      dels: [domainRefusal()],
    });
    await expect(del(CTX, provider)).rejects.toThrow('domain configured');
    expect(updates().map((u) => [isEcho(u), u['DeletionProtection']])).toEqual([
      [true, 'ACTIVE'],
      [false, 'ACTIVE'],
    ]);
    // The report names attempt 1's PRE-FLIP read, not attempt 2's reset one.
    expect(childLogger.error).toHaveBeenCalledWith(expect.stringContaining('AllowAdminCreateUserOnly=true'));
  });

  it('a LATER bare flip does not overwrite the first pre-flip read the ERROR report names', async () => {
    const provider = new CognitoUserPoolProvider();
    // Attempt 1: bare flip over the ORIGINAL pool, retryable delete failure.
    script({ echoError: { INACTIVE: echoRefusal() }, dels: [throttle()] });
    await expect(del(CTX, provider)).rejects.toThrow('Rate exceeded');
    // Attempt 2: the guard is ACTIVE again (turned back on out of band) over
    // the already-RESET pool; the echo is refused again, so a second bare flip
    // goes out, then the delete fails terminally.
    const reset = {
      ...livePool('ACTIVE'),
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: false },
      LambdaConfig: {},
      UserPoolAddOns: undefined,
    };
    cognitoSend.mockReset();
    script({
      reads: [reset, { ...reset, DeletionProtection: 'INACTIVE' }],
      echoError: { INACTIVE: echoRefusal(), ACTIVE: echoRefusal() },
      dels: [domainRefusal()],
    });
    await expect(del(CTX, provider)).rejects.toThrow('domain configured');
    // The report names what the pool held BEFORE cdkd first reset it.
    expect(childLogger.error).toHaveBeenCalledWith(
      expect.stringContaining(`AllowAdminCreateUserOnly=true, LambdaConfig.PreAuthentication=${TRIGGER}`)
    );
  });

  it('an ambiguous bare flip that did NOT land is forgotten once a later attempt echoes successfully', async () => {
    const provider = new CognitoUserPoolProvider();
    const fiveHundred = Object.assign(named('ServiceUnavailableException', 'boom'), {
      $metadata: { httpStatusCode: 503 },
    });
    // Attempt 1: echo refused, bare flip answers 503 and does NOT land -> retried.
    script({ echoError: { INACTIVE: echoRefusal() }, bareError: { INACTIVE: fiveHundred } });
    await expect(del(CTX, provider)).rejects.toThrow();
    // Attempt 2: the pool reads ACTIVE; the echo is now accepted (the settings
    // stay intact); the delete fails terminally; the re-enable's echo is refused.
    cognitoSend.mockReset();
    script({ echoError: { ACTIVE: echoRefusal() }, dels: [domainRefusal()] });
    await expect(del(CTX, provider)).rejects.toThrow('domain configured');
    // No bare ACTIVE against a pool whose settings are intact, and no false
    // "reset" report.
    const reEnables = updates().filter((u) => u['DeletionProtection'] === 'ACTIVE');
    expect(reEnables).toHaveLength(1);
    expect(isEcho(reEnables[0]!)).toBe(true);
    expect(childLogger.error).not.toHaveBeenCalledWith(expect.stringContaining('is LIVE with its self sign-up'));
    expect(childLogger.error).not.toHaveBeenCalledWith(expect.stringContaining('MAY have been reset'));
    expect(childLogger.error).toHaveBeenCalledWith(expect.stringContaining('could NOT re-enable DeletionProtection'));
  });

  it('a definite reset from an earlier attempt is still reported when the re-enable finds the guard back on', async () => {
    const provider = new CognitoUserPoolProvider();
    // Attempt 1: echo refused, the bare write lands (a definite reset), and
    // the delete fails retryably.
    script({ echoError: { INACTIVE: echoRefusal() }, dels: [throttle()] });
    await expect(del(CTX, provider)).rejects.toThrow('Rate exceeded');
    // Out of band the guard is turned back on. Attempt 2: the echo gets no
    // answer and does not land; the delete fails terminally; the fresh read
    // says ACTIVE.
    cognitoSend.mockReset();
    const timeout = Object.assign(new Error('socket hang up'), { name: 'TimeoutError' });
    script({ echoError: { INACTIVE: timeout }, dels: [domainRefusal()] });
    await expect(del(CTX, provider)).rejects.toThrow('domain configured');
    expect(childLogger.warn).toHaveBeenCalledWith(expect.stringContaining('already read it on, and cdkd wrote it back (AWS accepted the write)'));
    expect(childLogger.error).toHaveBeenCalledWith(
      expect.stringContaining(`${POOL} is LIVE with its self sign-up, Lambda triggers and advanced security reset`)
    );
  });

  it('after a CONFIRMED flip, a fresh read of ACTIVE (a stale read) still writes the echoed ACTIVE back', async () => {
    // The flip returned 200; the re-enable's read lags and says ACTIVE.
    script({ reads: [livePool('ACTIVE'), livePool('ACTIVE')], dels: [domainRefusal()] });
    await expect(del()).rejects.toThrow('domain configured');
    const reEnables = updates().filter((u) => u['DeletionProtection'] === 'ACTIVE');
    expect(reEnables).toHaveLength(1);
    expect(isEcho(reEnables[0]!)).toBe(true);
    expect(childLogger.warn).toHaveBeenCalledWith(expect.stringContaining('already read it on, and cdkd wrote it back (AWS accepted the write)'));
  });

  it('a not-found answer to the bare write says nothing about the guard being left on', async () => {
    const gone = new ResourceNotFoundException({ $metadata: { httpStatusCode: 400 }, message: 'gone' });
    script({ echoError: { INACTIVE: echoRefusal() }, bareError: { INACTIVE: gone }, dels: [gone] });
    await expect(del()).resolves.toBeUndefined();
    expect(childLogger.warn).not.toHaveBeenCalledWith(expect.stringContaining('left on'));
    expect(childLogger.warn).not.toHaveBeenCalledWith(expect.stringContaining('without an answer'));
  });

  it('a no-answer echo on a pool whose read carried NO DeletionProtection latches nothing (#2204: only a guard observed on is owed back)', async () => {
    const timeout = Object.assign(new Error('socket hang up'), { name: 'TimeoutError' });
    const noFlag = { ...livePool('ACTIVE'), DeletionProtection: undefined };
    script({ reads: [noFlag], echoError: { INACTIVE: timeout }, dels: [domainRefusal()] });
    await expect(del()).rejects.toThrow('domain configured');
    expect(updates().filter((u) => u['DeletionProtection'] === 'ACTIVE')).toHaveLength(0);
  });

  it('a no-answer BARE write on a pool whose read carried NO DeletionProtection latches nothing either', async () => {
    const timeout = Object.assign(new Error('socket hang up'), { name: 'TimeoutError' });
    const noFlag = { ...livePool('ACTIVE'), DeletionProtection: undefined };
    script({
      reads: [noFlag],
      echoError: { INACTIVE: echoRefusal() },
      bareError: { INACTIVE: timeout },
      dels: [domainRefusal()],
    });
    await expect(del()).rejects.toThrow('domain configured');
    expect(updates().filter((u) => u['DeletionProtection'] === 'ACTIVE')).toHaveLength(0);
  });

  it('a successful echo flip keeps an EARLIER definite reset reported, but stops it licensing a bare re-enable', async () => {
    const provider = new CognitoUserPoolProvider();
    // Run 1: echo refused, bare flip lands (definite), retryable delete failure.
    script({ echoError: { INACTIVE: echoRefusal() }, dels: [throttle()] });
    await expect(del(CTX, provider)).rejects.toThrow('Rate exceeded');
    // Run 2 (within the reuse window, guard back on): the echo now lands; the
    // delete fails terminally; the re-enable's echo is refused.
    cognitoSend.mockReset();
    script({ echoError: { ACTIVE: echoRefusal() }, dels: [domainRefusal()] });
    await expect(del(CTX, provider)).rejects.toThrow('domain configured');
    // Run 1's reset really happened: still reported, as an EARLIER reset the
    // echo since may have undone -- not in the present tense ...
    expect(childLogger.error).toHaveBeenCalledWith(
      expect.stringMatching(/were reset by an earlier UpdateUserPool.*they may have been restored since/)
    );
    expect(childLogger.error).not.toHaveBeenCalledWith(expect.stringContaining('is LIVE with its self sign-up'));
    // ... but the echo landed since, so no bare ACTIVE is licensed by it.
    const reEnables = updates().filter((u) => u['DeletionProtection'] === 'ACTIVE');
    expect(reEnables).toHaveLength(1);
    expect(isEcho(reEnables[0]!)).toBe(true);
  });

  it('a read-on write-back failure KEEPS the flip record, so a later delete of the same pool retries the re-enable', async () => {
    const provider = new CognitoUserPoolProvider();
    // Confirmed flip; terminal delete failure; the re-enable read lags (ACTIVE)
    // and the write-back is throttled.
    script({ reads: [livePool('ACTIVE'), livePool('ACTIVE')], echoError: { ACTIVE: throttle() }, dels: [domainRefusal()] });
    await expect(del(CTX, provider)).rejects.toThrow('domain configured');
    expect(childLogger.error).not.toHaveBeenCalledWith(expect.stringContaining('still off'));
    // A later delete: the guard reads OFF (the flip had landed), no flip is
    // sent, the delete fails again -- and the retained record re-enables it.
    cognitoSend.mockReset();
    script({ reads: [livePool('INACTIVE')], dels: [domainRefusal()] });
    await expect(del(CTX, provider)).rejects.toThrow('domain configured');
    const reEnables = updates().filter((u) => u['DeletionProtection'] === 'ACTIVE');
    expect(reEnables).toHaveLength(1);
    expect(isEcho(reEnables[0]!)).toBe(true);
  });

  it('a definite bare flip after an echoedSince record licenses the bare re-enable again', async () => {
    const provider = new CognitoUserPoolProvider();
    // Run 1: bare lands (definite), retryable failure.
    script({ echoError: { INACTIVE: echoRefusal() }, dels: [throttle()] });
    await expect(del(CTX, provider)).rejects.toThrow('Rate exceeded');
    // Run 2: guard back on out of band; the echo lands (echoedSince); retryable.
    cognitoSend.mockReset();
    script({ dels: [throttle()] });
    await expect(del(CTX, provider)).rejects.toThrow('Rate exceeded');
    // Run 3: guard back on again; the echo is refused, bare lands again; the
    // delete fails terminally; the re-enable echo is refused -> bare ACTIVE.
    cognitoSend.mockReset();
    script({ echoError: { INACTIVE: echoRefusal(), ACTIVE: echoRefusal() }, dels: [domainRefusal()] });
    await expect(del(CTX, provider)).rejects.toThrow('domain configured');
    expect(updates().filter((u) => u['DeletionProtection'] === 'ACTIVE').map(isEcho)).toEqual([true, false]);
  });

  it('a licensed bare re-enable that FAILS on a pool reading OFF names the BARE failure, not the echo refusal', async () => {
    script({
      echoError: { INACTIVE: echoRefusal(), ACTIVE: echoRefusal() },
      bareError: { ACTIVE: named('ConcurrentModificationException', 'busy') },
      reads: [livePool('ACTIVE'), livePool('INACTIVE')],
      dels: [domainRefusal()],
    });
    await expect(del()).rejects.toThrow('domain configured');
    expect(childLogger.error).toHaveBeenCalledWith(
      expect.stringMatching(/could NOT re-enable DeletionProtection.*\(busy\)/)
    );
  });

  it('a licensed bare re-enable answering not-found on a pool reading ON takes the not-found arm', async () => {
    const gone = new ResourceNotFoundException({ $metadata: { httpStatusCode: 400 }, message: 'gone' });
    script({
      echoError: { INACTIVE: echoRefusal(), ACTIVE: echoRefusal() },
      bareError: { ACTIVE: gone },
      reads: [livePool('ACTIVE'), livePool('ACTIVE')],
      dels: [domainRefusal()],
    });
    await expect(del()).rejects.toThrow('domain configured');
    expect(childLogger.warn).not.toHaveBeenCalledWith(expect.stringContaining('writing it back failed'));
    expect(childLogger.warn).toHaveBeenCalledWith(expect.stringContaining('answered ResourceNotFoundException'));
  });

  it('a re-enable read with NO pool after an AMBIGUOUS bare flip reports "MAY have been reset"', async () => {
    const timeout = Object.assign(new Error('socket hang up'), { name: 'TimeoutError' });
    script({
      echoError: { INACTIVE: echoRefusal() },
      bareError: { INACTIVE: timeout },
      reads: [livePool('ACTIVE'), null],
      dels: [domainRefusal()],
    });
    await expect(del()).rejects.toThrow('domain configured');
    expect(childLogger.error).toHaveBeenCalledWith(expect.stringContaining('MAY have been reset'));
  });

  it('a DEVELOPER pool whose echo is THROTTLED: one UpdateUserPool, a retryable throw, no SES re-send', async () => {
    const ses = { EmailSendingAccount: 'DEVELOPER', SourceArn: 'arn:aws:ses:us-east-1:123456789012:identity/x.com' };
    script({ reads: [{ ...livePool('ACTIVE'), EmailConfiguration: ses }], echoError: { INACTIVE: throttle() } });
    const thrown = await del()
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(isRetryableTransientError(thrown, (thrown as Error).message)).toBe(true);
    expect(updates()).toHaveLength(1);
    expect(deleteCalls()).toBe(0);
    expect(childLogger.warn).not.toHaveBeenCalledWith(expect.stringContaining('EmailConfiguration'));
  });

  it('a no-answer failure of the write sent WITHOUT the SES EmailConfiguration says the email configuration was reset if it landed', async () => {
    const ses = { EmailSendingAccount: 'DEVELOPER', SourceArn: 'arn:aws:ses:us-east-1:123456789012:identity/x.com' };
    const timeout = Object.assign(new Error('socket hang up'), { name: 'TimeoutError' });
    cognitoSend.mockImplementation(async (cmd: Cmd) => {
      const name = cmd.constructor.name;
      if (name === 'DescribeUserPoolCommand') return { UserPool: { ...livePool('ACTIVE'), EmailConfiguration: ses } };
      if (name === 'UpdateUserPoolCommand') {
        throw cmd.input['EmailConfiguration'] !== undefined ? echoRefusal() : timeout;
      }
      if (name === 'DeleteUserPoolCommand') throw named('InvalidParameterException', 'deletion protection is activated');
      throw new Error(`unexpected ${name}`);
    });
    await expect(del()).rejects.toThrow();
    const warns = childLogger.warn.mock.calls.map((c) => String(c[0]));
    // The flip-off: `warnGuardLeftOn` names it, and nothing else does (one line).
    const flipOff = warns.filter((w) => w.includes('whether DeletionProtection was turned off is unknown'));
    expect(flipOff).toHaveLength(1);
    expect(flipOff[0]).toContain(
      "except the SES EmailConfiguration, which that write omitted: if it landed, the pool's email " +
        "configuration was reset to Cognito's default sender (EmailSendingAccount COGNITO_DEFAULT), " +
        'dropping its SES SourceArn, which stays that way if the delete fails.'
    );
    // No second line for the flip-off's re-send; and the re-enable reads the
    // guard ON, so it sends no write without the SES sender at all (#4149).
    expect(warns.filter((w) => w.includes('the write re-sent without it'))).toEqual([]);
    expect(
      updates()
        .filter((u) => u['DeletionProtection'] === 'ACTIVE')
        .map((u) => u['EmailConfiguration'] !== undefined)
    ).toEqual([true]);
    expect(warns.join('\n')).not.toContain('possibly');
  });

  it('a re-enable on a pool reading OFF re-sends without the SES EmailConfiguration, and a no-answer there gets its own line', async () => {
    const ses = { EmailSendingAccount: 'DEVELOPER', SourceArn: 'arn:aws:ses:us-east-1:123456789012:identity/x.com' };
    const timeout = Object.assign(new Error('socket hang up'), { name: 'TimeoutError' });
    let liveDp: Dp = 'ACTIVE';
    cognitoSend.mockImplementation(async (cmd: Cmd) => {
      const name = cmd.constructor.name;
      if (name === 'DescribeUserPoolCommand') return { UserPool: { ...livePool(liveDp), EmailConfiguration: ses } };
      if (name === 'UpdateUserPoolCommand') {
        if (cmd.input['EmailConfiguration'] !== undefined) throw echoRefusal();
        if (cmd.input['DeletionProtection'] === 'ACTIVE') throw timeout;
        liveDp = 'INACTIVE';
        return {};
      }
      if (name === 'DeleteUserPoolCommand') throw domainRefusal();
      throw new Error(`unexpected ${name}`);
    });
    await expect(del()).rejects.toThrow('domain configured');
    expect(
      updates()
        .filter((u) => u['DeletionProtection'] === 'ACTIVE')
        .map((u) => u['EmailConfiguration'] !== undefined)
    ).toEqual([true, false]);
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /re-sent without it answered socket hang up\. If that write landed, the pool's email configuration was reset to Cognito's default sender \(EmailSendingAccount COGNITO_DEFAULT\), dropping its SES SourceArn, and a redeploy will not restore it/
      )
    );
  });

  it('a flip-off that landed WITHOUT the SES EmailConfiguration and a failed delete: the re-enable read settles it at ERROR', async () => {
    const ses = { EmailSendingAccount: 'DEVELOPER', SourceArn: 'arn:aws:ses:us-east-1:123456789012:identity/sender@example.com' };
    let liveDp: Dp = 'ACTIVE';
    let liveEmail: Record<string, unknown> = ses;
    cognitoSend.mockImplementation(async (cmd: Cmd) => {
      const name = cmd.constructor.name;
      if (name === 'DescribeUserPoolCommand') return { UserPool: { ...livePool(liveDp), EmailConfiguration: liveEmail } };
      if (name === 'UpdateUserPoolCommand') {
        if (cmd.input['EmailConfiguration'] !== undefined) throw echoRefusal();
        liveDp = cmd.input['DeletionProtection'] as Dp;
        liveEmail = { EmailSendingAccount: 'COGNITO_DEFAULT' };
        return {};
      }
      if (name === 'DeleteUserPoolCommand') throw domainRefusal();
      throw new Error(`unexpected ${name}`);
    });
    await expect(del()).rejects.toThrow('domain configured');
    const errors = childLogger.error.mock.calls.map((c) => String(c[0]));
    expect(errors).toContainEqual(
      expect.stringMatching(
        /us-east-1_abc is LIVE with its SES email configuration reset: .*reset to Cognito's default sender \(EmailSendingAccount COGNITO_DEFAULT\).*a redeploy will not restore it/
      )
    );
    // The flip-off's own warn speaks of the delete, not of restoring.
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('without that EmailConfiguration. The pool\'s email configuration was reset')
    );
    expect(childLogger.warn).toHaveBeenCalledWith(expect.stringContaining('which stays that way if the delete fails.'));
    expect([...errors, ...childLogger.warn.mock.calls.map((c) => String(c[0]))].join('\n')).not.toContain(
      'sender@example.com'
    );
  });

  it('an email-less flip-off that answered 5xx but LANDED is settled at ERROR by the re-enable after an outer-loop re-entry', async () => {
    const provider = new CognitoUserPoolProvider();
    const ses = { EmailSendingAccount: 'DEVELOPER', SourceArn: 'arn:aws:ses:us-east-1:123456789012:identity/x.com' };
    const fiveHundred = Object.assign(named('ServiceUnavailableException', 'boom'), {
      $metadata: { httpStatusCode: 503 },
    });
    let liveDp: Dp = 'ACTIVE';
    let liveEmail: Record<string, unknown> = ses;
    cognitoSend.mockImplementation(async (cmd: Cmd) => {
      const name = cmd.constructor.name;
      if (name === 'DescribeUserPoolCommand') return { UserPool: { ...livePool(liveDp), EmailConfiguration: liveEmail } };
      if (name === 'UpdateUserPoolCommand') {
        if (cmd.input['EmailConfiguration'] !== undefined) throw echoRefusal();
        // Attempt 1's email-less flip-off LANDS, then answers 503.
        liveDp = cmd.input['DeletionProtection'] as Dp;
        liveEmail = { EmailSendingAccount: 'COGNITO_DEFAULT' };
        if (liveDp === 'INACTIVE') throw fiveHundred;
        return {};
      }
      if (name === 'DeleteUserPoolCommand') throw domainRefusal();
      throw new Error(`unexpected ${name}`);
    });
    await expect(del(CTX, provider)).rejects.toThrow('boom');
    expect(childLogger.warn).toHaveBeenCalledWith(expect.stringContaining('which stays that way if the delete fails.'));
    expect(childLogger.error).not.toHaveBeenCalled();
    // Attempt 2: reads INACTIVE on the default sender, no flip, terminal delete failure.
    await expect(del(CTX, provider)).rejects.toThrow('domain configured');
    expect(childLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('us-east-1_abc is LIVE with its SES email configuration reset')
    );
  });

  it('the unclear and earlier bare-flip wordings name the SES email configuration on a DEVELOPER pool', async () => {
    const ses = { EmailSendingAccount: 'DEVELOPER', SourceArn: 'arn:aws:ses:us-east-1:123456789012:identity/x.com' };
    const dev = { ...livePool('ACTIVE'), EmailConfiguration: ses };
    const timeout = Object.assign(new Error('socket hang up'), { name: 'TimeoutError' });
    // unclear: both echoes refused, the bare flip gets no answer.
    script({
      reads: [dev],
      echoError: { INACTIVE: echoRefusal(), ACTIVE: echoRefusal() },
      bareError: { INACTIVE: timeout },
      dels: [named('InvalidParameterException', 'deletion protection is activated')],
    });
    await expect(del()).rejects.toThrow('deletion protection is activated');
    expect(childLogger.error).toHaveBeenCalledWith(
      expect.stringContaining(
        'is LIVE and its self sign-up, Lambda triggers, advanced security and SES email configuration MAY have been reset'
      )
    );
    // earlier: run 1's bare flip lands, run 2's echo flip lands.
    vi.clearAllMocks();
    cognitoSend.mockReset();
    const provider = new CognitoUserPoolProvider();
    script({ reads: [dev], echoError: { INACTIVE: echoRefusal() }, dels: [throttle()] });
    await expect(del(CTX, provider)).rejects.toThrow('Rate exceeded');
    cognitoSend.mockReset();
    script({ reads: [dev], echoError: { ACTIVE: echoRefusal() }, dels: [domainRefusal()] });
    await expect(del(CTX, provider)).rejects.toThrow('domain configured');
    expect(childLogger.error).toHaveBeenCalledWith(
      expect.stringContaining(
        'is LIVE; its self sign-up, Lambda triggers, advanced security and SES email configuration were reset by an earlier'
      )
    );
  });

  it('a DEFINITE email-less flip-off licenses the email-less re-enable even when the fresh read is stale (ACTIVE + DEVELOPER)', async () => {
    const ses = { EmailSendingAccount: 'DEVELOPER', SourceArn: 'arn:aws:ses:us-east-1:123456789012:identity/x.com' };
    cognitoSend.mockImplementation(async (cmd: Cmd) => {
      const name = cmd.constructor.name;
      // Every read is the stale pre-flip one.
      if (name === 'DescribeUserPoolCommand') return { UserPool: { ...livePool('ACTIVE'), EmailConfiguration: ses } };
      if (name === 'UpdateUserPoolCommand') {
        if (cmd.input['EmailConfiguration'] !== undefined) throw echoRefusal();
        return {};
      }
      if (name === 'DeleteUserPoolCommand') throw domainRefusal();
      throw new Error(`unexpected ${name}`);
    });
    await expect(del()).rejects.toThrow('domain configured');
    expect(
      updates()
        .filter((u) => u['DeletionProtection'] === 'ACTIVE')
        .map((u) => u['EmailConfiguration'] !== undefined)
    ).toEqual([true, false]);
  });

  it('an AMBIGUOUS email-less flip-off keeps the read-on skip: no email-less re-enable', async () => {
    const ses = { EmailSendingAccount: 'DEVELOPER', SourceArn: 'arn:aws:ses:us-east-1:123456789012:identity/x.com' };
    const timeout = Object.assign(new Error('socket hang up'), { name: 'TimeoutError' });
    cognitoSend.mockImplementation(async (cmd: Cmd) => {
      const name = cmd.constructor.name;
      if (name === 'DescribeUserPoolCommand') return { UserPool: { ...livePool('ACTIVE'), EmailConfiguration: ses } };
      if (name === 'UpdateUserPoolCommand') {
        if (cmd.input['EmailConfiguration'] !== undefined) throw echoRefusal();
        if (cmd.input['DeletionProtection'] === 'INACTIVE') throw timeout;
        return {};
      }
      if (name === 'DeleteUserPoolCommand') throw domainRefusal();
      throw new Error(`unexpected ${name}`);
    });
    await expect(del()).rejects.toThrow();
    expect(
      updates()
        .filter((u) => u['DeletionProtection'] === 'ACTIVE')
        .map((u) => u['EmailConfiguration'] !== undefined)
    ).toEqual([true]);
  });

  it.each([
    ['a landed email-less write (definite record)', 'landed'],
    ['an email-less write answering 503 (ambiguous record)', '503'],
    ['an email-less write timing out (ambiguous record)', 'timeout'],
  ] as const)(
    'a later flip-off echo that CARRIED the DEVELOPER sender and landed drops the record after %s: a stale read-on re-enable sends no email-less write',
    async (_label, attempt1) => {
      const provider = new CognitoUserPoolProvider();
      const ses = { EmailSendingAccount: 'DEVELOPER', SourceArn: 'arn:aws:ses:us-east-1:123456789012:identity/x.com' };
      const fiveHundred = Object.assign(named('ServiceUnavailableException', 'boom'), {
        $metadata: { httpStatusCode: 503 },
      });
      const timeout = Object.assign(new Error('socket hang up'), { name: 'TimeoutError' });
      let attempt = 1;
      cognitoSend.mockImplementation(async (cmd: Cmd) => {
        const name = cmd.constructor.name;
        // Every read: ACTIVE on the DEVELOPER sender (stale on attempt 2's re-enable).
        if (name === 'DescribeUserPoolCommand') return { UserPool: { ...livePool('ACTIVE'), EmailConfiguration: ses } };
        if (name === 'UpdateUserPoolCommand') {
          const withSes = cmd.input['EmailConfiguration'] !== undefined;
          const dp = cmd.input['DeletionProtection'];
          if (attempt === 1) {
            if (withSes) throw echoRefusal();
            if (attempt1 === '503') throw fiveHundred;
            if (attempt1 === 'timeout') throw timeout;
            return {};
          }
          // Attempt 2: the flip-off echo WITH the SES sender lands; the
          // re-enable's echo with it is refused.
          if (withSes && dp === 'INACTIVE') return {};
          if (withSes) throw echoRefusal();
          return {};
        }
        if (name === 'DeleteUserPoolCommand') {
          if (attempt === 1) throw throttle();
          throw domainRefusal();
        }
        throw new Error(`unexpected ${name}`);
      });
      await expect(del(CTX, provider)).rejects.toThrow();
      attempt = 2;
      cognitoSend.mockClear();
      await expect(del(CTX, provider)).rejects.toThrow('domain configured');
      const sent = updates();
      expect(sent.filter((u) => u['DeletionProtection'] === 'INACTIVE').map((u) => u['EmailConfiguration'] !== undefined)).toEqual([
        true,
      ]);
      expect(
        sent.filter((u) => u['DeletionProtection'] === 'ACTIVE').map((u) => u['EmailConfiguration'] !== undefined)
      ).toEqual([true]);
    }
  );

  it('no SES ERROR when the re-enable still reads the DEVELOPER sender (the email-less write did not take)', async () => {
    const ses = { EmailSendingAccount: 'DEVELOPER', SourceArn: 'arn:aws:ses:us-east-1:123456789012:identity/x.com' };
    let liveDp: Dp = 'ACTIVE';
    cognitoSend.mockImplementation(async (cmd: Cmd) => {
      const name = cmd.constructor.name;
      if (name === 'DescribeUserPoolCommand') return { UserPool: { ...livePool(liveDp), EmailConfiguration: ses } };
      if (name === 'UpdateUserPoolCommand') {
        if (cmd.input['EmailConfiguration'] !== undefined) throw echoRefusal();
        liveDp = cmd.input['DeletionProtection'] as Dp;
        return {};
      }
      if (name === 'DeleteUserPoolCommand') throw domainRefusal();
      throw new Error(`unexpected ${name}`);
    });
    await expect(del()).rejects.toThrow('domain configured');
    expect(childLogger.error).not.toHaveBeenCalledWith(expect.stringContaining('SES email configuration reset'));
  });

  it('a TRANSIENT failure of the flip-off re-sent WITHOUT the SES EmailConfiguration warns of the reset before the retry', async () => {
    const ses = { EmailSendingAccount: 'DEVELOPER', SourceArn: 'arn:aws:ses:us-east-1:123456789012:identity/x.com' };
    const fiveHundred = Object.assign(named('ServiceUnavailableException', 'boom'), {
      $metadata: { httpStatusCode: 503 },
    });
    cognitoSend.mockImplementation(async (cmd: Cmd) => {
      const name = cmd.constructor.name;
      if (name === 'DescribeUserPoolCommand') return { UserPool: { ...livePool('ACTIVE'), EmailConfiguration: ses } };
      if (name === 'UpdateUserPoolCommand') {
        throw cmd.input['EmailConfiguration'] !== undefined ? echoRefusal() : fiveHundred;
      }
      throw new Error(`unexpected ${name}`);
    });
    const thrown = await del()
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(isRetryableTransientError(thrown, (thrown as Error).message)).toBe(true);
    expect(deleteCalls()).toBe(0);
    expect(updates().map((u) => u['EmailConfiguration'] !== undefined)).toEqual([true, false]);
    expect(childLogger.warn).toHaveBeenCalledTimes(1);
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /us-east-1_abc: UpdateUserPool refused the write carrying the pool's SES EmailConfiguration \(InvalidParameterException.*re-sent without it answered ServiceUnavailableException.*If that write landed, the pool's email configuration was reset to Cognito's default sender \(EmailSendingAccount COGNITO_DEFAULT\), dropping its SES SourceArn, which stays that way if the delete fails\.$/
      )
    );
  });

  it('a REFUSED re-send WITHOUT the SES EmailConfiguration did not land, so no reset is claimed for it', async () => {
    const ses = { EmailSendingAccount: 'DEVELOPER', SourceArn: 'arn:aws:ses:us-east-1:123456789012:identity/x.com' };
    cognitoSend.mockImplementation(async (cmd: Cmd) => {
      const name = cmd.constructor.name;
      if (name === 'DescribeUserPoolCommand') return { UserPool: { ...livePool('ACTIVE'), EmailConfiguration: ses } };
      if (name === 'UpdateUserPoolCommand') {
        throw cmd.input['EmailConfiguration'] !== undefined
          ? echoRefusal()
          : named('NotAuthorizedException', 'not allowed');
      }
      if (name === 'DeleteUserPoolCommand') throw named('InvalidParameterException', 'deletion protection is activated');
      throw new Error(`unexpected ${name}`);
    });
    await expect(del()).rejects.toThrow();
    expect(childLogger.warn).toHaveBeenCalledWith(expect.stringContaining('DeletionProtection was left on'));
    expect(childLogger.warn).not.toHaveBeenCalledWith(expect.stringContaining('COGNITO_DEFAULT'));
  });

  it('a re-enable that reads ON but whose echoed ACTIVE answers not-found takes the not-found arm', async () => {
    const gone = new ResourceNotFoundException({ $metadata: { httpStatusCode: 400 }, message: 'gone' });
    script({ reads: [livePool('ACTIVE'), livePool('ACTIVE')], echoError: { ACTIVE: gone }, dels: [domainRefusal()] });
    await expect(del()).rejects.toThrow('domain configured');
    expect(childLogger.warn).not.toHaveBeenCalledWith(expect.stringContaining('writing it back failed'));
    expect(childLogger.warn).toHaveBeenCalledWith(expect.stringContaining('answered ResourceNotFoundException'));
  });

  it('a definite bare flip + a stale ON read + a refused echo: the bare ACTIVE lands and the wording is "already read it on"', async () => {
    script({
      echoError: { INACTIVE: echoRefusal(), ACTIVE: echoRefusal() },
      reads: [livePool('ACTIVE'), livePool('ACTIVE')],
      dels: [domainRefusal()],
    });
    await expect(del()).rejects.toThrow('domain configured');
    expect(updates().filter((u) => u['DeletionProtection'] === 'ACTIVE').map(isEcho)).toEqual([true, false]);
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('already read it on, and cdkd wrote it back (AWS accepted the write)')
    );
  });

  it('a definite bare flip + a stale ON read + refused echo AND refused bare ACTIVE: a warn with the check, not "still off"', async () => {
    script({
      echoError: { INACTIVE: echoRefusal(), ACTIVE: echoRefusal() },
      bareError: { ACTIVE: named('InvalidParameterException', 'bare refused') },
      reads: [livePool('ACTIVE'), livePool('ACTIVE')],
      dels: [domainRefusal()],
    });
    await expect(del()).rejects.toThrow('domain configured');
    expect(childLogger.error).not.toHaveBeenCalledWith(expect.stringContaining('still off'));
    expect(childLogger.warn).toHaveBeenCalledWith(expect.stringContaining('writing it back failed'));
  });

  it('a refused DEVELOPER EmailConfiguration is re-sent without it, at warn, before any bare write', async () => {
    const ses = { EmailSendingAccount: 'DEVELOPER', SourceArn: 'arn:aws:ses:us-east-1:123456789012:identity/x.com' };
    const devPool = (dp: Dp) => ({ ...livePool(dp), EmailConfiguration: ses });
    let liveDp: Dp = 'ACTIVE';
    cognitoSend.mockImplementation(async (cmd: Cmd) => {
      const name = cmd.constructor.name;
      if (name === 'DescribeUserPoolCommand') return { UserPool: devPool(liveDp) };
      if (name === 'UpdateUserPoolCommand') {
        if (cmd.input['EmailConfiguration'] !== undefined) throw echoRefusal();
        liveDp = cmd.input['DeletionProtection'] as Dp;
        return {};
      }
      if (name === 'DeleteUserPoolCommand') throw domainRefusal();
      throw new Error(`unexpected ${name}`);
    });
    await expect(del()).rejects.toThrow('domain configured');
    const sent = updates();
    // Flip: echo with SES refused -> echo without it lands. Re-enable: same.
    expect(sent.map((u) => [u['EmailConfiguration'] !== undefined, isEcho(u), u['DeletionProtection']])).toEqual([
      [true, true, 'INACTIVE'],
      [false, true, 'INACTIVE'],
      [true, true, 'ACTIVE'],
      [false, true, 'ACTIVE'],
    ]);
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /refused the write \(possibly the pool's SES EmailConfiguration.*without that EmailConfiguration\. The pool's email configuration was reset to Cognito's default sender \(EmailSendingAccount COGNITO_DEFAULT\), dropping its SES SourceArn/
      )
    );
    expect(childLogger.warn).not.toHaveBeenCalledWith(expect.stringContaining('not measured'));
    expect(childLogger.warn).not.toHaveBeenCalledWith(expect.stringContaining('turned off alone'));
    expect(childLogger.error).not.toHaveBeenCalledWith(expect.stringContaining('is LIVE with'));
  });

  it('never re-enables bare after an ECHOED flip: a refused echo on the re-enable is an ERROR line', async () => {
    script({ echoError: { ACTIVE: echoRefusal() }, dels: [domainRefusal()] });
    await expect(del()).rejects.toThrow('domain configured');
    const reEnables = updates().filter((u) => u['DeletionProtection'] === 'ACTIVE');
    expect(reEnables).toHaveLength(1);
    expect(reEnables[0]).toMatchObject({ LambdaConfig: { PreAuthentication: TRIGGER } });
    expect(childLogger.error).toHaveBeenCalledWith(
      expect.stringMatching(/could NOT re-enable DeletionProtection on us-east-1_abc.*update-user-pool.*self sign-up/)
    );
    expect(childLogger.error).not.toHaveBeenCalledWith(expect.stringContaining('is LIVE with its self sign-up'));
  });

  it('a failed fresh read on the re-enable sends no UpdateUserPool at all', async () => {
    script({
      reads: [livePool('ACTIVE'), fiveHundredRead()],
      dels: [domainRefusal()],
    });
    await expect(del()).rejects.toThrow('domain configured');
    expect(updates().filter((u) => u['DeletionProtection'] === 'ACTIVE')).toHaveLength(0);
    expect(childLogger.error).toHaveBeenCalledWith(expect.stringContaining('could NOT re-enable DeletionProtection'));
  });

  it('a fresh read that returns no pool sends no UpdateUserPool, and never claims the guard was re-enabled', async () => {
    script({ reads: [livePool('ACTIVE'), null], dels: [domainRefusal()] });
    await expect(del()).rejects.toThrow('domain configured');
    expect(updates().filter((u) => u['DeletionProtection'] === 'ACTIVE')).toHaveLength(0);
    expect(childLogger.error).toHaveBeenCalledWith(expect.stringContaining('could NOT re-enable DeletionProtection'));
    expect(childLogger.warn).not.toHaveBeenCalledWith(expect.stringContaining('re-enabled on'));
  });
});
