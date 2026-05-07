import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UpdateUserPoolCommand } from '@aws-sdk/client-cognito-identity-provider';

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

const PHYS_ID = 'us-east-1_abcd';

describe('CognitoUserPoolProvider read-update round-trip', () => {
  let provider: CognitoUserPoolProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new CognitoUserPoolProvider();
  });

  // Mechanical guard for Class 2 placeholder regression on
  // structurally-incomplete-when-empty sub-objects. See
  // docs/provider-development.md § 3b.
  //
  // `SmsConfiguration: {}` would be rejected by UpdateUserPool with
  // "Required attribute SnsCallerArn missing" because SnsCallerArn is
  // a required sub-field. The provider must NOT include an empty-object
  // placeholder on the round-trip update.
  it('Class 2 — SmsConfiguration empty-object placeholder is NOT shipped on round-trip', async () => {
    // The DescribeUserPool inside update() returns enough to build the
    // post-update attributes block.
    mockSend.mockResolvedValueOnce({}); // UpdateUserPool
    mockSend.mockResolvedValueOnce({
      UserPool: { Arn: `arn:aws:cognito-idp:us-east-1:0:userpool/${PHYS_ID}` },
    }); // DescribeUserPool

    const observed = {
      UserPoolName: 'p',
      AutoVerifiedAttributes: [],
      UsernameAttributes: [],
      AliasAttributes: [],
      Policies: {},
      LambdaConfig: {},
      MfaConfiguration: 'OFF',
      AdminCreateUserConfig: {},
      AccountRecoverySetting: {},
      UserAttributeUpdateSettings: {},
      DeletionProtection: 'INACTIVE',
      EmailConfiguration: {},
      SmsConfiguration: {}, // Class 2 placeholder
      VerificationMessageTemplate: {},
      UsernameConfiguration: {},
      DeviceConfiguration: {},
      UserPoolAddOns: {}, // Class 2 placeholder
      EmailVerificationMessage: '',
      EmailVerificationSubject: '',
      SmsAuthenticationMessage: '',
      SmsVerificationMessage: '',
      UserPoolTags: {},
    };

    await provider.update('L', PHYS_ID, 'AWS::Cognito::UserPool', observed, observed);

    const updateCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof UpdateUserPoolCommand
    );
    expect(updateCall).toBeDefined();
    const input = updateCall![0].input as Record<string, unknown>;

    // Class 2: empty-object placeholders must NOT reach the wire.
    expect(input.SmsConfiguration).toBeUndefined();
    expect(input.UserPoolAddOns).toBeUndefined();
  });

  // Mechanical guard for Class 2 — non-empty SmsConfiguration / UserPoolAddOns
  // (i.e. the user has actually configured them) MUST still reach AWS.
  // Otherwise the sanitize would silently swallow legitimate updates.
  it('Class 2 — non-empty SmsConfiguration / UserPoolAddOns still reach UpdateUserPool', async () => {
    mockSend.mockResolvedValueOnce({}); // UpdateUserPool
    mockSend.mockResolvedValueOnce({
      UserPool: { Arn: `arn:aws:cognito-idp:us-east-1:0:userpool/${PHYS_ID}` },
    }); // DescribeUserPool

    const observed = {
      UserPoolName: 'p',
      SmsConfiguration: { SnsCallerArn: 'arn:aws:iam::0:role/SmsRole' },
      UserPoolAddOns: { AdvancedSecurityMode: 'ENFORCED' },
    };

    await provider.update('L', PHYS_ID, 'AWS::Cognito::UserPool', observed, observed);

    const updateCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof UpdateUserPoolCommand
    );
    expect(updateCall).toBeDefined();
    const input = updateCall![0].input as Record<string, unknown>;

    expect(input.SmsConfiguration).toEqual({ SnsCallerArn: 'arn:aws:iam::0:role/SmsRole' });
    expect(input.UserPoolAddOns).toEqual({ AdvancedSecurityMode: 'ENFORCED' });
  });

  // Mechanical guard for the truthy-gate failure mode on string fields
  // where empty-string is a legal AWS-clear value. See
  // docs/provider-development.md § 3b "update() must gate optional
  // fields on `!== undefined`, not truthy".
  //
  // When state has `EmailVerificationMessage: ''` (placeholder for "no
  // override") and AWS-side has a real message, `cdkd drift --revert`
  // pushes `''` back through update(). A truthy gate would silently
  // drop the empty string, the AWS update succeeds without clearing
  // the message, `--revert` reports `✓ reverted`, and the next drift
  // re-detects the same drift.
  it('truthy-gate — empty-string message placeholders DO reach UpdateUserPool input', async () => {
    mockSend.mockResolvedValueOnce({}); // UpdateUserPool
    mockSend.mockResolvedValueOnce({
      UserPool: { Arn: `arn:aws:cognito-idp:us-east-1:0:userpool/${PHYS_ID}` },
    }); // DescribeUserPool

    const observed = {
      UserPoolName: 'p',
      EmailVerificationMessage: '',
      EmailVerificationSubject: '',
      SmsAuthenticationMessage: '',
      SmsVerificationMessage: '',
    };

    await provider.update('L', PHYS_ID, 'AWS::Cognito::UserPool', observed, observed);

    const updateCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof UpdateUserPoolCommand
    );
    expect(updateCall).toBeDefined();
    const input = updateCall![0].input as Record<string, unknown>;

    // The empty-string placeholders MUST reach AWS (it's the documented
    // way to clear these fields). A truthy gate would drop them.
    expect(input.EmailVerificationMessage).toBe('');
    expect(input.EmailVerificationSubject).toBe('');
    expect(input.SmsAuthenticationMessage).toBe('');
    expect(input.SmsVerificationMessage).toBe('');
  });

  // Full no-drift round-trip: every always-emit placeholder from
  // readCurrentState's minimum-response output goes straight back
  // through update() and AWS receives no rejection-shaped value.
  it('full round-trip on minimum-response observed snapshot ships no AWS-rejection-shaped values', async () => {
    mockSend.mockResolvedValueOnce({}); // UpdateUserPool
    mockSend.mockResolvedValueOnce({
      UserPool: { Arn: `arn:aws:cognito-idp:us-east-1:0:userpool/${PHYS_ID}` },
    }); // DescribeUserPool

    // Mirrors the "AWS minimum response" key set asserted in
    // cognito-provider-readcurrentstate.test.ts.
    const observed = {
      UserPoolName: 'p',
      AutoVerifiedAttributes: [],
      UsernameAttributes: [],
      AliasAttributes: [],
      Policies: {},
      LambdaConfig: {},
      MfaConfiguration: 'OFF',
      AdminCreateUserConfig: {},
      AccountRecoverySetting: {},
      UserAttributeUpdateSettings: {},
      DeletionProtection: 'INACTIVE',
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
    };

    await expect(
      provider.update('L', PHYS_ID, 'AWS::Cognito::UserPool', observed, observed)
    ).resolves.toBeDefined();

    const updateCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof UpdateUserPoolCommand
    );
    expect(updateCall).toBeDefined();
    const input = updateCall![0].input as Record<string, unknown>;

    // The known AWS-rejection-shaped values are the empty placeholders
    // for required-sub-field types.
    expect(input.SmsConfiguration).toBeUndefined();
    expect(input.UserPoolAddOns).toBeUndefined();

    // UserPoolId is always set (sanity).
    expect(input.UserPoolId).toBe(PHYS_ID);
  });
});
