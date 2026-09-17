import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  EcsSecretsResolutionError,
  classifySecretArn,
  resolveEcsSecrets,
} from '../../../src/local/ecs-secrets-resolver.js';
import {
  resetAwsClientDefaults,
  setAssumedRoleCredentials,
  setPreAssumeEnvCredentials,
} from '../../../src/utils/aws-client-defaults.js';

// Mock the AWS SDK clients. The `send` is hoisted via vi.hoisted so the
// factory closure can reference it.
const sends = vi.hoisted(() => ({
  secrets: vi.fn(),
  ssm: vi.fn(),
}));

/** Every client config the resolver CONSTRUCTS, in order. */
const ctorConfigs = vi.hoisted(() => ({ secrets: [] as unknown[], ssm: [] as unknown[] }));

vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class {
    send = sends.secrets;
    constructor(config: unknown) {
      ctorConfigs.secrets.push(config);
    }
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
    constructor(config: unknown) {
      ctorConfigs.ssm.push(config);
    }
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
  ctorConfigs.secrets.length = 0;
  ctorConfigs.ssm.length = 0;
  resetAwsClientDefaults();
});

afterEach(() => {
  resetAwsClientDefaults();
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

/**
 * A `--role-arn` assumed for cdkd's own calls must NOT answer these two reads
 * (issue [#3130](https://github.com/go-to-k/cdkd/issues/3130) review round 2).
 *
 * The resolved plaintext becomes the emulated task's ENVIRONMENT, so letting
 * the deploy role — typically the more privileged identity — answer would read
 * secrets the caller's own principal cannot and hand them to local code.
 *
 * The observable is the IDENTITY on the client CONFIG, never the absence of a
 * `credentials` key. Absence is what the opt-out used to produce, and it is
 * precisely the inert shape PR #3223 round 5 had to remove: with no profile
 * selected, the SDK's own chain reads its first answer out of the `AWS_*`
 * triple `applyRoleArnIfSet` had just overwritten with the role, so an
 * empty config resolved the role under the name of opting out of it. The
 * opt-out now INJECTS the caller's own identity, and these cases read it back.
 */
describe('secret reads run as the CALLER, never as the CLI-wide assumed role', () => {
  const entry = {
    containerName: 'web',
    name: 'TOKEN',
    valueFrom: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:foo-AbCdEf',
  };
  const ROLE_KEY = 'ASIADEPLOYROLEKEY0000';
  // 21 characters, like its sibling: `git-secrets` matches an AWS access key
  // id as EXACTLY 20, so a 20-character placeholder blocks the commit.
  const CALLER_KEY = 'AKIACALLEROWNCREDS000';

  /**
   * `AWS_PROFILE` is cleared because a selected profile takes the opt-out down
   * shape 1, where nothing is injected and `credentials` is legitimately
   * absent — which would make the positive assertion below vacuous again, this
   * time via the developer's own environment rather than via the code. The
   * triple is saved because these cases WRITE it, standing in for the
   * overwrite `applyRoleArnIfSet` performs, and it must not leak onward.
   */
  const OWNED_ENV = [
    'AWS_PROFILE',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
  ] as const;
  let savedEnv: Record<string, string | undefined>;
  beforeEach(() => {
    savedEnv = Object.fromEntries(OWNED_ENV.map((n) => [n, process.env[n]]));
    for (const n of OWNED_ENV) delete process.env[n];
  });
  afterEach(() => {
    for (const n of OWNED_ENV) {
      const v = savedEnv[n];
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    }
  });

  it('builds both clients with the CALLER key, not the published role', async () => {
    // Exactly the state `applyRoleArnIfSet` leaves behind: the caller's own
    // triple snapshotted, the environment overwritten with the role's, the
    // role published. The snapshot takes the opt-out down shape 2, so
    // `credentials` is a STATIC bag and the key can be read back directly —
    // which is what makes this a positive assertion rather than the
    // `!== ROLE_KEY` check it replaced, satisfied for free by a `credentials`
    // that is a provider FUNCTION with no `accessKeyId` on it at all.
    setPreAssumeEnvCredentials({
      accessKeyId: CALLER_KEY,
      secretAccessKey: 'callersecret',
      sessionToken: 'callertoken',
    });
    process.env['AWS_ACCESS_KEY_ID'] = ROLE_KEY;
    process.env['AWS_SECRET_ACCESS_KEY'] = 'deploysecret';
    process.env['AWS_SESSION_TOKEN'] = 'deploytoken';
    setAssumedRoleCredentials({
      accessKeyId: ROLE_KEY,
      secretAccessKey: 'deploysecret',
      sessionToken: 'deploytoken',
    });
    sends.secrets.mockResolvedValueOnce({ SecretString: 'v' });

    await resolveEcsSecrets([entry], { region: 'us-east-1' });

    expect(ctorConfigs.secrets).toHaveLength(1);
    expect(ctorConfigs.ssm).toHaveLength(1);
    for (const config of [...ctorConfigs.secrets, ...ctorConfigs.ssm]) {
      expect(config).toMatchObject({ region: 'us-east-1' });
      const credentials = (config as { credentials?: { accessKeyId?: string } }).credentials;
      expect(credentials?.accessKeyId).toBe(CALLER_KEY);
    }
  });

  it('injects SOMETHING even when the caller left no snapshot to restore', async () => {
    // Shape 3 — an SSO / IMDS / container-role caller. There is no static bag
    // to read a key off, so the assertion that carries here is that the config
    // is NOT the empty one: a `credentials` must be present, because that
    // presence is the whole difference between resolving the caller's chain
    // and letting the SDK read the role out of the env triple.
    process.env['AWS_ACCESS_KEY_ID'] = ROLE_KEY;
    process.env['AWS_SECRET_ACCESS_KEY'] = 'deploysecret';
    process.env['AWS_SESSION_TOKEN'] = 'deploytoken';
    setAssumedRoleCredentials({
      accessKeyId: ROLE_KEY,
      secretAccessKey: 'deploysecret',
      sessionToken: 'deploytoken',
    });
    sends.secrets.mockResolvedValueOnce({ SecretString: 'v' });

    await resolveEcsSecrets([entry], { region: 'us-east-1' });

    expect(ctorConfigs.secrets).toHaveLength(1);
    expect(ctorConfigs.ssm).toHaveLength(1);
    for (const config of [...ctorConfigs.secrets, ...ctorConfigs.ssm]) {
      expect(config).toHaveProperty('credentials');
      expect(typeof (config as { credentials?: unknown }).credentials).toBe('function');
    }
  });

  it('still constructs the same way when no role was assumed', async () => {
    // The other polarity: the opt-out must not be what makes the config
    // credential-free, or the case above would pass for the wrong reason.
    sends.secrets.mockResolvedValueOnce({ SecretString: 'v' });

    await resolveEcsSecrets([entry], { region: 'us-east-1' });

    // Same length floor as above: a walk over an empty array would satisfy
    // the loop vacuously, which is the failure this polarity exists to rule
    // out for the other one.
    expect(ctorConfigs.secrets).toHaveLength(1);
    expect(ctorConfigs.ssm).toHaveLength(1);
    for (const config of [...ctorConfigs.secrets, ...ctorConfigs.ssm]) {
      expect(config).not.toHaveProperty('credentials');
    }
  });
});
