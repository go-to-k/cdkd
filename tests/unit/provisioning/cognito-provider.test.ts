import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

// Mock AWS clients before importing the provider
const mockSend = vi.fn();

vi.mock('@aws-sdk/client-cognito-identity-provider', async () => {
  const actual = await vi.importActual('@aws-sdk/client-cognito-identity-provider');
  return {
    ...actual,
    CognitoIdentityProviderClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

// Hoisted so the tests can assert on the provider's own warnings (the
// unrecognized-EnabledMfas warn below); the module factory closes over the
// same object.
const { childLogger } = vi.hoisted(() => ({
  childLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  },
}));
childLogger.child.mockReturnValue(childLogger);

vi.mock('../../../src/utils/logger.js', () => {
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

import { ResourceNotFoundException } from '@aws-sdk/client-cognito-identity-provider';
import { CognitoUserPoolProvider } from '../../../src/provisioning/providers/cognito-provider.js';

describe('CognitoUserPoolProvider', () => {
  let provider: CognitoUserPoolProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new CognitoUserPoolProvider();
  });

  describe('create', () => {
    it('should create user pool and return UserPoolId as physicalId with attributes', async () => {
      mockSend.mockResolvedValueOnce({
        UserPool: {
          Id: 'us-east-1_abc123',
          Arn: 'arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_abc123',
        },
      });

      const result = await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
        UserPoolName: 'my-user-pool',
      });

      expect(result.physicalId).toBe('us-east-1_abc123');
      expect(result.attributes).toEqual({
        Arn: 'arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_abc123',
        ProviderName: 'cognito-idp.us-east-1.amazonaws.com/us-east-1_abc123',
        ProviderURL: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc123',
        UserPoolId: 'us-east-1_abc123',
      });
      expect(mockSend).toHaveBeenCalledTimes(1);

      const createCall = mockSend.mock.calls[0][0];
      expect(createCall.constructor.name).toBe('CreateUserPoolCommand');
    });

    it('should pass PoolName as UserPoolName', async () => {
      mockSend.mockResolvedValueOnce({
        UserPool: {
          Id: 'us-east-1_abc123',
          Arn: 'arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_abc123',
        },
      });

      await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
        UserPoolName: 'custom-pool-name',
      });

      const createCall = mockSend.mock.calls[0][0];
      expect(createCall.input.PoolName).toBe('custom-pool-name');
    });

    it('should use logicalId as PoolName when UserPoolName is not provided', async () => {
      mockSend.mockResolvedValueOnce({
        UserPool: {
          Id: 'us-east-1_abc123',
          Arn: 'arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_abc123',
        },
      });

      await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {});

      const createCall = mockSend.mock.calls[0][0];
      expect(createCall.input.PoolName).toBe('MyUserPool');
    });

    it('should throw ProvisioningError on failure', async () => {
      mockSend.mockRejectedValueOnce(new Error('Access Denied'));

      await expect(
        provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          UserPoolName: 'my-pool',
        })
      ).rejects.toThrow('Failed to create Cognito User Pool MyUserPool');
    });

    it('should forward Policies.SignInPolicy alongside PasswordPolicy (#1380)', async () => {
      mockSend.mockResolvedValueOnce({
        UserPool: {
          Id: 'us-east-1_abc123',
          Arn: 'arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_abc123',
        },
      });

      await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
        Policies: {
          PasswordPolicy: { MinimumLength: 12 },
          SignInPolicy: { AllowedFirstAuthFactors: ['PASSWORD', 'EMAIL_OTP'] },
        },
      });

      const createCall = mockSend.mock.calls[0][0];
      expect(createCall.input.Policies).toEqual({
        PasswordPolicy: { MinimumLength: 12 },
        SignInPolicy: { AllowedFirstAuthFactors: ['PASSWORD', 'EMAIL_OTP'] },
      });
    });

    it('should forward Policies when only SignInPolicy is present (#1380)', async () => {
      // CDK synthesizes Policies with ONLY SignInPolicy when the user sets
      // signInPolicy but not passwordPolicy — Policies must still be sent.
      mockSend.mockResolvedValueOnce({
        UserPool: {
          Id: 'us-east-1_abc123',
          Arn: 'arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_abc123',
        },
      });

      await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
        Policies: {
          SignInPolicy: { AllowedFirstAuthFactors: ['PASSWORD', 'WEB_AUTHN'] },
        },
      });

      const createCall = mockSend.mock.calls[0][0];
      expect(createCall.input.Policies).toEqual({
        SignInPolicy: { AllowedFirstAuthFactors: ['PASSWORD', 'WEB_AUTHN'] },
      });
    });
  });

  describe('update', () => {
    it('should update user pool (Policies, MfaConfiguration, etc.)', async () => {
      // UpdateUserPool
      mockSend.mockResolvedValueOnce({});
      // DescribeUserPool
      mockSend.mockResolvedValueOnce({
        UserPool: {
          Arn: 'arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_abc123',
        },
      });

      const result = await provider.update(
        'MyUserPool',
        'us-east-1_abc123',
        'AWS::Cognito::UserPool',
        {
          Policies: {
            PasswordPolicy: {
              MinimumLength: 12,
              RequireUppercase: true,
            },
          },
          MfaConfiguration: 'OPTIONAL',
        },
        {
          Policies: {
            PasswordPolicy: {
              MinimumLength: 8,
              RequireUppercase: false,
            },
          },
          MfaConfiguration: 'OFF',
        }
      );

      expect(result.physicalId).toBe('us-east-1_abc123');
      expect(result.wasReplaced).toBe(false);
      expect(result.attributes).toEqual({
        Arn: 'arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_abc123',
        ProviderName: 'cognito-idp.us-east-1.amazonaws.com/us-east-1_abc123',
        ProviderURL: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc123',
        UserPoolId: 'us-east-1_abc123',
      });
      expect(mockSend).toHaveBeenCalledTimes(2);

      const updateCall = mockSend.mock.calls[0][0];
      expect(updateCall.constructor.name).toBe('UpdateUserPoolCommand');
      expect(updateCall.input.UserPoolId).toBe('us-east-1_abc123');
      expect(updateCall.input.Policies).toEqual({
        PasswordPolicy: {
          MinimumLength: 12,
          RequireUppercase: true,
        },
      });
      expect(updateCall.input.MfaConfiguration).toBe('OPTIONAL');

      const describeCall = mockSend.mock.calls[1][0];
      expect(describeCall.constructor.name).toBe('DescribeUserPoolCommand');
    });

    it('should forward Policies.SignInPolicy on update (#1380)', async () => {
      // UpdateUserPool resets omitted attributes to defaults, so dropping
      // SignInPolicy here wipes an existing passwordless configuration.
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({
        UserPool: {
          Arn: 'arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_abc123',
        },
      });

      await provider.update(
        'MyUserPool',
        'us-east-1_abc123',
        'AWS::Cognito::UserPool',
        {
          Policies: {
            PasswordPolicy: { MinimumLength: 12 },
            SignInPolicy: { AllowedFirstAuthFactors: ['PASSWORD', 'EMAIL_OTP'] },
          },
        },
        {
          Policies: {
            PasswordPolicy: { MinimumLength: 8 },
          },
        }
      );

      const updateCall = mockSend.mock.calls[0][0];
      expect(updateCall.input.Policies).toEqual({
        PasswordPolicy: { MinimumLength: 12 },
        SignInPolicy: { AllowedFirstAuthFactors: ['PASSWORD', 'EMAIL_OTP'] },
      });
    });

    it('adds a new custom attribute via AddCustomAttributes (Schema in-place add)', async () => {
      // UpdateUserPool
      mockSend.mockResolvedValueOnce({});
      // AddCustomAttributes
      mockSend.mockResolvedValueOnce({});
      // DescribeUserPool
      mockSend.mockResolvedValueOnce({
        UserPool: {
          Arn: 'arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_abc123',
        },
      });

      await provider.update(
        'MyUserPool',
        'us-east-1_abc123',
        'AWS::Cognito::UserPool',
        {
          Schema: [
            { Name: 'tenantId', AttributeDataType: 'String', Mutable: true },
            { Name: 'region', AttributeDataType: 'String', Mutable: true },
          ],
        },
        {
          Schema: [{ Name: 'tenantId', AttributeDataType: 'String', Mutable: true }],
        }
      );

      const addCall = mockSend.mock.calls.find(
        (call: unknown[]) =>
          (call[0] as { constructor: { name: string } }).constructor.name ===
          'AddCustomAttributesCommand'
      );
      expect(addCall).toBeDefined();
      expect(addCall![0].input.UserPoolId).toBe('us-east-1_abc123');
      // Only the newly-added attribute is sent, not the pre-existing one.
      expect(addCall![0].input.CustomAttributes).toEqual([
        { Name: 'region', AttributeDataType: 'String', Mutable: true },
      ]);
    });

    it('does not call AddCustomAttributes when the Schema is unchanged', async () => {
      mockSend.mockResolvedValueOnce({}); // UpdateUserPool
      mockSend.mockResolvedValueOnce({
        UserPool: {
          Arn: 'arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_abc123',
        },
      }); // DescribeUserPool

      await provider.update(
        'MyUserPool',
        'us-east-1_abc123',
        'AWS::Cognito::UserPool',
        { Schema: [{ Name: 'tenantId', AttributeDataType: 'String', Mutable: true }] },
        { Schema: [{ Name: 'tenantId', AttributeDataType: 'String', Mutable: true }] }
      );

      const addCall = mockSend.mock.calls.find(
        (call: unknown[]) =>
          (call[0] as { constructor: { name: string } }).constructor.name ===
          'AddCustomAttributesCommand'
      );
      expect(addCall).toBeUndefined();
    });

    it('throws ResourceUpdateNotSupportedError when an existing custom attribute is removed', async () => {
      mockSend.mockResolvedValueOnce({}); // UpdateUserPool

      await expect(
        provider.update(
          'MyUserPool',
          'us-east-1_abc123',
          'AWS::Cognito::UserPool',
          { Schema: [{ Name: 'tenantId', AttributeDataType: 'String', Mutable: true }] },
          {
            Schema: [
              { Name: 'tenantId', AttributeDataType: 'String', Mutable: true },
              { Name: 'level', AttributeDataType: 'Number', Mutable: false },
            ],
          }
        )
      ).rejects.toMatchObject({ name: 'ResourceUpdateNotSupportedError' });
    });

    it('throws ResourceUpdateNotSupportedError when an existing custom attribute is modified', async () => {
      mockSend.mockResolvedValueOnce({}); // UpdateUserPool

      await expect(
        provider.update(
          'MyUserPool',
          'us-east-1_abc123',
          'AWS::Cognito::UserPool',
          { Schema: [{ Name: 'tenantId', AttributeDataType: 'String', Mutable: false }] },
          { Schema: [{ Name: 'tenantId', AttributeDataType: 'String', Mutable: true }] }
        )
      ).rejects.toMatchObject({ name: 'ResourceUpdateNotSupportedError' });
    });

    it('the immutable-Schema rejection points at --replace --force-stateful-recreation (UserPool is stateful)', async () => {
      mockSend.mockResolvedValueOnce({}); // UpdateUserPool

      await expect(
        provider.update(
          'MyUserPool',
          'us-east-1_abc123',
          'AWS::Cognito::UserPool',
          { Schema: [{ Name: 'tenantId', AttributeDataType: 'String', Mutable: true }] },
          {
            Schema: [
              { Name: 'tenantId', AttributeDataType: 'String', Mutable: true },
              { Name: 'level', AttributeDataType: 'Number', Mutable: false },
            ],
          }
        )
      ).rejects.toThrow(/--replace --force-stateful-recreation/);
    });

    it('throws on a Schema entry with no Name (malformed template), not a silent skip', async () => {
      mockSend.mockResolvedValueOnce({}); // UpdateUserPool

      await expect(
        provider.update(
          'MyUserPool',
          'us-east-1_abc123',
          'AWS::Cognito::UserPool',
          { Schema: [{ AttributeDataType: 'String', Mutable: true }] },
          { Schema: [] }
        )
      ).rejects.toThrow(/Schema attribute with no Name/);
    });

    it('should not pass PoolName in update params (PoolName is immutable)', async () => {
      // UpdateUserPool
      mockSend.mockResolvedValueOnce({});
      // DescribeUserPool
      mockSend.mockResolvedValueOnce({
        UserPool: {
          Arn: 'arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_abc123',
        },
      });

      await provider.update(
        'MyUserPool',
        'us-east-1_abc123',
        'AWS::Cognito::UserPool',
        {
          UserPoolName: 'new-pool-name',
          MfaConfiguration: 'OFF',
        },
        {
          UserPoolName: 'old-pool-name',
          MfaConfiguration: 'OFF',
        }
      );

      const updateCall = mockSend.mock.calls[0][0];
      // PoolName should NOT be in the update params since it's immutable
      expect(updateCall.input.PoolName).toBeUndefined();
    });
  });

  describe('delete', () => {
    it('without removeProtection, goes straight to DeleteUserPool (no Describe / Update)', async () => {
      // Post-gating: bare delete does NOT pre-check or flip
      // DeletionProtection. AWS rejects the delete on a protected pool;
      // the user is expected to set --remove-protection.
      mockSend.mockResolvedValueOnce({});

      await provider.delete('MyUserPool', 'us-east-1_abc123', 'AWS::Cognito::UserPool');

      expect(mockSend).toHaveBeenCalledTimes(1);
      const deleteCall = mockSend.mock.calls[0][0];
      expect(deleteCall.constructor.name).toBe('DeleteUserPoolCommand');
      expect(deleteCall.input.UserPoolId).toBe('us-east-1_abc123');
    });

    it('should handle ResourceNotFoundException gracefully', async () => {
      mockSend.mockRejectedValueOnce(
        new ResourceNotFoundException({ $metadata: {}, message: 'not found' })
      );

      await provider.delete('MyUserPool', 'us-east-1_abc123', 'AWS::Cognito::UserPool');

      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('with removeProtection=true and templated DeletionProtection=ACTIVE, flips before delete', async () => {
      // Templated ACTIVE short-circuits the Describe call: UpdateUserPool + DeleteUserPool only.
      mockSend
        .mockResolvedValueOnce({}) // UpdateUserPool
        .mockResolvedValueOnce({}); // DeleteUserPool

      await provider.delete(
        'MyUserPool',
        'us-east-1_abc123',
        'AWS::Cognito::UserPool',
        { DeletionProtection: 'ACTIVE' },
        { removeProtection: true }
      );

      expect(mockSend).toHaveBeenCalledTimes(2);
      const updateCall = mockSend.mock.calls[0][0];
      expect(updateCall.constructor.name).toBe('UpdateUserPoolCommand');
      expect(updateCall.input.DeletionProtection).toBe('INACTIVE');
      const deleteCall = mockSend.mock.calls[1][0];
      expect(deleteCall.constructor.name).toBe('DeleteUserPoolCommand');
    });

    it('should throw ProvisioningError on unexpected failure', async () => {
      // Bare delete now skips Describe; the unexpected failure happens on DeleteUserPool itself.
      mockSend.mockRejectedValueOnce(new Error('Access Denied'));

      await expect(
        provider.delete('MyUserPool', 'us-east-1_abc123', 'AWS::Cognito::UserPool')
      ).rejects.toThrow('Failed to delete Cognito User Pool MyUserPool');
    });
  });

  // Issue #609 backfill: UserPoolTier (CreateUserPool/UpdateUserPool direct)
  // + EnabledMfas / EmailAuthenticationMessage+Subject / WebAuthn* (routed
  // through the SetUserPoolMfaConfig post-create control-plane API).
  describe('backfill properties (#609)', () => {
    describe('UserPoolTier', () => {
      it('rides on CreateUserPool', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:tier' },
        });

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          UserPoolTier: 'PLUS',
        });

        // Only CreateUserPool — no MFA props, so no SetUserPoolMfaConfig.
        expect(mockSend).toHaveBeenCalledTimes(1);
        const createCall = mockSend.mock.calls[0][0];
        expect(createCall.constructor.name).toBe('CreateUserPoolCommand');
        expect(createCall.input.UserPoolTier).toBe('PLUS');
      });

      it('rides on UpdateUserPool', async () => {
        mockSend.mockResolvedValueOnce({}); // UpdateUserPool
        mockSend.mockResolvedValueOnce({ UserPool: { Arn: 'arn:tier' } }); // DescribeUserPool

        await provider.update(
          'MyUserPool',
          'us-east-1_abc123',
          'AWS::Cognito::UserPool',
          { UserPoolTier: 'ESSENTIALS' },
          {}
        );

        const updateCall = mockSend.mock.calls[0][0];
        expect(updateCall.constructor.name).toBe('UpdateUserPoolCommand');
        expect(updateCall.input.UserPoolTier).toBe('ESSENTIALS');
      });
    });

    describe('EnabledMfas via SetUserPoolMfaConfig', () => {
      it('maps each factor to its MFA-config sub-block on create', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:mfa' },
        }); // CreateUserPool
        mockSend.mockResolvedValueOnce({}); // SetUserPoolMfaConfig

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          EnabledMfas: ['SMS_MFA', 'SOFTWARE_TOKEN_MFA', 'EMAIL_OTP'],
          SmsConfiguration: { SnsCallerArn: 'arn:aws:iam::1:role/sms' },
        });

        expect(mockSend).toHaveBeenCalledTimes(2);
        // EnabledMfas must NOT be forwarded on CreateUserPool (no such field).
        const createCall = mockSend.mock.calls[0][0];
        expect(createCall.constructor.name).toBe('CreateUserPoolCommand');
        expect(createCall.input.EnabledMfas).toBeUndefined();

        const mfaCall = mockSend.mock.calls[1][0];
        expect(mfaCall.constructor.name).toBe('SetUserPoolMfaConfigCommand');
        expect(mfaCall.input.UserPoolId).toBe('us-east-1_abc123');
        // SetUserPoolMfaConfig is a full-replace: MfaConfiguration MUST be set
        // (an omitted value resets the pool to OFF and drops the factors below).
        // Defaults to OPTIONAL when the template omits it but enables factors.
        expect(mfaCall.input.MfaConfiguration).toBe('OPTIONAL');
        expect(mfaCall.input.SoftwareTokenMfaConfiguration).toEqual({ Enabled: true });
        expect(mfaCall.input.SmsMfaConfiguration).toEqual({
          SmsConfiguration: { SnsCallerArn: 'arn:aws:iam::1:role/sms' },
        });
        expect(mfaCall.input.EmailMfaConfiguration).toBeDefined();
      });

      it("threads the template's MfaConfiguration into SetUserPoolMfaConfig (not reset to OFF)", async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:mfa' },
        }); // CreateUserPool
        mockSend.mockResolvedValueOnce({}); // SetUserPoolMfaConfig

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          MfaConfiguration: 'ON',
          EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
        });

        // With a factor present, MfaConfiguration must NOT ride on
        // CreateUserPool (AWS rejects ON/OPTIONAL there before the factor is
        // enabled — "SMS configuration ... required when MFA is
        // required/optional"); SetUserPoolMfaConfig owns it instead.
        const createCall = mockSend.mock.calls[0][0];
        expect(createCall.constructor.name).toBe('CreateUserPoolCommand');
        expect(createCall.input.MfaConfiguration).toBeUndefined();

        const mfaCall = mockSend.mock.calls[1][0];
        expect(mfaCall.constructor.name).toBe('SetUserPoolMfaConfigCommand');
        expect(mfaCall.input.MfaConfiguration).toBe('ON');
      });

      it('forwards MfaConfiguration to CreateUserPool when NO MFA factor is present (no SetUserPoolMfaConfig)', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:mfa' },
        }); // CreateUserPool only

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          MfaConfiguration: 'OFF',
        });

        // No factor → no SetUserPoolMfaConfig call; MfaConfiguration rides on
        // CreateUserPool as before.
        expect(mockSend).toHaveBeenCalledTimes(1);
        const createCall = mockSend.mock.calls[0][0];
        expect(createCall.constructor.name).toBe('CreateUserPoolCommand');
        expect(createCall.input.MfaConfiguration).toBe('OFF');
      });

      it('does NOT call SetUserPoolMfaConfig when no MFA props are present', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:none' },
        });

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          UserPoolName: 'plain-pool',
        });

        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(mockSend.mock.calls[0][0].constructor.name).toBe('CreateUserPoolCommand');
      });

      it('applies EnabledMfas via SetUserPoolMfaConfig on update', async () => {
        mockSend.mockResolvedValueOnce({}); // UpdateUserPool
        mockSend.mockResolvedValueOnce({}); // SetUserPoolMfaConfig
        mockSend.mockResolvedValueOnce({ UserPool: { Arn: 'arn:upd' } }); // DescribeUserPool

        await provider.update(
          'MyUserPool',
          'us-east-1_abc123',
          'AWS::Cognito::UserPool',
          { EnabledMfas: ['SOFTWARE_TOKEN_MFA'] },
          {}
        );

        expect(mockSend).toHaveBeenCalledTimes(3);
        expect(mockSend.mock.calls[0][0].constructor.name).toBe('UpdateUserPoolCommand');
        const mfaCall = mockSend.mock.calls[1][0];
        expect(mfaCall.constructor.name).toBe('SetUserPoolMfaConfigCommand');
        expect(mfaCall.input.SoftwareTokenMfaConfiguration).toEqual({ Enabled: true });
        expect(mockSend.mock.calls[2][0].constructor.name).toBe('DescribeUserPoolCommand');
      });
    });

    describe('EmailAuthenticationMessage / Subject', () => {
      it('map to EmailMfaConfiguration.Message/Subject on create', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:email' },
        });
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          EmailAuthenticationMessage: 'Your code is {####}',
          EmailAuthenticationSubject: 'Sign-in code',
        });

        const mfaCall = mockSend.mock.calls[1][0];
        expect(mfaCall.constructor.name).toBe('SetUserPoolMfaConfigCommand');
        expect(mfaCall.input.EmailMfaConfiguration).toEqual({
          Message: 'Your code is {####}',
          Subject: 'Sign-in code',
        });
        // Deliberately still OPTIONAL: EmailMfaConfiguration IS emitted here, and
        // whether AWS accepts that block under OFF is unverified (issue #1923),
        // so this shape keeps its existing default rather than being flipped on
        // an untested wire assumption.
        expect(mfaCall.input.MfaConfiguration).toBe('OPTIONAL');
      });
    });

    describe('WebAuthn config', () => {
      it('maps WebAuthnRelyingPartyID/UserVerification to WebAuthnConfiguration', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:wa' },
        });
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          WebAuthnRelyingPartyID: 'auth.example.com',
          WebAuthnUserVerification: 'preferred',
        });

        const mfaCall = mockSend.mock.calls[1][0];
        expect(mfaCall.constructor.name).toBe('SetUserPoolMfaConfigCommand');
        expect(mfaCall.input.WebAuthnConfiguration).toEqual({
          RelyingPartyId: 'auth.example.com',
          UserVerification: 'preferred',
        });
        // WebAuthn is not an MFA factor, so the call must NOT claim OPTIONAL —
        // AWS rejects that outright (issue #1920). Pinned as the WHOLE request:
        // the original blind spot here was a field nobody asserted, so asserting
        // the complete input is what stops the next one from hiding too.
        expect(mfaCall.input).toEqual({
          UserPoolId: 'us-east-1_abc123',
          MfaConfiguration: 'OFF',
          WebAuthnConfiguration: {
            RelyingPartyId: 'auth.example.com',
            UserVerification: 'preferred',
          },
        });
      });
    });

    describe('MfaConfiguration default on SetUserPoolMfaConfig', () => {
      // SetUserPoolMfaConfig is a full-replace, so the request always carries
      // MfaConfiguration. When the template omits it, the value is chosen by
      // whether the call enables a real MFA factor. Both polarities are pinned
      // here: the OFF arm is the issue #1920 regression, and the OPTIONAL arm
      // is the reason the default exists at all.
      it('defaults to OFF for a WebAuthn-only pool (no MFA factor enabled)', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:wa-only' },
        });
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          WebAuthnRelyingPartyID: 'auth.example.com',
          WebAuthnUserVerification: 'required',
        });

        const mfaCall = mockSend.mock.calls[1][0];
        expect(mfaCall.constructor.name).toBe('SetUserPoolMfaConfigCommand');
        expect(mfaCall.input.MfaConfiguration).toBe('OFF');
        expect(mfaCall.input.WebAuthnConfiguration).toEqual({
          RelyingPartyId: 'auth.example.com',
          UserVerification: 'required',
        });
      });

      it('defaults to OFF for a WebAuthn-only pool on update too', async () => {
        mockSend.mockResolvedValueOnce({}); // UpdateUserPool
        mockSend.mockResolvedValueOnce({}); // SetUserPoolMfaConfig
        mockSend.mockResolvedValueOnce({ UserPool: { Arn: 'arn:wa-upd' } }); // DescribeUserPool

        await provider.update(
          'MyUserPool',
          'us-east-1_abc123',
          'AWS::Cognito::UserPool',
          { WebAuthnRelyingPartyID: 'auth.example.com' },
          {}
        );

        const mfaCall = mockSend.mock.calls[1][0];
        expect(mfaCall.constructor.name).toBe('SetUserPoolMfaConfigCommand');
        expect(mfaCall.input.MfaConfiguration).toBe('OFF');
      });

      it('still defaults to OPTIONAL when a real MFA factor is enabled', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:soft' },
        });
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
        });

        const mfaCall = mockSend.mock.calls[1][0];
        expect(mfaCall.input.MfaConfiguration).toBe('OPTIONAL');
        expect(mfaCall.input.SoftwareTokenMfaConfiguration).toEqual({ Enabled: true });
      });

      it('defaults to OPTIONAL when a real factor rides alongside WebAuthn', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:mixed' },
        });
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          // SOFTWARE_TOKEN_MFA, not EMAIL_OTP: an EMAIL_OTP factor also emits
          // EmailMfaConfiguration, so it would satisfy EITHER half of the
          // condition and could not tell them apart.
          EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
          WebAuthnRelyingPartyID: 'auth.example.com',
        });

        const mfaCall = mockSend.mock.calls[1][0];
        expect(mfaCall.input.MfaConfiguration).toBe('OPTIONAL');
      });

      it('lets an explicit OFF win over the OPTIONAL default', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:explicit-off' },
        });
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
          MfaConfiguration: 'OFF',
        });

        const mfaCall = mockSend.mock.calls[1][0];
        expect(mfaCall.input.MfaConfiguration).toBe('OFF');
      });

      // THE regression this fix must not introduce. An unrecognized entry emits
      // no factor block, so keying the default on the RECOGNIZED set would send
      // OFF here -- and AWS ACCEPTS OFF, so the pool would ship with MFA
      // silently disabled and the declared factor dropped. Keying on the
      // REQUESTED set keeps the pre-existing loud failure: OPTIONAL with no
      // factor block is what AWS refuses, naming the problem.
      it('keeps OPTIONAL for an unrecognized EnabledMfas entry so AWS still refuses loudly', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:typo' },
        });
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          EnabledMfas: ['SOFTWARE_TOKEN'], // typo for SOFTWARE_TOKEN_MFA
        });

        const mfaCall = mockSend.mock.calls[1][0];
        expect(mfaCall.input.MfaConfiguration).toBe('OPTIONAL');
        expect(mfaCall.input.SoftwareTokenMfaConfiguration).toBeUndefined();
      });

      it('warns which EnabledMfas entries it does not recognize', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:typo-warn' },
        });
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          EnabledMfas: ['SOFTWARE_TOKEN', 'SOFTWARE_TOKEN_MFA'],
        });

        const warned = childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
        // Quoted, so the closing quote keeps the recognized sibling from
        // matching as a prefix of the unrecognized one.
        expect(warned).toContain('"SOFTWARE_TOKEN"');
        // The recognized sibling must NOT be named as unrecognized.
        expect(warned).not.toContain('"SOFTWARE_TOKEN_MFA"');
      });

      it('does not warn when every EnabledMfas entry is recognized', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:no-warn' },
        });
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          // All three recognized factors, so dropping ANY of them from the
          // recognized set is caught here, not just SMS / software-token.
          EnabledMfas: ['SOFTWARE_TOKEN_MFA', 'SMS_MFA', 'EMAIL_OTP'],
          SmsConfiguration: { SnsCallerArn: 'arn:aws:iam::123456789012:role/sms' },
        });

        const warned = childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
        // Asserted as EMPTY, not as "does not contain <phrase>". A phrase-based
        // negative stops testing anything the moment the message is reworded --
        // which is exactly what happened to the earlier version of this
        // assertion, leaving `if (dropped.length > 0)` unpinned.
        expect(warned).toBe('');
      });

      // The same silent-drop class as the misspelled entry, reached through the
      // SHAPE instead of the spelling: a YAML scalar (or a !Ref to a String
      // parameter) fails Array.isArray, so it used to read as "no factor
      // declared" -> OFF -> ACCEPTED by AWS -> MFA silently disabled.
      it('keeps OPTIONAL when EnabledMfas is a scalar rather than a list', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:scalar' },
        });
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          EnabledMfas: 'SOFTWARE_TOKEN_MFA',
          WebAuthnRelyingPartyID: 'auth.example.com',
        });

        const mfaCall = mockSend.mock.calls[1][0];
        expect(mfaCall.constructor.name).toBe('SetUserPoolMfaConfigCommand');
        expect(mfaCall.input.MfaConfiguration).toBe('OPTIONAL');
        expect(mfaCall.input.SoftwareTokenMfaConfiguration).toBeUndefined();
      });

      it('warns that a non-list EnabledMfas enabled no factor', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:scalar-warn' },
        });
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          EnabledMfas: 'SOFTWARE_TOKEN_MFA',
          WebAuthnRelyingPartyID: 'auth.example.com',
        });

        const warned = childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
        expect(warned).toContain('(not a list)');
        // The message must state the value actually sent. Here nothing forced
        // OFF, so the call stays OPTIONAL and AWS is what refuses it.
        expect(warned).toContain('MfaConfiguration is OPTIONAL');
      });

      // A mis-shaped declaration with no OTHER MFA-routed property must still
      // reach SetUserPoolMfaConfig at all -- otherwise the call is skipped and
      // the factor is dropped in silence, one layer earlier than the default.
      it('still issues SetUserPoolMfaConfig for a scalar EnabledMfas on its own', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:scalar-only' },
        });
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          EnabledMfas: 'SOFTWARE_TOKEN_MFA',
        });

        const mfaCall = mockSend.mock.calls.find(
          (c) => c[0].constructor.name === 'SetUserPoolMfaConfigCommand'
        );
        expect(mfaCall).toBeDefined();
        expect(mfaCall![0].input.MfaConfiguration).toBe('OPTIONAL');
      });

      // The create()-side consequence of counting a mis-shaped declaration as
      // MFA props: MfaConfiguration must stop riding CreateUserPool (AWS
      // rejects ON there before any factor exists) and travel on the
      // SetUserPoolMfaConfig call instead. Nothing pinned this branch before.
      it('keeps an explicit MfaConfiguration off CreateUserPool for a scalar EnabledMfas', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:scalar-on' },
        });
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          EnabledMfas: 'SOFTWARE_TOKEN_MFA',
          MfaConfiguration: 'ON',
        });

        const createCall = mockSend.mock.calls[0][0];
        expect(createCall.constructor.name).toBe('CreateUserPoolCommand');
        expect(createCall.input.MfaConfiguration).toBeUndefined();
        const mfaCall = mockSend.mock.calls[1][0];
        expect(mfaCall.constructor.name).toBe('SetUserPoolMfaConfigCommand');
        expect(mfaCall.input.MfaConfiguration).toBe('ON');
      });

      // The one branch where a dropped factor really does deploy MFA-disabled:
      // the template itself asked for OFF. The warn must say so rather than
      // predicting the rejection that does not happen.
      it('warns that the pool deploys MFA-disabled when an explicit OFF meets a dropped factor', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:scalar-off' },
        });
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          EnabledMfas: 'SOFTWARE_TOKEN_MFA',
          MfaConfiguration: 'OFF',
        });

        const mfaCall = mockSend.mock.calls[1][0];
        expect(mfaCall.input.MfaConfiguration).toBe('OFF');
        const warned = childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
        expect(warned).toContain('deploys with MFA DISABLED');
      });

      // `null` / `''` are absence, not a mis-shaped declaration: neither may
      // fire a spurious SetUserPoolMfaConfig or flip the default to OPTIONAL.
      it('treats a null or empty-string EnabledMfas as absence, not as intent', async () => {
        for (const [arn, value] of [
          ['arn:null-mfa', null],
          ['arn:empty-mfa', ''],
        ] as const) {
          mockSend.mockClear();
          mockSend.mockResolvedValueOnce({ UserPool: { Id: 'us-east-1_abc123', Arn: arn } });
          mockSend.mockResolvedValueOnce({});

          await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
            EnabledMfas: value,
            WebAuthnRelyingPartyID: 'auth.example.com',
          });

          const mfaCall = mockSend.mock.calls[1][0];
          expect(mfaCall.input.MfaConfiguration).toBe('OFF');
        }
      });

      it('issues no SetUserPoolMfaConfig at all for a null EnabledMfas on its own', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:null-only' },
        });

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          EnabledMfas: null,
        });

        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(mockSend.mock.calls[0][0].constructor.name).toBe('CreateUserPoolCommand');
      });

      // The malformed path's JSON quoting was untested: String({Ref:'P'}) is
      // "[object Object]", naming nothing -- and an intrinsic that failed to
      // resolve is the likeliest way to reach this warning at all.
      it('names a non-list EnabledMfas by its JSON shape, not [object Object]', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:obj' },
        });
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          EnabledMfas: { Ref: 'MfaParam' },
          WebAuthnRelyingPartyID: 'auth.example.com',
        });

        const warned = childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
        expect(warned).toContain('{"Ref":"MfaParam"} (not a list)');
        expect(warned).not.toContain('[object Object]');
      });

      // An unrecognized entry ALONGSIDE a working factor: AWS accepts and the
      // entry is silently ignored. The warning must say that rather than
      // predicting a rejection that never comes.
      it('tells the user the call succeeds when a dropped entry rides with a real factor', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:mixed-warn' },
        });
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          EnabledMfas: ['SOFTWARE_TOKEN', 'SOFTWARE_TOKEN_MFA'],
        });

        const mfaCall = mockSend.mock.calls[1][0];
        expect(mfaCall.input.MfaConfiguration).toBe('OPTIONAL');
        expect(mfaCall.input.SoftwareTokenMfaConfiguration).toEqual({ Enabled: true });
        const warned = childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
        expect(warned).toContain('silently ignored');
        expect(warned).not.toContain('AWS rejects');
      });

      it('defaults to OFF for an EMPTY EnabledMfas array alongside WebAuthn', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:empty' },
        });
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          EnabledMfas: [],
          WebAuthnRelyingPartyID: 'auth.example.com',
        });

        const mfaCall = mockSend.mock.calls[1][0];
        expect(mfaCall.input.MfaConfiguration).toBe('OFF');
      });

      it('defaults to OPTIONAL for the SMS factor and carries SmsConfiguration', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:sms' },
        });
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          EnabledMfas: ['SMS_MFA'],
          SmsConfiguration: { SnsCallerArn: 'arn:aws:iam::123456789012:role/sms' },
        });

        const mfaCall = mockSend.mock.calls[1][0];
        expect(mfaCall.input.MfaConfiguration).toBe('OPTIONAL');
        expect(mfaCall.input.SmsMfaConfiguration).toEqual({
          SmsConfiguration: { SnsCallerArn: 'arn:aws:iam::123456789012:role/sms' },
        });
      });

      it('lets an explicit ON win over the OFF default', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:explicit-on' },
        });
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          WebAuthnRelyingPartyID: 'auth.example.com',
          MfaConfiguration: 'ON',
        });

        const mfaCall = mockSend.mock.calls[1][0];
        expect(mfaCall.input.MfaConfiguration).toBe('ON');
      });
    });

    describe('post-create atomicity', () => {
      it('rolls back the pool (DeleteUserPool) when SetUserPoolMfaConfig fails', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:rollback' },
        }); // CreateUserPool
        mockSend.mockRejectedValueOnce(new Error('mfa boom')); // SetUserPoolMfaConfig
        mockSend.mockResolvedValueOnce({}); // DeleteUserPool rollback

        await expect(
          provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
            EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
          })
        ).rejects.toThrow('Failed to create Cognito User Pool MyUserPool');

        expect(mockSend).toHaveBeenCalledTimes(3);
        const rollbackCall = mockSend.mock.calls[2][0];
        expect(rollbackCall.constructor.name).toBe('DeleteUserPoolCommand');
        expect(rollbackCall.input.UserPoolId).toBe('us-east-1_abc123');
      });
    });

    describe('unhandledByDesign', () => {
      it('declares WebAuthnFactorConfiguration as unhandled (no SDK wire path)', () => {
        const map = provider.unhandledByDesign.get('AWS::Cognito::UserPool');
        expect(map?.has('WebAuthnFactorConfiguration')).toBe(true);
      });
    });
  });

  // Auto-mode import resolves a user pool from an explicit `--resource`
  // override or from the template's `UserPoolName` (matched against each
  // pool's Name via a paginated ListUserPools walk). The `aws:cdk:path` tag
  // match that used to ride the same walk is gone (issue #1134): AWS rejects
  // `aws:`-prefixed tag writes, so that tag never exists on a real resource
  // and the walk could not match.
  describe('import (name-based lookup)', () => {
    beforeEach(() => {
      // Drop once-queued responses leaked by earlier tests: clearAllMocks()
      // clears calls but NOT unconsumed mockResolvedValueOnce entries.
      mockSend.mockReset();
    });

    const importInput = (overrides: Record<string, unknown> = {}) => ({
      logicalId: 'MyUserPool',
      resourceType: 'AWS::Cognito::UserPool',
      stackName: 'MyStack',
      region: 'us-east-1',
      properties: {},
      ...overrides,
    });

    it('resolves an explicit --resource override via DescribeUserPool', async () => {
      mockSend.mockResolvedValueOnce({ UserPool: { Id: 'us-east-1_bbb222' } });

      const result = await provider.import(
        importInput({ knownPhysicalId: 'us-east-1_bbb222' })
      );

      expect(result).toEqual({ physicalId: 'us-east-1_bbb222', attributes: {} });
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend.mock.calls[0][0].constructor.name).toBe('DescribeUserPoolCommand');
    });

    it('matches Properties.UserPoolName against each pool Name', async () => {
      mockSend.mockResolvedValueOnce({
        UserPools: [
          { Id: 'us-east-1_aaa111', Name: 'other' },
          { Id: 'us-east-1_bbb222', Name: 'my-pool' },
        ],
      });

      const result = await provider.import(
        importInput({ properties: { UserPoolName: 'my-pool' } })
      );

      expect(result).toEqual({ physicalId: 'us-east-1_bbb222', attributes: {} });
      // List-only: no per-candidate DescribeUserPool / ListTagsForResource.
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend.mock.calls[0][0].constructor.name).toBe('ListUserPoolsCommand');
    });

    it('folds the NextToken across pages until the name matches', async () => {
      mockSend
        .mockResolvedValueOnce({
          UserPools: [{ Id: 'us-east-1_aaa111', Name: 'other' }],
          NextToken: 'page-2',
        })
        .mockResolvedValueOnce({ UserPools: [{ Id: 'us-east-1_bbb222', Name: 'my-pool' }] });

      const result = await provider.import(
        importInput({ properties: { UserPoolName: 'my-pool' } })
      );

      expect(result).toEqual({ physicalId: 'us-east-1_bbb222', attributes: {} });
      expect(mockSend).toHaveBeenCalledTimes(2);
      expect(mockSend.mock.calls[0][0].input.NextToken).toBeUndefined();
      expect(mockSend.mock.calls[1][0].input.NextToken).toBe('page-2');
    });

    it('returns null when no pool name matches', async () => {
      mockSend.mockResolvedValueOnce({
        UserPools: [
          { Id: 'us-east-1_aaa111', Name: 'other' },
          { Id: 'us-east-1_bbb222', Name: 'also-other' },
        ],
      });

      const result = await provider.import(
        importInput({ properties: { UserPoolName: 'my-pool' } })
      );

      expect(result).toBeNull();
    });

    it('returns null without any AWS call when no override and no UserPoolName', async () => {
      const result = await provider.import(importInput());

      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});
