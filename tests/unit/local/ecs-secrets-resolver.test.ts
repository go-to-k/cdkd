import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EcsSecretsResolutionError,
  classifySecretArn,
  resolveEcsSecrets,
} from '../../../src/local/ecs-secrets-resolver.js';

// Mock the AWS SDK clients. The `send` is hoisted via vi.hoisted so the
// factory closure can reference it.
const sends = vi.hoisted(() => ({
  secrets: vi.fn(),
  ssm: vi.fn(),
}));

vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class {
    send = sends.secrets;
    destroy(): void {}
  },
  GetSecretValueCommand: class {
    constructor(public input: unknown) {}
  },
}));
vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class {
    send = sends.ssm;
    destroy(): void {}
  },
  GetParameterCommand: class {
    constructor(public input: unknown) {}
  },
}));

beforeEach(() => {
  sends.secrets.mockReset();
  sends.ssm.mockReset();
});

describe('classifySecretArn', () => {
  it('classifies plain Secrets Manager ARN', () => {
    const s = classifySecretArn('arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret');
    expect(s.kind).toBe('secrets-manager');
    if (s.kind === 'secrets-manager') {
      expect(s.baseArn).toBe('arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret');
      expect(s.jsonKey).toBeUndefined();
    }
  });

  it('classifies Secrets Manager ARN with json-key suffix', () => {
    const s = classifySecretArn(
      'arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret:apiKey::'
    );
    expect(s.kind).toBe('secrets-manager');
    if (s.kind === 'secrets-manager') {
      expect(s.jsonKey).toBe('apiKey');
    }
  });

  it('classifies SSM Parameter ARN', () => {
    const s = classifySecretArn('arn:aws:ssm:us-east-1:123456789012:parameter/path/key');
    expect(s.kind).toBe('ssm');
    if (s.kind === 'ssm') {
      expect(s.name).toBe('/path/key');
    }
  });

  it('returns unknown for malformed ARN', () => {
    expect(classifySecretArn('not-an-arn').kind).toBe('unknown');
    expect(classifySecretArn('arn:aws:s3::::bucket').kind).toBe('unknown');
  });
});

describe('resolveEcsSecrets', () => {
  it('returns empty array on no entries', async () => {
    const r = await resolveEcsSecrets([]);
    expect(r).toEqual([]);
  });

  it('resolves plain Secrets Manager secret', async () => {
    sends.secrets.mockResolvedValueOnce({ SecretString: 'pa55' });
    const r = await resolveEcsSecrets([
      {
        containerName: 'app',
        name: 'API_KEY',
        valueFrom: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:foo',
      },
    ]);
    expect(r).toEqual([
      expect.objectContaining({ containerName: 'app', name: 'API_KEY', value: 'pa55' }),
    ]);
  });

  it('extracts json-key from Secrets Manager value', async () => {
    sends.secrets.mockResolvedValueOnce({ SecretString: '{"apiKey":"abc","other":"x"}' });
    const r = await resolveEcsSecrets([
      {
        containerName: 'app',
        name: 'API_KEY',
        valueFrom:
          'arn:aws:secretsmanager:us-east-1:123456789012:secret:foo:apiKey::',
      },
    ]);
    expect(r[0]!.value).toBe('abc');
  });

  it('hard-fails on missing json-key', async () => {
    sends.secrets.mockResolvedValueOnce({ SecretString: '{"other":"x"}' });
    await expect(
      resolveEcsSecrets([
        {
          containerName: 'app',
          name: 'API_KEY',
          valueFrom:
            'arn:aws:secretsmanager:us-east-1:123456789012:secret:foo:apiKey::',
        },
      ])
    ).rejects.toBeInstanceOf(EcsSecretsResolutionError);
  });

  it('resolves SSM parameter with decryption', async () => {
    sends.ssm.mockResolvedValueOnce({ Parameter: { Value: 'val' } });
    const r = await resolveEcsSecrets([
      {
        containerName: 'app',
        name: 'P',
        valueFrom: 'arn:aws:ssm:us-east-1:123456789012:parameter/path/key',
      },
    ]);
    expect(r[0]!.value).toBe('val');
  });

  it('hard-fails on access-denied access', async () => {
    sends.secrets.mockRejectedValueOnce(new Error('AccessDenied: user not authorized'));
    await expect(
      resolveEcsSecrets([
        {
          containerName: 'app',
          name: 'K',
          valueFrom: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:foo',
        },
      ])
    ).rejects.toThrow(/AccessDenied/);
  });

  it('hard-fails on unknown shape', async () => {
    await expect(
      resolveEcsSecrets([
        { containerName: 'app', name: 'K', valueFrom: 'arn:aws:s3::::bucket' },
      ])
    ).rejects.toBeInstanceOf(EcsSecretsResolutionError);
  });

  it('hard-fails on invalid JSON when json-key set', async () => {
    sends.secrets.mockResolvedValueOnce({ SecretString: 'not json' });
    await expect(
      resolveEcsSecrets([
        {
          containerName: 'app',
          name: 'K',
          valueFrom:
            'arn:aws:secretsmanager:us-east-1:123456789012:secret:foo:apiKey::',
        },
      ])
    ).rejects.toThrow(/not valid JSON/);
  });
});
