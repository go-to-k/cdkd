import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';

const mockStsSend = vi.fn();
const mockStsDestroy = vi.fn();
vi.mock('@aws-sdk/client-sts', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-sts')>(
    '@aws-sdk/client-sts',
  );
  return {
    ...actual,
    STSClient: vi.fn().mockImplementation(() => ({
      send: mockStsSend,
      destroy: mockStsDestroy,
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
  assumeRoleForCrossAccountStateRead,
  clearCrossAccountCredentialsCache,
  parseIamRoleArn,
} from '../../../src/utils/role-arn.js';

describe('parseIamRoleArn', () => {
  it('parses a standard arn:aws:iam:: role ARN', () => {
    const result = parseIamRoleArn('arn:aws:iam::123456789012:role/MyRole');
    expect(result).toEqual({ partition: 'aws', accountId: '123456789012' });
  });

  it('parses an aws-us-gov partition role ARN', () => {
    const result = parseIamRoleArn(
      'arn:aws-us-gov:iam::111122223333:role/govcloud-role',
    );
    expect(result).toEqual({ partition: 'aws-us-gov', accountId: '111122223333' });
  });

  it('parses an aws-cn partition role ARN', () => {
    const result = parseIamRoleArn('arn:aws-cn:iam::555566667777:role/cn-role');
    expect(result).toEqual({ partition: 'aws-cn', accountId: '555566667777' });
  });

  it('parses a role with a multi-segment path prefix (service-linked role)', () => {
    const result = parseIamRoleArn(
      'arn:aws:iam::123456789012:role/aws-service-role/foo.amazonaws.com/AWSServiceRoleForX',
    );
    expect(result).toEqual({ partition: 'aws', accountId: '123456789012' });
  });

  it('accepts role names with allowed special chars (+, =, ,, ., @, -, _)', () => {
    const result = parseIamRoleArn('arn:aws:iam::123456789012:role/role+name=v1,foo.bar-baz_qux@example');
    expect(result).toEqual({ partition: 'aws', accountId: '123456789012' });
  });

  it('returns null for non-ARN strings', () => {
    expect(parseIamRoleArn('not-an-arn')).toBeNull();
    expect(parseIamRoleArn('')).toBeNull();
  });

  it('returns null for IAM user ARN (not a role)', () => {
    expect(parseIamRoleArn('arn:aws:iam::123456789012:user/some-user')).toBeNull();
  });

  it('returns null for non-12-digit account ID', () => {
    expect(parseIamRoleArn('arn:aws:iam::12345:role/MyRole')).toBeNull();
    expect(parseIamRoleArn('arn:aws:iam::1234567890123:role/MyRole')).toBeNull();
  });

  it('returns null for non-IAM service ARN', () => {
    expect(
      parseIamRoleArn('arn:aws:s3:::my-bucket'),
    ).toBeNull();
  });

  it('returns null when the partition is missing', () => {
    expect(parseIamRoleArn('arn::iam::123456789012:role/MyRole')).toBeNull();
  });
});

describe('assumeRoleForCrossAccountStateRead', () => {
  beforeEach(() => {
    mockStsSend.mockReset();
    mockStsDestroy.mockReset();
    vi.mocked(STSClient).mockClear();
    clearCrossAccountCredentialsCache();
  });

  it('calls sts:AssumeRole and returns the temporary credentials', async () => {
    const expiration = new Date('2026-12-31T23:59:59Z');
    mockStsSend.mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: 'ASIA-cross-acct',
        SecretAccessKey: 'cross-secret',
        SessionToken: 'cross-session',
        Expiration: expiration,
      },
    });

    const creds = await assumeRoleForCrossAccountStateRead(
      'arn:aws:iam::123456789012:role/producer-role',
    );

    expect(STSClient).toHaveBeenCalledTimes(1);
    expect(STSClient).toHaveBeenCalledWith({});
    const cmd = mockStsSend.mock.calls[0][0];
    expect(cmd).toBeInstanceOf(AssumeRoleCommand);
    expect(cmd.input.RoleArn).toBe('arn:aws:iam::123456789012:role/producer-role');
    expect(cmd.input.RoleSessionName).toMatch(/^cdkd-xacc-\d+$/);
    expect(cmd.input.DurationSeconds).toBe(3600);

    expect(creds).toEqual({
      accessKeyId: 'ASIA-cross-acct',
      secretAccessKey: 'cross-secret',
      sessionToken: 'cross-session',
      expiration,
    });
  });

  it('caches credentials per (roleArn) — second call does NOT issue a new sts:AssumeRole', async () => {
    mockStsSend.mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: 'ASIA-1',
        SecretAccessKey: 'secret-1',
        SessionToken: 'token-1',
      },
    });

    const a = await assumeRoleForCrossAccountStateRead(
      'arn:aws:iam::123456789012:role/r',
    );
    const b = await assumeRoleForCrossAccountStateRead(
      'arn:aws:iam::123456789012:role/r',
    );

    expect(a).toBe(b);
    expect(mockStsSend).toHaveBeenCalledTimes(1);
  });

  it('does NOT pollute process.env (unlike applyRoleArnIfSet)', async () => {
    const before = {
      AWS_ACCESS_KEY_ID: process.env['AWS_ACCESS_KEY_ID'],
      AWS_SECRET_ACCESS_KEY: process.env['AWS_SECRET_ACCESS_KEY'],
      AWS_SESSION_TOKEN: process.env['AWS_SESSION_TOKEN'],
    };
    mockStsSend.mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: 'ASIA-no-leak',
        SecretAccessKey: 'no-leak-secret',
        SessionToken: 'no-leak-session',
      },
    });

    await assumeRoleForCrossAccountStateRead(
      'arn:aws:iam::123456789012:role/no-leak',
    );

    expect(process.env['AWS_ACCESS_KEY_ID']).toBe(before.AWS_ACCESS_KEY_ID);
    expect(process.env['AWS_SECRET_ACCESS_KEY']).toBe(before.AWS_SECRET_ACCESS_KEY);
    expect(process.env['AWS_SESSION_TOKEN']).toBe(before.AWS_SESSION_TOKEN);
  });

  it('caches separately per role ARN', async () => {
    mockStsSend
      .mockResolvedValueOnce({
        Credentials: {
          AccessKeyId: 'ASIA-A',
          SecretAccessKey: 'a-secret',
          SessionToken: 'a-token',
        },
      })
      .mockResolvedValueOnce({
        Credentials: {
          AccessKeyId: 'ASIA-B',
          SecretAccessKey: 'b-secret',
          SessionToken: 'b-token',
        },
      });

    const a = await assumeRoleForCrossAccountStateRead(
      'arn:aws:iam::111111111111:role/A',
    );
    const b = await assumeRoleForCrossAccountStateRead(
      'arn:aws:iam::222222222222:role/B',
    );

    expect(a.accessKeyId).toBe('ASIA-A');
    expect(b.accessKeyId).toBe('ASIA-B');
    expect(mockStsSend).toHaveBeenCalledTimes(2);
  });

  it('throws when AssumeRole returns no credentials', async () => {
    mockStsSend.mockResolvedValueOnce({});

    await expect(
      assumeRoleForCrossAccountStateRead('arn:aws:iam::123:role/x'),
    ).rejects.toThrow(/cross-account Fn::GetStackOutput returned no credentials/);
  });

  it('throws when AssumeRole returns partial credentials', async () => {
    mockStsSend.mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: 'ASIA-only',
        // missing SecretAccessKey + SessionToken
      },
    });

    await expect(
      assumeRoleForCrossAccountStateRead('arn:aws:iam::123:role/x'),
    ).rejects.toThrow(/missing required credentials fields/);
  });

  it('collapses concurrent first-time callers into a single STS hop', async () => {
    let resolveSts: ((v: unknown) => void) | undefined;
    mockStsSend.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSts = resolve;
      }),
    );

    const p1 = assumeRoleForCrossAccountStateRead(
      'arn:aws:iam::333:role/concurrent',
    );
    const p2 = assumeRoleForCrossAccountStateRead(
      'arn:aws:iam::333:role/concurrent',
    );

    expect(mockStsSend).toHaveBeenCalledTimes(1);

    resolveSts?.({
      Credentials: {
        AccessKeyId: 'ASIA-concurrent',
        SecretAccessKey: 'cs',
        SessionToken: 'ct',
      },
    });

    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toBe(b);
    expect(mockStsSend).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // MUST-FIX 1: STS credential expiration check + safety buffer
  // ---------------------------------------------------------------------------

  it('refreshes credentials when cached entry has expired (past Expiration)', async () => {
    const expiredAt = new Date(Date.now() - 60_000); // already expired 1 minute ago
    mockStsSend
      .mockResolvedValueOnce({
        Credentials: {
          AccessKeyId: 'ASIA-old',
          SecretAccessKey: 'old-secret',
          SessionToken: 'old-session',
          Expiration: expiredAt,
        },
      })
      .mockResolvedValueOnce({
        Credentials: {
          AccessKeyId: 'ASIA-new',
          SecretAccessKey: 'new-secret',
          SessionToken: 'new-session',
          Expiration: new Date(Date.now() + 3600_000),
        },
      });

    const first = await assumeRoleForCrossAccountStateRead(
      'arn:aws:iam::123456789012:role/r',
    );
    expect(first.accessKeyId).toBe('ASIA-old');

    const second = await assumeRoleForCrossAccountStateRead(
      'arn:aws:iam::123456789012:role/r',
    );
    expect(second.accessKeyId).toBe('ASIA-new');
    expect(mockStsSend).toHaveBeenCalledTimes(2);
  });

  it('refreshes credentials when cached entry is within the 60-second safety buffer', async () => {
    // Expiration is 30 seconds in the future — inside the 60s buffer so
    // we should refresh rather than return the soon-to-expire creds.
    const aboutToExpire = new Date(Date.now() + 30_000);
    mockStsSend
      .mockResolvedValueOnce({
        Credentials: {
          AccessKeyId: 'ASIA-buffer',
          SecretAccessKey: 'buffer-secret',
          SessionToken: 'buffer-session',
          Expiration: aboutToExpire,
        },
      })
      .mockResolvedValueOnce({
        Credentials: {
          AccessKeyId: 'ASIA-buffer-refreshed',
          SecretAccessKey: 'refreshed-secret',
          SessionToken: 'refreshed-session',
          Expiration: new Date(Date.now() + 3600_000),
        },
      });

    await assumeRoleForCrossAccountStateRead('arn:aws:iam::123456789012:role/buf');
    const second = await assumeRoleForCrossAccountStateRead(
      'arn:aws:iam::123456789012:role/buf',
    );

    expect(second.accessKeyId).toBe('ASIA-buffer-refreshed');
    expect(mockStsSend).toHaveBeenCalledTimes(2);
  });

  it('reuses cached credentials when Expiration is far in the future', async () => {
    const farFuture = new Date(Date.now() + 3600_000); // 1 hour out
    mockStsSend.mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: 'ASIA-fresh',
        SecretAccessKey: 'fresh-secret',
        SessionToken: 'fresh-session',
        Expiration: farFuture,
      },
    });

    const a = await assumeRoleForCrossAccountStateRead(
      'arn:aws:iam::123456789012:role/fresh',
    );
    const b = await assumeRoleForCrossAccountStateRead(
      'arn:aws:iam::123456789012:role/fresh',
    );

    expect(a).toBe(b);
    // Only ONE STS hop because the cached creds are valid.
    expect(mockStsSend).toHaveBeenCalledTimes(1);
  });

  it('reuses cached credentials when Expiration is undefined (defensive)', async () => {
    // STS always returns Expiration in practice but the field is
    // technically optional on the SDK type; treat undefined as
    // "still valid" so we don't re-AssumeRole every call.
    mockStsSend.mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: 'ASIA-noexp',
        SecretAccessKey: 'secret',
        SessionToken: 'token',
        // no Expiration
      },
    });

    const a = await assumeRoleForCrossAccountStateRead(
      'arn:aws:iam::123456789012:role/noexp',
    );
    const b = await assumeRoleForCrossAccountStateRead(
      'arn:aws:iam::123456789012:role/noexp',
    );

    expect(a).toBe(b);
    expect(mockStsSend).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // MUST-FIX 2: cache eviction on rejection + MUST-FIX 3: rejection tests
  // ---------------------------------------------------------------------------

  it('does NOT pin the cache to a rejection — subsequent call re-issues STS', async () => {
    // First call rejects (e.g. transient throttle).
    mockStsSend.mockRejectedValueOnce(
      new Error('AccessDenied: User is not authorized to perform sts:AssumeRole'),
    );
    // Second call succeeds.
    mockStsSend.mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: 'ASIA-recovered',
        SecretAccessKey: 'recovered-secret',
        SessionToken: 'recovered-session',
        Expiration: new Date(Date.now() + 3600_000),
      },
    });

    await expect(
      assumeRoleForCrossAccountStateRead('arn:aws:iam::123456789012:role/retry'),
    ).rejects.toThrow(/AssumeRole into .* failed/);

    // The cache MUST have been evicted by now, so the next call retries.
    const recovered = await assumeRoleForCrossAccountStateRead(
      'arn:aws:iam::123456789012:role/retry',
    );

    expect(recovered.accessKeyId).toBe('ASIA-recovered');
    expect(mockStsSend).toHaveBeenCalledTimes(2);
  });

  it('concurrent rejections share the SAME in-flight promise (no double STS call)', async () => {
    let rejectSts: ((err: unknown) => void) | undefined;
    mockStsSend.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectSts = reject;
      }),
    );

    const p1 = assumeRoleForCrossAccountStateRead(
      'arn:aws:iam::123456789012:role/concurrent-fail',
    );
    const p2 = assumeRoleForCrossAccountStateRead(
      'arn:aws:iam::123456789012:role/concurrent-fail',
    );

    // Both callers see the SAME pending STS call.
    expect(mockStsSend).toHaveBeenCalledTimes(1);

    const stsErr = new Error('AccessDenied: trust policy mismatch');
    rejectSts?.(stsErr);

    // Both reject with the trust-policy-hint-wrapped error.
    await expect(p1).rejects.toThrow(/AssumeRole into .* failed: AccessDenied/);
    await expect(p2).rejects.toThrow(/AssumeRole into .* failed: AccessDenied/);

    // Still only one STS call observed.
    expect(mockStsSend).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // NICE-TO-HAVE 9: trust-policy hint wrapping
  // ---------------------------------------------------------------------------

  it('wraps STS errors with the trust-policy / cross-stack-references hint', async () => {
    const original = new Error(
      'AccessDenied: User: arn:aws:iam::111:role/cdkd-deployer is not authorized to perform: sts:AssumeRole on resource: arn:aws:iam::222:role/cross-acct',
    );
    mockStsSend.mockRejectedValueOnce(original);

    await expect(
      assumeRoleForCrossAccountStateRead('arn:aws:iam::222:role/cross-acct'),
    ).rejects.toThrow(/trust-policy/i);

    // Same call, fresh: assert full message shape including the docs pointer.
    mockStsSend.mockRejectedValueOnce(original);
    await expect(
      assumeRoleForCrossAccountStateRead('arn:aws:iam::222:role/cross-acct'),
    ).rejects.toThrow(/docs\/cross-stack-references\.md/);
  });

  it('chains the original STS error as `cause` on the trust-policy wrapper', async () => {
    const original = new Error('sts:AssumeRole denied');
    mockStsSend.mockRejectedValueOnce(original);

    try {
      await assumeRoleForCrossAccountStateRead('arn:aws:iam::333:role/cause-chain');
      throw new Error('Expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error & { cause?: unknown }).cause).toBe(original);
    }
  });
});
