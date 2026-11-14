import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { ambientDefaultRegion, namedEnvAwsRegion } from 'cdk-local/internal';

vi.mock('../../../src/cli/aws-emulator-activation.js', () => ({
  // The real activation probes the emulator's health endpoint over the network.
  activateAwsEmulatorForCommand: vi.fn(async () => {}),
}));

import { buildProgram } from '../../../src/cli/program.js';
import { setAwsEndpointOverrideSource } from '../../../src/utils/aws-client-defaults.js';
import { setPasteableAwsCaBundle } from '../../../src/utils/pasteable-aws-profile.js';
import { setChildProcessAwsEnv } from '../../../src/utils/child-process-aws-env.js';
import { getLogger } from '../../../src/utils/logger.js';

/**
 * go-to-k/cdkd#6270, the cdk-local half: the engine commands' region chains
 * live in cdk-local and read `AWS_REGION` through its `namedEnvAwsRegion()`,
 * consulting `ambientDefaultRegion()` only after the stack's and the state
 * record's region (go-to-k/cdk-local#964). The region `--aws-emulator` copies
 * into `AWS_REGION` must therefore be recorded THERE, or a stack pinned to
 * `us-west-2` runs in the emulator run's region under these commands.
 * `eu-south-1` stands for the run's region.
 */

const RUN_REGION = 'eu-south-1';
const ENGINE_COMMANDS = [
  'start-service',
  'start-alb',
  'start-web-function',
  'start-microvm',
  'start-cloudfront',
  'start-agentcore',
] as const;
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
  delete process.env['CDKD_AWS_EMULATOR'];
  // A run directory whose config names RUN_REGION.
  const home = mkdtempSync(join(tmpdir(), 'cdkd-emu-6270-engine-'));
  const run = join(home, '.aws', 'emulator', '1');
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, 'config'), `[default]\nregion = ${RUN_REGION}\n`);
  writeFileSync(
    join(run, 'emulator_credentials'),
    '[default]\naws_access_key_id = EMU\naws_secret_access_key = s\n'
  );
  process.env['HOME'] = home;
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

/** Parse `cdkd local <name> ...args` with its action stubbed out. */
async function parseLocal(name: string, args: string[]): Promise<void> {
  const program = buildProgram();
  const local = program.commands.find((c) => c.name() === 'local')!;
  const cmd = local.commands.find((c) => c.name() === name)!;
  expect(cmd, `cdkd local ${name}`).toBeDefined();
  cmd.action(function (this: Command) {});
  const info = vi.spyOn(getLogger(), 'info').mockImplementation(() => {});
  try {
    await program.parseAsync(['node', 'cdkd', 'local', name, ...args], { from: 'node' });
  } finally {
    info.mockRestore();
  }
}

function realAwsEnvVarsFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cdkd-emu-6270-envvars-'));
  const file = join(dir, 'env.json');
  writeFileSync(
    file,
    JSON.stringify({ Parameters: { AWS_ENDPOINT_URL_SECRETS_MANAGER: 'real-aws' } })
  );
  return file;
}

describe("cdk-local's ambient default region under --aws-emulator (go-to-k/cdkd#6270)", () => {
  it.each(ENGINE_COMMANDS)(
    "%s: the run's region is recorded as cdk-local's ambient default, not a named region",
    async (name) => {
      await parseLocal(name, ['--aws-emulator=https://127.0.0.1:1']);
      // The copy still happens, so env-only readers agree on a region...
      expect(process.env['AWS_REGION']).toBe(RUN_REGION);
      // ...but cdk-local's chains read it as the default it is: a stack's or
      // state record's region outranks it.
      expect(ambientDefaultRegion()).toBe(RUN_REGION);
      expect(namedEnvAwsRegion()).toBeUndefined();
    }
  );

  it('a region the shell named stays a named region (nothing recorded)', async () => {
    process.env['AWS_REGION'] = 'ap-northeast-1';
    await parseLocal('start-service', ['--aws-emulator=https://127.0.0.1:1']);
    expect(ambientDefaultRegion()).toBeUndefined();
    expect(namedEnvAwsRegion()).toBe('ap-northeast-1');
  });

  it.each(['start-service', 'start-web-function', 'start-microvm', 'start-agentcore'])(
    '%s in mixed mode records nothing (the environment is not pointed at the emulator)',
    async (name) => {
      await parseLocal(name, [
        '--aws-emulator=https://127.0.0.1:1',
        '--env-vars',
        realAwsEnvVarsFile(),
      ]);
      expect(process.env['AWS_REGION']).toBeUndefined();
      expect(ambientDefaultRegion()).toBeUndefined();
    }
  );

  it('without --aws-emulator (real AWS) records nothing', async () => {
    await parseLocal('start-service', []);
    expect(process.env['AWS_REGION']).toBeUndefined();
    expect(ambientDefaultRegion()).toBeUndefined();
  });
});
