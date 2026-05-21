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
});
