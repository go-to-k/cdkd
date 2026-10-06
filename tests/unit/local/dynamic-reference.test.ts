import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * Issue [#2056](https://github.com/go-to-k/cdkd/issues/2056): the resolver the
 * cdkd-owned `local` commands use builds its Secrets Manager / SSM clients as
 * the CALLER, never the `--role-arn` role — the resolved value lands in the
 * container, the reason `--from-cfn-stack`'s decrypting clients opt out too.
 *
 * The SDK client constructors are captured, so each case reads the exact
 * config a lookup's client was built with.
 */

const h = vi.hoisted(() => ({
  smConfigs: [] as Record<string, unknown>[],
  ssmConfigs: [] as Record<string, unknown>[],
}));

vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: vi.fn((config: Record<string, unknown>) => {
    h.smConfigs.push(config);
    return {
      send: async () => ({ SecretString: JSON.stringify({ password: 'plain-2056-helper' }) }),
      destroy: () => undefined,
    };
  }),
  GetSecretValueCommand: vi.fn((input: unknown) => ({ input })),
}));

vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: vi.fn((config: Record<string, unknown>) => {
    h.ssmConfigs.push(config);
    return {
      send: async () => ({ Parameter: { Type: 'String', Value: 'plain-ssm' } }),
      destroy: () => undefined,
    };
  }),
  GetParameterCommand: vi.fn((input: unknown) => ({ input })),
}));

import { createCallerDynamicReferenceResolver } from '../../../src/local/dynamic-reference.js';
import {
  resetAwsClientDefaults,
  setAssumedRoleCredentials,
  setPreAssumeEnvCredentials,
} from '../../../src/utils/aws-client-defaults.js';

const ROLE = { accessKeyId: 'ROLE-AKID-2056', secretAccessKey: 'role-secret', sessionToken: 'role-tok' };
const CALLER = { accessKeyId: 'CALLER-AKID-2056', secretAccessKey: 'caller-secret' };

async function credentialsOf(config: Record<string, unknown>): Promise<unknown> {
  const c = config['credentials'];
  return typeof c === 'function' ? await (c as () => Promise<unknown>)() : c;
}

afterEach(() => {
  h.smConfigs.length = 0;
  h.ssmConfigs.length = 0;
  resetAwsClientDefaults();
});

describe('createCallerDynamicReferenceResolver (#2056)', () => {
  it('under a published --role-arn role, both clients resolve the CALLER, in the lookup region', async () => {
    setPreAssumeEnvCredentials(CALLER);
    setAssumedRoleCredentials(ROLE);
    const r = createCallerDynamicReferenceResolver(undefined);
    try {
      await expect(
        r.resolveString('{{resolve:secretsmanager:s:SecretString:password::}}', {
          region: 'eu-west-1',
          consumer: 'test',
        })
      ).resolves.toBe('plain-2056-helper');
      await expect(
        r.resolveString('{{resolve:ssm:/p}}', { region: 'ap-south-1', consumer: 'test' })
      ).resolves.toBe('plain-ssm');
    } finally {
      r.dispose();
    }
    expect(h.smConfigs).toHaveLength(1);
    expect(h.ssmConfigs).toHaveLength(1);
    expect(h.smConfigs[0]!['region']).toBe('eu-west-1');
    expect(h.ssmConfigs[0]!['region']).toBe('ap-south-1');
    for (const config of [h.smConfigs[0]!, h.ssmConfigs[0]!]) {
      const creds = (await credentialsOf(config)) as { accessKeyId?: string } | undefined;
      expect(creds?.accessKeyId).toBe(CALLER.accessKeyId);
    }
  });

  it('--profile reaches both clients', async () => {
    setPreAssumeEnvCredentials(CALLER);
    setAssumedRoleCredentials(ROLE);
    const r = createCallerDynamicReferenceResolver('dev-profile');
    try {
      await r.resolveString('{{resolve:ssm:/p}}', { region: 'us-east-1', consumer: 'test' });
      await r.resolveString('{{resolve:secretsmanager:s:SecretString:password::}}', {
        region: 'us-east-1',
        consumer: 'test',
      });
    } finally {
      r.dispose();
    }
    for (const config of [h.ssmConfigs[0]!, h.smConfigs[0]!]) {
      expect(config['profile']).toBe('dev-profile');
      const creds = (await credentialsOf(config)) as { accessKeyId?: string } | undefined;
      expect(creds?.accessKeyId).not.toBe(ROLE.accessKeyId);
    }
  });

  it('an upper-cased state-record region reaches the client folded', async () => {
    const r = createCallerDynamicReferenceResolver(undefined);
    try {
      await r.resolveString('{{resolve:ssm:/p}}', { region: 'US-EAST-1', consumer: 'test' });
      await r.resolveString('{{resolve:secretsmanager:s:SecretString:password::}}', {
        region: 'EU-WEST-1',
        consumer: 'test',
      });
    } finally {
      r.dispose();
    }
    expect(h.ssmConfigs[0]!['region']).toBe('us-east-1');
    expect(h.smConfigs[0]!['region']).toBe('eu-west-1');
  });
});
