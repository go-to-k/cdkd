import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import { createLocalCommand } from '../../../src/cli/commands/local-invoke.js';
import { applyLambdaCredentialEnv } from '../../../src/cli/commands/local-invoke/credentials.js';
import { applyAgentCoreCredentialEnv } from '../../../src/cli/commands/local-invoke-agentcore/env.js';
import { setAwsEndpointOverride } from 'cdk-local/internal';
import { awsClientDefaults } from '../../../src/utils/aws-client-defaults.js';
import { s3ClientDefaults } from '../../../src/utils/s3-client-defaults.js';
import { activateLocalAwsWiring } from '../../../src/local/local-aws-wiring.js';
import { CdkdError } from '../../../src/utils/error-handler.js';
import { getLogger } from '../../../src/utils/logger.js';

/**
 * go-to-k/cdkd#6131 / #6132: every `cdkd local` command that runs a workload
 * takes `--aws-emulator [url]` and `--ca-bundle <file>`, and the four commands
 * cdkd implements itself activate the wiring BEFORE `--role-arn`, so the role
 * hop and every client after it follow the emulator.
 */
const WORKLOAD_COMMANDS = [
  'invoke',
  'start-api',
  'run-task',
  'invoke-agentcore',
  'start-service',
  'start-alb',
  'start-cloudfront',
  'start-agentcore',
  'start-web-function',
  'start-microvm',
];

describe('--aws-emulator / --ca-bundle registration', () => {
  const local = createLocalCommand();

  it.each(WORKLOAD_COMMANDS)('local %s registers both flags', (name) => {
    const cmd = local.commands.find((c) => c.name() === name);
    expect(cmd, name).toBeDefined();
    const flags = cmd!.options.map((o) => o.flags);
    expect(flags).toContain('--aws-emulator [url]');
    expect(flags).toContain('--ca-bundle <file>');
  });

  it('names the cdkd env var, not the cdk-local one', () => {
    const invoke = local.commands.find((c) => c.name() === 'invoke')!;
    const opt = invoke.options.find((o) => o.long === '--aws-emulator')!;
    expect(opt.description).toContain('CDKD_AWS_EMULATOR');
  });
});

describe('the cdkd-owned commands enter through activateLocalAwsAndRoleArn', () => {
  // Its ORDER (wiring, then --role-arn) is asserted behaviourally in
  // tests/unit/local/local-aws-wiring-activation.test.ts; this pins that each
  // command takes that one entry and assumes no role by another route.
  const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
  it.each([
    'src/cli/commands/local-invoke/command.ts',
    'src/cli/commands/local-start-api/command.ts',
    'src/cli/commands/local-run-task/command.ts',
    'src/cli/commands/local-invoke-agentcore/command.ts',
  ])('%s', (file) => {
    const src = readFileSync(join(root, file), 'utf8');
    expect(src.split('await activateLocalAwsAndRoleArn(options);').length - 1).toBe(1);
    expect(src).not.toMatch(/applyRoleArnForLocal\(|applyRoleArnIfSet\(/);
  });
});

describe('the three Lambda-family commands resolve --profile only through the gate', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
  it.each([
    'src/cli/commands/local-invoke/command.ts',
    'src/cli/commands/local-start-api/command.ts',
    'src/cli/commands/local-invoke-agentcore/command.ts',
  ])('%s', (file) => {
    const src = readFileSync(join(root, file), 'utf8');
    expect(src).toMatch(
      /await profileCredentialsForWorkload\(\s*options\.profile,\s*resolveProfileCredentials\s*\)/
    );
    expect(src).not.toMatch(/resolveProfileCredentials\(options\.profile\)/);
    expect(src.indexOf('profileCredentialsForWorkload(')).toBeGreaterThan(
      src.indexOf('await activateLocalAwsAndRoleArn(options);')
    );
  });
});

describe('local invoke: the container region', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env['AWS_REGION'];
    delete process.env['AWS_DEFAULT_REGION'];
    delete process.env['AWS_ACCESS_KEY_ID'];
    delete process.env['AWS_SECRET_ACCESS_KEY'];
    delete process.env['AWS_SESSION_TOKEN'];
  });
  afterEach(() => {
    restoreProcessEnv(saved);
    vi.restoreAllMocks();
  });

  it('sets AWS_REGION from --region, folded', async () => {
    const env: Record<string, string> = {};
    await applyLambdaCredentialEnv(env, { region: 'US-EAST-1' });
    expect(env['AWS_REGION']).toBe('us-east-1');
    expect(env['AWS_DEFAULT_REGION']).toBe('us-east-1');
  });

  it('--region wins over the host region in BOTH variables (host us-east-1, --region us-west-2)', async () => {
    process.env['AWS_REGION'] = 'us-east-1';
    process.env['AWS_DEFAULT_REGION'] = 'us-east-1';
    const env: Record<string, string> = {};
    await applyLambdaCredentialEnv(env, { region: 'us-west-2' });
    expect(env['AWS_REGION']).toBe('us-west-2');
    expect(env['AWS_DEFAULT_REGION']).toBe('us-west-2');
  });

  it('invoke-agentcore: --region wins over the host region in BOTH variables', async () => {
    process.env['AWS_REGION'] = 'us-east-1';
    process.env['AWS_DEFAULT_REGION'] = 'us-east-1';
    const env: Record<string, string> = {};
    await applyAgentCoreCredentialEnv(env, { region: 'us-west-2' });
    expect(env['AWS_REGION']).toBe('us-west-2');
    expect(env['AWS_DEFAULT_REGION']).toBe('us-west-2');
  });

  it('keeps the host AWS_REGION when --region is absent', async () => {
    process.env['AWS_REGION'] = 'eu-west-1';
    const env: Record<string, string> = {};
    await applyLambdaCredentialEnv(env, { stackRegion: 'ap-south-1' });
    expect(env['AWS_REGION']).toBe('eu-west-1');
  });

  it('takes a host AWS_DEFAULT_REGION when it is the only variable', async () => {
    process.env['AWS_DEFAULT_REGION'] = 'eu-central-1';
    const env: Record<string, string> = {};
    await applyLambdaCredentialEnv(env, { stackRegion: 'ap-south-1' });
    expect(env['AWS_REGION']).toBe('eu-central-1');
    expect(env['AWS_DEFAULT_REGION']).toBe('eu-central-1');
  });

  it("falls back to the stack's own region, skipping an env-agnostic one", async () => {
    const env: Record<string, string> = {};
    await applyLambdaCredentialEnv(env, { stackRegion: 'ap-south-1' });
    expect(env['AWS_REGION']).toBe('ap-south-1');
    const agnostic: Record<string, string> = {};
    await applyLambdaCredentialEnv(agnostic, { stackRegion: 'unknown-region' });
    expect(agnostic['AWS_REGION']).toBeUndefined();
  });
});

describe("cdkd's own clients follow cdk-local's --aws-emulator override", () => {
  afterEach(() => {
    setAwsEndpointOverride(undefined);
  });

  it('createLocalCommand registers the source: an activated override reaches awsClientDefaults', () => {
    createLocalCommand();
    expect(awsClientDefaults().endpoint).toBeUndefined();
    setAwsEndpointOverride({
      endpoint: 'https://127.0.0.1:9297',
      credentials: { accessKeyId: 'EMULATORKEY000000000', secretAccessKey: 's' },
    });
    expect(awsClientDefaults().endpoint).toBe('https://127.0.0.1:9297');
    expect(s3ClientDefaults()).toEqual({ forcePathStyle: true });
  });
});

describe('activateLocalAwsWiring never echoes userinfo', () => {
  const saved = { ...process.env };
  afterEach(() => {
    restoreProcessEnv(saved);
  });

  it.each([
    ['the flag', 'https://AKIDEXAMPLEUSER:topsecretvalue@127.0.0.1:9', undefined],
    ['the env var', undefined, 'https://AKIDEXAMPLEUSER:topsecretvalue@127.0.0.1:9'],
    ['a value the URL parser rejects', 'https://AKIDEXAMPLEUSER:topsecretvalue@[bad:9', undefined],
    ['a query', 'https://127.0.0.1:9297/?X-Amz-Credential=AKIDEXAMPLEUSER&sig=topsecretvalue', undefined],
    ['a fragment', 'https://127.0.0.1:9297#AKIDEXAMPLEUSER:topsecretvalue', undefined],
  ])('%s', async (_label, flag, envValue) => {
    if (envValue !== undefined) process.env['CDKD_AWS_EMULATOR'] = envValue;
    const err = (await activateLocalAwsWiring({ awsEmulator: flag }).catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(CdkdError);
    expect(err.message).toMatch(/user name, password, query or fragment/);
    expect(err.message).not.toContain('topsecretvalue');
    expect(err.message).not.toContain('AKIDEXAMPLEUSER');
  });
});

describe('a value that is not an http(s) URL (the optional value swallowed the target)', () => {
  it.each(['MyStack/Handler', 'ftp://127.0.0.1:9297'])('%s', async (value) => {
    const err = (await activateLocalAwsWiring({ awsEmulator: value }).catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(CdkdError);
    expect(err.message).toMatch(/--aws-emulator=<url>/);
    expect(err.message).not.toContain(value);
  });
});

describe('the `cdkd local` preAction hook covers every subcommand', () => {
  /**
   * Parse `argv` through the parent `local` command with the target
   * subcommand's action replaced by a spy; return the spy and the line the
   * hook logged (it renders and exits through `handleError`).
   */
  async function parseThroughHook(
    name: string,
    argv: string[]
  ): Promise<{ action: ReturnType<typeof vi.fn>; logged: string }> {
    const local = createLocalCommand();
    local.exitOverride();
    for (const c of local.commands) c.exitOverride();
    const action = vi.fn();
    local.commands.find((c) => c.name() === name)!.action(action);
    const errorSpy = vi.spyOn(getLogger(), 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    try {
      await local.parseAsync(argv, { from: 'user' }).catch(() => undefined);
      expect(exitSpy).toHaveBeenCalledWith(1);
      return { action, logged: errorSpy.mock.calls.map((c) => String(c[0])).join('\n') };
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
  }
  const BAD = '--aws-emulator=https://u:topsecretvalue@127.0.0.1:9';

  it('local start-web-function (a cdk-local engine command)', async () => {
    const { action, logged } = await parseThroughHook('start-web-function', [
      'start-web-function',
      'Stack/Target',
      BAD,
    ]);
    expect(action).not.toHaveBeenCalled();
    expect(logged).toMatch(/user name, password, query or fragment/);
    expect(logged).not.toContain('topsecretvalue');
  });

  it('local start-service (a cdk-local engine command)', async () => {
    const { action, logged } = await parseThroughHook('start-service', [
      'start-service',
      'Stack/Target',
      BAD,
    ]);
    expect(action).not.toHaveBeenCalled();
    expect(logged).not.toContain('topsecretvalue');
  });

  it('local invoke, with the value in CDKD_AWS_EMULATOR', async () => {
    process.env['CDKD_AWS_EMULATOR'] = 'https://127.0.0.1:9297/?sig=topsecretvalue';
    try {
      const { action, logged } = await parseThroughHook('invoke', ['invoke', 'Stack/Target']);
      expect(action).not.toHaveBeenCalled();
      expect(logged).toMatch(/user name, password, query or fragment/);
      expect(logged).not.toContain('topsecretvalue');
    } finally {
      delete process.env['CDKD_AWS_EMULATOR'];
    }
  });
});

/** Restore the environment IN PLACE: replacing `process.env` unlinks it from the real one. */
function restoreProcessEnv(snapshot: Record<string, string | undefined>): void {
  for (const k of Object.keys(process.env)) if (!(k in snapshot)) delete process.env[k];
  for (const [k, v] of Object.entries(snapshot)) if (v !== undefined) process.env[k] = v;
}
