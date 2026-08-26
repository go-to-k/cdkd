import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
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
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));
vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class {
    send = sends.ssm;
    destroy(): void {}
  },
  GetParameterCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
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

  // Issue #2189: V8 embeds a ~10-char prefix of the PARSED INPUT in
  // `SyntaxError.message` (`Unexpected token 's', "supersecre"... is not
  // valid JSON`). Interpolating that message put the secret plaintext on
  // stderr. Each test below pairs the negative assertion (the leaked
  // substring is absent) with a positive one (the actionable context
  // survives) so an unrelated failure cannot satisfy it on its own.
  it('does not echo the secret plaintext prefix in the invalid-JSON error', async () => {
    const secret = 'supersecretpassword12345';
    // What V8 would splice into the message: the first character it choked
    // on, and the 10-char quoted prefix.
    expect(secret.slice(0, 10)).toBe('supersecre');
    sends.secrets.mockResolvedValueOnce({ SecretString: secret });

    const err = await resolveEcsSecrets([
      {
        containerName: 'app',
        name: 'DB_PASS',
        valueFrom: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:foo:password::',
      },
    ]).then(
      () => {
        throw new Error('expected resolveEcsSecrets to reject');
      },
      (e: unknown) => e as Error
    );

    expect(err).toBeInstanceOf(EcsSecretsResolutionError);
    // Negative: no secret-derived text survives anywhere in the message.
    expect(err.message).not.toContain('supersecre');
    expect(err.message).not.toContain(secret);
    expect(err.message).not.toContain("Unexpected token 's'");
    // Positive: the message is still actionable — it names the container,
    // the env var, the requested json-key and a safe discriminator.
    expect(err.message).toContain("Container 'app'");
    expect(err.message).toContain("'DB_PASS'");
    expect(err.message).toContain("'password'");
    expect(err.message).toContain('not valid JSON');
    expect(err.message).toContain('SyntaxError');
  });

  it('does not echo a SHORT secret, which V8 quotes in full rather than truncating', async () => {
    // V8 only appends `...` when the input exceeds its prefix window; a
    // short value is quoted whole (`Unexpected token 'o', "shortpw" is not
    // valid JSON`), so this is a second, distinct leak shape.
    const secret = 'shortpw';
    sends.secrets.mockResolvedValueOnce({ SecretString: secret });

    const err = await resolveEcsSecrets([
      {
        containerName: 'web',
        name: 'TOKEN',
        valueFrom: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:foo:tok::',
      },
    ]).then(
      () => {
        throw new Error('expected resolveEcsSecrets to reject');
      },
      (e: unknown) => e as Error
    );

    expect(err).toBeInstanceOf(EcsSecretsResolutionError);
    expect(err.message).not.toContain(secret);
    expect(err.message).toContain("'web'");
    expect(err.message).toContain("'TOKEN'");
    expect(err.message).toContain("'tok'");
    expect(err.message).toContain('not valid JSON');
  });
});
