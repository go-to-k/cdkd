import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';

const mockStsSend = vi.fn();
vi.mock('@aws-sdk/client-sts', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-sts')>(
    '@aws-sdk/client-sts',
  );
  return {
    ...actual,
    STSClient: vi.fn().mockImplementation(() => ({
      send: mockStsSend,
      destroy: vi.fn(),
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

import { applyRoleArnIfSet } from '../../../src/utils/role-arn.js';

const PRESERVED_ENV = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'CDKD_ROLE_ARN'];

describe('applyRoleArnIfSet', () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    mockStsSend.mockReset();
    vi.mocked(STSClient).mockClear();
    originalEnv = {};
    for (const key of PRESERVED_ENV) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of PRESERVED_ENV) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
  });

  it('is a no-op when neither --role-arn nor CDKD_ROLE_ARN is set', async () => {
    await applyRoleArnIfSet({ roleArn: undefined, region: 'us-east-1' });

    expect(STSClient).not.toHaveBeenCalled();
    expect(mockStsSend).not.toHaveBeenCalled();
    expect(process.env['AWS_ACCESS_KEY_ID']).toBeUndefined();
  });

  it('writes assumed-role temp creds into AWS_* env vars when --role-arn is provided', async () => {
    mockStsSend.mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: 'ASIA-temp-key',
        SecretAccessKey: 'temp-secret',
        SessionToken: 'temp-session',
        Expiration: new Date('2026-01-01T00:00:00Z'),
      },
    });

    await applyRoleArnIfSet({
      roleArn: 'arn:aws:iam::123456789012:role/cdkd-deploy',
      region: 'us-east-1',
    });

    expect(STSClient).toHaveBeenCalledTimes(1);
    expect(STSClient).toHaveBeenCalledWith({ region: 'us-east-1' });
    const cmd = mockStsSend.mock.calls[0][0];
    expect(cmd).toBeInstanceOf(AssumeRoleCommand);
    expect(cmd.input.RoleArn).toBe('arn:aws:iam::123456789012:role/cdkd-deploy');
    expect(cmd.input.RoleSessionName).toMatch(/^cdkd-\d+$/);
    expect(cmd.input.DurationSeconds).toBe(3600);

    expect(process.env['AWS_ACCESS_KEY_ID']).toBe('ASIA-temp-key');
    expect(process.env['AWS_SECRET_ACCESS_KEY']).toBe('temp-secret');
    expect(process.env['AWS_SESSION_TOKEN']).toBe('temp-session');
  });

  it('falls back to CDKD_ROLE_ARN env var when --role-arn flag is not set', async () => {
    process.env['CDKD_ROLE_ARN'] = 'arn:aws:iam::999999999999:role/from-env';
    mockStsSend.mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: 'ASIA-env',
        SecretAccessKey: 'secret-env',
        SessionToken: 'session-env',
      },
    });

    await applyRoleArnIfSet({ roleArn: undefined, region: 'us-west-2' });

    const cmd = mockStsSend.mock.calls[0][0];
    expect(cmd.input.RoleArn).toBe('arn:aws:iam::999999999999:role/from-env');
    expect(process.env['AWS_ACCESS_KEY_ID']).toBe('ASIA-env');
  });

  it('CLI --role-arn takes precedence over CDKD_ROLE_ARN env var', async () => {
    process.env['CDKD_ROLE_ARN'] = 'arn:aws:iam::000:role/env-version';
    mockStsSend.mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: 'ASIA-cli',
        SecretAccessKey: 'secret',
        SessionToken: 'session',
      },
    });

    await applyRoleArnIfSet({
      roleArn: 'arn:aws:iam::123:role/cli-version',
      region: 'us-east-1',
    });

    const cmd = mockStsSend.mock.calls[0][0];
    expect(cmd.input.RoleArn).toBe('arn:aws:iam::123:role/cli-version');
  });

  it('throws when AssumeRole returns no credentials', async () => {
    mockStsSend.mockResolvedValueOnce({});

    await expect(
      applyRoleArnIfSet({
        roleArn: 'arn:aws:iam::123:role/x',
        region: 'us-east-1',
      }),
    ).rejects.toThrow(/AssumeRole returned no credentials/);
    expect(process.env['AWS_ACCESS_KEY_ID']).toBeUndefined();
  });

  it('throws when AssumeRole returns partial credentials', async () => {
    mockStsSend.mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: 'ASIA-only',
        // SecretAccessKey + SessionToken missing
      },
    });

    await expect(
      applyRoleArnIfSet({
        roleArn: 'arn:aws:iam::123:role/x',
        region: 'us-east-1',
      }),
    ).rejects.toThrow(/missing credentials fields/);
  });

  it('passes through region: undefined to STSClient when not provided', async () => {
    mockStsSend.mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: 'ASIA-x',
        SecretAccessKey: 's',
        SessionToken: 't',
      },
    });

    await applyRoleArnIfSet({ roleArn: 'arn:aws:iam::123:role/x', region: undefined });

    // STS region falls back to the SDK default chain (env / profile);
    // we don't pass region in that case.
    expect(STSClient).toHaveBeenCalledWith({});
  });
});
