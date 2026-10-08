import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { S3Client } from '@aws-sdk/client-s3';

const loggerDebug = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({ send: vi.fn(), destroy: vi.fn() })),
  GetCallerIdentityCommand: vi.fn().mockImplementation((input) => ({ ...input })),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const l = { debug: loggerDebug, info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { getLogger: () => ({ ...l, child: () => l }) };
});

import {
  clearExpectedBucketOwnerCache,
  recordResolvedAccountId,
  resolveExpectedBucketOwner,
} from '../../../src/utils/expected-bucket-owner.js';
import { formatError, normalizeAwsError } from '../../../src/utils/error-handler.js';

/**
 * Issue [#3361](https://github.com/go-to-k/cdkd/issues/3361), the
 * `src/utils` slice: `String(Object.create(null))` throws
 * `TypeError: Cannot convert object to primitive value`, so a helper that
 * stringified an arbitrary caught value with a bare `String()` threw from the
 * path meant to absorb or describe that value.
 */

/** What `safeStringify` renders for a value `String()` cannot convert. */
const PLACEHOLDER = 'a value that could not be converted to text';

const debugs = (): string[] => loggerDebug.mock.calls.map((c) => String(c[0]));

/** A client whose credential provider rejects with `value`. */
function clientWhoseCredentialsReject(value: unknown): S3Client {
  return {
    config: {
      region: async () => 'us-east-1',
      credentials: () => Promise.reject(value),
    },
  } as unknown as S3Client;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearExpectedBucketOwnerCache();
});

describe('expected-bucket-owner best-effort catches (#3361)', () => {
  it('resolveExpectedBucketOwner still degrades to "header omitted" on an unconvertible rejection', async () => {
    // Documented best-effort: a failed resolution omits the header. The debug
    // line used `String(error)`, so the catch threw and every state-bucket call
    // spreading `expectedOwnerParam` rejected instead of going out headerless.
    await expect(
      resolveExpectedBucketOwner(clientWhoseCredentialsReject(Object.create(null)))
    ).resolves.toBeUndefined();

    const skipped = debugs().filter((d) => d.includes('ExpectedBucketOwner resolution skipped'));
    expect(skipped).toEqual([`ExpectedBucketOwner resolution skipped (header omitted): ${PLACEHOLDER}`]);
  });

  it('recordResolvedAccountId stays a silent no-op on an unconvertible rejection', async () => {
    await expect(
      recordResolvedAccountId(clientWhoseCredentialsReject(Object.create(null)), '123456789012')
    ).resolves.toBeUndefined();

    expect(debugs()).toEqual([`ExpectedBucketOwner seed skipped: ${PLACEHOLDER}`]);
  });

  it('keeps the bare String() rendering, error name included, for an Error', async () => {
    // `safeStringify`, not `.detail`: the old text carried the name prefix.
    const denied = Object.assign(new Error('no creds'), { name: 'CredentialsProviderError' });
    await resolveExpectedBucketOwner(clientWhoseCredentialsReject(denied));

    expect(debugs()).toEqual([
      'ExpectedBucketOwner resolution skipped (header omitted): CredentialsProviderError: no creds',
    ]);
  });
});

describe('error-handler non-Error arms (#3361)', () => {
  it('formatError renders an unconvertible thrown value instead of throwing', () => {
    // The final arm exists for a non-Error throw. `handleError` calls this
    // inside the command wrapper's catch, so a throw here replaced the exit-code
    // handling with the top-level "Fatal error:" fallback.
    expect(formatError(Object.create(null))).toBe(PLACEHOLDER);
    expect(formatError('plain string')).toBe('plain string');
  });

  it('normalizeAwsError wraps an unconvertible value instead of throwing, keeping it as cause', () => {
    // The non-Error arm exists precisely to turn such a value into an Error;
    // its `String(err)` threw instead, so the caller's own catch (several
    // classify the normalized error and swallow a NotFound) never ran.
    const value: unknown = Object.create(null);

    const normalized = normalizeAwsError(value);

    expect(normalized).toBeInstanceOf(Error);
    expect(normalized.message).toBe(PLACEHOLDER);
    expect(normalized.cause).toBe(value);
  });
});
