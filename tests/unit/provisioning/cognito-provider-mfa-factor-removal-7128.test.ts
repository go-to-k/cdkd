import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#7128: removing EnabledMfas under MfaConfiguration OFF left the
// software-token factor enabled. `UpdateUserPool` OFF keeps the factor blocks;
// a bare `SetUserPoolMfaConfig` OFF resets them (measured us-east-1, recorded
// at `clearsRemovedMfaConfig`), which is what CloudFormation ends with.

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-cognito-identity-provider', async () => {
  const actual = await vi.importActual('@aws-sdk/client-cognito-identity-provider');
  return {
    ...actual,
    CognitoIdentityProviderClient: vi.fn(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

const { childLogger } = vi.hoisted(() => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn((): unknown => childLogger),
  };
  return { childLogger };
});

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    child: () => childLogger,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { CognitoUserPoolProvider } from '../../../src/provisioning/providers/cognito-provider.js';
import type { UpdateContext } from '../../../src/types/resource.js';
import { clearsRemovedMfaConfig } from '../../../src/provisioning/providers/cognito/mfa-request.js';
import {
  createSecretMasker,
  SECRET_MASK,
} from '../../../src/deployment/secret-redaction.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

const POOL_ID = 'us-east-1_abc123';
const POOL_ARN = `arn:aws:cognito-idp:us-east-1:123456789012:userpool/${POOL_ID}`;

interface SentCommand {
  constructor: { name: string };
  input: Record<string, unknown>;
}

function order(): string[] {
  return mockSend.mock.calls.map((c) => (c[0] as SentCommand).constructor.name);
}

function sent(name: string): SentCommand[] {
  return mockSend.mock.calls
    .map((c) => c[0] as SentCommand)
    .filter((cmd) => cmd.constructor.name === name);
}

const TOTP_OPTIONAL = { MfaConfiguration: 'OPTIONAL', EnabledMfas: ['SOFTWARE_TOKEN_MFA'] };
const BARE_OFF = { UserPoolId: POOL_ID, MfaConfiguration: 'OFF' };
const LIVE_WEBAUTHN = {
  RelyingPartyId: 'example.com',
  UserVerification: 'required',
  FactorConfiguration: 'MULTI_FACTOR_WITH_USER_VERIFICATION',
};

/** Answer each command by name; DescribeUserPool always returns the ARN. */
function respond(answers: Record<string, (input: Record<string, unknown>) => unknown>): void {
  mockSend.mockImplementation(async (cmd: SentCommand) => {
    if (cmd.constructor.name === 'DescribeUserPoolCommand') return { UserPool: { Arn: POOL_ARN } };
    const answer = answers[cmd.constructor.name];
    return answer ? answer(cmd.input) : {};
  });
}

function denied(): never {
  throw Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' });
}

describe('CognitoUserPoolProvider.update — MFA factor removal under OFF (#7128)', () => {
  let provider: CognitoUserPoolProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    childLogger.child.mockReturnValue(childLogger);
    mockSend.mockImplementation(async (cmd: SentCommand) =>
      cmd.constructor.name === 'DescribeUserPoolCommand' ? { UserPool: { Arn: POOL_ARN } } : {}
    );
    provider = new CognitoUserPoolProvider();
  });

  const update = (
    desired: Record<string, unknown>,
    previous: Record<string, unknown>,
    context?: UpdateContext
  ) => provider.update('MyUserPool', POOL_ID, 'AWS::Cognito::UserPool', desired, previous, context);

  it('OPTIONAL + software token -> OFF resets the factor blocks after UpdateUserPool', async () => {
    await update({ MfaConfiguration: 'OFF' }, TOTP_OPTIONAL);

    expect(sent('UpdateUserPoolCommand')[0]!.input['MfaConfiguration']).toBe('OFF');
    const mfa = sent('SetUserPoolMfaConfigCommand');
    expect(mfa).toHaveLength(1);
    expect(mfa[0]!.input).toEqual(BARE_OFF);
    expect(order().indexOf('SetUserPoolMfaConfigCommand')).toBeGreaterThan(
      order().indexOf('UpdateUserPoolCommand')
    );
    // The template asked for OFF: nothing to announce.
    expect(childLogger.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['ON + SMS and software token', { MfaConfiguration: 'ON', EnabledMfas: ['SMS_MFA', 'SOFTWARE_TOKEN_MFA'] }],
    ['an email-OTP message', { MfaConfiguration: 'OPTIONAL', EnabledMfas: ['EMAIL_OTP'], EmailAuthenticationMessage: 'm {####}' }],
  ])('previous %s -> OFF with nothing left resets', async (_, previous) => {
    await update({ MfaConfiguration: 'OFF' }, previous);

    expect(sent('SetUserPoolMfaConfigCommand').map((c) => c.input)).toEqual([BARE_OFF]);
  });

  it('an absent MfaConfiguration over an MFA-on pool sends the #1160 call once, not twice', async () => {
    await update({}, TOTP_OPTIONAL);

    expect(sent('SetUserPoolMfaConfigCommand').map((c) => c.input)).toEqual([BARE_OFF]);
  });

  it('a partial removal (SMS + software token -> SMS) is the usual full-replace call', async () => {
    await update(
      { MfaConfiguration: 'OPTIONAL', EnabledMfas: ['SMS_MFA'] },
      { MfaConfiguration: 'OPTIONAL', EnabledMfas: ['SMS_MFA', 'SOFTWARE_TOKEN_MFA'] }
    );

    const mfa = sent('SetUserPoolMfaConfigCommand');
    expect(mfa).toHaveLength(1);
    expect(mfa[0]!.input['MfaConfiguration']).toBe('OPTIONAL');
    expect(mfa[0]!.input['SmsMfaConfiguration']).toBeDefined();
    expect(mfa[0]!.input).not.toHaveProperty('SoftwareTokenMfaConfiguration');
  });

  it('removing EnabledMfas while WebAuthn props stay is the usual call carrying WebAuthn only', async () => {
    await update(
      { MfaConfiguration: 'OFF', WebAuthnRelyingPartyID: 'example.com' },
      { MfaConfiguration: 'OPTIONAL', EnabledMfas: ['SOFTWARE_TOKEN_MFA'], WebAuthnRelyingPartyID: 'example.com' }
    );

    const mfa = sent('SetUserPoolMfaConfigCommand');
    expect(mfa).toHaveLength(1);
    expect(mfa[0]!.input['MfaConfiguration']).toBe('OFF');
    expect(mfa[0]!.input['WebAuthnConfiguration']).toEqual({ RelyingPartyId: 'example.com' });
    expect(mfa[0]!.input).not.toHaveProperty('SoftwareTokenMfaConfiguration');
  });

  it.each([
    ['OFF -> OFF with no factor either side', { MfaConfiguration: 'OFF' }, { MfaConfiguration: 'OFF' }],
    ['a pool that never declared MFA', { MfaConfiguration: 'OFF' }, {}],
    ['a declared OPTIONAL with no factor (left to UpdateUserPool)', { MfaConfiguration: 'OPTIONAL' }, TOTP_OPTIONAL],
    ['a blank MfaConfiguration (the shape guard reports it)', { MfaConfiguration: '  ' }, TOTP_OPTIONAL],
    // WebAuthn-only removal: the bare call would also drop WebAuthnConfiguration,
    // and neither CloudFormation's end state nor a passkey pool is measured.
    ['a WebAuthn-only previous bag under OFF', { MfaConfiguration: 'OFF' }, { MfaConfiguration: 'OFF', WebAuthnRelyingPartyID: 'example.com' }],
    ['a WebAuthn-only previous bag, MfaConfiguration absent', {}, { MfaConfiguration: 'OFF', WebAuthnRelyingPartyID: 'example.com' }],
  ])('sends no reset for %s', async (_, desired, previous) => {
    await update(desired, previous);

    expect(sent('SetUserPoolMfaConfigCommand')).toHaveLength(0);
  });

  it.each([
    ['a rollback replay', { replayingState: true }],
    // drift --revert: the desired side is the recorded baseline, the previous
    // side the live readback holding an out-of-band software token.
    ['drift --revert', { desiredFromAwsReadback: true }],
  ])('resets on %s too', async (_, context) => {
    await update({ MfaConfiguration: 'OFF' }, { MfaConfiguration: 'OFF', EnabledMfas: ['SOFTWARE_TOKEN_MFA'] }, context);

    expect(sent('SetUserPoolMfaConfigCommand').map((c) => c.input)).toEqual([BARE_OFF]);
  });

  it('records the desired bag as is, so the next diff has nothing to change', async () => {
    const result = await update({ MfaConfiguration: 'OFF' }, TOTP_OPTIONAL);

    expect(result.effectiveProperties).toBeUndefined();
  });

  describe('the live WebAuthn configuration (measured: the bare call drops it)', () => {
    it('carries the live WebAuthnConfiguration, as read, into the reset', async () => {
      respond({ GetUserPoolMfaConfigCommand: () => ({ MfaConfiguration: 'OPTIONAL', WebAuthnConfiguration: LIVE_WEBAUTHN }) });

      await update({ MfaConfiguration: 'OFF' }, TOTP_OPTIONAL);

      expect(sent('SetUserPoolMfaConfigCommand').map((c) => c.input)).toEqual([
        { ...BARE_OFF, WebAuthnConfiguration: LIVE_WEBAUTHN },
      ]);
    });

    it('carries it on the #1160 arm too', async () => {
      respond({ GetUserPoolMfaConfigCommand: () => ({ WebAuthnConfiguration: LIVE_WEBAUTHN }) });

      await update({}, TOTP_OPTIONAL);

      expect(sent('SetUserPoolMfaConfigCommand').map((c) => c.input)).toEqual([
        { ...BARE_OFF, WebAuthnConfiguration: LIVE_WEBAUTHN },
      ]);
    });

    it('sends the bare request when the pool holds no WebAuthn configuration', async () => {
      respond({ GetUserPoolMfaConfigCommand: () => ({ MfaConfiguration: 'OPTIONAL' }) });

      await update({ MfaConfiguration: 'OFF' }, TOTP_OPTIONAL);

      expect(sent('GetUserPoolMfaConfigCommand')).toHaveLength(1);
      expect(sent('SetUserPoolMfaConfigCommand').map((c) => c.input)).toEqual([BARE_OFF]);
    });

    it('a failed live read sends no #7128 reset and warns, without the AWS message', async () => {
      respond({ GetUserPoolMfaConfigCommand: denied });

      await update({ MfaConfiguration: 'OFF' }, TOTP_OPTIONAL);

      expect(sent('SetUserPoolMfaConfigCommand')).toHaveLength(0);
      const warned = childLogger.warn.mock.calls.map((c) => String(c[0]));
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain('did not reset the removed MFA factors');
      expect(warned[0]).toContain(`get-user-pool-mfa-config --user-pool-id ${POOL_ID}`);
      expect(warned[0]).not.toContain('not authorized');
    });

    it('a failed live read keeps the #1160 arm on its bare request, so MFA still goes OFF', async () => {
      respond({ GetUserPoolMfaConfigCommand: denied });

      await update({}, TOTP_OPTIONAL);

      expect(sent('SetUserPoolMfaConfigCommand').map((c) => c.input)).toEqual([BARE_OFF]);
      const carryWarn = childLogger.warn.mock.calls
        .map((c) => String(c[0]))
        .filter((w) => w.includes('could not carry a WebAuthn'));
      expect(carryWarn).toHaveLength(1);
      expect(carryWarn[0]).not.toContain('not authorized');
    });

    it('sends no WebAuthn block when the live one carries none of its fields', async () => {
      respond({ GetUserPoolMfaConfigCommand: () => ({ WebAuthnConfiguration: {} }) });

      await update({ MfaConfiguration: 'OFF' }, TOTP_OPTIONAL);

      expect(sent('SetUserPoolMfaConfigCommand').map((c) => c.input)).toEqual([BARE_OFF]);
    });

    it('warns that a removed WebAuthn property stays when the reset carries it', async () => {
      respond({ GetUserPoolMfaConfigCommand: () => ({ WebAuthnConfiguration: { RelyingPartyId: 'auth.example.com' } }) });

      await update({ MfaConfiguration: 'OFF' }, { ...TOTP_OPTIONAL, WebAuthnRelyingPartyID: 'auth.example.com' });

      expect(sent('SetUserPoolMfaConfigCommand').map((c) => c.input)).toEqual([
        { ...BARE_OFF, WebAuthnConfiguration: { RelyingPartyId: 'auth.example.com' } },
      ]);
      const kept = childLogger.warn.mock.calls
        .map((c) => String(c[0]))
        .filter((w) => w.includes('keeps its current WebAuthn configuration'));
      expect(kept).toHaveLength(1);
      expect(kept[0]).toContain('no longer declares WebAuthnRelyingPartyID,');
    });

    it('does not warn about WebAuthn on drift --revert, whose previous side is the live readback', async () => {
      respond({ GetUserPoolMfaConfigCommand: () => ({ WebAuthnConfiguration: { RelyingPartyId: 'auth.example.com' } }) });

      await update(
        { MfaConfiguration: 'OFF' },
        { ...TOTP_OPTIONAL, WebAuthnRelyingPartyID: 'auth.example.com', WebAuthnUserVerification: 'preferred' },
        { desiredFromAwsReadback: true }
      );

      expect(sent('SetUserPoolMfaConfigCommand')).toHaveLength(1);
      expect(childLogger.warn.mock.calls.map((c) => String(c[0])).filter((w) => w.includes('WebAuthn'))).toHaveLength(0);
    });

    it('still warns about a removed WebAuthn property on a rollback replay', async () => {
      await update({ MfaConfiguration: 'OFF' }, { ...TOTP_OPTIONAL, WebAuthnRelyingPartyID: 'auth.example.com' }, { replayingState: true });

      expect(
        childLogger.warn.mock.calls.map((c) => String(c[0])).filter((w) => w.includes('keeps its current WebAuthn configuration'))
      ).toHaveLength(1);
    });

    it('does not warn about WebAuthn when a factor stays and the full-replace call drops it', async () => {
      await update(TOTP_OPTIONAL, { ...TOTP_OPTIONAL, WebAuthnRelyingPartyID: 'auth.example.com' });

      expect(childLogger.warn.mock.calls.map((c) => String(c[0])).filter((w) => w.includes('WebAuthn'))).toHaveLength(0);
    });

    it('reads nothing on an update that removes no factor', async () => {
      await update({ MfaConfiguration: 'OFF' }, { MfaConfiguration: 'OFF' });

      expect(sent('GetUserPoolMfaConfigCommand')).toHaveLength(0);
    });
  });

  it('an email-OTP message alone (resolved OPTIONAL) removed with MfaConfiguration is the #1160 arm, with its warning', async () => {
    await update({}, { EmailAuthenticationMessage: 'Your code is {####}' });

    expect(sent('SetUserPoolMfaConfigCommand').map((c) => c.input)).toEqual([BARE_OFF]);
    const hit = childLogger.warn.mock.calls.map((c) => String(c[0])).filter((w) => w.includes('cdkd turned MFA OFF'));
    expect(hit).toHaveLength(1);
    expect(hit[0]).toContain('it was OPTIONAL');
  });

  it('a rollback replay turning MFA back ON sends the usual full-replace call, no reset', async () => {
    await update(
      { MfaConfiguration: 'OPTIONAL', EnabledMfas: ['SOFTWARE_TOKEN_MFA'] },
      { MfaConfiguration: 'OFF' },
      { replayingState: true }
    );

    const mfa = sent('SetUserPoolMfaConfigCommand');
    expect(mfa).toHaveLength(1);
    expect(mfa[0]!.input['MfaConfiguration']).toBe('OPTIONAL');
    expect(mfa[0]!.input['SoftwareTokenMfaConfiguration']).toEqual({ Enabled: true });
    expect(sent('GetUserPoolMfaConfigCommand')).toHaveLength(0);
  });

  it('a refused reset fails the update with a masked ProvisioningError', async () => {
    const secret = 'super-secret-mfa-factor-value';
    respond({
      SetUserPoolMfaConfigCommand: () => {
        throw Object.assign(new Error(`Invalid value ${secret}`), { name: 'InvalidParameterException' });
      },
    });

    const failure = await update({ MfaConfiguration: 'OFF' }, TOTP_OPTIONAL, {
      maskSecrets: createSecretMasker(new Map([[secret, '{{resolve:secretsmanager:s:SecretString:k::}}']])),
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProvisioningError);
    const message = (failure as Error).message;
    expect(message).toContain('Failed to update Cognito User Pool MyUserPool');
    expect(message).not.toContain(secret);
    expect(message).toContain(SECRET_MASK);
  });
});

describe('clearsRemovedMfaConfig', () => {
  it.each([
    ['factor removed under OFF', { MfaConfiguration: 'OFF' }, 'OFF', TOTP_OPTIONAL, true],
    ['factor removed, MfaConfiguration absent', {}, '', TOTP_OPTIONAL, true],
    ['email-OTP message removed under OFF', { MfaConfiguration: 'OFF' }, 'OFF', { EmailAuthenticationSubject: 's' }, true],
    ['an MFA-routed property kept', { MfaConfiguration: 'OFF', WebAuthnRelyingPartyID: 'example.com' }, 'OFF', TOTP_OPTIONAL, false],
    ['WebAuthn-only previous', { MfaConfiguration: 'OFF' }, 'OFF', { WebAuthnRelyingPartyID: 'example.com' }, false],
    ['declared OPTIONAL', { MfaConfiguration: 'OPTIONAL' }, 'OPTIONAL', TOTP_OPTIONAL, false],
    ['blank MfaConfiguration', { MfaConfiguration: '  ' }, '', TOTP_OPTIONAL, false],
    ['nothing previous', { MfaConfiguration: 'OFF' }, 'OFF', {}, false],
  ])('%s', (_, desired, declared, previous, expected) => {
    expect(clearsRemovedMfaConfig(desired, previous, declared)).toBe(expected);
  });
});
