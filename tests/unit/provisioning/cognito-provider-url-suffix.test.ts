import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.hoisted(() => vi.fn());
const clientRegion = vi.hoisted(() => ({ value: 'us-east-1' }));

vi.mock('@aws-sdk/client-cognito-identity-provider', async () => {
  const actual = await vi.importActual('@aws-sdk/client-cognito-identity-provider');
  return {
    ...actual,
    CognitoIdentityProviderClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve(clientRegion.value) },
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

/**
 * Issue #1745 — `ProviderName` / `ProviderURL` hardcoded `amazonaws.com`, so
 * outside the commercial partition cdkd recorded a hostname that does not
 * resolve. The commercial output must be BYTE-IDENTICAL to before, which is
 * what makes the change safe to ship without a non-commercial account.
 */
describe('CognitoUserPoolProvider derives the OIDC provider host suffix (issue #1745)', () => {
  let provider: CognitoUserPoolProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    clientRegion.value = 'us-east-1';
    provider = new CognitoUserPoolProvider();
  });

  it('create in a cn- region emits amazonaws.com.cn', async () => {
    clientRegion.value = 'cn-north-1';
    mockSend.mockResolvedValueOnce({
      UserPool: {
        Id: 'cn-north-1_abc123',
        Arn: 'arn:aws-cn:cognito-idp:cn-north-1:123456789012:userpool/cn-north-1_abc123',
      },
    });

    const result = await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
      UserPoolName: 'my-user-pool',
    });

    expect(result.attributes?.['ProviderName']).toBe(
      'cognito-idp.cn-north-1.amazonaws.com.cn/cn-north-1_abc123'
    );
    expect(result.attributes?.['ProviderURL']).toBe(
      'https://cognito-idp.cn-north-1.amazonaws.com.cn/cn-north-1_abc123'
    );
  });

  it('create in a commercial region is byte-identical to the pre-fix output', async () => {
    mockSend.mockResolvedValueOnce({
      UserPool: {
        Id: 'us-east-1_abc123',
        Arn: 'arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_abc123',
      },
    });

    const result = await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
      UserPoolName: 'my-user-pool',
    });

    expect(result.attributes?.['ProviderName']).toBe(
      'cognito-idp.us-east-1.amazonaws.com/us-east-1_abc123'
    );
    expect(result.attributes?.['ProviderURL']).toBe(
      'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc123'
    );
  });

  it('update agrees with create — an update must not rewrite a cn suffix back to the commercial one', async () => {
    clientRegion.value = 'cn-north-1';
    // UpdateUserPool, then DescribeUserPool.
    mockSend.mockResolvedValueOnce({});
    mockSend.mockResolvedValueOnce({
      UserPool: {
        Id: 'cn-north-1_abc123',
        Arn: 'arn:aws-cn:cognito-idp:cn-north-1:123456789012:userpool/cn-north-1_abc123',
      },
    });

    const result = await provider.update(
      'MyUserPool',
      'cn-north-1_abc123',
      'AWS::Cognito::UserPool',
      { UserPoolName: 'my-user-pool' },
      { UserPoolName: 'my-user-pool' }
    );

    expect(result.attributes?.['ProviderName']).toBe(
      'cognito-idp.cn-north-1.amazonaws.com.cn/cn-north-1_abc123'
    );
    expect(result.attributes?.['ProviderURL']).toBe(
      'https://cognito-idp.cn-north-1.amazonaws.com.cn/cn-north-1_abc123'
    );
  });

  it('a us-gov region keeps amazonaws.com (the partition differs, the suffix does not)', async () => {
    clientRegion.value = 'us-gov-west-1';
    mockSend.mockResolvedValueOnce({
      UserPool: {
        Id: 'us-gov-west-1_abc123',
        Arn: 'arn:aws-us-gov:cognito-idp:us-gov-west-1:123456789012:userpool/us-gov-west-1_abc123',
      },
    });

    const result = await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
      UserPoolName: 'my-user-pool',
    });

    expect(result.attributes?.['ProviderName']).toBe(
      'cognito-idp.us-gov-west-1.amazonaws.com/us-gov-west-1_abc123'
    );
  });
});
