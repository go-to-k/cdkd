import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('../../../src/cli/aws-emulator-activation.js', () => ({
  // The real activation probes the emulator's health endpoint over the network.
  activateAwsEmulatorForCommand: vi.fn(async () => {}),
}));

const stsMock = vi.hoisted(() => ({
  send: vi.fn(async () => ({ Account: '123456789012' }) as unknown),
  destroy: vi.fn(),
}));
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn(function STSClient() {
    return stsMock;
  }),
  GetCallerIdentityCommand: vi.fn(function GetCallerIdentityCommand(this: unknown) {}),
}));

const bundleCalls = vi.hoisted(() => [] as Array<{ region?: string }>);
vi.mock('../../../src/local/agentcore-s3-bundle.js', () => ({
  downloadAndExtractS3Bundle: vi.fn(async (_loc: unknown, opts: { region?: string }) => {
    bundleCalls.push(opts);
    throw new Error('stop after the download options');
  }),
}));

import { buildProgram } from '../../../src/cli/program.js';
import { setAwsEndpointOverrideSource } from '../../../src/utils/aws-client-defaults.js';
import { setPasteableAwsCaBundle } from '../../../src/utils/pasteable-aws-profile.js';
import { setChildProcessAwsEnv } from '../../../src/utils/child-process-aws-env.js';
import { getLogger } from '../../../src/utils/logger.js';
import { recordEmulatorDefaultRegion } from '../../../src/utils/emulator-default-region.js';
import { resolveContainerRegion } from '../../../src/local/local-aws-wiring.js';
import { resolvePseudoParametersForInvoke } from '../../../src/cli/commands/local-invoke/template-env.js';
import { resolvePseudoParametersForStartApi } from '../../../src/cli/commands/local-start-api/state.js';
import {
  buildEcsImageResolutionContext,
  resolveEcsConsumerRegion,
} from '../../../src/cli/commands/local-run-task/image-context.js';
import {
  buildAgentCoreImageContext,
  resolveAgentCoreCodeImageFromS3,
} from '../../../src/cli/commands/local-invoke-agentcore/image.js';
import { buildSigV4HeadersIfRequested } from '../../../src/cli/commands/local-invoke-agentcore/sigv4.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

/**
 * go-to-k/cdkd#6270: under `--aws-emulator`, cdkd copies the emulator run's
 * `config` region into its own `AWS_REGION` when the shell names none. That
 * copy is a DEFAULT, so a stack pinned to `us-west-2` (deployed into the
 * emulator's `us-west-2`) must run there under `cdkd local`, not in the run's
 * region. `eu-south-1` stands for the run's region so it differs from every
 * `us-east-1` literal fallback.
 */

const RUN_REGION = 'eu-south-1';
const ENV_KEYS = [
  'AWS_PROFILE',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_ENDPOINT_URL',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_EC2_METADATA_DISABLED',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'HOME',
  'CDKD_AWS_EMULATOR',
];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  delete process.env['AWS_REGION'];
  delete process.env['AWS_DEFAULT_REGION'];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setAwsEndpointOverrideSource(undefined);
  setPasteableAwsCaBundle(undefined);
  setChildProcessAwsEnv(undefined);
});

/** Parse `cdkd local invoke --aws-emulator` against a run whose config names `RUN_REGION`. */
async function parseLocalInvokeUnderEmulator(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'cdkd-emu-6270-'));
  const run = join(home, '.aws', 'emulator', '1');
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, 'config'), `[default]\nregion = ${RUN_REGION}\n`);
  writeFileSync(
    join(run, 'emulator_credentials'),
    '[default]\naws_access_key_id = EMU\naws_secret_access_key = s\n'
  );
  process.env['HOME'] = home;
  const program = buildProgram();
  const local = program.commands.find((c) => c.name() === 'local')!;
  const invoke = local.commands.find((c) => c.name() === 'invoke')!;
  invoke.action(function (this: Command) {});
  const info = vi.spyOn(getLogger(), 'info').mockImplementation(() => {});
  try {
    await program.parseAsync(
      ['node', 'cdkd', 'local', 'invoke', 'Stack/Fn', '--aws-emulator=https://127.0.0.1:1'],
      { from: 'node' }
    );
  } finally {
    info.mockRestore();
  }
}

/** The state `--aws-emulator` leaves when the shell names no region. */
function emulatorDefault(region: string): void {
  process.env['AWS_REGION'] = region;
  recordEmulatorDefaultRegion(region);
}

describe('the container region under --aws-emulator, through the real writer', () => {
  it("ranks the run's region below the stack's and the state record's", async () => {
    await parseLocalInvokeUnderEmulator();
    // The copy still happens, so env-only readers agree on a region.
    expect(process.env['AWS_REGION']).toBe(RUN_REGION);
    expect(await resolveContainerRegion({ stackRegion: 'us-west-2' })).toBe('us-west-2');
    expect(await resolveContainerRegion({ stateRegion: 'us-west-2' })).toBe('us-west-2');
    // An environment-agnostic stack with no state still gets the run's region.
    expect(await resolveContainerRegion({})).toBe(RUN_REGION);
    // `--region` still wins.
    expect(await resolveContainerRegion({ region: 'eu-west-1', stackRegion: 'us-west-2' })).toBe(
      'eu-west-1'
    );
  });

  it('keeps a region the shell names above the stack region', async () => {
    process.env['AWS_REGION'] = 'ap-northeast-1';
    await parseLocalInvokeUnderEmulator();
    expect(await resolveContainerRegion({ stackRegion: 'us-west-2' })).toBe('ap-northeast-1');
  });

  it("a later --region-style overwrite of AWS_REGION is the user's again", async () => {
    await parseLocalInvokeUnderEmulator();
    process.env['AWS_REGION'] = 'ca-central-1';
    expect(await resolveContainerRegion({ stackRegion: 'us-west-2' })).toBe('ca-central-1');
  });
});

describe('without --aws-emulator nothing changes', () => {
  it('a shell AWS_REGION outranks the stack region, as before', async () => {
    process.env['AWS_REGION'] = RUN_REGION;
    expect(await resolveContainerRegion({ stackRegion: 'us-west-2' })).toBe(RUN_REGION);
    expect((await resolvePseudoParametersForInvoke('us-west-2', {} as never))?.region).toBe(
      RUN_REGION
    );
    expect(resolveEcsConsumerRegion(undefined, {}, 'us-west-2')).toBe(RUN_REGION);
  });
});

describe('the other region chains that rank AWS_REGION above a stack region', () => {
  it('local invoke ${AWS::Region}: the stack region, else the run default', async () => {
    emulatorDefault(RUN_REGION);
    expect((await resolvePseudoParametersForInvoke('us-west-2', {} as never))?.region).toBe(
      'us-west-2'
    );
    expect((await resolvePseudoParametersForInvoke(undefined, {} as never))?.region).toBe(
      RUN_REGION
    );
  });

  it('local start-api ${AWS::Region}: the state record region', async () => {
    emulatorDefault(RUN_REGION);
    expect(
      (await resolvePseudoParametersForStartApi('us-west-2', { fromState: true } as never))?.region
    ).toBe('us-west-2');
  });

  it('local run-task consumer region: the synth region, else the run default', () => {
    emulatorDefault(RUN_REGION);
    expect(resolveEcsConsumerRegion(undefined, {}, 'us-west-2')).toBe('us-west-2');
    expect(resolveEcsConsumerRegion(undefined, {}, undefined)).toBe(RUN_REGION);
  });

  it('local run-task image ${AWS::Region}: the stack region', async () => {
    emulatorDefault(RUN_REGION);
    const stack = {
      stackName: 'S6270',
      displayName: 'S6270',
      artifactId: 'S6270',
      dependencyNames: [],
      region: 'us-west-2',
      template: {
        Resources: {
          TaskDef: {
            Type: 'AWS::ECS::TaskDefinition',
            Properties: {
              ContainerDefinitions: [
                {
                  Name: 'app',
                  Image: { 'Fn::Sub': '${AWS::AccountId}.dkr.ecr.${AWS::Region}.${AWS::URLSuffix}/r:1' },
                },
              ],
            },
          },
        },
      },
    } as unknown as StackInfo;
    const { context } = await buildEcsImageResolutionContext(stack, undefined, {} as never);
    expect(context?.pseudoParameters?.region).toBe('us-west-2');
    // An environment-agnostic stack still gets the run's region.
    const agnostic = { ...stack, region: undefined } as unknown as StackInfo;
    const fallback = await buildEcsImageResolutionContext(agnostic, undefined, {} as never);
    expect(fallback.context?.pseudoParameters?.region).toBe(RUN_REGION);
  });

  it('local invoke-agentcore image ${AWS::Region}: the stack region', async () => {
    emulatorDefault(RUN_REGION);
    const stack = {
      stackName: 'S6270',
      displayName: 'S6270',
      artifactId: 'S6270',
      dependencyNames: [],
      region: 'us-west-2',
      template: { Resources: {} },
    } as unknown as StackInfo;
    const provider = { label: '--from-state', load: async () => undefined };
    const { context } = await buildAgentCoreImageContext(stack, provider as never, {
      fromState: true,
    } as never);
    expect(context?.pseudoParameters?.region).toBe('us-west-2');
    const agnostic = { ...stack, region: undefined } as unknown as StackInfo;
    const fallback = await buildAgentCoreImageContext(agnostic, provider as never, {
      fromState: true,
    } as never);
    expect(fallback.context?.pseudoParameters?.region).toBe(RUN_REGION);
  });

  it('local invoke-agentcore --sigv4: an environment-agnostic runtime signs in the run default', async () => {
    emulatorDefault(RUN_REGION);
    const runtime = { logicalId: 'Runtime', stack: { stackName: 'S6270' } };
    // No region anywhere but the run default: the refusal must not fire. What
    // fails next (no credential to sign with in a unit run) is not the subject.
    const outcome = await buildSigV4HeadersIfRequested(
      { sigv4: true } as never,
      runtime as never,
      undefined,
      'localhost',
      8080,
      {},
      's'
    ).then(
      () => '',
      (err: unknown) => String((err as Error).message)
    );
    expect(outcome).not.toMatch(/Pass --region/);
  });

  it('local invoke-agentcore --sigv4: a stack region outranks the run default in the signing scope', async () => {
    emulatorDefault(RUN_REGION);
    process.env['AWS_ACCESS_KEY_ID'] = 'AKIAEXAMPLE6270';
    process.env['AWS_SECRET_ACCESS_KEY'] = 'secret6270';
    const runtime = { logicalId: 'Runtime', stack: { stackName: 'S6270', region: 'us-west-2' } };
    const headers = await buildSigV4HeadersIfRequested(
      { sigv4: true } as never,
      runtime as never,
      undefined,
      'localhost',
      8080,
      {},
      's'
    );
    const auth = Object.entries(headers ?? {}).find(([k]) => k.toLowerCase() === 'authorization')?.[1];
    expect(auth).toContain('/us-west-2/');
  });

  it('local invoke-agentcore fromS3 bundle: the stack region, else the run default', async () => {
    emulatorDefault(RUN_REGION);
    const download = async (stackRegion: string | undefined): Promise<string | undefined> => {
      bundleCalls.length = 0;
      await resolveAgentCoreCodeImageFromS3(
        { logicalId: 'Runtime', stack: { stackName: 'S6270', region: stackRegion }, resource: {} } as never,
        { runtime: 'PYTHON_3_12', entryPoint: ['main.py'] } as never,
        { bucket: 'bundle-bucket', key: 'bundle.zip' },
        {} as never,
        'arm64',
        undefined
      ).catch(() => undefined);
      return bundleCalls[0]?.region;
    };
    expect(await download('us-west-2')).toBe('us-west-2');
    expect(await download(undefined)).toBe(RUN_REGION);
  });
});
