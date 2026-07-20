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

import { ResourceNotFoundException } from '@aws-sdk/client-cognito-identity-provider';
import { CognitoUserPoolProvider } from '../../../src/provisioning/providers/cognito-provider.js';
import { importTagWalkTestHooks } from '../../../src/provisioning/import-tag-walk.js';

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

  // Issue #1091 batch 3: the tag-based import lookup costs TWO reads per
  // candidate (DescribeUserPool for the ARN, then ListTagsForResource) and is
  // routed through the shared importTagWalk helper: a throttled read is
  // retried with backoff (re-running the whole per-candidate callback)
  // instead of aborting the whole import, while a non-throttling error still
  // surfaces immediately. The per-candidate name match rides the same walk as
  // a synthetic tag, checked BEFORE any tag read.
  describe('import tag walk', () => {
    const CDK_PATH = 'MyStack/MyUserPool/Resource';
    const ARN_A = 'arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_aaa111';
    const ARN_B = 'arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_bbb222';

    beforeEach(() => {
      // Drop once-queued responses leaked by earlier tests: clearAllMocks()
      // clears calls but NOT unconsumed mockResolvedValueOnce entries.
      mockSend.mockReset();
      // Skip the walk's real throttle backoff waits.
      importTagWalkTestHooks.sleep = async () => {};
    });
    afterEach(() => {
      importTagWalkTestHooks.sleep = undefined;
    });

    const importInput = (overrides: Record<string, unknown> = {}) => ({
      logicalId: 'MyUserPool',
      resourceType: 'AWS::Cognito::UserPool',
      cdkPath: CDK_PATH,
      stackName: 'MyStack',
      region: 'us-east-1',
      properties: {},
      ...overrides,
    });

    /** AWS-SDK-shaped throttling rejection (HTTP 400 + throttling name). */
    const throttle = (): Error => {
      const err = new Error('Rate exceeded') as Error & { $metadata: { httpStatusCode: number } };
      err.name = 'ThrottlingException';
      err.$metadata = { httpStatusCode: 400 };
      return err;
    };

    it('name match short-circuits without any tag read', async () => {
      // Only the list page is queued: a name-matched candidate must resolve
      // BEFORE its DescribeUserPool / ListTagsForResource reads, even when a
      // cdkPath is also present.
      mockSend.mockResolvedValueOnce({
        UserPools: [{ Id: 'us-east-1_bbb222', Name: 'my-pool' }],
      });

      const result = await provider.import(
        importInput({ properties: { UserPoolName: 'my-pool' } })
      );

      expect(result).toEqual({ physicalId: 'us-east-1_bbb222', attributes: {} });
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend.mock.calls[0][0].constructor.name).toBe('ListUserPoolsCommand');
    });

    it('matches map-shaped aws:cdk:path tags via the walk (happy path)', async () => {
      mockSend
        .mockResolvedValueOnce({
          UserPools: [
            { Id: 'us-east-1_aaa111', Name: 'other' },
            { Id: 'us-east-1_bbb222', Name: 'target' },
          ],
        })
        // Candidate 1: DescribeUserPool for the ARN, tags do not match.
        .mockResolvedValueOnce({ UserPool: { Id: 'us-east-1_aaa111', Arn: ARN_A } })
        .mockResolvedValueOnce({ Tags: { 'aws:cdk:path': 'OtherStack/Other/Resource' } })
        // Candidate 2: DescribeUserPool for the ARN, tags match.
        .mockResolvedValueOnce({ UserPool: { Id: 'us-east-1_bbb222', Arn: ARN_B } })
        .mockResolvedValueOnce({ Tags: { 'aws:cdk:path': CDK_PATH } });

      const result = await provider.import(importInput());

      expect(result).toEqual({ physicalId: 'us-east-1_bbb222', attributes: {} });
      expect(mockSend).toHaveBeenCalledTimes(5);
    });

    it('retries a throttled ListTagsForResource mid-walk and still finds the match', async () => {
      mockSend
        .mockResolvedValueOnce({ UserPools: [{ Id: 'us-east-1_bbb222', Name: 'target' }] })
        // Candidate attempt 1: DescribeUserPool ok, ListTagsForResource throttled.
        .mockResolvedValueOnce({ UserPool: { Id: 'us-east-1_bbb222', Arn: ARN_B } })
        .mockRejectedValueOnce(throttle())
        // Retry re-runs the WHOLE per-candidate callback: DescribeUserPool
        // again, then the tag read succeeds with the match.
        .mockResolvedValueOnce({ UserPool: { Id: 'us-east-1_bbb222', Arn: ARN_B } })
        .mockResolvedValueOnce({ Tags: { 'aws:cdk:path': CDK_PATH } });

      const result = await provider.import(importInput());

      expect(result).toEqual({ physicalId: 'us-east-1_bbb222', attributes: {} });
      expect(mockSend).toHaveBeenCalledTimes(5);
    });

    it('does not retry a non-throttling error during the walk', async () => {
      const denied = new Error(
        'User is not authorized to perform cognito-idp:ListTagsForResource'
      );
      denied.name = 'AccessDeniedException';

      mockSend
        .mockResolvedValueOnce({ UserPools: [{ Id: 'us-east-1_bbb222', Name: 'target' }] })
        .mockResolvedValueOnce({ UserPool: { Id: 'us-east-1_bbb222', Arn: ARN_B } })
        .mockRejectedValueOnce(denied);

      await expect(provider.import(importInput())).rejects.toThrow(/not authorized/);
      expect(mockSend).toHaveBeenCalledTimes(3);
    });
  });
});
