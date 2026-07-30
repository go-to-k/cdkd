import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { S3Client } from '@aws-sdk/client-s3';

const { mockStsSend, mockStsDestroy } = vi.hoisted(() => ({
  mockStsSend: vi.fn(),
  mockStsDestroy: vi.fn(),
}));

vi.mock('@aws-sdk/client-sts', () => ({
  // The client config is forwarded to `mockStsSend` as a second argument so a
  // test can return a different account per credential set (the cross-account
  // `RoleArn` path, issue #1283).
  STSClient: vi.fn().mockImplementation((cfg: unknown) => ({
    send: (cmd: unknown) => mockStsSend(cmd, cfg),
    destroy: mockStsDestroy,
  })),
  GetCallerIdentityCommand: vi.fn().mockImplementation((input) => ({ ...input })),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

import {
  resolveExpectedBucketOwner,
  expectedOwnerParam,
  recordResolvedAccountId,
  clearExpectedBucketOwnerCache,
} from '../../../src/utils/expected-bucket-owner.js';

/** A structurally-standard S3 client double (config.region/credentials fns). */
function standardClient(
  creds: Record<string, unknown> = { accessKeyId: 'AKIA', secretAccessKey: 'secret' }
): S3Client {
  return {
    config: {
      region: async () => 'us-east-1',
      credentials: async () => creds,
    },
  } as unknown as S3Client;
}

beforeEach(() => {
  vi.clearAllMocks();
  // The credentials-keyed layer (issue #1283) is module-level and survives
  // across tests; without this reset a later test reusing the same
  // `accessKeyId` would silently observe zero STS calls.
  clearExpectedBucketOwnerCache();
  mockStsSend.mockResolvedValue({ Account: '123456789012' });
});

describe('resolveExpectedBucketOwner', () => {
  it('resolves the caller account via STS using the client credentials', async () => {
    await expect(resolveExpectedBucketOwner(standardClient())).resolves.toBe('123456789012');
    expect(mockStsSend).toHaveBeenCalledTimes(1);
    expect(mockStsDestroy).toHaveBeenCalledTimes(1);
  });

  it('caches per client instance (one STS call for repeated resolutions)', async () => {
    const client = standardClient();
    await resolveExpectedBucketOwner(client);
    await resolveExpectedBucketOwner(client);
    expect(mockStsSend).toHaveBeenCalledTimes(1);
  });

  it('returns undefined for a non-standard client (test double) without calling STS', async () => {
    const bare = { send: vi.fn() } as unknown as S3Client;
    await expect(resolveExpectedBucketOwner(bare)).resolves.toBeUndefined();
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('returns undefined when the resolved credentials lack an access key', async () => {
    await expect(resolveExpectedBucketOwner(standardClient({}))).resolves.toBeUndefined();
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('degrades to undefined (header omitted) when STS fails', async () => {
    mockStsSend.mockRejectedValue(new Error('sts down'));
    await expect(resolveExpectedBucketOwner(standardClient())).resolves.toBeUndefined();
  });

  it('does NOT cache a transient STS failure — the next resolution retries and succeeds', async () => {
    const client = standardClient();
    mockStsSend.mockRejectedValueOnce(new Error('throttled'));
    await expect(resolveExpectedBucketOwner(client)).resolves.toBeUndefined();
    await expect(resolveExpectedBucketOwner(client)).resolves.toBe('123456789012');
    expect(mockStsSend).toHaveBeenCalledTimes(2);
  });
});

/**
 * Issue #1283: the STS resolution is memoized by the resolved ACCESS KEY ID,
 * not by client identity, so the several clients cdkd builds from one
 * credential chain in a single deploy preflight share one round trip. The
 * security-critical property is that this can never hand one identity's
 * account to another — an assumed-role session has its own key id.
 */
describe('credentials-keyed memoization (issue #1283)', () => {
  /** Return a distinct account per access key id. */
  function accountPerKey(map: Record<string, string>) {
    mockStsSend.mockImplementation(
      (_cmd: unknown, cfg: { credentials?: { accessKeyId?: string } }) => {
        const key = cfg?.credentials?.accessKeyId ?? '';
        const account = map[key];
        if (!account) return Promise.reject(new Error(`no account mapped for ${key}`));
        return Promise.resolve({ Account: account });
      }
    );
  }

  it('shares ONE STS call across distinct clients resolving the same credentials', async () => {
    const creds = { accessKeyId: 'AKIASHARED', secretAccessKey: 'secret' };
    // Two separate client objects — the per-client WeakMap cannot help here,
    // which is exactly the deploy-preflight shape (probe client + the
    // region-rebuilt state client).
    await expect(resolveExpectedBucketOwner(standardClient(creds))).resolves.toBe('123456789012');
    await expect(resolveExpectedBucketOwner(standardClient(creds))).resolves.toBe('123456789012');

    expect(mockStsSend).toHaveBeenCalledTimes(1);
  });

  it('resolves the PRODUCER account for a client carrying assumed credentials', async () => {
    accountPerKey({ AKIALOCAL: '111111111111', ASIAASSUMED: '222222222222' });

    const local = standardClient({ accessKeyId: 'AKIALOCAL', secretAccessKey: 'secret' });
    // The cross-account Fn::GetStackOutput RoleArn path: an ephemeral backend
    // whose client carries sts:AssumeRole credentials for ANOTHER account.
    const assumed = standardClient({
      accessKeyId: 'ASIAASSUMED',
      secretAccessKey: 'secret',
      sessionToken: 'token',
    });

    await expect(resolveExpectedBucketOwner(local)).resolves.toBe('111111111111');
    await expect(resolveExpectedBucketOwner(assumed)).resolves.toBe('222222222222');
    expect(mockStsSend).toHaveBeenCalledTimes(2);
  });

  it('does not cache a transient failure under the credentials key either', async () => {
    const creds = { accessKeyId: 'AKIARETRY', secretAccessKey: 'secret' };
    mockStsSend.mockRejectedValueOnce(new Error('throttled'));

    // Distinct clients, so only the credentials-keyed layer is in play.
    await expect(resolveExpectedBucketOwner(standardClient(creds))).resolves.toBeUndefined();
    await expect(resolveExpectedBucketOwner(standardClient(creds))).resolves.toBe('123456789012');
    expect(mockStsSend).toHaveBeenCalledTimes(2);
  });
});

describe('recordResolvedAccountId (issue #1283 seed)', () => {
  it('lets a later resolution reuse the account with no STS round trip', async () => {
    const creds = { accessKeyId: 'AKIASEED', secretAccessKey: 'secret' };
    // Models config-loader.ts: a GetCallerIdentity was just issued with THIS
    // client's credentials, so its result is recorded against them.
    await recordResolvedAccountId(standardClient(creds), '123456789012');

    await expect(resolveExpectedBucketOwner(standardClient(creds))).resolves.toBe('123456789012');
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('cannot leak the seeded account onto a client with different (assumed) credentials', async () => {
    mockStsSend.mockResolvedValue({ Account: '222222222222' });
    await recordResolvedAccountId(
      standardClient({ accessKeyId: 'AKIALOCAL', secretAccessKey: 'secret' }),
      '111111111111'
    );

    const assumed = standardClient({
      accessKeyId: 'ASIAASSUMED',
      secretAccessKey: 'secret',
      sessionToken: 'token',
    });
    // The seed is keyed by the seeding client's OWN credentials, so the
    // assumed-credentials client still resolves its own (different) account.
    await expect(resolveExpectedBucketOwner(assumed)).resolves.toBe('222222222222');
    expect(mockStsSend).toHaveBeenCalledTimes(1);
  });

  it('is a no-op for a non-standard client, an unresolvable chain, or a missing account', async () => {
    await expect(
      recordResolvedAccountId({ send: vi.fn() }, '123456789012')
    ).resolves.toBeUndefined();
    await expect(recordResolvedAccountId(standardClient({}), '123456789012')).resolves.toBeUndefined();
    await expect(
      recordResolvedAccountId(standardClient(), undefined)
    ).resolves.toBeUndefined();

    // None of those seeded anything: a real resolution still calls STS.
    await expect(resolveExpectedBucketOwner(standardClient())).resolves.toBe('123456789012');
    expect(mockStsSend).toHaveBeenCalledTimes(1);
  });

  it('never overwrites an already-resolved account for the same credentials', async () => {
    const creds = { accessKeyId: 'AKIAFIRST', secretAccessKey: 'secret' };
    await expect(resolveExpectedBucketOwner(standardClient(creds))).resolves.toBe('123456789012');

    await recordResolvedAccountId(standardClient(creds), '999999999999');

    await expect(resolveExpectedBucketOwner(standardClient(creds))).resolves.toBe('123456789012');
  });
});

describe('expectedOwnerParam', () => {
  it('spreads to ExpectedBucketOwner when resolved', async () => {
    await expect(expectedOwnerParam(standardClient())).resolves.toEqual({
      ExpectedBucketOwner: '123456789012',
    });
  });

  it('spreads to an empty object when unresolved', async () => {
    const bare = {} as unknown as S3Client;
    await expect(expectedOwnerParam(bare)).resolves.toEqual({});
  });
});
