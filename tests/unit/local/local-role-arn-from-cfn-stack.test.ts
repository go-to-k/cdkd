import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// Only the STS hop of the REAL `applyRoleArnIfSet` is faked: it returns a role
// triple. Nothing in cdk-local is mocked.
const stsSend = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-sts')>();
  return {
    ...actual,
    STSClient: vi.fn().mockImplementation(() => ({ send: stsSend, destroy: vi.fn() })),
  };
});

import { resetEmbedConfig } from 'cdk-local';
import { resetWorkloadIdentity } from 'cdk-local/internal';
import { createLocalCommand } from '../../../src/cli/commands/local-invoke.js';
import { createLocalStateProvider } from '../../../src/cli/commands/local-state-source.js';
import { applyRoleArnForLocal } from '../../../src/local/local-role-arn.js';
import { resetAwsClientDefaults } from '../../../src/utils/aws-client-defaults.js';

/**
 * go-to-k/cdkd#3240, end to end across the seam: `createLocalCommand` installs
 * `workloadIdentity: 'caller'`, `applyRoleArnForLocal` publishes the assume and
 * the caller's pre-assume snapshot, and the `--from-cfn-stack` provider cdkd
 * builds then reads CloudFormation as the CALLER, not the `--role-arn` role.
 */

const CALLER = {
  accessKeyId: 'AKIACALLERCALLER000',
  secretAccessKey: 'caller-secret',
  sessionToken: 'caller-token',
};
const ROLE = {
  AccessKeyId: 'ASIAROLEROLEROLE000',
  SecretAccessKey: 'role-secret',
  SessionToken: 'role-token',
};

const ENV_KEYS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  delete process.env['AWS_PROFILE'];
  process.env['AWS_ACCESS_KEY_ID'] = CALLER.accessKeyId;
  process.env['AWS_SECRET_ACCESS_KEY'] = CALLER.secretAccessKey;
  process.env['AWS_SESSION_TOKEN'] = CALLER.sessionToken;
  stsSend.mockReset();
  stsSend.mockResolvedValue({
    Credentials: { ...ROLE, Expiration: new Date('2030-01-01T00:00:00Z') },
  });
  resetAwsClientDefaults();
  resetWorkloadIdentity();
  resetEmbedConfig();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetAwsClientDefaults();
  resetWorkloadIdentity();
  resetEmbedConfig();
});

describe('applyRoleArnForLocal + createLocalStateProvider --from-cfn-stack', () => {
  it("builds the CloudFormation client on the caller's credentials, not the role's", async () => {
    createLocalCommand();
    await applyRoleArnForLocal({
      roleArn: 'arn:aws:iam::222222222222:role/deploy',
      region: 'us-east-1',
    });
    // The assume really happened: the process environment now holds the role.
    expect(process.env['AWS_ACCESS_KEY_ID']).toBe(ROLE.AccessKeyId);

    const provider = createLocalStateProvider(
      { fromState: false, statePrefix: 'cdkd', fromCfnStack: 'DeployedStack', region: 'us-east-1' },
      'Stack',
      'us-east-1'
    );
    expect(provider).toBeDefined();
    try {
      // `getClient` is private in cdk-local's typings; the client it builds is
      // the thing under test.
      const client = (
        provider as unknown as {
          getClient(): { config: { credentials: () => Promise<Record<string, unknown>> } };
        }
      ).getClient();
      const resolved = await client.config.credentials();
      expect(resolved).toMatchObject({
        accessKeyId: CALLER.accessKeyId,
        secretAccessKey: CALLER.secretAccessKey,
        sessionToken: CALLER.sessionToken,
      });
      expect(resolved['accessKeyId']).not.toBe(ROLE.AccessKeyId);
    } finally {
      provider!.dispose?.();
    }
  });
});
