import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('@aws-sdk/client-kms', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-kms')>();
  return {
    ...actual,
    KMSClient: vi.fn().mockImplementation(() => ({
      config: {
        region: () => Promise.resolve('us-east-1'),
        retryStrategy: () =>
          Promise.resolve({
            acquireInitialRetryToken: () => Promise.resolve('token'),
            refreshRetryTokenForRetry: () => Promise.resolve('retry-token'),
            recordSuccess: () => undefined,
          }),
      },
      send: (command: unknown) => mockSend(command),
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

import {
  KMSProvider,
  resetKmsCreateRetryStateForTests,
} from '../../../src/provisioning/providers/kms-provider.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';

const KEY_TYPE = 'AWS::KMS::Key';
const KEY_ID = '1234abcd-12ab-34cd-56ef-1234567890ab';
const KEY_ARN = `arn:aws:kms:us-east-1:123456789012:key/${KEY_ID}`;

function script(fail: Record<string, Error | undefined>): void {
  mockSend.mockImplementation((command: { constructor: { name: string } }) => {
    const name = command.constructor.name;
    if (fail[name]) return Promise.reject(fail[name]);
    switch (name) {
      case 'CreateKeyCommand':
        return Promise.resolve({ KeyMetadata: { KeyId: KEY_ID, Arn: KEY_ARN } });
      case 'DescribeKeyCommand':
        return Promise.resolve({
          KeyMetadata: { KeyId: KEY_ID, Arn: KEY_ARN, KeyState: 'Enabled' },
        });
      default:
        return Promise.resolve({});
    }
  });
}

async function createError(
  provider: KMSProvider,
  resourceType: string,
  properties: Record<string, unknown>
): Promise<unknown> {
  try {
    await provider.create('MyKey', resourceType, properties);
  } catch (error) {
    return error;
  }
  throw new Error('create() did not throw');
}

describe('KMSProvider created-before-failure mark (go-to-k/cdkd#4583)', () => {
  let provider: KMSProvider;

  beforeEach(() => {
    mockSend.mockReset();
    resetKmsCreateRetryStateForTests();
    provider = new KMSProvider();
  });

  it('marks the key id when a follow-up call failed after CreateKey returned', async () => {
    script({ EnableKeyRotationCommand: new Error('EnableKeyRotation boom') });

    const error = await createError(provider, KEY_TYPE, { EnableKeyRotation: true });
    expect(createdBeforeFailure(error, 'MyKey', KEY_TYPE)).toBe(KEY_ID);
  });

  it('marks the key a retried attempt resumed when its follow-up failed again', async () => {
    script({ DisableKeyCommand: new Error('DisableKey boom') });

    await createError(provider, KEY_TYPE, { Enabled: false });
    const error = await createError(provider, KEY_TYPE, { Enabled: false });

    const names = mockSend.mock.calls.map((c) => (c[0] as object).constructor.name);
    expect(names.filter((n) => n === 'CreateKeyCommand')).toHaveLength(1);
    expect(names).toContain('DescribeKeyCommand');
    expect(createdBeforeFailure(error, 'MyKey', KEY_TYPE)).toBe(KEY_ID);
  });

  it('does not mark when CreateKey itself failed', async () => {
    script({ CreateKeyCommand: new Error('LimitExceededException') });

    const error = await createError(provider, KEY_TYPE, {});
    expect(error).toBeInstanceOf(Error);
    expect(createdBeforeFailure(error, 'MyKey', KEY_TYPE)).toBeUndefined();
  });

  it('does not mark a KMS Alias whose CreateAlias failed (no follow-up call)', async () => {
    script({ CreateAliasCommand: new Error('AlreadyExistsException') });

    const error = await createError(provider, 'AWS::KMS::Alias', {
      AliasName: 'alias/x',
      TargetKeyId: KEY_ID,
    });
    expect(error).toBeInstanceOf(Error);
    expect(createdBeforeFailure(error, 'MyKey', 'AWS::KMS::Alias')).toBeUndefined();
  });
});
