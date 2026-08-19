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
import { ProvisioningError } from '../../../src/utils/error-handler.js';

/**
 * Await a call that MUST reject, and return the Error it rejected with.
 *
 * NOT `provider.create(...).catch((e: unknown) => e as Error)`, which was the
 * first spelling here and was wrong twice over. `Promise<T>.catch(fn)` widens
 * to `Promise<T | ReturnType<fn>>`, so the value typed as
 * `ResourceCreateResult | Error` and every `.message` read was a type error --
 * 20 of them, invisible to `vp run test` (whose `Type Errors` line covers only
 * `*.test-d.ts`) and caught only by `vp run typecheck:test`.
 *
 * The tempting repair -- `as Error`, or widening the annotation -- is the worse
 * one: it makes a call that RESOLVED flow into an assertion about a refusal
 * message, so `expect(error.message).toContain(...)` would fail on a missing
 * property rather than reporting "it did not refuse", and a regression that
 * deleted the pre-flight would surface as a confusing type-shaped failure
 * instead of a clear one. Throwing here keeps every refusal test PROVING the
 * refusal, which is the discriminator those tests exist for.
 */
async function rejectionOf(call: Promise<unknown>): Promise<Error> {
  try {
    await call;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`expected an Error rejection, got ${typeof error}: ${String(error)}`);
  }
  throw new Error('expected the call to REJECT, but it resolved successfully');
}

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
      // Forwarding is what APPLIES a declared value. `previousProperties` here
      // declares no SignInPolicy, so this case ADDS one; dropping it from the
      // request would leave the pool with no sign-in policy at all. It is NOT
      // about omission resetting the field -- measured us-east-1 2026-08-19
      // (issue #1968), an UpdateUserPool omitting SignInPolicy leaves it
      // intact; see `toSdkUserPoolPolicies` in the provider.
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
        // SetUserPoolMfaConfig is a full-replace: MfaConfiguration MUST be set.
        // Measured 2026-08-19 (issue #1968), the two arms differ: omitting it
        // WITH factor blocks in the request makes AWS REJECT the call, and
        // omitting it with none resets the pool to OFF. See the
        // SetUserPoolMfaConfig section of the ledger in
        // `readLiveMfaConfiguration`. Defaults to OPTIONAL when the template
        // omits it but enables factors.
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
        // The undeclared-downgrade pre-read (#1925 item 3) runs first: its gate
        // is a deliberate SUPERSET (no declared MfaConfiguration + some
        // MFA-routed property), so it fires here and its result goes unused.
        mockSend.mockResolvedValueOnce({ MfaConfiguration: 'OFF' }); // GetUserPoolMfaConfig
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

        expect(mockSend).toHaveBeenCalledTimes(4);
        expect(mockSend.mock.calls[0][0].constructor.name).toBe('GetUserPoolMfaConfigCommand');
        expect(mockSend.mock.calls[1][0].constructor.name).toBe('UpdateUserPoolCommand');
        const mfaCall = mockSend.mock.calls[2][0];
        expect(mfaCall.constructor.name).toBe('SetUserPoolMfaConfigCommand');
        expect(mfaCall.input.SoftwareTokenMfaConfiguration).toEqual({ Enabled: true });
        expect(mockSend.mock.calls[3][0].constructor.name).toBe('DescribeUserPoolCommand');
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
        // GetUserPoolMfaConfig: the undeclared-OFF announcement probe (#1925
        // item 3) reads the live value BEFORE UpdateUserPool, defensively --
        // measured, that update does NOT reset MfaConfiguration. OFF here, so
        // nothing is being downgraded and no warning is emitted.
        mockSend.mockResolvedValueOnce({ MfaConfiguration: 'OFF' });
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

        const mfaCall = mockSend.mock.calls[2][0];
        expect(mfaCall.constructor.name).toBe('SetUserPoolMfaConfigCommand');
        expect(mfaCall.input.MfaConfiguration).toBe('OFF');
        // Asserted, not merely claimed in the comment above: a live OFF is not
        // a downgrade, and dropping the live-value test from the announcement
        // condition would warn here (and on every failed probe) with nothing
        // being turned off.
        expect(childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n')).toBe('');
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

      // An explicitly DECLARED value beats the OPTIONAL default. ON rather than
      // OFF: the OFF spelling of this same bag is now refused by the pre-flight
      // (issue #1977), so the declared-beats-default rule is pinned with the
      // other value the default is not — OPTIONAL is what a declared factor
      // defaults to, so ON is a real discriminator here.
      it('lets an explicit ON win over the OPTIONAL default', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:explicit-on' },
        });
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
          MfaConfiguration: 'ON',
        });

        const mfaCall = mockSend.mock.calls[1][0];
        expect(mfaCall.input.MfaConfiguration).toBe('ON');
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
        // Arm 3 of the consequence: nothing else is enabled here, so AWS is
        // what refuses. Asserted so the arm's own text cannot rot unnoticed.
        expect(warned).toContain('AWS rejects');
      });

      // An unrecognized entry ALONGSIDE a working factor: AWS accepts and the
      // entry is silently ignored. The warning must say that rather than
      // predicting a rejection that never comes.
      // Every factor that makes AWS accept, not just software-token: each is a
      // separate disjunct of the sub-block test, and a single-factor case
      // leaves the other two deletable.
      it.each([
        ['SOFTWARE_TOKEN_MFA', {}],
        ['SMS_MFA', { SmsConfiguration: { SnsCallerArn: 'arn:aws:iam::123456789012:role/sms' } }],
        ['EMAIL_OTP', {}],
      ])(
        'warns that a dropped entry did not fail the call when a %s block is also sent',
        async (factor, extra) => {
          mockSend.mockResolvedValueOnce({
            UserPool: { Id: 'us-east-1_abc123', Arn: `arn:mixed-${factor}` },
          });
          mockSend.mockResolvedValueOnce({});

          await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
            EnabledMfas: ['SOFTWARE_TOKEN', factor],
            ...extra,
          });

          const mfaCall = mockSend.mock.calls[1][0];
          expect(mfaCall.input.MfaConfiguration).toBe('OPTIONAL');
          const warned = childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
          expect(warned).toContain('silently ignored');
          // The call is NOT predicted to fail: AWS accepts it and drops the
          // unrecognized entry.
          expect(warned).not.toContain('AWS rejects');
        }
      );

      // The consequence arm that USED to cover this shape ("AWS REJECTS this
      // call outright") is gone: issue #1977 made OFF-plus-a-factor-block a
      // pre-flight refusal, so the dropped-entry warning can no longer be
      // reached with that combination and the arm was unreachable rather than
      // rare. Pinned as the REFUSAL instead, so deleting the pre-flight makes
      // this test fail rather than silently restoring an unreachable message.
      it('refuses before any call when a dropped entry rides beside a factor block under OFF', async () => {
        await expect(
          provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
            EnabledMfas: ['SOFTWARE_TOKEN_MFA', 'NOT_A_FACTOR'],
            MfaConfiguration: 'OFF',
          })
        ).rejects.toThrow('MfaConfiguration is OFF while an MFA factor is configured');

        expect(mockSend).not.toHaveBeenCalled();
      });

      // Pins the `?? String(f)` fallback. A template cannot produce an
      // undefined member, but JSON.stringify(undefined) returns undefined and
      // join() would render it as a gap naming no entry at all.
      it('names an undefined EnabledMfas member instead of leaving a blank gap', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:undef-member' },
        });
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          EnabledMfas: [undefined],
        });

        const warned = childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
        expect(warned).toContain('undefined');
        expect(warned).not.toContain('entries  do not map');
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

    // Issue #1925 item 1. `create()` has always withheld MfaConfiguration from
    // CreateUserPool when a factor is applied post-create; `update()` forwarded
    // it to UpdateUserPool unconditionally, which is the same AWS rejection one
    // call over — and SetUserPoolMfaConfig overwrites the value in the same
    // update anyway, so the forward bought nothing.
    describe('MfaConfiguration gate on UpdateUserPool (#1925)', () => {
      it('withholds MfaConfiguration from UpdateUserPool when an MFA factor is present', async () => {
        mockSend.mockResolvedValueOnce({}); // UpdateUserPool
        mockSend.mockResolvedValueOnce({}); // SetUserPoolMfaConfig
        mockSend.mockResolvedValueOnce({ UserPool: { Arn: 'arn:gate' } }); // DescribeUserPool

        await provider.update(
          'MyUserPool',
          'us-east-1_abc123',
          'AWS::Cognito::UserPool',
          // The enable-MFA-on-update transition: the pool has no factor yet, so
          // UpdateUserPool with OPTIONAL is exactly what AWS refuses.
          { MfaConfiguration: 'OPTIONAL', EnabledMfas: ['SOFTWARE_TOKEN_MFA'] },
          {}
        );

        const updateCall = mockSend.mock.calls[0][0];
        expect(updateCall.constructor.name).toBe('UpdateUserPoolCommand');
        expect(updateCall.input.MfaConfiguration).toBeUndefined();

        // The value is not lost — SetUserPoolMfaConfig owns it, and enables the
        // factor in the same call so AWS accepts it.
        const mfaCall = mockSend.mock.calls[1][0];
        expect(mfaCall.constructor.name).toBe('SetUserPoolMfaConfigCommand');
        expect(mfaCall.input.MfaConfiguration).toBe('OPTIONAL');
        expect(mfaCall.input.SoftwareTokenMfaConfiguration).toEqual({ Enabled: true });
      });

      it('withholds it for a mis-shaped EnabledMfas too (declaresFactor, no factor block)', async () => {
        mockSend.mockResolvedValueOnce({}); // UpdateUserPool
        mockSend.mockResolvedValueOnce({}); // SetUserPoolMfaConfig
        mockSend.mockResolvedValueOnce({ UserPool: { Arn: 'arn:gate-scalar' } }); // DescribeUserPool

        await provider.update(
          'MyUserPool',
          'us-east-1_abc123',
          'AWS::Cognito::UserPool',
          { MfaConfiguration: 'ON', EnabledMfas: 'SOFTWARE_TOKEN_MFA' },
          {}
        );

        // `hasMfaConfigProps` counts a mis-shaped declaration, so the gate must
        // close here too — otherwise the loud SetUserPoolMfaConfig failure is
        // preceded by an UpdateUserPool rejection that names the wrong thing.
        expect(mockSend.mock.calls[0][0].input.MfaConfiguration).toBeUndefined();
        expect(mockSend.mock.calls[1][0].input.MfaConfiguration).toBe('ON');
      });

      // The other polarity: with NO MFA-routed property there is no
      // SetUserPoolMfaConfig call to own the value, so UpdateUserPool must
      // still carry it or the change would be dropped entirely.
      it('still forwards MfaConfiguration to UpdateUserPool when NO MFA factor is present', async () => {
        mockSend.mockResolvedValueOnce({}); // UpdateUserPool
        mockSend.mockResolvedValueOnce({ UserPool: { Arn: 'arn:gate-off' } }); // DescribeUserPool

        await provider.update(
          'MyUserPool',
          'us-east-1_abc123',
          'AWS::Cognito::UserPool',
          { MfaConfiguration: 'OFF' },
          {}
        );

        expect(mockSend).toHaveBeenCalledTimes(2);
        const updateCall = mockSend.mock.calls[0][0];
        expect(updateCall.constructor.name).toBe('UpdateUserPoolCommand');
        expect(updateCall.input.MfaConfiguration).toBe('OFF');
        expect(mockSend.mock.calls[1][0].constructor.name).toBe('DescribeUserPoolCommand');
      });
    });

    // Issue #1925 item 2. The value used to be read as
    // `properties['MfaConfiguration'] as UserPoolMfaType | undefined` and fed
    // to `??` / a truthy gate, so a declared `null` (or an intrinsic that
    // resolved to one) silently took the default — which for a pool declaring
    // no factor is OFF, i.e. MFA DISABLED with nothing said anywhere.
    describe('malformed MfaConfiguration (#1925)', () => {
      it.each([
        ['null', null],
        ['an array', ['OPTIONAL']],
        ['an unresolved intrinsic', { Ref: 'MfaParam' }],
        ['a number', 1],
      ])('refuses %s on a template-path create, before CreateUserPool', async (_label, value) => {
        await expect(
          provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
            MfaConfiguration: value,
          })
        ).rejects.toThrow('AWS::Cognito::UserPool MfaConfiguration must be a non-empty string');

        // Refused BEFORE any AWS call, so there is no half-created pool.
        expect(mockSend).not.toHaveBeenCalled();
      });

      // The guard runs OUTSIDE create()'s try, so the wrapper is hand-written
      // and deleting it would leave a raw Error escaping untyped into the
      // deploy engine's retry loop. Asserting only the message cannot see that.
      it('wraps the refusal as a ProvisioningError, not a bare Error', async () => {
        await expect(
          provider.create('MyUserPool', 'AWS::Cognito::UserPool', { MfaConfiguration: null })
        ).rejects.toBeInstanceOf(ProvisioningError);
      });

      // The hole the guard closes is widest with NO MFA-routed property:
      // `buildMfaConfigRequest` returns undefined before it ever reads
      // MfaConfiguration there, so nothing else in the provider could refuse
      // it and a null silently deployed an SMS-configured pool with MFA off.
      it('refuses a null even when no MFA-routed property is present', async () => {
        await expect(
          provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
            MfaConfiguration: null,
            SmsConfiguration: { SnsCallerArn: 'arn:aws:iam::123456789012:role/sms' },
          })
        ).rejects.toThrow('AWS::Cognito::UserPool MfaConfiguration must be a non-empty string');
        expect(mockSend).not.toHaveBeenCalled();
      });

      // Explicit non-replay. `replayWarn` keys on `replayingState === true`, so
      // only `undefined` and `true` were covered -- a guard rewritten to key on
      // the context's PRESENCE would pass both and silently downgrade an
      // ordinary template-path create to a warning.
      it('still refuses on a create whose context sets replayingState: false', async () => {
        await expect(
          provider.create(
            'MyUserPool',
            'AWS::Cognito::UserPool',
            { MfaConfiguration: null },
            { replayingState: false }
          )
        ).rejects.toBeInstanceOf(ProvisioningError);
        expect(mockSend).not.toHaveBeenCalled();
      });

      // A reverse-replacement rollback creates from a STATE record, which the
      // user cannot edit from the template — so the refusal downgrades to a
      // warning there or the old resource becomes unrestorable.
      it('warns instead of refusing on a state replay, and takes the default', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:replay' },
        }); // CreateUserPool
        mockSend.mockResolvedValueOnce({}); // SetUserPoolMfaConfig

        await provider.create(
          'MyUserPool',
          'AWS::Cognito::UserPool',
          { MfaConfiguration: null, EnabledMfas: ['SOFTWARE_TOKEN_MFA'] },
          { replayingState: true }
        );

        const warned = childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
        expect(warned).toContain('AWS::Cognito::UserPool MfaConfiguration must be a non-empty');

        // Falls back to the factor-aware default rather than sending the junk.
        const mfaCall = mockSend.mock.calls[1][0];
        expect(mfaCall.constructor.name).toBe('SetUserPoolMfaConfigCommand');
        expect(mfaCall.input.MfaConfiguration).toBe('OPTIONAL');
      });

      // `update()` has no context parameter, so it cannot tell a template push
      // from the state-borne bag `drift --revert` / the rollback revert arm
      // hand it. The downgrade is unconditional there.
      it('warns instead of refusing on update, and drops it from UpdateUserPool', async () => {
        mockSend.mockResolvedValueOnce({}); // UpdateUserPool
        mockSend.mockResolvedValueOnce({ UserPool: { Arn: 'arn:upd-null' } }); // DescribeUserPool

        await provider.update(
          'MyUserPool',
          'us-east-1_abc123',
          'AWS::Cognito::UserPool',
          { MfaConfiguration: null },
          {}
        );

        const warned = childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
        expect(warned).toContain('AWS::Cognito::UserPool MfaConfiguration must be a non-empty');
        expect(mockSend.mock.calls[0][0].input.MfaConfiguration).toBeUndefined();
      });

      // A blank string is accepted as absence rather than refused (the guard's
      // blank-fallback rule), but it must NOT reach the wire: the pre-fix `??`
      // treated `''` as a declared value, so SetUserPoolMfaConfig carried an
      // empty MfaConfiguration.
      it('treats an empty-string MfaConfiguration as absent, not as a wire value', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:blank-mfa-config' },
        }); // CreateUserPool
        mockSend.mockResolvedValueOnce({}); // SetUserPoolMfaConfig

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          MfaConfiguration: '',
          EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
        });

        expect(mockSend.mock.calls[0][0].input.MfaConfiguration).toBeUndefined();
        expect(mockSend.mock.calls[1][0].input.MfaConfiguration).toBe('OPTIONAL');
      });

      // The other polarity for the whole guard: a well-formed value is
      // untouched on both paths and no warning is emitted.
      it('passes a well-formed value through silently', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:ok-mfa-config' },
        }); // CreateUserPool only — no MFA-routed property

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          MfaConfiguration: 'OFF',
        });

        expect(mockSend.mock.calls[0][0].input.MfaConfiguration).toBe('OFF');
        expect(childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n')).toBe('');
      });
    });

    // Issue #1925 third item (added by comment). SetUserPoolMfaConfig is a
    // full replace re-issued on every update carrying an MFA-routed property,
    // so a passkey-only template applied to a pool whose live MfaConfiguration
    // is ON / OPTIONAL turns MFA off on the next unrelated change. That is
    // template-is-truth parity and is NOT changed — only announced.
    describe('undeclared downgrade to OFF on update (#1925)', () => {
      it('reads the live value and warns when the update turns MFA off', async () => {
        mockSend.mockResolvedValueOnce({ MfaConfiguration: 'ON' }); // GetUserPoolMfaConfig
        mockSend.mockResolvedValueOnce({}); // UpdateUserPool
        mockSend.mockResolvedValueOnce({}); // SetUserPoolMfaConfig
        mockSend.mockResolvedValueOnce({ UserPool: { Arn: 'arn:downgrade' } }); // DescribeUserPool

        await provider.update(
          'MyUserPool',
          'us-east-1_abc123',
          'AWS::Cognito::UserPool',
          { WebAuthnRelyingPartyID: 'auth.example.com' },
          {}
        );

        // The read must come FIRST -- defensively, NOT because AWS resets the
        // field. Measured us-east-1 2026-08-18: MfaConfiguration survives an
        // UpdateUserPool that omits it (see `readLiveMfaConfiguration`, which
        // carries the ledger of which fields were measured to reset). Reading
        // first is kept because it cannot report a value this same call
        // clobbered, whatever AWS does later; do not re-derive the ordering
        // from the blanket "omitted parameters are reset" doc sentence.
        const getCall = mockSend.mock.calls[0][0];
        expect(getCall.constructor.name).toBe('GetUserPoolMfaConfigCommand');
        expect(getCall.input.UserPoolId).toBe('us-east-1_abc123');
        expect(mockSend.mock.calls[1][0].constructor.name).toBe('UpdateUserPoolCommand');

        const warned = childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
        expect(warned).toContain('the template declares no MfaConfiguration');
        expect(warned).toContain('live value was ON');

        // The request itself is unchanged — this is an announcement, not a fix.
        expect(mockSend.mock.calls[2][0].input.MfaConfiguration).toBe('OFF');
      });

      it('warns for a live OPTIONAL too', async () => {
        mockSend.mockResolvedValueOnce({ MfaConfiguration: 'OPTIONAL' }); // GetUserPoolMfaConfig
        mockSend.mockResolvedValueOnce({}); // UpdateUserPool
        mockSend.mockResolvedValueOnce({}); // SetUserPoolMfaConfig
        mockSend.mockResolvedValueOnce({ UserPool: { Arn: 'arn:downgrade-opt' } }); // Describe

        await provider.update(
          'MyUserPool',
          'us-east-1_abc123',
          'AWS::Cognito::UserPool',
          { WebAuthnRelyingPartyID: 'auth.example.com' },
          {}
        );

        expect(childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
          'live value was OPTIONAL'
        );
      });

      // Silent polarity 1: the template PINNED OFF, so nothing is being
      // defaulted and there is nothing to announce — the probe must not even
      // run, since it costs an AWS call on every such deploy.
      it('does not probe or warn when the template declares MfaConfiguration', async () => {
        mockSend.mockResolvedValueOnce({}); // UpdateUserPool
        mockSend.mockResolvedValueOnce({}); // SetUserPoolMfaConfig
        mockSend.mockResolvedValueOnce({ UserPool: { Arn: 'arn:pinned-off' } }); // Describe

        await provider.update(
          'MyUserPool',
          'us-east-1_abc123',
          'AWS::Cognito::UserPool',
          { WebAuthnRelyingPartyID: 'auth.example.com', MfaConfiguration: 'OFF' },
          {}
        );

        expect(
          mockSend.mock.calls.some((c) => c[0].constructor.name === 'GetUserPoolMfaConfigCommand')
        ).toBe(false);
        expect(childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain(
          'the template declares no MfaConfiguration'
        );
      });

      // Silent polarity 2: on a fresh CREATE there is no live value, so nothing
      // is being downgraded and a warning would fire on every passkey-only
      // deploy — the noise the issue explicitly rules out.
      it('never probes on the create path', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:create-no-probe' },
        }); // CreateUserPool
        mockSend.mockResolvedValueOnce({}); // SetUserPoolMfaConfig

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          WebAuthnRelyingPartyID: 'auth.example.com',
        });

        expect(mockSend).toHaveBeenCalledTimes(2);
        expect(
          mockSend.mock.calls.some((c) => c[0].constructor.name === 'GetUserPoolMfaConfigCommand')
        ).toBe(false);
      });

      // Silent polarity 3: the resolved value is not OFF, so the update is not
      // a downgrade at all. The pre-read's gate is a deliberate SUPERSET, so it
      // DOES probe here — what must stay silent is the warning, decided off the
      // built request. Asserted as "probed but did not warn" rather than "did
      // not probe", because the latter would pin the over-read as if it were
      // the contract.
      it('does not warn when the update enables a factor, even though it probed', async () => {
        mockSend.mockResolvedValueOnce({ MfaConfiguration: 'ON' }); // GetUserPoolMfaConfig
        mockSend.mockResolvedValueOnce({}); // UpdateUserPool
        mockSend.mockResolvedValueOnce({}); // SetUserPoolMfaConfig
        mockSend.mockResolvedValueOnce({ UserPool: { Arn: 'arn:no-downgrade' } }); // Describe

        await provider.update(
          'MyUserPool',
          'us-east-1_abc123',
          'AWS::Cognito::UserPool',
          { EnabledMfas: ['SOFTWARE_TOKEN_MFA'] },
          {}
        );

        // A live ON is primed deliberately: the ONLY thing keeping this silent
        // is the resolved value being OPTIONAL rather than OFF.
        expect(mockSend.mock.calls[2][0].input.MfaConfiguration).toBe('OPTIONAL');
        expect(childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain(
          'the template declares no MfaConfiguration'
        );
      });

      // `declaredMfaConfiguration === ''` covers two different inputs: the
      // template omitted the property, or it declared one the guard REFUSED.
      // The message said "the template declares no MfaConfiguration" for both,
      // which in the second case is simply false and tells the user to add a
      // property they already have.
      it('names the REFUSAL, not a missing declaration, when a declared value was rejected', async () => {
        mockSend.mockResolvedValueOnce({ MfaConfiguration: 'ON' }); // GetUserPoolMfaConfig
        mockSend.mockResolvedValueOnce({}); // UpdateUserPool
        mockSend.mockResolvedValueOnce({}); // SetUserPoolMfaConfig
        mockSend.mockResolvedValueOnce({ UserPool: { Arn: 'arn:refused-announce' } }); // Describe

        await provider.update(
          'MyUserPool',
          'us-east-1_abc123',
          'AWS::Cognito::UserPool',
          // Declared but malformed, alongside a WebAuthn config so the update
          // still routes through SetUserPoolMfaConfig and resolves to OFF.
          { MfaConfiguration: null, WebAuthnRelyingPartyID: 'auth.example.com' },
          {}
        );

        const warned = childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
        // The downgrade is still announced, and still names the live value...
        expect(warned).toContain('live value was ON');
        // ...but attributes it to the refusal, not to a missing declaration.
        expect(warned).toContain('the declared MfaConfiguration was refused as malformed');
        expect(warned).not.toContain('the template declares no MfaConfiguration');
        // The remedy must be "repair it", not "add it".
        expect(warned).toContain('Repair MfaConfiguration');
      });

      // The message is PAST tense ("sent MfaConfiguration=OFF"), so emitting it
      // before the call asserted a state AWS had not reached -- and on a failed
      // SetUserPoolMfaConfig, never would. Ordering is captured at the moment
      // the call runs rather than inferred afterwards, since "both happened"
      // is true in either order and would pin nothing.
      it('announces only AFTER SetUserPoolMfaConfig has landed', async () => {
        let warnCountWhenSetRan = -1;
        mockSend.mockResolvedValueOnce({ MfaConfiguration: 'ON' }); // GetUserPoolMfaConfig
        mockSend.mockResolvedValueOnce({}); // UpdateUserPool
        mockSend.mockImplementationOnce(() => {
          warnCountWhenSetRan = childLogger.warn.mock.calls.length;
          return Promise.resolve({});
        }); // SetUserPoolMfaConfig
        mockSend.mockResolvedValueOnce({ UserPool: { Arn: 'arn:order' } }); // Describe

        await provider.update(
          'MyUserPool',
          'us-east-1_abc123',
          'AWS::Cognito::UserPool',
          { WebAuthnRelyingPartyID: 'auth.example.com' },
          {}
        );

        const announcedAt = childLogger.warn.mock.calls.findIndex((c) =>
          String(c[0]).includes('sent MfaConfiguration=OFF')
        );
        expect(announcedAt).toBeGreaterThanOrEqual(0);
        // Not yet warned when the call ran, so the index must be at or past the
        // count captured inside it.
        expect(warnCountWhenSetRan).toBeGreaterThanOrEqual(0);
        expect(announcedAt).toBeGreaterThanOrEqual(warnCountWhenSetRan);
      });

      // ...and nothing is announced at all when that call FAILS, since the OFF
      // the message describes never landed.
      it('announces nothing when SetUserPoolMfaConfig fails', async () => {
        mockSend.mockResolvedValueOnce({ MfaConfiguration: 'ON' }); // GetUserPoolMfaConfig
        mockSend.mockResolvedValueOnce({}); // UpdateUserPool
        mockSend.mockRejectedValueOnce(new Error('InvalidParameterException')); // Set

        await expect(
          provider.update(
            'MyUserPool',
            'us-east-1_abc123',
            'AWS::Cognito::UserPool',
            { WebAuthnRelyingPartyID: 'auth.example.com' },
            {}
          )
        ).rejects.toThrow();

        expect(childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain(
          'sent MfaConfiguration=OFF'
        );
      });

      // A declared BLANK is neither absent nor refused: the shape guard
      // ACCEPTED it, so there is no "warning above" to refer back to, and the
      // wording that named a refusal was describing a rejection that never
      // happened.
      it('names a BLANK declaration as blank, not as a refusal', async () => {
        mockSend.mockResolvedValueOnce({ MfaConfiguration: 'OPTIONAL' }); // GetUserPoolMfaConfig
        mockSend.mockResolvedValueOnce({}); // UpdateUserPool
        mockSend.mockResolvedValueOnce({}); // SetUserPoolMfaConfig
        mockSend.mockResolvedValueOnce({ UserPool: { Arn: 'arn:blank-announce' } }); // Describe

        await provider.update(
          'MyUserPool',
          'us-east-1_abc123',
          'AWS::Cognito::UserPool',
          { MfaConfiguration: '', WebAuthnRelyingPartyID: 'auth.example.com' },
          {}
        );

        const warned = childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
        expect(warned).toContain('the declared MfaConfiguration is blank');
        expect(warned).not.toContain('was refused as malformed');
        // Still a repair, not an add -- the property exists.
        expect(warned).toContain('Repair MfaConfiguration');
        expect(warned).toContain('live value was OPTIONAL');
      });

      // The other polarity of the same branch: a genuinely ABSENT property
      // must still get the original wording.
      it('names the missing declaration when the template really declared none', async () => {
        mockSend.mockResolvedValueOnce({ MfaConfiguration: 'ON' }); // GetUserPoolMfaConfig
        mockSend.mockResolvedValueOnce({}); // UpdateUserPool
        mockSend.mockResolvedValueOnce({}); // SetUserPoolMfaConfig
        mockSend.mockResolvedValueOnce({ UserPool: { Arn: 'arn:absent-announce' } }); // Describe

        await provider.update(
          'MyUserPool',
          'us-east-1_abc123',
          'AWS::Cognito::UserPool',
          { WebAuthnRelyingPartyID: 'auth.example.com' },
          {}
        );

        const warned = childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
        expect(warned).toContain('the template declares no MfaConfiguration');
        expect(warned).not.toContain('was refused as malformed');
        expect(warned).toContain('Declare MfaConfiguration: ON');
      });

      // The probe exists only to ANNOUNCE, so its failure must not fail the
      // update the user asked for.
      it('is best-effort: a failed probe does not fail the update', async () => {
        mockSend.mockRejectedValueOnce(new Error('AccessDenied')); // GetUserPoolMfaConfig
        mockSend.mockResolvedValueOnce({}); // UpdateUserPool
        mockSend.mockResolvedValueOnce({}); // SetUserPoolMfaConfig
        mockSend.mockResolvedValueOnce({ UserPool: { Arn: 'arn:probe-fail' } }); // Describe

        const result = await provider.update(
          'MyUserPool',
          'us-east-1_abc123',
          'AWS::Cognito::UserPool',
          { WebAuthnRelyingPartyID: 'auth.example.com' },
          {}
        );

        expect(result.physicalId).toBe('us-east-1_abc123');
        expect(mockSend.mock.calls[2][0].constructor.name).toBe('SetUserPoolMfaConfigCommand');
        // An undetermined live value is never reported as a DOWNGRADE -- there
        // is no value to name. Without the live-value test in the announcement
        // condition this warned `live value was undefined` on every probe
        // failure, which on a least-privileged role is every single deploy.
        const warned = childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
        expect(warned).not.toContain('live value was');
        expect(warned).not.toContain('undefined');
      });

      // Item 3. The probe's gate is a deliberate SUPERSET of the announcement
      // condition, so a template that structurally CANNOT downgrade still
      // probes. Warning at the point of failure therefore told a
      // least-privileged role "cdkd cannot say whether it turns MFA off" on
      // every deploy of an EnabledMfas-only template -- which resolves to
      // OPTIONAL and turns nothing off.
      it('stays silent about the failed probe when the request does not resolve to OFF', async () => {
        const denied = new Error('not authorized to perform: cognito-idp:GetUserPoolMfaConfig');
        denied.name = 'AccessDeniedException';
        mockSend.mockRejectedValueOnce(denied); // GetUserPoolMfaConfig
        mockSend.mockResolvedValueOnce({}); // UpdateUserPool
        mockSend.mockResolvedValueOnce({}); // SetUserPoolMfaConfig
        mockSend.mockResolvedValueOnce({ UserPool: { Arn: 'arn:probe-denied-optional' } });

        await provider.update(
          'MyUserPool',
          'us-east-1_abc123',
          'AWS::Cognito::UserPool',
          { EnabledMfas: ['SOFTWARE_TOKEN_MFA'] },
          {}
        );

        expect(mockSend.mock.calls[2][0].input.MfaConfiguration).toBe('OPTIONAL');
        expect(childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n')).toBe('');
      });

      // Item 2 -- the one path this PR made QUIETER than main. A malformed but
      // TRUTHY value used to reach UpdateUserPool, AWS rejected the enum, MFA
      // stayed as it was and the deploy FAILED. Now the guard substitutes and
      // the deploy exits 0 with MFA off; on a role that cannot read the live
      // value the downgrade announcement is suppressed, so without this arm
      // nothing at all names the OFF.
      it('reports the OFF when a declared value was refused and the live value is unreadable', async () => {
        const denied = new Error('not authorized to perform: cognito-idp:GetUserPoolMfaConfig');
        denied.name = 'AccessDeniedException';
        mockSend.mockRejectedValueOnce(denied); // GetUserPoolMfaConfig
        mockSend.mockResolvedValueOnce({}); // UpdateUserPool
        mockSend.mockResolvedValueOnce({}); // SetUserPoolMfaConfig
        mockSend.mockResolvedValueOnce({ UserPool: { Arn: 'arn:quiet-path' } }); // Describe

        await provider.update(
          'MyUserPool',
          'us-east-1_abc123',
          'AWS::Cognito::UserPool',
          { MfaConfiguration: [], WebAuthnRelyingPartyID: 'auth.example.com' },
          {}
        );

        expect(mockSend.mock.calls[2][0].input.MfaConfiguration).toBe('OFF');
        const warned = childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
        expect(warned).toContain('the declared MfaConfiguration could not be used');
        expect(warned).toContain('sent MfaConfiguration=OFF');
        expect(warned).toContain('could not be read');
        expect(warned).toContain('cognito-idp:GetUserPoolMfaConfig');
        // No live value to name, so it must not invent one.
        expect(warned).not.toContain('live value was');
      });

      // The same arm for a genuinely ABSENT declaration: still reported, since
      // the OFF is real either way, but it must not claim a value was declared.
      it('reports the OFF for an absent declaration with an unreadable live value', async () => {
        mockSend.mockRejectedValueOnce(new Error('boom')); // GetUserPoolMfaConfig
        mockSend.mockResolvedValueOnce({}); // UpdateUserPool
        mockSend.mockResolvedValueOnce({}); // SetUserPoolMfaConfig
        mockSend.mockResolvedValueOnce({ UserPool: { Arn: 'arn:quiet-absent' } }); // Describe

        await provider.update(
          'MyUserPool',
          'us-east-1_abc123',
          'AWS::Cognito::UserPool',
          { WebAuthnRelyingPartyID: 'auth.example.com' },
          {}
        );

        const warned = childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
        expect(warned).toContain('the template declares no MfaConfiguration');
        expect(warned).toContain('could not be read');
        expect(warned).not.toContain('could not be used');
      });

      // AWS's raw AccessDenied text names the account, role and session, and
      // this warning is persisted into the deployment-events store -- so it
      // must never reach a default-verbosity line. The raw message stays at
      // debug for --verbose runs.
      it('never puts AWS raw error text in the warning, only in debug', async () => {
        const denied = new Error(
          'User: arn:aws:sts::123456789012:assumed-role/deploy/sess is not authorized to perform: cognito-idp:GetUserPoolMfaConfig'
        );
        denied.name = 'AccessDeniedException';
        mockSend.mockRejectedValueOnce(denied); // GetUserPoolMfaConfig
        mockSend.mockResolvedValueOnce({}); // UpdateUserPool
        mockSend.mockResolvedValueOnce({}); // SetUserPoolMfaConfig
        mockSend.mockResolvedValueOnce({ UserPool: { Arn: 'arn:probe-denied' } }); // Describe

        await provider.update(
          'MyUserPool',
          'us-east-1_abc123',
          'AWS::Cognito::UserPool',
          { WebAuthnRelyingPartyID: 'auth.example.com' },
          {}
        );

        const warned = childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
        expect(warned).not.toContain('assumed-role');
        expect(warned).not.toContain('123456789012');
        const debugged = childLogger.debug.mock.calls.map((c) => String(c[0])).join('\n');
        expect(debugged).toContain('assumed-role');
        expect(debugged).toContain('AccessDeniedException');
      });
    });

    // Issue #1932 item 1. `readEnabledMfas` treats `''` as absence on purpose
    // (counting it as intent would fire a spurious SetUserPoolMfaConfig and
    // turn a working deploy into a hard AWS rejection) — but a mangled Fn::Join
    // or an empty String parameter collapses to exactly this shape, and it was
    // the one mis-shape that produced no message at all.
    describe('empty-string EnabledMfas (#1932)', () => {
      it('warns when another MFA-routed property is present', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:blank-warn' },
        });
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          EnabledMfas: '',
          WebAuthnRelyingPartyID: 'auth.example.com',
        });

        const warned = childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
        expect(warned).toContain('EnabledMfas is an empty string');
        expect(warned).toContain('MfaConfiguration is OFF');
      });

      // Absence must stay absence ON THE WIRE — the warning is the only change.
      it('changes nothing about the request', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:blank-wire' },
        });
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          EnabledMfas: '',
          WebAuthnRelyingPartyID: 'auth.example.com',
        });

        const mfaCall = mockSend.mock.calls[1][0];
        expect(mfaCall.input.MfaConfiguration).toBe('OFF');
        expect(mfaCall.input.SoftwareTokenMfaConfiguration).toBeUndefined();
        expect(mfaCall.input.SmsMfaConfiguration).toBeUndefined();
        expect(mfaCall.input.EmailMfaConfiguration).toBeUndefined();
      });

      it('issues no SetUserPoolMfaConfig, and no warning, for a blank EnabledMfas on its own', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:blank-only' },
        });

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          EnabledMfas: '',
        });

        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n')).toBe('');
      });

      // The two shapes the warning must NOT fire on. `null` is an explicit
      // "nothing" (the resolver deletes AWS::NoValue keys rather than emitting
      // null), and `[]` is a legitimately empty list that `readCurrentState`
      // emits on every no-drift round-trip of an MFA-less pool.
      it.each([
        ['null', null],
        ['an empty array', []],
      ])('stays silent for %s', async (_label, value) => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:blank-negative' },
        });
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          EnabledMfas: value,
          WebAuthnRelyingPartyID: 'auth.example.com',
        });

        expect(childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain(
          'EnabledMfas is an empty string'
        );
      });
    });

    // Issue #1932 item 2 became a PRE-FLIGHT REFUSAL in issue #1977. MEASURED
    // 2026-08-19 (issue #1968): AWS rejects OFF alongside a factor block 100%
    // of the time, including `SoftwareTokenMfaConfiguration {Enabled: false}` --
    // so the warning that used to fire here could only ever be followed by a
    // failure, and on the UPDATE path by a PARTIAL APPLY (UpdateUserPool has
    // already landed when SetUserPoolMfaConfig is refused). The refusal
    // replaces the warning rather than sitting beside it.
    describe('a declared factor pinned to MfaConfiguration OFF (#1932 / #1977)', () => {
      it('refuses on the create path before any AWS call', async () => {
        await expect(
          provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
            EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
            MfaConfiguration: 'OFF',
          })
        ).rejects.toThrow(ProvisioningError);

        // The DISCRIMINATOR is that nothing was sent -- not merely that the
        // call threw. Before the pre-flight this bag reached CreateUserPool and
        // SetUserPoolMfaConfig, and only the latter failed.
        expect(mockSend).not.toHaveBeenCalled();
      });

      it('names MfaConfiguration, the factor block and the remedy', async () => {
        const error = await rejectionOf(
          provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
            EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
            MfaConfiguration: 'OFF',
          })
        );

        expect(error.message).toContain('MfaConfiguration is OFF');
        expect(error.message).toContain('SoftwareTokenMfaConfiguration');
        expect(error.message).toContain('EnabledMfas');
        // The AWS wording is quoted so a user searching for it lands here.
        expect(error.message).toContain(
          "Invalid MFA configuration given, can't turn off MFA and configure an MFA together"
        );
        // Actionable, leading with the remedy that KEEPS MFA on; the
        // MFA-disabling alternative is demoted to a parenthetical.
        expect(error.message).toContain('Set MfaConfiguration to ON or OPTIONAL');
        expect(error.message).toContain('If MFA is genuinely not wanted');
        // The superseded WARNING must not also fire.
        expect(childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain(
          'MfaConfiguration is pinned to OFF'
        );
        // The seam sits OUTSIDE create()'s try, so the refusal is NOT re-worded
        // as an AWS creation failure. `toContain` assertions all survive that
        // re-wrap, so without this negative the placement is unfenced.
        expect(error.message).not.toContain('Failed to create Cognito User Pool');
      });

      // The `SmsMfaConfiguration` arm of the named-block list. SMS_MFA emits a
      // block of its own, so an implementation that enumerated only the
      // software-token and email blocks would refuse this bag with a message
      // naming NO block at all.
      it('names SmsMfaConfiguration when the OFF-pinned factor is SMS_MFA', async () => {
        const error = await rejectionOf(
          provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
            EnabledMfas: ['SMS_MFA'],
            SmsConfiguration: { SnsCallerArn: 'arn:aws:iam::123456789012:role/sms' },
            MfaConfiguration: 'OFF',
          })
        );

        expect(error.message).toContain('SmsMfaConfiguration');
        expect(mockSend).not.toHaveBeenCalled();
      });

      // Silent polarity 3, and the reason this warn is keyed on the emitted
      // BLOCK rather than on `declaresFactor`: a mis-shaped EnabledMfas also
      // sets `declaresFactor`, so the wider condition fired here alongside the
      // dropped-entry warning and CONTRADICTED it -- that one correctly reports
      // the entry as enabling nothing, while this one would claim a factor is
      // configured. #1932 item 2 scopes this arm to a RECOGNIZED factor.
      it('stays silent for a MIS-SHAPED EnabledMfas pinned to OFF, leaving the dropped-entry warn to speak', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:malformed-off' },
        });
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          EnabledMfas: 'SOFTWARE_TOKEN_MFA', // a scalar, not a list
          MfaConfiguration: 'OFF',
        });

        const warned = childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
        expect(warned).not.toContain('MfaConfiguration is pinned to OFF');
        // The dropped-entry warning still covers this shape, and says the
        // accurate thing: nothing was enabled from it.
        expect(warned).toContain('(not a list)');
        expect(warned).toContain('deploys with MFA DISABLED');
      });

      // The second disjunct: a factor SUB-BLOCK with no EnabledMfas at all.
      // EmailAuthenticationMessage alone emits EmailMfaConfiguration, which is
      // the one block `declaresFactor` does not already imply, so this is the
      // arm a `declaresFactor`-keyed pre-flight would miss entirely.
      it('refuses an emitted factor block with no EnabledMfas', async () => {
        const error = await rejectionOf(
          provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
            EmailAuthenticationMessage: 'Your code is {####}',
            MfaConfiguration: 'OFF',
          })
        );

        expect(error.message).toContain('MfaConfiguration is OFF');
        expect(error.message).toContain('EmailMfaConfiguration');
        expect(mockSend).not.toHaveBeenCalled();
      });

      // The UPDATE path is the one the refusal exists for: without it
      // `UpdateUserPool` lands FIRST and only the follow-up
      // `SetUserPoolMfaConfig` is refused, leaving a partial apply behind.
      it('refuses on the update path before UpdateUserPool is sent', async () => {
        const error = await rejectionOf(
          provider.update(
            'MyUserPool',
            'us-east-1_abc123',
            'AWS::Cognito::UserPool',
            { EnabledMfas: ['SOFTWARE_TOKEN_MFA'], MfaConfiguration: 'OFF' },
            {}
          )
        );

        expect(error).toBeInstanceOf(ProvisioningError);
        expect(error.message).toContain('MfaConfiguration is OFF');
        // The DISCRIMINATOR: UpdateUserPool never went out, so there is no
        // half-applied update to unwind. `not.toHaveBeenCalled` rather than a
        // per-command check because it is the strongest available statement and
        // the cheapest to keep true.
        //
        // It does NOT, on its own, prove the pre-flight precedes the
        // `GetUserPoolMfaConfig` probe: that probe is gated on a BLANK declared
        // MfaConfiguration, and neither refusal can fire on a blank one (a
        // blank resolves to OPTIONAL or OFF-with-no-block, never to OFF-with-a-
        // block nor to ON). The two conditions are mutually exclusive, so the
        // ordering against the probe is unobservable; what IS pinned, and what
        // matters, is the ordering against the mutating call.
        expect(mockSend).not.toHaveBeenCalled();
      });

      // MUST-STILL-DEPLOY 1: the same factor with no OFF pin. The default is
      // OPTIONAL, which AWS ACCEPTS (the 2026-08-19 control), so an over-broad
      // rule keyed on the factor block ALONE would break this working template.
      it('still deploys, silently, when MfaConfiguration is not OFF', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:not-pinned' },
        });
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
        });

        expect(mockSend.mock.calls[1][0].constructor.name).toBe('SetUserPoolMfaConfigCommand');
        expect(mockSend.mock.calls[1][0].input.MfaConfiguration).toBe('OPTIONAL');
        expect(childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n')).toBe('');
      });

      // MUST-STILL-DEPLOY 2: OFF with NO factor asked for. WebAuthn is not an
      // MFA factor and emits no factor block, so the passkey-only pool — the
      // shape #1920 made OFF the default for — must keep deploying. A rule
      // keyed on "MfaConfiguration is OFF and SetUserPoolMfaConfig runs" rather
      // than on the FACTOR BLOCK would refuse every passkey-only pool.
      it('still deploys a passkey-only pool, where OFF is correct', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:passkey-only' },
        });
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          WebAuthnRelyingPartyID: 'auth.example.com',
          MfaConfiguration: 'OFF',
        });

        expect(mockSend.mock.calls[1][0].input).toEqual({
          UserPoolId: 'us-east-1_abc123',
          MfaConfiguration: 'OFF',
          WebAuthnConfiguration: { RelyingPartyId: 'auth.example.com' },
        });
        expect(childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n')).toBe('');
      });
    });

    // Issue #1975. `Policies.SignInPolicy.AllowedFirstAuthFactors` allowing a
    // passwordless first-auth factor next to `MfaConfiguration: ON` is refused
    // by AWS with `Only PASSWORD and WEB_AUTHN (if configured) can be enabled
    // as an auth factor if MFA is enabled` (measured us-east-1, 2026-08-19).
    // CREATE was already loud (the `createdUserPoolId` catch deletes the pool);
    // UPDATE partial-applied, because `UpdateUserPool` carries the new
    // SignInPolicy and lands BEFORE `SetUserPoolMfaConfig` is refused -- so the
    // pool ended up with the LOOSENED sign-in policy and the OLD MFA state.
    describe('EMAIL_OTP sign-in factor beside MfaConfiguration ON (#1975)', () => {
      const emailOtpPolicies = {
        SignInPolicy: { AllowedFirstAuthFactors: ['PASSWORD', 'EMAIL_OTP'] },
      };

      it('refuses an EMAIL_OTP sign-in factor on the create path before any AWS call', async () => {
        await expect(
          provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
            Policies: emailOtpPolicies,
            EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
            MfaConfiguration: 'ON',
          })
        ).rejects.toThrow(ProvisioningError);

        expect(mockSend).not.toHaveBeenCalled();
      });

      it('refuses an EMAIL_OTP sign-in factor on the update path before UpdateUserPool is sent', async () => {
        const error = await rejectionOf(
          provider.update(
            'MyUserPool',
            'us-east-1_abc123',
            'AWS::Cognito::UserPool',
            {
              Policies: emailOtpPolicies,
              EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
              MfaConfiguration: 'ON',
            },
            { Policies: { SignInPolicy: { AllowedFirstAuthFactors: ['PASSWORD'] } } }
          )
        );

        expect(error).toBeInstanceOf(ProvisioningError);
        // The DISCRIMINATOR: the sign-in policy never reached AWS, so there is
        // no half-applied update to unwind.
        expect(mockSend).not.toHaveBeenCalled();
      });

      it('names MfaConfiguration, AllowedFirstAuthFactors and the remedy', async () => {
        const error = await rejectionOf(
          provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
            Policies: emailOtpPolicies,
            EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
            MfaConfiguration: 'ON',
          })
        );

        expect(error.message).toContain('MfaConfiguration is ON');
        expect(error.message).toContain(
          'Policies.SignInPolicy.AllowedFirstAuthFactors allows EMAIL_OTP'
        );
        expect(error.message).toContain(
          'Only PASSWORD and WEB_AUTHN (if configured) can be enabled as an auth factor if MFA is enabled'
        );
        // The MFA-WEAKENING remedy is demoted to a parenthetical rather than
        // offered as a co-equal option: this is an authentication surface, so
        // the first thing named must be the one that keeps MFA on.
        expect(error.message).toContain(
          'Remove EMAIL_OTP from Policies.SignInPolicy.AllowedFirstAuthFactors, leaving PASSWORD'
        );
        expect(error.message).toContain(
          '(Setting MfaConfiguration to OPTIONAL or OFF also clears the conflict, but weakens MFA.)'
        );
        // The remedy must NOT hold out WEB_AUTHN as the escape hatch, even
        // though AWS's own quoted error text names it as accepted. MEASURED
        // us-east-1 2026-08-20: WEB_AUTHN as a first auth factor is ALSO
        // rejected under MfaConfiguration ON unless
        // WebAuthnConfiguration.FactorConfiguration is
        // MULTI_FACTOR_WITH_USER_VERIFICATION -- a field the pinned SDK
        // (3.1018.0) cannot send, so cdkd cannot reach that shape. Advice a
        // user cannot follow is worse than no advice, and only the QUOTE may
        // mention WEB_AUTHN.
        const remedy = error.message.slice(error.message.indexOf('Remove EMAIL_OTP'));
        expect(remedy).not.toContain('WEB_AUTHN');
        // The pre-flight refusal must NOT be re-wrapped by create()'s catch,
        // which would re-word it as an AWS creation failure. Nothing else in
        // this suite holds that -- every other assertion is `toContain`, which
        // survives the re-wrap -- so the seam's placement OUTSIDE the try is
        // pinned here.
        expect(error.message).not.toContain('Failed to create Cognito User Pool');
      });

      // The rule is written from the enum, not from EMAIL_OTP alone: AWS's own
      // message enumerates the ACCEPTED set, and SMS_OTP is the only other
      // member of `AuthFactorType` outside it. MEASURED us-east-1 2026-08-19 on
      // a pool WITH a valid SmsConfiguration -- without one, CreateUserPool
      // refuses the factor first with a different error.
      it('refuses SMS_OTP the same way', async () => {
        const error = await rejectionOf(
          provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
            Policies: { SignInPolicy: { AllowedFirstAuthFactors: ['PASSWORD', 'SMS_OTP'] } },
            EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
            MfaConfiguration: 'ON',
          })
        );

        expect(error.message).toContain('allows SMS_OTP');
        expect(mockSend).not.toHaveBeenCalled();
      });

      // Both deny-list members in one policy, so the `offending.join(', ')`
      // rendering is exercised rather than only its single-element form. A
      // one-member-only implementation would name just the first.
      it('names BOTH offending factors when a policy carries both', async () => {
        const error = await rejectionOf(
          provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
            Policies: {
              SignInPolicy: { AllowedFirstAuthFactors: ['PASSWORD', 'EMAIL_OTP', 'SMS_OTP'] },
            },
            EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
            MfaConfiguration: 'ON',
          })
        );

        expect(error.message).toContain('allows EMAIL_OTP, SMS_OTP');
        expect(error.message).toContain('Remove EMAIL_OTP, SMS_OTP from');
        expect(mockSend).not.toHaveBeenCalled();
      });

      // THE SCOPE LIMIT, and the over-refusal it prevents. With no MFA-routed
      // property there is no SetUserPoolMfaConfig call, so MfaConfiguration
      // rides on the SINGLE CreateUserPool / UpdateUserPool call -- nothing can
      // be PARTLY applied, which is the whole harm this pre-flight exists to
      // prevent. MEASURED us-east-1 2026-08-19: AWS ACCEPTS a pool created with
      // AllowedFirstAuthFactors [PASSWORD, EMAIL_OTP] and no MFA config call.
      // Refusing here would block a working hand-written template.
      it('still deploys EMAIL_OTP + ON when no SetUserPoolMfaConfig is sent', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:no-mfa-call' },
        });

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          Policies: emailOtpPolicies,
          MfaConfiguration: 'ON',
        });

        // ONE call, and it carries MfaConfiguration itself -- the discriminator
        // for "no second call to be refused after the first one lands".
        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(mockSend.mock.calls[0][0].constructor.name).toBe('CreateUserPoolCommand');
        expect(mockSend.mock.calls[0][0].input.MfaConfiguration).toBe('ON');
      });

      // The UPDATE twin of the scope limit: same single-call shape, and the
      // path where a partial apply would otherwise be possible.
      it('still updates EMAIL_OTP + ON when no SetUserPoolMfaConfig is sent', async () => {
        mockSend.mockResolvedValueOnce({}); // UpdateUserPool
        mockSend.mockResolvedValueOnce({ UserPool: { Arn: 'arn:no-mfa-call-upd' } }); // Describe

        await provider.update(
          'MyUserPool',
          'us-east-1_abc123',
          'AWS::Cognito::UserPool',
          { Policies: emailOtpPolicies, MfaConfiguration: 'ON' },
          {}
        );

        expect(mockSend).toHaveBeenCalledTimes(2);
        expect(mockSend.mock.calls[0][0].constructor.name).toBe('UpdateUserPoolCommand');
        expect(mockSend.mock.calls[0][0].input.MfaConfiguration).toBe('ON');
      });

      // MUST-STILL-DEPLOY 1: the accepted pair. This is the exact combination
      // the AWS message names as allowed, so refusing it would block a working
      // passkey-plus-MFA template.
      it('still deploys PASSWORD + WEB_AUTHN under MfaConfiguration ON', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:allowed-factors' },
        });
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          Policies: { SignInPolicy: { AllowedFirstAuthFactors: ['PASSWORD', 'WEB_AUTHN'] } },
          EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
          MfaConfiguration: 'ON',
        });

        expect(mockSend.mock.calls[0][0].input.Policies).toEqual({
          SignInPolicy: { AllowedFirstAuthFactors: ['PASSWORD', 'WEB_AUTHN'] },
        });
        expect(mockSend.mock.calls[1][0].input.MfaConfiguration).toBe('ON');
      });

      // MUST-STILL-DEPLOY 2: EMAIL_OTP with MFA OFF. Nothing about the sign-in
      // policy is wrong on its own -- passwordless email OTP is exactly what
      // the property is for -- so the refusal must be about the COMBINATION.
      it('still deploys EMAIL_OTP when MfaConfiguration is OFF', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:email-otp-off' },
        });

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          Policies: emailOtpPolicies,
          MfaConfiguration: 'OFF',
        });

        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(mockSend.mock.calls[0][0].input.MfaConfiguration).toBe('OFF');
      });

      // MUST-STILL-DEPLOY 3, and the reason the rule is NOT `!== 'OFF'`:
      // OPTIONAL is UNMEASURED. Whether AWS reads it as "MFA is enabled" for
      // this check was never probed, and refusing a combination AWS accepts
      // blocks a working deploy, while missing one only leaves the pre-#1975
      // behaviour in place. Widening the rule to OPTIONAL requires a probe --
      // this case is what makes that a deliberate change rather than a drift.
      it('still deploys EMAIL_OTP under OPTIONAL, which is UNMEASURED', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:email-otp-optional' },
        });
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          Policies: emailOtpPolicies,
          EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
          MfaConfiguration: 'OPTIONAL',
        });

        expect(mockSend.mock.calls[1][0].input.MfaConfiguration).toBe('OPTIONAL');
      });

      // MUST-STILL-DEPLOY 4, and the ONLY case that discriminates the DENY-list
      // from the allow-list the AWS message states: a factor AWS adds after
      // this code was written. Written from the allow-list, cdkd would refuse
      // it on the day it starts working -- the same reason the
      // unrecognized-EnabledMfas case warns rather than throws. Written from
      // the deny-list, it is simply not pre-flighted, which is the pre-#1975
      // behaviour (a loud AWS rejection) rather than a regression.
      it('still deploys a factor cdkd does not know, rather than assuming the allow-list', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:future-factor' },
        });

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          Policies: {
            SignInPolicy: { AllowedFirstAuthFactors: ['PASSWORD', 'FUTURE_AWS_FACTOR'] },
          },
          MfaConfiguration: 'ON',
        });

        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(mockSend.mock.calls[0][0].constructor.name).toBe('CreateUserPoolCommand');
      });

      // MUST-STILL-DEPLOY 5: an unresolved / mis-shaped SignInPolicy is AWS's
      // to reject, with its own message. Guessing at a container cdkd cannot
      // read would block a deploy over a value it never understood.
      it.each([
        ['a scalar Policies', { Policies: 'PASSWORD,EMAIL_OTP' }],
        ['a scalar SignInPolicy', { Policies: { SignInPolicy: 'EMAIL_OTP' } }],
        [
          'a scalar AllowedFirstAuthFactors',
          { Policies: { SignInPolicy: { AllowedFirstAuthFactors: 'EMAIL_OTP' } } },
        ],
        [
          'an intrinsic-valued member',
          { Policies: { SignInPolicy: { AllowedFirstAuthFactors: [{ Ref: 'Factor' }] } } },
        ],
        ['a null Policies', { Policies: null }],
        ['a null SignInPolicy', { Policies: { SignInPolicy: null } }],
        // A NESTED-list member (a collapsed Fn::Split, a hand-written YAML
        // nesting slip). It is the one mis-shape a `String(member)` read would
        // silently normalize INTO a refusal -- `String(['EMAIL_OTP'])` is
        // `'EMAIL_OTP'` -- so it is what fences the string filter.
        [
          'a nested-list member',
          { Policies: { SignInPolicy: { AllowedFirstAuthFactors: [['EMAIL_OTP']] } } },
        ],
      ])('still deploys with %s', async (_label, extra) => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:malformed-signin' },
        });
        mockSend.mockResolvedValueOnce({}); // SetUserPoolMfaConfig

        // `EnabledMfas` is REQUIRED here, not incidental: rule 2 fires only
        // when a SetUserPoolMfaConfig request is actually BUILT, so without an
        // MFA-routed property these bags never reach `readAllowedFirstAuthFactors`
        // at all and every shape guard in it would be unfenced. Measured --
        // deleting the `Array.isArray` gate left this whole block GREEN until
        // the factor was added.
        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          ...(extra as Record<string, unknown>),
          EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
          MfaConfiguration: 'ON',
        });

        expect(mockSend).toHaveBeenCalledTimes(2);
        expect(mockSend.mock.calls[0][0].constructor.name).toBe('CreateUserPoolCommand');
        expect(mockSend.mock.calls[1][0].constructor.name).toBe('SetUserPoolMfaConfigCommand');
        expect(mockSend.mock.calls[1][0].input.MfaConfiguration).toBe('ON');
      });
    });

    // Issue #1925 item 2, review round 2. `requireConfigString` accepts ANY
    // string against a blank fallback, so `''` cleared the shape guard and was
    // then substituted by the OPTIONAL/OFF default downstream -- the silent
    // default the guard exists to kill, reached one shape further in.
    describe('blank-string MfaConfiguration (#1925)', () => {
      it('warns for a WebAuthn-only pool, which used to fail LOUDLY at AWS', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:blank-cfg-warn' },
        });
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          MfaConfiguration: '',
          WebAuthnRelyingPartyID: 'auth.example.com',
        });

        expect(childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
          'MfaConfiguration is an empty string'
        );
      });

      // The security-relevant shape: `''` meaning ON silently becomes OPTIONAL.
      it('warns when a blank value downgrades a declared factor to the OPTIONAL default', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:blank-cfg-factor' },
        });
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          MfaConfiguration: '',
          EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
        });

        expect(childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
          'MfaConfiguration is an empty string'
        );
        // Wire behavior is unchanged -- the blank stays absence, so the default
        // applies exactly as before. Only the silence is removed.
        expect(mockSend.mock.calls[1][0].input.MfaConfiguration).toBe('OPTIONAL');
      });

      it('warns on the update path too', async () => {
        mockSend.mockResolvedValueOnce({}); // UpdateUserPool
        mockSend.mockResolvedValueOnce({ UserPool: { Arn: 'arn:blank-cfg-upd' } }); // Describe

        await provider.update(
          'MyUserPool',
          'us-east-1_abc123',
          'AWS::Cognito::UserPool',
          { MfaConfiguration: '' },
          {}
        );

        expect(childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
          'MfaConfiguration is an empty string'
        );
      });

      // BOTH spellings must reach the SAME wire value, which is the half that
      // was wrong: `requireConfigString` short-circuits on a blank fallback and
      // returns any string verbatim, so `'   '` was truthy, rode the
      // `if (mfaConfiguration && ...)` gates onto Create/UpdateUserPool and the
      // `|| default` onto SetUserPoolMfaConfig, and AWS rejected the enum --
      // while this very warning promised the default had been applied. Testing
      // only the warning passed over the wrong wire value.
      it.each([
        ['an empty string', ''],
        ['a whitespace-only string', '   '],
        ['a tab', '\t'],
      ])('warns for %s AND sends the default, not the blank, to AWS', async (_label, value) => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:blank-cfg-wire' },
        });
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          MfaConfiguration: value,
          WebAuthnRelyingPartyID: 'auth.example.com',
        });

        expect(childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
          'MfaConfiguration is an empty string'
        );
        // The default -- NOT the blank the template wrote.
        const mfaCall = mockSend.mock.calls[1][0];
        expect(mfaCall.constructor.name).toBe('SetUserPoolMfaConfigCommand');
        expect(mfaCall.input.MfaConfiguration).toBe('OFF');
      });

      // The forward onto Create/UpdateUserPool is the OTHER wire path a blank
      // could ride, reached when no MFA-routed property is present.
      it.each([
        ['an empty string', ''],
        ['a whitespace-only string', '   '],
      ])('keeps %s off CreateUserPool entirely', async (_label, value) => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:blank-cfg-create' },
        });

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          MfaConfiguration: value,
          UserPoolName: 'plain',
        });

        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(mockSend.mock.calls[0][0].input.MfaConfiguration).toBeUndefined();
      });

      it('keeps a whitespace-only value off UpdateUserPool too', async () => {
        mockSend.mockResolvedValueOnce({}); // UpdateUserPool
        mockSend.mockResolvedValueOnce({ UserPool: { Arn: 'arn:blank-cfg-upd-ws' } }); // Describe

        await provider.update(
          'MyUserPool',
          'us-east-1_abc123',
          'AWS::Cognito::UserPool',
          { MfaConfiguration: '   ' },
          {}
        );

        expect(mockSend.mock.calls[0][0].constructor.name).toBe('UpdateUserPoolCommand');
        expect(mockSend.mock.calls[0][0].input.MfaConfiguration).toBeUndefined();
      });

      // The diff side must fold identically, or state and template narrow to
      // different values and the phantom drift comes back through the twin.
      it('folds a whitespace-only value the same way on the diff side', () => {
        expect(
          provider.canonicalizeDesiredProperties('AWS::Cognito::UserPool', {
            MfaConfiguration: '   ',
            WebAuthnRelyingPartyID: 'auth.example.com',
          })['MfaConfiguration']
        ).toBe('OFF');
      });

      // Silent polarity: a well-formed value, and an ABSENT one, must not warn.
      it.each([
        ['a well-formed value', { MfaConfiguration: 'OFF' } as Record<string, unknown>],
        ['an absent value', {} as Record<string, unknown>],
      ])('stays silent for %s', async (_label, extra) => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:blank-cfg-negative' },
        });

        await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          UserPoolName: 'plain',
          ...extra,
        });

        expect(childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain(
          'MfaConfiguration is an empty string'
        );
      });
    });

    // Issue #1925 item 2, review round 2. Every substitution arm sends a value
    // the template did not declare, so without reporting it state recorded the
    // declared `null` / `''` while AWS held OPTIONAL / OFF -- permanent phantom
    // drift that `cdkd drift --revert` re-issues forever with nothing to apply.
    describe('effectiveProperties for a substituted MfaConfiguration (#1925)', () => {
      it('records the sent value on the replay-CREATE downgrade arm', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:eff-replay' },
        });
        mockSend.mockResolvedValueOnce({});

        const result = await provider.create(
          'MyUserPool',
          'AWS::Cognito::UserPool',
          { MfaConfiguration: null, EnabledMfas: ['SOFTWARE_TOKEN_MFA'] },
          { replayingState: true }
        );

        // The value on the wire, not the `null` the state record carried.
        const sent = mockSend.mock.calls[1][0].input.MfaConfiguration;
        expect(sent).toBe('OPTIONAL');
        expect(result.effectiveProperties?.['MfaConfiguration']).toBe(sent);
        // A COMPLETE replacement, not a patch: sibling keys must survive.
        expect(result.effectiveProperties?.['EnabledMfas']).toEqual(['SOFTWARE_TOKEN_MFA']);
      });

      it('records the sent value on the update warn-and-default arm', async () => {
        // A REFUSED value reads as `''`, which together with the MFA-routed
        // EnabledMfas satisfies the announcement pre-read's superset gate, so
        // the probe runs first here.
        mockSend.mockResolvedValueOnce({ MfaConfiguration: 'OFF' }); // GetUserPoolMfaConfig
        mockSend.mockResolvedValueOnce({}); // UpdateUserPool
        mockSend.mockResolvedValueOnce({}); // SetUserPoolMfaConfig
        mockSend.mockResolvedValueOnce({ UserPool: { Arn: 'arn:eff-upd' } }); // Describe

        const result = await provider.update(
          'MyUserPool',
          'us-east-1_abc123',
          'AWS::Cognito::UserPool',
          { MfaConfiguration: null, EnabledMfas: ['SOFTWARE_TOKEN_MFA'] },
          {}
        );

        const sent = mockSend.mock.calls[2][0].input.MfaConfiguration;
        expect(sent).toBe('OPTIONAL');
        expect(result.effectiveProperties?.['MfaConfiguration']).toBe(sent);
      });

      it('records the sent value on the blank-string arm', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:eff-blank' },
        });
        mockSend.mockResolvedValueOnce({});

        const result = await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          MfaConfiguration: '',
          WebAuthnRelyingPartyID: 'auth.example.com',
        });

        const sent = mockSend.mock.calls[1][0].input.MfaConfiguration;
        expect(sent).toBe('OFF');
        expect(result.effectiveProperties?.['MfaConfiguration']).toBe(sent);
      });

      // Nothing carries the field here, so recording a value AWS was never told
      // would be a different lie. The key is DROPPED instead.
      it('drops the key when a blank value means nothing is sent at all', async () => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:eff-blank-nosend' },
        });

        const result = await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
          MfaConfiguration: '',
          UserPoolName: 'plain',
        });

        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(mockSend.mock.calls[0][0].input.MfaConfiguration).toBeUndefined();
        expect(result.effectiveProperties).toBeDefined();
        expect('MfaConfiguration' in result.effectiveProperties!).toBe(false);
        expect(result.effectiveProperties?.['UserPoolName']).toBe('plain');
      });

      // The other polarity: nothing was substituted, so nothing is reported --
      // an unconditional report would replace the desired bag on every deploy.
      it.each([
        ['a well-formed value', { MfaConfiguration: 'ON', EnabledMfas: ['SOFTWARE_TOKEN_MFA'] }],
        ['an absent value', { EnabledMfas: ['SOFTWARE_TOKEN_MFA'] }],
      ])('reports nothing for %s', async (_label, props) => {
        mockSend.mockResolvedValueOnce({
          UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:eff-none' },
        });
        mockSend.mockResolvedValueOnce({});

        const result = await provider.create(
          'MyUserPool',
          'AWS::Cognito::UserPool',
          props as Record<string, unknown>
        );

        expect(result.effectiveProperties).toBeUndefined();
      });

      // The DIFF-side half. Shipping the record without this makes the next
      // deploy read the substitution back as a user-made change and re-run the
      // update forever, which is worse than shipping neither.
      describe('canonicalizeDesiredProperties', () => {
        it('narrows the desired bag to the same value the wire got', () => {
          const desired = provider.canonicalizeDesiredProperties('AWS::Cognito::UserPool', {
            MfaConfiguration: null,
            EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
          });
          expect(desired['MfaConfiguration']).toBe('OPTIONAL');
          expect(desired['EnabledMfas']).toEqual(['SOFTWARE_TOKEN_MFA']);
        });

        it('narrows a blank value the same way', () => {
          expect(
            provider.canonicalizeDesiredProperties('AWS::Cognito::UserPool', {
              MfaConfiguration: '',
              WebAuthnRelyingPartyID: 'auth.example.com',
            })['MfaConfiguration']
          ).toBe('OFF');
        });

        it('is silent -- the provisioning path already announced it', () => {
          provider.canonicalizeDesiredProperties('AWS::Cognito::UserPool', {
            MfaConfiguration: null,
            EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
          });
          expect(childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n')).toBe('');
        });

        it.each([
          ['a well-formed value', { MfaConfiguration: 'ON' }],
          ['an absent value', { UserPoolName: 'plain' }],
        ])('returns the input object unchanged for %s', (_label, props) => {
          const input = props as Record<string, unknown>;
          expect(provider.canonicalizeDesiredProperties('AWS::Cognito::UserPool', input)).toBe(
            input
          );
        });

        it('leaves another resource type alone', () => {
          const input = { MfaConfiguration: null };
          expect(provider.canonicalizeDesiredProperties('AWS::S3::Bucket', input)).toBe(input);
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
