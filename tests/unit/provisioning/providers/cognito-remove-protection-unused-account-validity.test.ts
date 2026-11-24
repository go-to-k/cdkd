/**
 * The `--remove-protection` echo and the deprecated
 * `AdminCreateUserConfig.UnusedAccountValidityDays` (issue #6548).
 * `DescribeUserPool` returns that member on every pool, mirroring
 * `Policies.PasswordPolicy.TemporaryPasswordValidityDays`. A pool whose
 * `PasswordPolicy` sets the temporary-password validity REFUSES an echo
 * carrying it, and the fallback bare flip is refused too on a pool whose
 * `UserAttributeUpdateSettings` requires verification, so the guard stayed on
 * and the destroy failed. The echo is re-sent once without the member, only
 * after that refusal: a pool configured through the deprecated member alone
 * accepts it and would reset the value on omission (measured).
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const cognitoSend = vi.fn();

vi.mock('@aws-sdk/client-cognito-identity-provider', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    CognitoIdentityProviderClient: vi.fn(() => ({
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
  child: vi.fn(function (this: unknown) { return this; }),
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

import {
  CognitoUserPoolProvider,
  userPoolDeletionProtectionUpdate,
} from '../../../../src/provisioning/providers/cognito-provider.js';
import {
  echoesUnusedAccountValidityDays,
  isUnusedAccountValidityRefusal,
} from '../../../../src/provisioning/providers/cognito/shared.js';

const POOL = 'us-east-1_abc';
const TRIGGER = 'arn:aws:lambda:us-east-1:123456789012:function:pre-auth';
const CTX = { removeProtection: true, expectedRegion: 'us-east-1' };
const UNUSED_REFUSAL =
  'Please use TemporaryPasswordValidityDays in PasswordPolicy instead of UnusedAccountValidityDays';
const VERIFY_REFUSAL =
  'All attributes in AttributesRequireVerificationBeforeUpdate must exist in AutoVerifiedAttributes';

type Cmd = { constructor: { name: string }; input: Record<string, unknown> };

/** The shape the repro pool read back (us-east-1, 2026-11-18). */
function livePool(
  dp: 'ACTIVE' | 'INACTIVE',
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    Id: POOL,
    DeletionProtection: dp,
    Policies: { PasswordPolicy: { MinimumLength: 12, TemporaryPasswordValidityDays: 3 } },
    LambdaConfig: { PreAuthentication: TRIGGER },
    AutoVerifiedAttributes: ['email'],
    UserAttributeUpdateSettings: { AttributesRequireVerificationBeforeUpdate: ['email'] },
    AdminCreateUserConfig: {
      AllowAdminCreateUserOnly: true,
      UnusedAccountValidityDays: 3,
      InviteMessageTemplate: { EmailSubject: 'hi', EmailMessage: 'u {username} p {####}' },
    },
    DeviceConfiguration: { ChallengeRequiredOnNewDevice: true },
    EmailConfiguration: { EmailSendingAccount: 'COGNITO_DEFAULT' },
    ...extra,
  };
}

function named(name: string, message: string): Error {
  const e = new Error(message) as Error & { $metadata: { httpStatusCode: number } };
  e.name = name;
  e.$metadata = { httpStatusCode: 400 };
  return e;
}

/**
 * A fake pool that refuses, like AWS: an echo carrying `UnusedAccountValidityDays`
 * (when `refuseUnused`, the default), a bare write while
 * `UserAttributeUpdateSettings` requires verification (it drops
 * `AutoVerifiedAttributes`), an echo carrying a DEVELOPER EmailConfiguration
 * (when `refuseSes`), and every echo with `echoRefusal`'s message. Deletes
 * answer `dels` in order (the last repeats).
 */
function script(opts: {
  pool?: Record<string, unknown>;
  refuseUnused?: boolean;
  refuseSes?: boolean;
  echoRefusal?: string;
  /** Fails the re-send WITHOUT the member (DeletionProtection value -> error), once per value. */
  resendError?: { INACTIVE?: Error; ACTIVE?: Error };
  dels?: Array<Error | undefined>;
}): void {
  const resendError = { ...opts.resendError };
  let dp: 'ACTIVE' | 'INACTIVE' = 'ACTIVE';
  let deleted = 0;
  const dels = opts.dels ?? [undefined];
  cognitoSend.mockImplementation(async (cmd: Cmd) => {
    const name = cmd.constructor.name;
    if (name === 'DescribeUserPoolCommand') return { UserPool: { ...livePool(dp), ...opts.pool } };
    if (name === 'UpdateUserPoolCommand') {
      const input = cmd.input;
      const acuc = input['AdminCreateUserConfig'] as Record<string, unknown> | undefined;
      if ((opts.refuseUnused ?? true) && acuc && 'UnusedAccountValidityDays' in acuc) {
        throw named('InvalidParameterException', UNUSED_REFUSAL);
      }
      const want = input['DeletionProtection'] as 'ACTIVE' | 'INACTIVE';
      if (acuc && !('UnusedAccountValidityDays' in acuc) && resendError[want]) {
        const err = resendError[want]!;
        delete resendError[want];
        throw err;
      }
      const bare = Object.keys(input).length <= 2;
      if (!bare && opts.echoRefusal) throw named('InvalidParameterException', opts.echoRefusal);
      if (bare && opts.echoRefusal === undefined) throw named('InvalidParameterException', VERIFY_REFUSAL);
      const email = input['EmailConfiguration'] as Record<string, unknown> | undefined;
      if (opts.refuseSes && email?.['EmailSendingAccount'] === 'DEVELOPER') {
        throw named('InvalidParameterException', 'SES identity not verified');
      }
      dp = input['DeletionProtection'] as 'ACTIVE' | 'INACTIVE';
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
const deleteCalls = (): number =>
  commands().filter((c) => c.constructor.name === 'DeleteUserPoolCommand').length;
const del = () =>
  new CognitoUserPoolProvider().delete('Pool', POOL, 'AWS::Cognito::UserPool', undefined, CTX);

beforeEach(() => {
  vi.clearAllMocks();
  cognitoSend.mockReset();
});

describe('userPoolDeletionProtectionUpdate: withoutUnusedAccountValidityDays (#6548)', () => {
  it('drops only UnusedAccountValidityDays from the echoed AdminCreateUserConfig', () => {
    const pool = livePool('ACTIVE');
    const input = userPoolDeletionProtectionUpdate(POOL, pool as never, 'INACTIVE', {
      withoutUnusedAccountValidityDays: true,
    });
    expect(input.AdminCreateUserConfig).toEqual({
      AllowAdminCreateUserOnly: true,
      InviteMessageTemplate: { EmailSubject: 'hi', EmailMessage: 'u {username} p {####}' },
    });
    // The read is not mutated: a later attempt still sees the member.
    expect(pool['AdminCreateUserConfig']).toHaveProperty('UnusedAccountValidityDays', 3);
    expect(input.LambdaConfig).toEqual({ PreAuthentication: TRIGGER });
    expect(input.UserAttributeUpdateSettings).toEqual(pool['UserAttributeUpdateSettings']);
  });

  it('keeps the member by default: a pool set through it alone resets it on omission', () => {
    const input = userPoolDeletionProtectionUpdate(POOL, livePool('ACTIVE') as never, 'INACTIVE');
    expect(input.AdminCreateUserConfig).toHaveProperty('UnusedAccountValidityDays', 3);
  });
});

describe('isUnusedAccountValidityRefusal / echoesUnusedAccountValidityDays', () => {
  it('matches only a validation refusal naming the member', () => {
    expect(isUnusedAccountValidityRefusal(named('InvalidParameterException', UNUSED_REFUSAL))).toBe(true);
    expect(isUnusedAccountValidityRefusal(named('InvalidParameterException', VERIFY_REFUSAL))).toBe(false);
    expect(isUnusedAccountValidityRefusal(named('TooManyRequestsException', UNUSED_REFUSAL))).toBe(false);
    expect(isUnusedAccountValidityRefusal({ name: 'InvalidParameterException', message: UNUSED_REFUSAL })).toBe(
      false
    );
  });

  it('reads the member off the pool', () => {
    expect(echoesUnusedAccountValidityDays(livePool('ACTIVE') as never)).toBe(true);
    expect(echoesUnusedAccountValidityDays({ AdminCreateUserConfig: { AllowAdminCreateUserOnly: true } })).toBe(
      false
    );
    expect(echoesUnusedAccountValidityDays({})).toBe(false);
  });
});

describe('CognitoUserPoolProvider.delete --remove-protection on a pool that refuses UnusedAccountValidityDays (#6548)', () => {
  it('re-sends the echo without the member, so the guard goes off with every setting kept and the pool is deleted', async () => {
    script({});
    await del();
    const sent = updates();
    expect(sent).toHaveLength(2);
    expect(sent[0]!['AdminCreateUserConfig']).toHaveProperty('UnusedAccountValidityDays', 3);
    expect(sent[1]!['AdminCreateUserConfig']).not.toHaveProperty('UnusedAccountValidityDays');
    expect(sent[1]).toMatchObject({
      DeletionProtection: 'INACTIVE',
      LambdaConfig: { PreAuthentication: TRIGGER },
      AutoVerifiedAttributes: ['email'],
      UserAttributeUpdateSettings: { AttributesRequireVerificationBeforeUpdate: ['email'] },
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    });
    expect(deleteCalls()).toBe(1);
    // Nothing was reset, so nothing is warned about.
    expect(childLogger.warn).not.toHaveBeenCalled();
  });

  it('the re-enable after a failed delete re-sends without the member too, turning the guard back on', async () => {
    script({
      dels: [named('InvalidParameterException', 'User pool cannot be deleted. It has a domain configured that should be deleted first.')],
    });
    await expect(del()).rejects.toThrow();
    const sent = updates();
    const reEnable = sent.filter((u) => u['DeletionProtection'] === 'ACTIVE');
    expect(reEnable).toHaveLength(2);
    expect(reEnable[0]!['AdminCreateUserConfig']).toHaveProperty('UnusedAccountValidityDays');
    expect(reEnable[1]!['AdminCreateUserConfig']).not.toHaveProperty('UnusedAccountValidityDays');
    expect(reEnable[1]).toMatchObject({ LambdaConfig: { PreAuthentication: TRIGGER } });
    // No bare (DeletionProtection-only) write went out either way.
    expect(sent.every((u) => Object.keys(u).length > 2)).toBe(true);
  });

  it('a re-send with NO answer takes the existing no-answer arm: no bare write, and the re-enable still writes the guard back', async () => {
    const timeout = Object.assign(new Error('socket hang up'), { name: 'TimeoutError' });
    script({
      resendError: { INACTIVE: timeout },
      dels: [named('InvalidParameterException', 'User pool cannot be deleted. It has a domain configured that should be deleted first.')],
    });
    await expect(del()).rejects.toThrow();
    const sent = updates();
    // Flip-off: the echo, its member-less re-send (no answer). No bare write.
    // Re-enable: the echo, its member-less re-send.
    expect(sent.map((u) => [Object.keys(u).length > 2, u['DeletionProtection']])).toEqual([
      [true, 'INACTIVE'],
      [true, 'INACTIVE'],
      [true, 'ACTIVE'],
      [true, 'ACTIVE'],
    ]);
    expect(childLogger.warn).toHaveBeenCalledWith(expect.stringContaining('failed without an answer from AWS'));
    expect(childLogger.warn).not.toHaveBeenCalledWith(expect.stringContaining('was left on'));
  });

  it('a re-enable re-send with NO answer never falls back to a bare write', async () => {
    const timeout = Object.assign(new Error('socket hang up'), { name: 'TimeoutError' });
    script({
      resendError: { ACTIVE: timeout },
      dels: [named('InvalidParameterException', 'User pool cannot be deleted. It has a domain configured that should be deleted first.')],
    });
    await expect(del()).rejects.toThrow();
    const sent = updates();
    expect(sent.every((u) => Object.keys(u).length > 2)).toBe(true);
    expect(sent.filter((u) => u['DeletionProtection'] === 'ACTIVE')).toHaveLength(2);
  });

  it('a pool that accepts the member is echoed once, with it', async () => {
    script({ refuseUnused: false });
    await del();
    const sent = updates();
    expect(sent).toHaveLength(1);
    expect(sent[0]!['AdminCreateUserConfig']).toHaveProperty('UnusedAccountValidityDays', 3);
  });

  it('another validation refusal does not drop the member: the bare fallback runs as before', async () => {
    script({ refuseUnused: false, echoRefusal: 'Invalid value for VerificationMessageTemplate.' });
    await del();
    const sent = updates();
    expect(sent).toHaveLength(2);
    expect(sent[0]!['AdminCreateUserConfig']).toHaveProperty('UnusedAccountValidityDays', 3);
    expect(sent[1]).toEqual({ UserPoolId: POOL, DeletionProtection: 'INACTIVE' });
    expect(deleteCalls()).toBe(1);
  });

  it('with a DEVELOPER EmailConfiguration refused as well, the SES-less re-send also leaves the member out', async () => {
    script({
      refuseSes: true,
      pool: {
        EmailConfiguration: {
          EmailSendingAccount: 'DEVELOPER',
          SourceArn: 'arn:aws:ses:us-east-1:123456789012:identity/a@example.com',
        },
      },
    });
    await del();
    const sent = updates();
    expect(sent).toHaveLength(3);
    expect(sent[2]!['AdminCreateUserConfig']).not.toHaveProperty('UnusedAccountValidityDays');
    expect(sent[2]).not.toHaveProperty('EmailConfiguration');
    expect(sent[2]!['DeletionProtection']).toBe('INACTIVE');
    expect(deleteCalls()).toBe(1);
  });
});
