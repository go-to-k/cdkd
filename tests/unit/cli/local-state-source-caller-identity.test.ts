import { BedrockAgentCoreControlClient } from '@aws-sdk/client-bedrock-agentcore-control';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { SSMClient } from '@aws-sdk/client-ssm';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import { createLocalStartAgentCoreCommand } from '../../../src/cli/commands/local-start-agentcore.js';
import { createLocalStartAlbCommand } from '../../../src/cli/commands/local-start-alb.js';
import { createLocalStartCloudFrontCommand } from '../../../src/cli/commands/local-start-cloudfront.js';
import { createLocalStartServiceCommand } from '../../../src/cli/commands/local-start-service.js';
import {
  bindCallerIdentityClients,
  CFN_PROVIDER_CLIENT_GETTERS,
  CfnLocalStateProvider,
  cfnProviderShapeDrift,
  isAssumeRequested,
  createLocalStateProvider,
  engineCredentialTripleChannel,
  engineFromCfnStackChannel,
  CFN_PROVIDER_PROTOTYPE_MEMBERS,
  ENGINE_ASSUME_ROLE_CHANNEL,
  engineRoleExposureWarning,
  ENGINE_ACCOUNT_ID_CHANNEL,
  ENGINE_DYNAMIC_REFERENCE_CHANNEL,
  ENGINE_ECS_SECRETS_CHANNEL,
  type LocalStateSourceOptions,
} from '../../../src/cli/commands/local-state-source.js';
import {
  resetAwsClientDefaults,
  setAssumedRoleCredentials,
  setPreAssumeEnvCredentials,
} from '../../../src/utils/aws-client-defaults.js';
import { getLogger } from '../../../src/utils/logger.js';
import { isIamRoleArn } from '../../../src/utils/role-arn.js';

/**
 * Issue go-to-k/cdkd#3240, channel 4: `--from-cfn-stack` on the four cdkd-owned
 * `local` commands must read the deployed stack as the CALLER, never as the
 * `--role-arn` role whose triple sits in `process.env`.
 *
 * The discriminator is the identity the SENDING client resolves: the process
 * environment holds the ROLE's keys (what cdk-local's own client would read
 * through `fromEnv`), and the pre-assume snapshot holds the CALLER's. Each case
 * drives the provider's REAL public method, so a cdk-local release renaming the
 * private getter this module shadows leaves cdk-local's own client sending and
 * the case red.
 */

const ROLE = { accessKeyId: 'AKIAROLEROLEROLE', secretAccessKey: 'role-secret', sessionToken: 'role-token' };
const CALLER = { accessKeyId: 'AKIACALLERCALLER', secretAccessKey: 'caller-secret' };

const ENV_KEYS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'CDKD_ROLE_ARN',
] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

function publishRole(): void {
  process.env['AWS_ACCESS_KEY_ID'] = ROLE.accessKeyId;
  process.env['AWS_SECRET_ACCESS_KEY'] = ROLE.secretAccessKey;
  process.env['AWS_SESSION_TOKEN'] = ROLE.sessionToken;
  setPreAssumeEnvCredentials(CALLER);
  setAssumedRoleCredentials(ROLE);
}

function cfnOptions(overrides: Partial<LocalStateSourceOptions> = {}): LocalStateSourceOptions {
  return {
    fromState: false,
    statePrefix: 'cdkd',
    fromCfnStack: 'DeployedStack',
    region: 'us-east-1',
    ...overrides,
  };
}

interface SendRecord {
  client: unknown;
  accessKeyId: string;
}

/**
 * Stub `send` on a client class: record which INSTANCE sent and the access key
 * its credential provider resolves, then fail the call so the provider takes
 * its own warn-and-fall-back arm without any network.
 */
function recordSends(clientClass: { prototype: object }): SendRecord[] {
  const records: SendRecord[] = [];
  vi.spyOn(clientClass.prototype as { send: (...a: unknown[]) => unknown }, 'send').mockImplementation(
    async function (this: { config: { credentials: () => Promise<{ accessKeyId: string }> } }) {
      const identity = await this.config.credentials();
      records.push({ client: this, accessKeyId: identity.accessKeyId });
      throw new Error('stubbed send');
    }
  );
  return records;
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  resetAwsClientDefaults();
  vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetAwsClientDefaults();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('createLocalStateProvider --from-cfn-stack under --role-arn (#3240 channel 4)', () => {
  it('SSM GetParameters (decrypted into the container) is sent by the injected client, as the caller', async () => {
    publishRole();
    const sends = recordSends(SSMClient);
    const provider = createLocalStateProvider(cfnOptions(), 'Stack', 'us-east-1');
    expect(provider).toBeInstanceOf(CfnLocalStateProvider);
    const template = {
      Parameters: { Secret: { Type: 'AWS::SSM::Parameter::Value<String>', Default: '/app/secret' } },
      Resources: {},
    };
    await (provider as CfnLocalStateProvider)
      .resolveTemplateSsmParameters(template as never)
      .catch(() => undefined);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.accessKeyId).toBe(CALLER.accessKeyId);
    // The injected client lives in the provider's own slot, so `dispose()`
    // destroys it.
    expect(sends[0]!.client).toBe((provider as unknown as { ssmClient: unknown }).ssmClient);
    provider!.dispose?.();
  });

  it('CloudFormation ListStackResources (load) is sent as the caller', async () => {
    publishRole();
    const sends = recordSends(CloudFormationClient);
    const provider = createLocalStateProvider(cfnOptions(), 'Stack', 'us-east-1')!;
    await provider.load('Stack', 'us-east-1');
    expect(sends.length).toBeGreaterThan(0);
    expect(sends.map((s) => s.accessKeyId)).toEqual(sends.map(() => CALLER.accessKeyId));
    expect(sends[0]!.client).toBe((provider as unknown as { client: unknown }).client);
  });

  it('Lambda GetFunctionConfiguration (deployed function env) is sent as the caller', async () => {
    publishRole();
    const sends = recordSends(LambdaClient);
    const provider = createLocalStateProvider(cfnOptions(), 'Stack', 'us-east-1') as CfnLocalStateProvider;
    await provider.resolveDeployedFunctionEnv('fn-physical-id');
    expect(sends).toHaveLength(1);
    expect(sends[0]!.accessKeyId).toBe(CALLER.accessKeyId);
    expect(sends[0]!.client).toBe((provider as unknown as { lambdaClient: unknown }).lambdaClient);
  });

  it('BedrockAgentCoreControl GetAgentRuntime is sent as the caller', async () => {
    publishRole();
    const sends = recordSends(BedrockAgentCoreControlClient);
    const provider = createLocalStateProvider(cfnOptions(), 'Stack', 'us-east-1') as CfnLocalStateProvider;
    await provider.resolveAgentCoreRuntimeRoleArn('runtime-id');
    expect(sends).toHaveLength(1);
    expect(sends[0]!.accessKeyId).toBe(CALLER.accessKeyId);
    expect(sends[0]!.client).toBe(
      (provider as unknown as { agentCoreControlClient: unknown }).agentCoreControlClient
    );
  });

  it('control: an UNBOUND provider resolves the role from the environment', async () => {
    // Proves the discriminator: without the rebinding the same send resolves
    // the role's key, so the cases above cannot pass vacuously.
    publishRole();
    const sends = recordSends(LambdaClient);
    const provider = new CfnLocalStateProvider({ cfnStackName: 'DeployedStack', region: 'us-east-1' });
    await provider.resolveDeployedFunctionEnv('fn-physical-id');
    expect(sends).toHaveLength(1);
    expect(sends[0]!.accessKeyId).toBe(ROLE.accessKeyId);
  });

  it('leaves the --from-state provider alone', () => {
    publishRole();
    const provider = createLocalStateProvider(
      cfnOptions({ fromCfnStack: undefined, fromState: true, stateBucket: 'b' }),
      'Stack',
      'us-east-1'
    );
    expect(provider).toBeDefined();
    expect(provider).not.toBeInstanceOf(CfnLocalStateProvider);
  });
});

describe('bindCallerIdentityClients fails closed on upstream drift', () => {
  const SLOTS = {
    region: 'us-east-1',
    client: undefined,
    lambdaClient: undefined,
    ssmClient: undefined,
    agentCoreControlClient: undefined,
  };
  // Every allowlisted prototype member, as a fake proto.
  const PROTO: Record<string, () => undefined> = Object.fromEntries(
    CFN_PROVIDER_PROTOTYPE_MEMBERS.filter((n) => n !== 'constructor').map((n) => [n, () => undefined])
  );
  function fakeProvider(proto: object = PROTO, own: object = SLOTS): CfnLocalStateProvider {
    return Object.assign(Object.create(proto), own) as CfnLocalStateProvider;
  }
  const drop = <T extends object>(o: T, k: string): object =>
    Object.fromEntries(Object.entries(o).filter(([key]) => key !== k));

  it('the installed cdk-local provider has exactly the reviewed shape', () => {
    // Pins the caret-ranged dependency: an added or renamed member in a future
    // cdk-local fails here before it reaches a user.
    const provider = new CfnLocalStateProvider({ cfnStackName: 'S', region: 'us-east-1' });
    expect(cfnProviderShapeDrift(provider)).toEqual([]);
    expect(Object.getOwnPropertyNames(CfnLocalStateProvider.prototype).sort()).toEqual(
      [...CFN_PROVIDER_PROTOTYPE_MEMBERS].sort()
    );
  });

  it('the fake provider matches the reviewed shape (the cases below change one thing each)', () => {
    expect(cfnProviderShapeDrift(fakeProvider())).toEqual([]);
  });

  it('throws under a role when a known getter is missing (renamed upstream)', () => {
    publishRole();
    expect(() => bindCallerIdentityClients(fakeProvider(drop(PROTO, 'getSsmClient')), undefined)).toThrow(
      /has no getSsmClient\(\).*--profile/s
    );
  });

  it('throws under a role when ANY unknown method appears, client-named or not', () => {
    publishRole();
    expect(() =>
      bindCallerIdentityClients(fakeProvider({ ...PROTO, getSecretsManagerClient: () => undefined }), undefined)
    ).toThrow(/an unknown getSecretsManagerClient\(\)/);
    expect(() =>
      bindCallerIdentityClients(fakeProvider({ ...PROTO, resolveSecretValue: () => undefined }), undefined)
    ).toThrow(/an unknown resolveSecretValue\(\)/);
  });

  it('throws under a role when an unknown method sits on a base class', () => {
    publishRole();
    const base = { getSecretsManagerClient: () => undefined };
    const proto = Object.assign(Object.create(base), PROTO);
    expect(() => bindCallerIdentityClients(fakeProvider(proto), undefined)).toThrow(
      /an unknown getSecretsManagerClient\(\)/
    );
  });

  it('throws under a role when a client slot is not an OWN member, even if the proto has one', () => {
    publishRole();
    // The slot is reachable through the prototype, so an `in` check would pass.
    const proto = { ...PROTO, client: undefined };
    expect(() => bindCallerIdentityClients(fakeProvider(proto, drop(SLOTS, 'client')), undefined)).toThrow(
      /no client slot/
    );
  });

  it('throws under a role when the region field is not a string, or only inherited', () => {
    publishRole();
    expect(() => bindCallerIdentityClients(fakeProvider(PROTO, { ...SLOTS, region: 42 }), undefined)).toThrow(
      /no region field/
    );
    expect(() =>
      bindCallerIdentityClients(fakeProvider({ ...PROTO, region: 'us-east-1' }, drop(SLOTS, 'region')), undefined)
    ).toThrow(/no region field/);
  });

  it('throws under a role when the region field is gone', () => {
    publishRole();
    expect(() => bindCallerIdentityClients(fakeProvider(PROTO, drop(SLOTS, 'region')), undefined)).toThrow(
      /no region field/
    );
  });

  it('throws under a role when an unknown own *Client slot appears', () => {
    publishRole();
    expect(() =>
      bindCallerIdentityClients(fakeProvider(PROTO, { ...SLOTS, secretsClient: undefined }), undefined)
    ).toThrow(/an unknown secretsClient slot/);
  });

  it('binds nothing and does not throw on drift when no role is published', () => {
    const provider = fakeProvider(drop(PROTO, 'getSsmClient'));
    expect(() => bindCallerIdentityClients(provider, undefined)).not.toThrow();
    expect(Object.keys(provider).sort()).toEqual(Object.keys(SLOTS).sort());
  });

  it('binds nothing and does not throw on drift when a profile steers the provider (flag or AWS_PROFILE)', () => {
    publishRole();
    const viaFlag = fakeProvider(drop(PROTO, 'getSsmClient'));
    expect(() => bindCallerIdentityClients(viaFlag, 'me')).not.toThrow();
    expect(Object.keys(viaFlag).sort()).toEqual(Object.keys(SLOTS).sort());
    process.env['AWS_PROFILE'] = 'me';
    const viaEnv = fakeProvider(drop(PROTO, 'getSsmClient'));
    expect(() => bindCallerIdentityClients(viaEnv, undefined)).not.toThrow();
    expect(Object.keys(viaEnv).sort()).toEqual(Object.keys(SLOTS).sort());
  });
});

describe('createLocalStateProvider refuses a --from-cfn-stack provider it cannot rebind', () => {
  async function withForeignProvider(run: () => void): Promise<void> {
    // The dispatcher returning something that is not CfnLocalStateProvider for
    // --from-cfn-stack: stub the base class's instanceof check.
    const original = Object.getOwnPropertyDescriptor(CfnLocalStateProvider, Symbol.hasInstance);
    Object.defineProperty(CfnLocalStateProvider, Symbol.hasInstance, {
      value: () => false,
      configurable: true,
    });
    try {
      run();
    } finally {
      if (original) Object.defineProperty(CfnLocalStateProvider, Symbol.hasInstance, original);
      else delete (CfnLocalStateProvider as unknown as Record<symbol, unknown>)[Symbol.hasInstance];
    }
  }

  it('throws under a role with no profile', async () => {
    publishRole();
    await withForeignProvider(() => {
      expect(() => createLocalStateProvider(cfnOptions(), 'Stack', 'us-east-1')).toThrow(
        /not CfnLocalStateProvider.*--profile/s
      );
    });
  });

  it('returns it unbound when a profile steers it, or no role is published', async () => {
    await withForeignProvider(() => {
      expect(() => createLocalStateProvider(cfnOptions(), 'Stack', 'us-east-1')).not.toThrow();
    });
    publishRole();
    await withForeignProvider(() => {
      expect(() => createLocalStateProvider(cfnOptions({ profile: 'me' }), 'Stack', 'us-east-1')).not.toThrow();
    });
  });
});

describe('rebound getters: dispose guard and memoization', () => {
  for (const [getter, slot] of [
    ['getClient', 'client'],
    ['getLambdaClient', 'lambdaClient'],
    ['getSsmClient', 'ssmClient'],
    ['getAgentCoreControlClient', 'agentCoreControlClient'],
  ] as const) {
    it(`${getter}: returns the same instance on every call, from its own slot`, () => {
      publishRole();
      const provider = createLocalStateProvider(cfnOptions(), 'Stack', 'us-east-1')!;
      const get = (provider as unknown as Record<string, () => unknown>)[getter]!;
      const first = get();
      expect(get()).toBe(first);
      expect((provider as unknown as Record<string, unknown>)[slot]).toBe(first);
      provider.dispose?.();
    });

    it(`${getter}: refuses use after dispose()`, () => {
      publishRole();
      const provider = createLocalStateProvider(cfnOptions(), 'Stack', 'us-east-1')!;
      // Shadowed getter, not cdk-local's: the binding is an OWN property.
      expect(Object.hasOwn(provider, getter)).toBe(true);
      provider.dispose?.();
      expect(() => (provider as unknown as Record<string, () => unknown>)[getter]!()).toThrow(
        /used after dispose/
      );
    });
  }
});

describe('rebound clients keep the base region and profile', () => {
  it('reads in the --stack-region, not the synth region', async () => {
    publishRole();
    const sends = recordSends(CloudFormationClient);
    const provider = createLocalStateProvider(cfnOptions({ stackRegion: 'eu-west-1' }), 'Stack', 'us-east-1')!;
    await provider.load('Stack', 'us-east-1');
    const client = sends[0]!.client as { config: { region: () => Promise<string> } };
    expect(await client.config.region()).toBe('eu-west-1');
  });

  for (const [getter, slot] of [
    ['getClient', 'client'],
    ['getLambdaClient', 'lambdaClient'],
    ['getSsmClient', 'ssmClient'],
    ['getAgentCoreControlClient', 'agentCoreControlClient'],
  ] as const) {
    it(`${getter}: a --profile reaches the client and no static credentials are injected over it`, async () => {
      publishRole();
      // A profile no config file defines: the SDK's profile chain must FAIL to
      // resolve it, which it can only do if the caller snapshot was not injected
      // as a static bag over the profile key (that would resolve the caller).
      const saved = {
        AWS_CONFIG_FILE: process.env['AWS_CONFIG_FILE'],
        AWS_SHARED_CREDENTIALS_FILE: process.env['AWS_SHARED_CREDENTIALS_FILE'],
        AWS_EC2_METADATA_DISABLED: process.env['AWS_EC2_METADATA_DISABLED'],
      };
      // No IMDS hop: the chain must fail locally, never reach the network.
      process.env['AWS_EC2_METADATA_DISABLED'] = 'true';
      process.env['AWS_CONFIG_FILE'] = '/nonexistent/cdkd-3240-config';
      process.env['AWS_SHARED_CREDENTIALS_FILE'] = '/nonexistent/cdkd-3240-credentials';
      try {
        const profile = 'cdkd-3240-undefined-profile';
        const provider = createLocalStateProvider(cfnOptions({ profile }), 'Stack', 'us-east-1')!;
        const client = (provider as unknown as Record<string, () => { config: Record<string, unknown> }>)[
          getter
        ]!();
        expect(client.config['profile']).toBe(profile);
        expect(client).toBe((provider as unknown as Record<string, unknown>)[slot]);
        await expect((client.config['credentials'] as () => Promise<unknown>)()).rejects.toThrow();
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    });
  }
});

describe('the malformed-ARN silence agrees with the installed cdk-local', () => {
  it("cdkd's isIamRoleArn accepts exactly what cdk-local's applyRoleArnIfSet would assume", () => {
    // The warning skips an ARN cdkd's check rejects, on the premise that the
    // engine refuses it too. Read the engine's own pattern and length cap out of
    // the installed bundle and compare behaviour, so a cdk-local release that
    // LOOSENS its check (and would assume an ARN cdkd stays silent about) fails.
    const dist = dirname(fileURLToPath(import.meta.resolve('cdk-local')));
    const bundle = readdirSync(dist)
      .filter((f) => f.endsWith('.js'))
      .map((f) => readFileSync(join(dist, f), 'utf8'))
      .find((src) => src.includes('const IAM_ROLE_ARN_PATTERN = '));
    expect(bundle).toBeDefined();
    const pattern = /const IAM_ROLE_ARN_PATTERN = \/(.+)\/;\n/.exec(bundle!)?.[1];
    const maxLength = Number(/const IAM_ROLE_ARN_MAX_LENGTH = (\d+);/.exec(bundle!)?.[1]);
    expect(pattern).toBeDefined();
    expect(maxLength).toBeGreaterThan(0);
    const engine = new RegExp(pattern!);
    const engineAccepts = (v: string): boolean => v.length <= maxLength && engine.test(v);
    const corpus = [
      'arn:aws:iam::222222222222:role/deploy',
      'arn:aws-cn:iam::222222222222:role/path/deploy',
      'arn:aws-us-gov:iam::222222222222:role/a+b=c,d.e@f-g',
      'arn:aws:iam::222222222222:role/',
      'arn:aws:iam::222222222222:user/deploy',
      'arn:aws:iam::abc:role/deploy',
      // Characters in the engine's `[!-~]` but outside IAM's documented
      // `[\\w+=,.@/-]`, and a non-12-digit account: the engine assumes both,
      // so cdkd must not call them malformed and silence the warning.
      'arn:aws:iam::222222222222:role/p!a(t)h/de#ploy',
      'arn:aws:iam::1234:role/deploy',
      'arn:aws:iam::222222222222:role/de ploy',
      'arn:aws:sts::222222222222:assumed-role/deploy/s',
      'not-an-arn',
      '',
      `arn:aws:iam::222222222222:role/${'r'.repeat(2048)}`,
      `arn:aws:iam::222222222222:role/${'r'.repeat(2048 - 'arn:aws:iam::222222222222:role/'.length)}`,
    ];
    for (const value of corpus) expect([value.slice(0, 60), isIamRoleArn(value)]).toEqual([value.slice(0, 60), engineAccepts(value)]);
  });
});

describe('engineRoleExposureWarning (#3240, engine channels)', () => {
  const ROLE_ARN = 'arn:aws:iam::222222222222:role/deploy';
  const albChannels = [
    engineCredentialTripleChannel('the Lambda containers'),
    ENGINE_ECS_SECRETS_CHANNEL,
    ENGINE_ACCOUNT_ID_CHANNEL,
  ];
  const CFN = engineFromCfnStackChannel();
  const base = {
    roleArn: ROLE_ARN,
    profileFlag: undefined,
    envProfile: undefined,
    fromCfnStack: false,
    assumesForWorkload: false,
  };

  it('is silent for a malformed role ARN, which the engine refuses before assuming', () => {
    expect(engineRoleExposureWarning('start-alb', albChannels, CFN, { ...base, roleArn: 'not-an-arn' })).toBe(
      undefined
    );
  });

  it('isAssumeRequested: every option shape the engines parse', () => {
    expect(isAssumeRequested(undefined)).toBe(false);
    expect(isAssumeRequested(false)).toBe(false);
    expect(isAssumeRequested('')).toBe(false);
    expect(isAssumeRequested({})).toBe(false);
    expect(isAssumeRequested(true)).toBe(true);
    expect(isAssumeRequested('arn:aws:iam::222222222222:role/fn')).toBe(true);
    expect(isAssumeRequested({ Fn: 'arn:aws:iam::222222222222:role/fn' })).toBe(true);
  });

  it('adds the --assume-role channel only when that flag is set', () => {
    expect(engineRoleExposureWarning('start-alb', albChannels, CFN, base)).not.toContain('--assume-role');
    expect(
      engineRoleExposureWarning('start-alb', albChannels, CFN, { ...base, assumesForWorkload: true })
    ).toContain('assumed BY the --role-arn role');
  });

  it('is silent without a role', () => {
    expect(engineRoleExposureWarning('start-alb', albChannels, CFN, { ...base, roleArn: undefined })).toBe(
      undefined
    );
  });

  it('is silent when the --profile flag is set', () => {
    expect(engineRoleExposureWarning('start-alb', albChannels, CFN, { ...base, profileFlag: 'me' })).toBe(
      undefined
    );
  });

  it('names every channel, the upstream issue and the remedy with no profile', () => {
    const msg = engineRoleExposureWarning('start-alb', albChannels, CFN, base)!;
    expect(msg).toContain('cdkd local start-alb');
    expect(msg).toContain('copied into the Lambda containers');
    expect(msg).toContain('ECS task secrets');
    expect(msg).toContain('${AWS::AccountId}');
    expect(msg).not.toContain('--from-cfn-stack');
    expect(msg).toContain('--profile <name>');
    expect(msg).toContain('go-to-k/cdk-local#783');
  });

  it('adds the --from-cfn-stack channel only when that flag is set', () => {
    const msg = engineRoleExposureWarning('start-alb', albChannels, CFN, { ...base, fromCfnStack: true })!;
    expect(msg).toContain('--from-cfn-stack reads the deployed stack');
  });

  it('with only an exported AWS_PROFILE, keeps just the flag-only credential-triple channel', () => {
    const msg = engineRoleExposureWarning('start-alb', albChannels, CFN, {
      ...base,
      envProfile: 'me',
      fromCfnStack: true,
    })!;
    expect(msg).toContain('exported AWS_PROFILE does not cover');
    expect(msg).toContain('copied into the Lambda containers');
    expect(msg).not.toContain('ECS task secrets');
    expect(msg).not.toContain('--from-cfn-stack reads');
  });

  it('an exported AWS_PROFILE closes the --assume-role channel (it is not flag-only)', () => {
    expect(ENGINE_ASSUME_ROLE_CHANNEL.flagOnly).toBe(false);
    expect(
      engineRoleExposureWarning('start-service', [ENGINE_ECS_SECRETS_CHANNEL], CFN, {
        ...base,
        envProfile: 'me',
        assumesForWorkload: true,
      })
    ).toBe(undefined);
  });

  it('names extra --from-cfn-stack reads only for the command that passes them', () => {
    const cf = engineFromCfnStackChannel("a deployed S3 origin's objects and KeyValueStore entries");
    expect(
      engineRoleExposureWarning('start-cloudfront', [], cf, { ...base, fromCfnStack: true })
    ).toContain('KeyValueStore');
    expect(
      engineRoleExposureWarning('start-alb', albChannels, CFN, { ...base, fromCfnStack: true })
    ).not.toContain('KeyValueStore');
  });

  it('names the {{resolve:...}} channel (#2056), which is not flag-only', () => {
    expect(ENGINE_DYNAMIC_REFERENCE_CHANNEL.flagOnly).toBe(false);
    expect(
      engineRoleExposureWarning('start-agentcore', [ENGINE_DYNAMIC_REFERENCE_CHANNEL], CFN, base)
    ).toContain('CloudFormation dynamic references ({{resolve:...}}) are fetched with the role');
    expect(
      engineRoleExposureWarning('start-agentcore', [ENGINE_DYNAMIC_REFERENCE_CHANNEL], CFN, {
        ...base,
        envProfile: 'me',
      })
    ).toBe(undefined);
  });

  it('is silent for start-service with an exported AWS_PROFILE (no flag-only channel there)', () => {
    expect(
      engineRoleExposureWarning(
        'start-service',
        [ENGINE_ECS_SECRETS_CHANNEL, ENGINE_ACCOUNT_ID_CHANNEL],
        CFN,
        { ...base, envProfile: 'me' }
      )
    ).toBe(undefined);
  });
});

describe('the four engine commands install the warning', () => {
  // Each site names its factory and a literal argv so the commander
  // parse-convention fence can resolve it; `quiet` replaces the engine action,
  // since only the preAction hooks are under test.
  function quiet(cmd: Command): void {
    cmd.exitOverride();
    cmd.action(() => undefined);
  }
  const warned = (name: string): string[] =>
    vi
      .mocked(getLogger().warn)
      .mock.calls.map((c) => String(c[0]))
      .filter((w) => w.includes(`cdkd local ${name}:`));

  it('start-service: warns under --role-arn with no profile', async () => {
    const cmd = createLocalStartServiceCommand();
    quiet(cmd);
    await cmd.parseAsync(['--role-arn', 'arn:aws:iam::222222222222:role/deploy'], { from: 'user' });
    expect(warned('start-service').some((w) => w.includes('ECS task secrets'))).toBe(true);
  });

  // Issue #2056: each engine command builds container env through cdk-local's
  // dynamic-reference resolver, whose clients take `profile` only.
  it('start-service: names the {{resolve:...}} channel under --role-arn', async () => {
    const cmd = createLocalStartServiceCommand();
    quiet(cmd);
    await cmd.parseAsync(['--role-arn', 'arn:aws:iam::222222222222:role/deploy'], { from: 'user' });
    expect(warned('start-service').some((w) => w.includes('CloudFormation dynamic references'))).toBe(true);
  });

  it('start-alb: names the {{resolve:...}} channel under --role-arn', async () => {
    const cmd = createLocalStartAlbCommand();
    quiet(cmd);
    await cmd.parseAsync(['--role-arn', 'arn:aws:iam::222222222222:role/deploy'], { from: 'user' });
    expect(warned('start-alb').some((w) => w.includes('CloudFormation dynamic references'))).toBe(true);
  });

  it('start-agentcore: names the {{resolve:...}} channel under --role-arn', async () => {
    const cmd = createLocalStartAgentCoreCommand();
    quiet(cmd);
    await cmd.parseAsync(['--role-arn', 'arn:aws:iam::222222222222:role/deploy'], { from: 'user' });
    expect(warned('start-agentcore').some((w) => w.includes('CloudFormation dynamic references'))).toBe(true);
  });

  it('start-cloudfront: names the {{resolve:...}} channel under --role-arn', async () => {
    const cmd = createLocalStartCloudFrontCommand();
    quiet(cmd);
    await cmd.parseAsync(['--role-arn', 'arn:aws:iam::222222222222:role/deploy'], { from: 'user' });
    expect(warned('start-cloudfront').some((w) => w.includes('CloudFormation dynamic references'))).toBe(true);
  });

  it('start-service: warns under CDKD_ROLE_ARN with no profile', async () => {
    process.env['CDKD_ROLE_ARN'] = 'arn:aws:iam::222222222222:role/deploy';
    const cmd = createLocalStartServiceCommand();
    quiet(cmd);
    await cmd.parseAsync([], { from: 'user' });
    expect(warned('start-service')).toHaveLength(1);
  });

  it('start-service: is silent with --profile', async () => {
    const cmd = createLocalStartServiceCommand();
    quiet(cmd);
    await cmd.parseAsync(['--role-arn', 'arn:aws:iam::222222222222:role/deploy', '--profile', 'me'], {
      from: 'user',
    });
    expect(warned('start-service')).toEqual([]);
  });

  it('start-alb: warns under --role-arn with no profile', async () => {
    const cmd = createLocalStartAlbCommand();
    quiet(cmd);
    await cmd.parseAsync(['--role-arn', 'arn:aws:iam::222222222222:role/deploy'], { from: 'user' });
    expect(warned('start-alb').some((w) => w.includes('the ALB\'s Lambda target-group containers'))).toBe(true);
  });

  it('start-alb: warns under CDKD_ROLE_ARN with no profile', async () => {
    process.env['CDKD_ROLE_ARN'] = 'arn:aws:iam::222222222222:role/deploy';
    const cmd = createLocalStartAlbCommand();
    quiet(cmd);
    await cmd.parseAsync([], { from: 'user' });
    expect(warned('start-alb')).toHaveLength(1);
  });

  it('start-alb: is silent with --profile', async () => {
    const cmd = createLocalStartAlbCommand();
    quiet(cmd);
    await cmd.parseAsync(['--role-arn', 'arn:aws:iam::222222222222:role/deploy', '--profile', 'me'], {
      from: 'user',
    });
    expect(warned('start-alb')).toEqual([]);
  });

  it('start-cloudfront: warns under --role-arn with no profile', async () => {
    const cmd = createLocalStartCloudFrontCommand();
    quiet(cmd);
    await cmd.parseAsync(['--role-arn', 'arn:aws:iam::222222222222:role/deploy'], { from: 'user' });
    expect(warned('start-cloudfront').some((w) => w.includes('Function URL and Lambda@Edge containers'))).toBe(true);
  });

  it('start-cloudfront: warns under CDKD_ROLE_ARN with no profile', async () => {
    process.env['CDKD_ROLE_ARN'] = 'arn:aws:iam::222222222222:role/deploy';
    const cmd = createLocalStartCloudFrontCommand();
    quiet(cmd);
    await cmd.parseAsync([], { from: 'user' });
    expect(warned('start-cloudfront')).toHaveLength(1);
  });

  it('start-cloudfront: is silent with --profile', async () => {
    const cmd = createLocalStartCloudFrontCommand();
    quiet(cmd);
    await cmd.parseAsync(['--role-arn', 'arn:aws:iam::222222222222:role/deploy', '--profile', 'me'], {
      from: 'user',
    });
    expect(warned('start-cloudfront')).toEqual([]);
  });

  it('start-agentcore: warns under --role-arn with no profile', async () => {
    const cmd = createLocalStartAgentCoreCommand();
    quiet(cmd);
    await cmd.parseAsync(['--role-arn', 'arn:aws:iam::222222222222:role/deploy'], { from: 'user' });
    expect(warned('start-agentcore').some((w) => w.includes('the agent container'))).toBe(true);
  });

  it('start-agentcore: warns under CDKD_ROLE_ARN with no profile', async () => {
    process.env['CDKD_ROLE_ARN'] = 'arn:aws:iam::222222222222:role/deploy';
    const cmd = createLocalStartAgentCoreCommand();
    quiet(cmd);
    await cmd.parseAsync([], { from: 'user' });
    expect(warned('start-agentcore')).toHaveLength(1);
  });

  it('start-agentcore: is silent with --profile', async () => {
    const cmd = createLocalStartAgentCoreCommand();
    quiet(cmd);
    await cmd.parseAsync(['--role-arn', 'arn:aws:iam::222222222222:role/deploy', '--profile', 'me'], {
      from: 'user',
    });
    expect(warned('start-agentcore')).toEqual([]);
  });

  it('start-alb: names --from-cfn-stack when that flag is parsed', async () => {
    const cmd = createLocalStartAlbCommand();
    quiet(cmd);
    await cmd.parseAsync(['--role-arn', 'arn:aws:iam::222222222222:role/deploy', '--from-cfn-stack'], {
      from: 'user',
    });
    expect(warned('start-alb').some((w) => w.includes('--from-cfn-stack reads'))).toBe(true);
  });

  it('start-alb: names the --assume-role channel when that flag is parsed', async () => {
    const cmd = createLocalStartAlbCommand();
    quiet(cmd);
    await cmd.parseAsync(['--role-arn', 'arn:aws:iam::222222222222:role/deploy', '--assume-role'], {
      from: 'user',
    });
    expect(warned('start-alb').some((w) => w.includes('assumed BY the --role-arn role'))).toBe(true);
  });

  it('start-alb: with an exported AWS_PROFILE names only the credential triple', async () => {
    process.env['AWS_PROFILE'] = 'me';
    const cmd = createLocalStartAlbCommand();
    quiet(cmd);
    await cmd.parseAsync(['--role-arn', 'arn:aws:iam::222222222222:role/deploy'], { from: 'user' });
    const warns = warned('start-alb');
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('exported AWS_PROFILE does not cover');
    expect(warns[0]).not.toContain('ECS task secrets');
  });

  it('start-service: silent with an exported AWS_PROFILE (it has no flag-only channel)', async () => {
    process.env['AWS_PROFILE'] = 'me';
    const cmd = createLocalStartServiceCommand();
    quiet(cmd);
    await cmd.parseAsync(['--role-arn', 'arn:aws:iam::222222222222:role/deploy'], { from: 'user' });
    expect(warned('start-service')).toEqual([]);
  });

  it('start-alb: silent for a malformed --role-arn', async () => {
    const cmd = createLocalStartAlbCommand();
    quiet(cmd);
    await cmd.parseAsync(['--role-arn', 'not-an-arn'], { from: 'user' });
    expect(warned('start-alb')).toEqual([]);
  });

  it('start-alb: names the --assume-role channel for --assume-task-role too', async () => {
    const cmd = createLocalStartAlbCommand();
    quiet(cmd);
    await cmd.parseAsync(['--role-arn', 'arn:aws:iam::222222222222:role/deploy', '--assume-task-role'], {
      from: 'user',
    });
    expect(warned('start-alb').some((w) => w.includes('assumed BY the --role-arn role'))).toBe(true);
  });

  it('start-cloudfront: --no-assume-role leaves the --assume-role channel out', async () => {
    const cmd = createLocalStartCloudFrontCommand();
    quiet(cmd);
    await cmd.parseAsync(['--role-arn', 'arn:aws:iam::222222222222:role/deploy', '--no-assume-role'], {
      from: 'user',
    });
    const warns = warned('start-cloudfront');
    expect(warns).toHaveLength(1);
    expect(warns[0]).not.toContain('assumed BY the --role-arn role');
  });

  it('start-cloudfront: its --from-cfn-stack channel names the S3-origin and KeyValueStore reads', async () => {
    const cmd = createLocalStartCloudFrontCommand();
    quiet(cmd);
    await cmd.parseAsync(['--role-arn', 'arn:aws:iam::222222222222:role/deploy', '--from-cfn-stack'], {
      from: 'user',
    });
    expect(warned('start-cloudfront').some((w) => w.includes('KeyValueStore'))).toBe(true);
  });
});
