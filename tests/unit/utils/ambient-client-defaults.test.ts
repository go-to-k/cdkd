/**
 * `ambientClientDefaults()` and the sites routed through it (issue #3588).
 *
 * A library caller installing `new AwsClients({ credentials })` must have every
 * SDK client cdkd builds OUTSIDE `AwsClients` sign as that identity. One case
 * per family of site: the helper itself, an SDK provider reached through the
 * provider registry, a synthesis context provider, an asset publisher, and the
 * cross-account `Fn::GetStackOutput` STS hop (source identity + cache key).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const clientConfigs: Record<string, Record<string, unknown>[]> = {};
function recordingClient(name: string, send: (command: unknown) => unknown) {
  return vi.fn().mockImplementation((config: Record<string, unknown>) => {
    (clientConfigs[name] ??= []).push(config);
    return {
      send: vi.fn(async (command: unknown) => send(command)),
      destroy: vi.fn(),
      config: { region: async () => config['region'] },
    };
  });
}

const stsSend = vi.fn();
vi.mock('@aws-sdk/client-sts', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-sts')>('@aws-sdk/client-sts');
  return { ...actual, STSClient: recordingClient('sts', (command) => stsSend(command)) };
});
vi.mock('@aws-sdk/client-sfn', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-sfn')>('@aws-sdk/client-sfn');
  return { ...actual, SFNClient: recordingClient('sfn', () => ({})) };
});
vi.mock('@aws-sdk/client-ec2', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-ec2')>('@aws-sdk/client-ec2');
  return {
    ...actual,
    EC2Client: recordingClient('ec2', () => ({
      Images: [{ ImageId: 'ami-1', CreationDate: '2026-01-01T00:00:00Z' }],
    })),
  };
});

import { AssumeRoleCommand, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import {
  ambientClientDefaults,
  ambientCredentialConfig,
  clientDefaultsFor,
  credentialFingerprint,
} from '../../../src/utils/ambient-client-defaults.js';
import {
  awsClientDefaults,
  resetAwsClientDefaults,
  setAssumedRoleCredentials,
} from '../../../src/utils/aws-client-defaults.js';
import {
  AwsClients,
  resetAwsClients,
  runWithStackAwsClients,
  setAwsClients,
} from '../../../src/utils/aws-clients.js';
import {
  assumeRoleForCrossAccountStateRead,
  clearCrossAccountCredentialsCache,
} from '../../../src/utils/role-arn.js';
import { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import { registerAllProviders } from '../../../src/provisioning/register-providers.js';
import { AmiContextProvider } from '../../../src/synthesis/context-providers/ami-provider.js';
import { AssetPublisher } from '../../../src/assets/asset-publisher.js';

const EXPLICIT = {
  accessKeyId: 'AKIDEXPLICIT3588',
  secretAccessKey: 'explicit-secret-3588',
  sessionToken: 'explicit-token-3588',
};
const OTHER = {
  accessKeyId: 'AKIDOTHER3588',
  secretAccessKey: 'other-secret-3588',
};

beforeEach(() => {
  for (const key of Object.keys(clientConfigs)) delete clientConfigs[key];
  stsSend.mockReset();
  clearCrossAccountCredentialsCache();
});
afterEach(() => {
  resetAwsClients();
  resetAwsClientDefaults();
});

describe('ambientClientDefaults', () => {
  it('carries the global AwsClients explicit credentials and profile', () => {
    setAwsClients(
      new AwsClients({ region: 'us-east-1', profile: 'lib-profile', credentials: EXPLICIT })
    );
    expect(ambientClientDefaults()).toEqual({ profile: 'lib-profile', credentials: EXPLICIT });
  });

  it("reads the STACK scope's clients over the global", () => {
    setAwsClients(new AwsClients({ region: 'us-east-1', credentials: OTHER }));
    const inScope = runWithStackAwsClients(
      new AwsClients({ region: 'eu-west-1', credentials: EXPLICIT }),
      () => ambientClientDefaults()
    );
    // The scope's region arrives through awsClientDefaults(), unchanged.
    expect(inScope).toEqual({ region: 'eu-west-1', credentials: EXPLICIT });
  });

  it('degrades to plain awsClientDefaults() with no explicit configuration', () => {
    setAwsClients(new AwsClients({ region: 'us-east-1' }));
    expect(ambientClientDefaults()).toEqual(awsClientDefaults());
    expect(ambientClientDefaults()).toEqual({});
  });

  it('degrades for a test double that has no credentialConfig', () => {
    setAwsClients({ destroy: () => {} } as unknown as AwsClients);
    expect(ambientCredentialConfig()).toEqual({});
    expect(ambientClientDefaults()).toEqual({});
  });

  it('lets explicit credentials outrank a published --role-arn role, as AwsClients does', () => {
    const role = { accessKeyId: 'ASIAROLE', secretAccessKey: 'role-secret', sessionToken: 't' };
    setAssumedRoleCredentials(role);
    setAwsClients(new AwsClients({ region: 'us-east-1', credentials: EXPLICIT }));
    expect(ambientClientDefaults().credentials).toEqual(EXPLICIT);

    setAwsClients(new AwsClients({ region: 'us-east-1' }));
    expect(ambientClientDefaults().credentials).toEqual(role);
  });

  it('hands each call its own copy of the credentials', () => {
    const config = { credentials: { ...EXPLICIT } };
    const built = clientDefaultsFor(config);
    expect(built.credentials).toEqual(EXPLICIT);
    expect(built.credentials).not.toBe(config.credentials);
  });
});

describe('credentialFingerprint', () => {
  it('tells profiles and access keys apart', () => {
    const keys = [
      credentialFingerprint({}),
      credentialFingerprint({ profile: 'a' }),
      credentialFingerprint({ profile: 'b' }),
      credentialFingerprint({ credentials: EXPLICIT }),
      credentialFingerprint({ credentials: OTHER }),
      credentialFingerprint({ profile: 'a', credentials: EXPLICIT }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('never carries secret material', () => {
    const key = credentialFingerprint({ profile: 'p', credentials: EXPLICIT });
    expect(key).not.toContain(EXPLICIT.secretAccessKey);
    expect(key).not.toContain(EXPLICIT.sessionToken);
  });
});

describe('routed sites carry the explicit credentials', () => {
  it('an SDK provider reached through the provider registry', async () => {
    const clients = new AwsClients({ region: 'eu-west-1', credentials: EXPLICIT });
    await runWithStackAwsClients(clients, async () => {
      const registry = new ProviderRegistry();
      registerAllProviders(registry);
      const provider = registry.getProvider('AWS::StepFunctions::StateMachine');
      await provider.delete(
        'Machine',
        'arn:aws:states:eu-west-1:123456789012:stateMachine:m',
        'AWS::StepFunctions::StateMachine'
      );
    });
    expect(clientConfigs['sfn']).toHaveLength(1);
    expect(clientConfigs['sfn']![0]).toMatchObject({ region: 'eu-west-1', credentials: EXPLICIT });
  });

  it('a synthesis context provider', async () => {
    setAwsClients(new AwsClients({ region: 'us-east-1', credentials: EXPLICIT }));
    await new AmiContextProvider({ region: 'us-west-2' }).resolve({ owners: ['amazon'] });
    expect(clientConfigs['ec2']).toHaveLength(1);
    expect(clientConfigs['ec2']![0]).toMatchObject({ region: 'us-west-2', credentials: EXPLICIT });
  });

  it("an asset publisher's account lookup", async () => {
    setAwsClients(new AwsClients({ region: 'us-east-1', credentials: EXPLICIT }));
    stsSend.mockImplementation(async (command: unknown) => {
      if (command instanceof GetCallerIdentityCommand) return { Account: '123456789012' };
      throw new Error('unexpected');
    });
    // The manifest does not exist, so the publish fails AFTER the lookup —
    // which is the one client this case is about.
    await expect(
      new AssetPublisher().publishFromManifest('/nonexistent/3588/manifest.json', {
        region: 'us-east-1',
      })
    ).rejects.toThrow();
    expect(clientConfigs['sts']).toHaveLength(1);
    expect(clientConfigs['sts']![0]).toMatchObject({ credentials: EXPLICIT });
  });
});

describe('assumeRoleForCrossAccountStateRead source identity (#3588)', () => {
  const ROLE = 'arn:aws:iam::111122223333:role/Producer';
  let issued = 0;
  beforeEach(() => {
    issued = 0;
    stsSend.mockImplementation(async (command: unknown) => {
      if (!(command instanceof AssumeRoleCommand)) throw new Error('unexpected');
      issued += 1;
      return {
        Credentials: {
          AccessKeyId: `ASIAXACC${issued}`,
          SecretAccessKey: `xacc-secret-${issued}`,
          SessionToken: `xacc-token-${issued}`,
          Expiration: new Date(Date.now() + 3_600_000),
        },
      };
    });
  });

  it('takes the hop as the active explicit credentials', async () => {
    setAwsClients(new AwsClients({ region: 'us-east-1', credentials: EXPLICIT }));
    await assumeRoleForCrossAccountStateRead(ROLE);
    expect(clientConfigs['sts']).toHaveLength(1);
    expect(clientConfigs['sts']![0]).toMatchObject({ credentials: EXPLICIT });
  });

  it('does not hand one source identity the credentials another obtained', async () => {
    const first = await runWithStackAwsClients(
      new AwsClients({ region: 'us-east-1', credentials: EXPLICIT }),
      () => assumeRoleForCrossAccountStateRead(ROLE)
    );
    const second = await runWithStackAwsClients(
      new AwsClients({ region: 'us-east-1', credentials: OTHER }),
      () => assumeRoleForCrossAccountStateRead(ROLE)
    );
    expect(issued).toBe(2);
    expect(second.accessKeyId).not.toBe(first.accessKeyId);
    expect(clientConfigs['sts']!.map((config) => config['credentials'])).toEqual([
      EXPLICIT,
      OTHER,
    ]);
  });

  it('still shares one hop for the SAME source identity', async () => {
    setAwsClients(new AwsClients({ region: 'us-east-1', credentials: EXPLICIT }));
    const first = await assumeRoleForCrossAccountStateRead(ROLE);
    const second = await assumeRoleForCrossAccountStateRead(ROLE);
    expect(issued).toBe(1);
    expect(second).toBe(first);
  });
});
