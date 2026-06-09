import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  DescribeUserPoolCommand,
  GetUserPoolMfaConfigCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-cognito-identity-provider', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    CognitoIdentityProviderClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
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

import { CognitoUserPoolProvider } from '../../../src/provisioning/providers/cognito-provider.js';

describe('CognitoUserPoolProvider.readCurrentState', () => {
  let provider: CognitoUserPoolProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new CognitoUserPoolProvider();
  });

  it('returns CFn-shaped UserPool fields from DescribeUserPool (happy path)', async () => {
    mockSend.mockResolvedValueOnce({
      UserPool: {
        Id: 'us-east-1_abcd',
        Name: 'my-pool',
        AutoVerifiedAttributes: ['email'],
        UsernameAttributes: ['email'],
        Policies: { PasswordPolicy: { MinimumLength: 8 } },
        MfaConfiguration: 'OFF',
        DeletionProtection: 'ACTIVE',
        // AWS-managed fields, must NOT surface:
        Arn: 'arn:aws:cognito-idp:us-east-1:123:userpool/us-east-1_abcd',
        CreationDate: new Date(),
        EstimatedNumberOfUsers: 0,
      },
    });
    // GetUserPoolMfaConfig (second call): empty MFA config.
    mockSend.mockResolvedValueOnce({});

    const result = await provider.readCurrentState(
      'us-east-1_abcd',
      'PoolLogical',
      'AWS::Cognito::UserPool'
    );

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeUserPoolCommand);
    expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(GetUserPoolMfaConfigCommand);
    expect(result).toEqual({
      UserPoolName: 'my-pool',
      AutoVerifiedAttributes: ['email'],
      UsernameAttributes: ['email'],
      AliasAttributes: [],
      Policies: { PasswordPolicy: { MinimumLength: 8 } },
      LambdaConfig: {},
      MfaConfiguration: 'OFF',
      AdminCreateUserConfig: {},
      AccountRecoverySetting: {},
      UserAttributeUpdateSettings: {},
      DeletionProtection: 'ACTIVE',
      EmailConfiguration: {},
      SmsConfiguration: {},
      VerificationMessageTemplate: {},
      UsernameConfiguration: {},
      DeviceConfiguration: {},
      UserPoolAddOns: {},
      EmailVerificationMessage: '',
      EmailVerificationSubject: '',
      SmsAuthenticationMessage: '',
      SmsVerificationMessage: '',
      UserPoolTags: {},
      // #609 backfill keys (UserPoolTier from Describe; MFA keys from
      // GetUserPoolMfaConfig — empty config above so defaults emit).
      UserPoolTier: 'ESSENTIALS',
      EnabledMfas: [],
      EmailAuthenticationMessage: '',
      EmailAuthenticationSubject: '',
      WebAuthnRelyingPartyID: '',
      WebAuthnUserVerification: '',
    });
  });

  it('reconstructs EnabledMfas + email/WebAuthn keys from GetUserPoolMfaConfig', async () => {
    mockSend.mockResolvedValueOnce({
      UserPool: {
        Id: 'us-east-1_abcd',
        Name: 'my-pool',
        UserPoolTier: 'PLUS',
      },
    });
    mockSend.mockResolvedValueOnce({
      SmsMfaConfiguration: { SmsConfiguration: { SnsCallerArn: 'arn:sms' } },
      SoftwareTokenMfaConfiguration: { Enabled: true },
      EmailMfaConfiguration: { Message: 'code {####}', Subject: 'Your code' },
      WebAuthnConfiguration: { RelyingPartyId: 'auth.example.com', UserVerification: 'required' },
    });

    const result = (await provider.readCurrentState(
      'us-east-1_abcd',
      'PoolLogical',
      'AWS::Cognito::UserPool'
    )) as Record<string, unknown>;

    expect(result['UserPoolTier']).toBe('PLUS');
    expect(result['EnabledMfas']).toEqual(['SMS_MFA', 'SOFTWARE_TOKEN_MFA', 'EMAIL_OTP']);
    expect(result['EmailAuthenticationMessage']).toBe('code {####}');
    expect(result['EmailAuthenticationSubject']).toBe('Your code');
    expect(result['WebAuthnRelyingPartyID']).toBe('auth.example.com');
    expect(result['WebAuthnUserVerification']).toBe('required');
  });

  it('skips MFA-derived keys (still returns Describe fields) when GetUserPoolMfaConfig fails', async () => {
    mockSend.mockResolvedValueOnce({
      UserPool: { Id: 'us-east-1_abcd', Name: 'my-pool', UserPoolTier: 'LITE' },
    });
    mockSend.mockRejectedValueOnce(new Error('AccessDenied on MFA API'));

    const result = (await provider.readCurrentState(
      'us-east-1_abcd',
      'PoolLogical',
      'AWS::Cognito::UserPool'
    )) as Record<string, unknown>;

    expect(result['UserPoolTier']).toBe('LITE');
    expect(result['UserPoolName']).toBe('my-pool');
    expect('EnabledMfas' in result).toBe(false);
    expect('WebAuthnRelyingPartyID' in result).toBe(false);
  });

  it('returns undefined when pool is gone', async () => {
    mockSend.mockRejectedValueOnce(
      new ResourceNotFoundException({ message: 'gone', $metadata: {} })
    );

    const result = await provider.readCurrentState(
      'us-east-1_gone',
      'PoolLogical',
      'AWS::Cognito::UserPool'
    );

    expect(result).toBeUndefined();
  });

  it('returns undefined for unsupported resource types', async () => {
    const result = await provider.readCurrentState(
      'client-id',
      'ClientLogical',
      'AWS::Cognito::UserPoolClient'
    );

    expect(result).toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('surfaces UserPoolTags as a map with aws:* filtered out', async () => {
    mockSend.mockResolvedValueOnce({
      UserPool: {
        Id: 'us-east-1_abcd',
        Name: 'my-pool',
        UserPoolTags: { Foo: 'Bar', 'aws:cdk:path': 'MyStack/MyPool/Resource' },
      },
    });

    const result = await provider.readCurrentState(
      'us-east-1_abcd',
      'PoolLogical',
      'AWS::Cognito::UserPool'
    );

    expect(result?.UserPoolTags).toEqual({ Foo: 'Bar' });
  });

  it('emits empty UserPoolTags placeholder when DescribeUserPool returns no user tags', async () => {
    mockSend.mockResolvedValueOnce({
      UserPool: {
        Id: 'us-east-1_abcd',
        Name: 'my-pool',
        UserPoolTags: { 'aws:cdk:path': 'MyStack/MyPool/Resource' },
      },
    });

    const result = await provider.readCurrentState(
      'us-east-1_abcd',
      'PoolLogical',
      'AWS::Cognito::UserPool'
    );

    expect(result?.UserPoolTags).toEqual({});
  });

  // Structural regression test for the always-emit-placeholder convention
  // (docs/provider-development.md § 3b). Ensures every user-controllable
  // top-level CFn key is present in the result even when AWS returns
  // the resource with all optional fields undefined / empty. A future
  // refactor that drops a placeholder for any of these keys must update
  // this test consciously — silent regression is structurally prevented.
  //
  // Note: `Schema` is intentionally NOT in the expected key set. The
  // provider only emits Schema when SchemaAttributes is non-empty
  // (immutable on create — emitting an empty array here would surface
  // as a phantom diff on every never-customized pool).
  it('emits placeholders for every user-controllable top-level key on AWS minimum response', async () => {
    mockSend.mockResolvedValueOnce({
      UserPool: {
        Id: 'us-east-1_x',
        Name: 'p',
        // Every other field deliberately undefined.
      },
    });
    // GetUserPoolMfaConfig — empty (no MFA factors / WebAuthn configured).
    mockSend.mockResolvedValueOnce({});

    const result = await provider.readCurrentState(
      'us-east-1_x',
      'PoolLogical',
      'AWS::Cognito::UserPool'
    );

    expect(Object.keys(result ?? {}).sort()).toEqual(
      [
        'AccountRecoverySetting',
        'AdminCreateUserConfig',
        'AliasAttributes',
        'AutoVerifiedAttributes',
        'DeletionProtection',
        'DeviceConfiguration',
        'EmailAuthenticationMessage',
        'EmailAuthenticationSubject',
        'EmailConfiguration',
        'EmailVerificationMessage',
        'EmailVerificationSubject',
        'EnabledMfas',
        'LambdaConfig',
        'MfaConfiguration',
        'Policies',
        'SmsAuthenticationMessage',
        'SmsConfiguration',
        'SmsVerificationMessage',
        'UserAttributeUpdateSettings',
        'UserPoolAddOns',
        'UserPoolName',
        'UserPoolTags',
        'UserPoolTier',
        'UsernameAttributes',
        'UsernameConfiguration',
        'VerificationMessageTemplate',
        'WebAuthnRelyingPartyID',
        'WebAuthnUserVerification',
      ].sort()
    );
    expect(result?.UserPoolName).toBe('p');
    expect(result?.AutoVerifiedAttributes).toEqual([]);
    expect(result?.UsernameAttributes).toEqual([]);
    expect(result?.AliasAttributes).toEqual([]);
    expect(result?.Policies).toEqual({});
    expect(result?.LambdaConfig).toEqual({});
    expect(result?.MfaConfiguration).toBe('OFF');
    expect(result?.AdminCreateUserConfig).toEqual({});
    expect(result?.AccountRecoverySetting).toEqual({});
    expect(result?.UserAttributeUpdateSettings).toEqual({});
    expect(result?.DeletionProtection).toBe('INACTIVE');
    expect(result?.EmailConfiguration).toEqual({});
    expect(result?.SmsConfiguration).toEqual({});
    expect(result?.VerificationMessageTemplate).toEqual({});
    expect(result?.UsernameConfiguration).toEqual({});
    expect(result?.DeviceConfiguration).toEqual({});
    expect(result?.UserPoolAddOns).toEqual({});
    expect(result?.EmailVerificationMessage).toBe('');
    expect(result?.EmailVerificationSubject).toBe('');
    expect(result?.SmsAuthenticationMessage).toBe('');
    expect(result?.SmsVerificationMessage).toBe('');
    expect(result?.UserPoolTags).toEqual({});
  });
});
