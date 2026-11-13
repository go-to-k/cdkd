/**
 * go-to-k/cdkd#6200: a `cdkd local` workload container gets the region cdkd
 * itself resolved, on BOTH credential arms.
 *
 * The repro: an environment-agnostic stack (no `env` on the CDK `Stack`), the
 * region only in `~/.aws/config`, no `--region` / `AWS_REGION` /
 * `AWS_DEFAULT_REGION`. `cdkd deploy` resolved the profile region and deployed
 * there, but `cdkd local invoke` handed the container no `AWS_REGION`, so the
 * handler's first SDK call failed `Region is missing`. The fallback arm stopped
 * at the stack's own region (absent for an env-agnostic stack) and the
 * `--assume-role` arm stopped even earlier, at the host variables.
 *
 * The profile region is the AWS SDK's own answer (`STSClient.config.region()`,
 * the sample `resolveEffectiveRegion` gives `deploy`), so the STS module is
 * mocked with a `config.region` the test controls.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { StackStateBundle } from '../../../src/cli/commands/local-start-api/state.js';
import { getLogger } from '../../../src/utils/logger.js';

const h = vi.hoisted(() => ({
  /** What the SDK's region chain (the selected profile) answers. */
  profileRegion: undefined as string | undefined,
  /** Every STSClient constructor config, in order. */
  configs: [] as Array<Record<string, unknown>>,
  /** How many times the profile region was sampled. */
  regionSamples: 0,
  assumeFails: false,
}));

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn(function STSClient(this: unknown, config: Record<string, unknown>) {
    h.configs.push(config);
    return {
      config: {
        region: async () => {
          h.regionSamples++;
          if (h.profileRegion === undefined) throw new Error('Region is missing');
          return h.profileRegion;
        },
      },
      send: async () => {
        if (h.assumeFails) throw new Error('AccessDenied: not authorized to sts:AssumeRole');
        return {
          Credentials: { AccessKeyId: 'ASIASTS', SecretAccessKey: 's', SessionToken: 't' },
        };
      },
      destroy: () => {},
    };
  }),
  AssumeRoleCommand: vi.fn(function AssumeRoleCommand(this: unknown) {}),
  GetCallerIdentityCommand: vi.fn(function GetCallerIdentityCommand(this: unknown) {}),
}));

const { applyLambdaCredentialEnv } = await import(
  '../../../src/cli/commands/local-invoke/credentials.js'
);
const { applyAgentCoreCredentialEnv } = await import(
  '../../../src/cli/commands/local-invoke-agentcore/env.js'
);
const { buildContainerSpec } = await import(
  '../../../src/cli/commands/local-start-api/container-spec.js'
);

const ROLE = 'arn:aws:iam::123456789012:role/fn-exec';
const REGION_KEYS = ['AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_PROFILE'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(REGION_KEYS.map((k) => [k, process.env[k]]));
  for (const k of REGION_KEYS) delete process.env[k];
  h.profileRegion = undefined;
  h.configs.length = 0;
  h.regionSamples = 0;
  h.assumeFails = false;
  vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
});

afterEach(() => {
  for (const k of REGION_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

/** The STS client the AssumeRole hop was built with (the last one constructed). */
const assumeClientRegion = (): unknown => h.configs.at(-1)?.['region'];

describe('cdkd local invoke: container region from the profile / state (go-to-k/cdkd#6200)', () => {
  it('fallback arm: an env-agnostic stack gets the profile region (the live repro)', async () => {
    h.profileRegion = 'us-east-1';
    const env: Record<string, string> = {};
    await applyLambdaCredentialEnv(env, {});
    expect(env['AWS_REGION']).toBe('us-east-1');
    expect(env['AWS_DEFAULT_REGION']).toBe('us-east-1');
  });

  it('fallback arm after a FAILED --assume-role (CDK default trust) gets it too', async () => {
    h.profileRegion = 'us-east-1';
    h.assumeFails = true;
    const env: Record<string, string> = {};
    await applyLambdaCredentialEnv(env, { assumeRoleArn: ROLE });
    expect(env['AWS_REGION']).toBe('us-east-1');
    expect(env['AWS_ACCESS_KEY_ID']).toBeUndefined();
  });

  it('--assume-role arm: the STS client AND the container get the profile region', async () => {
    h.profileRegion = 'ap-northeast-1';
    const env: Record<string, string> = {};
    await applyLambdaCredentialEnv(env, { assumeRoleArn: ROLE });
    expect(env['AWS_ACCESS_KEY_ID']).toBe('ASIASTS');
    expect(assumeClientRegion()).toBe('ap-northeast-1');
    expect(env['AWS_REGION']).toBe('ap-northeast-1');
  });

  it("--assume-role arm: the stack's own region now applies, as on the fallback arm", async () => {
    const env: Record<string, string> = {};
    await applyLambdaCredentialEnv(env, { assumeRoleArn: ROLE, stackRegion: 'ap-south-1' });
    expect(assumeClientRegion()).toBe('ap-south-1');
    expect(env['AWS_REGION']).toBe('ap-south-1');
  });

  it('the state record region (--from-state) wins over the profile', async () => {
    h.profileRegion = 'us-east-1';
    for (const assumeRoleArn of [undefined, ROLE]) {
      const env: Record<string, string> = {};
      await applyLambdaCredentialEnv(env, {
        ...(assumeRoleArn && { assumeRoleArn }),
        stateRegion: 'EU-WEST-1',
      });
      expect(env['AWS_REGION']).toBe('eu-west-1');
    }
    // A named region never samples the profile at all.
    expect(h.regionSamples).toBe(0);
  });

  it('--region, then the host variables, still win over stack / state / profile', async () => {
    h.profileRegion = 'us-east-1';
    const flag: Record<string, string> = {};
    await applyLambdaCredentialEnv(flag, {
      region: 'us-west-2',
      stackRegion: 'ap-south-1',
      stateRegion: 'eu-west-1',
    });
    expect(flag['AWS_REGION']).toBe('us-west-2');

    process.env['AWS_DEFAULT_REGION'] = 'eu-central-1';
    const host: Record<string, string> = {};
    await applyLambdaCredentialEnv(host, {
      assumeRoleArn: ROLE,
      stackRegion: 'ap-south-1',
      stateRegion: 'eu-west-1',
    });
    expect(assumeClientRegion()).toBe('eu-central-1');
    expect(host['AWS_REGION']).toBe('eu-central-1');
    expect(h.regionSamples).toBe(0);
  });

  it('samples the --profile region, not the default profile', async () => {
    h.profileRegion = 'sa-east-1';
    const env: Record<string, string> = {};
    await applyLambdaCredentialEnv(env, { profile: 'dev' });
    expect(env['AWS_REGION']).toBe('sa-east-1');
    expect(h.configs[0]).toMatchObject({ profile: 'dev' });
  });

  it('nothing configured anywhere: no region, and no invented us-east-1', async () => {
    const env: Record<string, string> = {};
    await applyLambdaCredentialEnv(env, { stackRegion: 'unknown-region' });
    expect(env['AWS_REGION']).toBeUndefined();
    expect(env['AWS_DEFAULT_REGION']).toBeUndefined();
  });
});

describe('cdkd local invoke-agentcore: container region from the profile / state (go-to-k/cdkd#6200)', () => {
  it('fallback arm: the profile region', async () => {
    h.profileRegion = 'us-east-1';
    const env: Record<string, string> = {};
    await applyAgentCoreCredentialEnv(env, {});
    expect(env['AWS_REGION']).toBe('us-east-1');
  });

  it('--assume-role arm: the state region for the STS client and the container', async () => {
    h.profileRegion = 'us-east-1';
    const env: Record<string, string> = {};
    await applyAgentCoreCredentialEnv(env, { assumeRoleArn: ROLE, stateRegion: 'eu-west-1' });
    expect(assumeClientRegion()).toBe('eu-west-1');
    expect(env['AWS_REGION']).toBe('eu-west-1');
  });
});

describe('cdkd local start-api: container region from the profile / state (go-to-k/cdkd#6200)', () => {
  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'cdkd-6200-'));
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  // Environment-agnostic: no `region` on the stack.
  const stack = {
    stackName: 'ApiStack',
    displayName: 'ApiStack',
    artifactId: 'ApiStack',
    template: {
      Resources: {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Runtime: 'nodejs22.x',
            Handler: 'index.handler',
            Code: { ZipFile: 'exports.handler = async () => ({});' },
          },
        },
      },
    },
    dependencyNames: [],
  } as unknown as StackInfo;

  const spec = (over: Partial<Parameters<typeof buildContainerSpec>[0]> = {}) =>
    buildContainerSpec({
      logicalId: 'Fn',
      stacks: [stack],
      overrides: undefined,
      assumeRole: undefined,
      containerHost: '127.0.0.1',
      stsRegion: undefined,
      inlineTmpDirs: new Set([workDir]),
      layerTmpDirs: new Set(),
      stateByStack: new Map(),
      skipPull: true,
      ...over,
    });

  it('fallback arm: the profile region', async () => {
    h.profileRegion = 'us-east-1';
    const out = await spec();
    expect(out.env['AWS_REGION']).toBe('us-east-1');
  });

  it('a loaded state bundle (--from-state) puts ITS region in the container', async () => {
    h.profileRegion = 'us-east-1';
    const bundle = {
      state: { version: 1, stackName: 'ApiStack', resources: {}, outputs: {}, lastModified: 0 },
      region: 'eu-west-1',
    } as unknown as StackStateBundle;
    const out = await spec({ stateByStack: new Map([['ApiStack', bundle]]) });
    expect(out.env['AWS_REGION']).toBe('eu-west-1');
    expect(h.regionSamples).toBe(0);
  });

  it('--profile dev: the profile region is sampled from profile dev', async () => {
    h.profileRegion = 'sa-east-1';
    const out = await spec({ profile: 'dev' });
    expect(out.env['AWS_REGION']).toBe('sa-east-1');
    expect(h.configs[0]).toMatchObject({ profile: 'dev' });
  });

  it('--assume-role arm: the profile region for the STS client and the container', async () => {
    h.profileRegion = 'ap-northeast-1';
    const out = await spec({ assumeRole: { globalArn: ROLE, perLambda: {} } });
    expect(out.env['AWS_ACCESS_KEY_ID']).toBe('ASIASTS');
    expect(assumeClientRegion()).toBe('ap-northeast-1');
    expect(out.env['AWS_REGION']).toBe('ap-northeast-1');
  });
});
