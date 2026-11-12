import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('../../../src/cli/aws-emulator-activation.js', () => ({
  // The real activation probes the emulator's health endpoint over the network.
  activateAwsEmulatorForCommand: vi.fn(async () => {}),
}));

import { buildProgram } from '../../../src/cli/program.js';
import {
  defaultProfileRegion,
  prepareAwsEmulatorForCommand,
} from '../../../src/cli/aws-emulator.js';
import { activateAwsEmulatorForCommand } from '../../../src/cli/aws-emulator-activation.js';
import { getLogger, isStdoutReservedForPayload } from '../../../src/utils/logger.js';
import { pasteableRunFlags } from '../../../src/utils/pasteable-run-context.js';
import {
  pasteableAwsProfileFlag,
  setPasteableAwsCaBundle,
} from '../../../src/utils/pasteable-aws-profile.js';
import { getAwsEndpointOverride, setAwsEndpointOverride } from 'cdk-local/internal';
import {
  awsEndpointOverrideActive,
  setAwsEndpointOverrideSource,
} from '../../../src/utils/aws-client-defaults.js';
import { CdkdError } from '../../../src/utils/error-handler.js';

/**
 * go-to-k/cdkd#6138: `--aws-emulator [url]` / `CDKD_AWS_EMULATOR` on every
 * command that talks to AWS, and the emulator identity only under it.
 */

/** A port with no `~/.aws/emulator/<port>/` run directory on any host. */
const EMULATOR_URL = 'https://127.0.0.1:1';

const ENV_KEYS = [
  'AWS_PROFILE',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_ENDPOINT_URL',
  'AWS_ENDPOINT_URL_S3',
  'AWS_IGNORE_CONFIGURED_ENDPOINT_URLS',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_EC2_METADATA_DISABLED',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'HOME',
  'CDKD_ROLE_ARN',
  'CDKD_AWS_EMULATOR',
];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  vi.mocked(activateAwsEmulatorForCommand).mockClear();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setAwsEndpointOverrideSource(undefined);
  setPasteableAwsCaBundle(undefined);
});

function find(program: Command, path: string[]): Command {
  let cmd = program;
  for (const name of path) cmd = cmd.commands.find((c) => c.name() === name)!;
  return cmd;
}

/** Run `fn` with cdk-local's override set, as the (mocked) activation would. */
function withActiveOverride<T>(fn: () => T): T {
  setAwsEndpointOverrideSource(getAwsEndpointOverride);
  setAwsEndpointOverride({ endpoint: EMULATOR_URL });
  try {
    return fn();
  } finally {
    setAwsEndpointOverride(undefined);
  }
}

const declares = (cmd: Command, long: string): boolean => cmd.options.some((o) => o.long === long);

describe('registration', () => {
  const program = buildProgram();

  it.each([
    ['bootstrap'],
    ['deploy'],
    ['destroy'],
    ['diff'],
    ['rollback'],
    ['gc'],
    ['state', 'list'],
    ['state', 'show'],
    ['state', 'destroy'],
    ['state', 'orphan'],
    ['state', 'info'],
    // Declared on the ancestor `events`, inherited by its subcommand.
    ['events'],
  ])('cdkd %s declares --aws-emulator', (...path) => {
    expect(declares(find(program, path), '--aws-emulator')).toBe(true);
  });

  it('a subcommand inheriting the flag from its parent honours it (events prune)', async () => {
    process.env['AWS_PROFILE'] = 'prod';
    await parse(['events', 'prune'], ['MyStack', '--aws-emulator=https://127.0.0.1:1']);
    expect(process.env['AWS_PROFILE']).toBeUndefined();
    expect(activateAwsEmulatorForCommand).toHaveBeenCalledWith('https://127.0.0.1:1');
  });

  it('every command declaring --profile declares --aws-emulator exactly once', () => {
    let checked = 0;
    const walk = (cmd: Command): void => {
      for (const sub of cmd.commands) {
        if (declares(sub, '--profile')) {
          expect(
            sub.options.filter((o) => o.long === '--aws-emulator'),
            sub.name()
          ).toHaveLength(1);
          checked++;
        }
        walk(sub);
      }
    };
    walk(program);
    expect(checked).toBeGreaterThan(25);
  });
});

/**
 * Parse `argv` through the real program with the target's action replaced by
 * a spy; return the options the action received.
 */
async function parse(path: string[], argv: string[]): Promise<Record<string, unknown>> {
  const program = buildProgram();
  const target = find(program, path);
  let received: Record<string, unknown> | undefined;
  target.action(function (this: Command) {
    received = this.opts();
  });
  const info = vi.spyOn(getLogger(), 'info').mockImplementation(() => {});
  try {
    // argv-shaped (default `from: 'node'`): the path is spread in.
    await program.parseAsync(['node', 'cdkd', ...path, ...argv], { from: 'node' });
  } finally {
    info.mockRestore();
  }
  return received!;
}

describe('under the flag (a non-local command)', () => {
  it('drops --profile, --role-arn and the real identity env, activates the wiring and points the env at the emulator', async () => {
    process.env['AWS_PROFILE'] = 'prod';
    process.env['AWS_ACCESS_KEY_ID'] = 'HOSTKEYID00000000000';
    process.env['AWS_SECRET_ACCESS_KEY'] = 'real-secret';
    process.env['AWS_SESSION_TOKEN'] = 'real-token';
    process.env['AWS_ENDPOINT_URL_S3'] = 'https://elsewhere.example';
    process.env['AWS_IGNORE_CONFIGURED_ENDPOINT_URLS'] = 'true';
    process.env['CDKD_ROLE_ARN'] = 'arn:aws:iam::123456789012:role/Deploy';
    const info = vi.spyOn(getLogger(), 'info').mockImplementation(() => {});
    const program = buildProgram();
    let received: Record<string, unknown> | undefined;
    find(program, ['deploy']).action(function (this: Command) {
      received = this.opts();
    });
    try {
      await program.parseAsync(
        [
          'deploy',
          '--profile',
          'prod',
          '--role-arn',
          'arn:aws:iam::123456789012:role/Other',
          '--aws-emulator',
          EMULATOR_URL,
        ],
        { from: 'user' }
      );
      expect(received!['profile']).toBeUndefined();
      expect(received!['roleArn']).toBeUndefined();
      for (const k of [
        'AWS_PROFILE',
        'AWS_ACCESS_KEY_ID',
        'AWS_SECRET_ACCESS_KEY',
        'AWS_SESSION_TOKEN',
        'AWS_ENDPOINT_URL_S3',
        'AWS_IGNORE_CONFIGURED_ENDPOINT_URLS',
        'CDKD_ROLE_ARN',
      ]) {
        expect(process.env[k], k).toBeUndefined();
      }
      expect(process.env['AWS_ENDPOINT_URL']).toBe(EMULATOR_URL);
      expect(process.env['AWS_CONFIG_FILE']).toBe(devNull);
      expect(process.env['AWS_SHARED_CREDENTIALS_FILE']).toBe(devNull);
      expect(process.env['AWS_EC2_METADATA_DISABLED']).toBe('true');
      expect(activateAwsEmulatorForCommand).toHaveBeenCalledWith(EMULATOR_URL);
      // cdkd's clients follow cdk-local's override once it is activated.
      setAwsEndpointOverride({ endpoint: EMULATOR_URL });
      try {
        expect(awsEndpointOverrideActive()).toBe(true);
      } finally {
        setAwsEndpointOverride(undefined);
      }
      // One notice naming what was ignored, never a value.
      const lines = info.mock.calls.map((c) => String(c[0])).filter((l) => /ignoring/.test(l));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('--profile');
      expect(lines[0]).toContain('--role-arn');
      expect(lines[0]).toContain('AWS_ACCESS_KEY_ID');
      expect(lines[0]).not.toContain('HOSTKEYID');
      expect(lines[0]).toContain('AWS_ENDPOINT_URL_S3');
      expect(lines[0]).not.toContain('real-secret');
      expect(lines[0]).not.toContain('real-token');
      expect(lines[0]).not.toContain('prod');
    } finally {
      info.mockRestore();
    }
  });

  it('prints its notices off stdout, which a payload command reserves only later', async () => {
    process.env['AWS_PROFILE'] = 'prod';
    vi.mocked(activateAwsEmulatorForCommand).mockImplementationOnce(async () => {
      getLogger().info('activation line');
    });
    const reservedAt: boolean[] = [];
    const info = vi.spyOn(getLogger(), 'info').mockImplementation(() => {
      reservedAt.push(isStdoutReservedForPayload());
    });
    const program = buildProgram();
    find(program, ['synth']).action(() => {});
    try {
      await program.parseAsync(['synth', '--aws-emulator=https://127.0.0.1:1'], { from: 'user' });
    } finally {
      info.mockRestore();
    }
    expect(reservedAt).toEqual([true, true]);
    // ...and hands stdout back for a command that keeps human output.
    expect(isStdoutReservedForPayload()).toBe(false);
  });

  it('CDKD_AWS_EMULATOR turns it on without the flag', async () => {
    process.env['CDKD_AWS_EMULATOR'] = EMULATOR_URL;
    process.env['AWS_PROFILE'] = 'prod';
    const opts = await parse(['state', 'list'], ['--profile', 'prod']);
    expect(opts['profile']).toBeUndefined();
    expect(process.env['AWS_PROFILE']).toBeUndefined();
    expect(activateAwsEmulatorForCommand).toHaveBeenCalledTimes(1);
    // Only a TYPED flag rides pasteable hints; the env reaches them from the shell.
    expect(pasteableRunFlags().awsEmulator).toBeUndefined();
  });

  it('normalises localhost to 127.0.0.1', async () => {
    await parse(['deploy'], ['--aws-emulator=https://localhost:1']);
    expect(process.env['AWS_ENDPOINT_URL']).toBe('https://127.0.0.1:1');
  });

  it('a pasted aws hint gets no --ca-bundle without a run ca.pem, or for an http endpoint', async () => {
    await parse(['deploy'], [`--aws-emulator=${EMULATOR_URL}`]);
    expect(withActiveOverride(pasteableAwsProfileFlag)).not.toContain('--ca-bundle');
    const home = mkdtempSync(join(tmpdir(), 'cdkd-emu-home-'));
    const run = join(home, '.aws', 'emulator', '1');
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, 'ca.pem'), 'pem');
    process.env['HOME'] = home;
    await parse(['deploy'], ['--aws-emulator=http://127.0.0.1:1']);
    expect(withActiveOverride(pasteableAwsProfileFlag)).not.toContain('--ca-bundle');
  });

  it('a typed --ca-bundle (cdkd local) is the CA a pasted aws hint trusts', async () => {
    await parse(
      ['local', 'invoke'],
      ['Stack/Fn', '--ca-bundle', '/tmp/my-ca.pem', `--aws-emulator=${EMULATOR_URL}`]
    );
    expect(withActiveOverride(pasteableAwsProfileFlag)).toContain('--ca-bundle /tmp/my-ca.pem');
  });

  it('an unreachable emulator is rendered and exits 1, never a Fatal stack', async () => {
    vi.mocked(activateAwsEmulatorForCommand).mockRejectedValueOnce(
      new CdkdError('--aws-emulator https://127.0.0.1:1: no AWS Emulator answers', 'AWS_EMULATOR_UNAVAILABLE')
    );
    const program = buildProgram();
    const action = vi.fn();
    find(program, ['deploy']).action(action);
    const errorSpy = vi.spyOn(getLogger(), 'error').mockImplementation(() => {});
    const info = vi.spyOn(getLogger(), 'info').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    try {
      await expect(
        program.parseAsync(['deploy', '--aws-emulator=https://127.0.0.1:1'], { from: 'user' })
      ).rejects.toThrow('exit 1');
      expect(action).not.toHaveBeenCalled();
      expect(errorSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
        /no AWS Emulator answers/
      );
    } finally {
      errorSpy.mockRestore();
      info.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it('a pasted hint carries the typed emulator and not the dropped --profile', async () => {
    await parse(['state', 'orphan'], ['MyStack', '--profile', 'prod', `--aws-emulator=${EMULATOR_URL}`]);
    expect(pasteableRunFlags().profile).toBeUndefined();
    expect(pasteableRunFlags().awsEmulator).toBe(EMULATOR_URL);
  });

  it("points the env at the run's files and takes its region when the shell names none", async () => {
    const home = mkdtempSync(join(tmpdir(), 'cdkd-emu-home-'));
    const run = join(home, '.aws', 'emulator', '1');
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, 'config'), '[default]\nregion = eu-west-1\nendpoint_url = x\n');
    writeFileSync(
      join(run, 'emulator_credentials'),
      '[default]\naws_access_key_id = EMU\naws_secret_access_key = s\n'
    );
    writeFileSync(join(run, 'ca.pem'), 'pem');
    process.env['HOME'] = home;
    await parse(['deploy'], [`--aws-emulator=${EMULATOR_URL}`]);
    // A pasted `aws` remedy names the emulator and trusts the run's CA.
    expect(withActiveOverride(pasteableAwsProfileFlag)).toBe(
      `--endpoint-url ${EMULATOR_URL} --ca-bundle ${join(run, 'ca.pem')}`
    );
    expect(process.env['AWS_CONFIG_FILE']).toBe(join(run, 'config'));
    expect(process.env['AWS_SHARED_CREDENTIALS_FILE']).toBe(join(run, 'emulator_credentials'));
    expect(process.env['AWS_REGION']).toBe('eu-west-1');
    // A region the shell names wins, in either variable.
    process.env['AWS_REGION'] = 'ap-northeast-1';
    await parse(['deploy'], [`--aws-emulator=${EMULATOR_URL}`]);
    expect(process.env['AWS_REGION']).toBe('ap-northeast-1');
    delete process.env['AWS_REGION'];
    process.env['AWS_DEFAULT_REGION'] = 'eu-central-1';
    await parse(['deploy'], [`--aws-emulator=${EMULATOR_URL}`]);
    expect(process.env['AWS_REGION']).toBeUndefined();
  });

  it('defaultProfileRegion reads the [default] section only', () => {
    expect(defaultProfileRegion('[default]\nregion = us-east-1\n')).toBe('us-east-1');
    expect(defaultProfileRegion('[profile x]\nregion = eu-west-1\n[default]\n')).toBeUndefined();
    expect(defaultProfileRegion('')).toBeUndefined();
  });

  it('without the flag nothing changes', async () => {
    process.env['AWS_ACCESS_KEY_ID'] = 'HOSTKEYID00000000000';
    const opts = await parse(['deploy'], ['--profile', 'prod']);
    expect(opts['profile']).toBe('prod');
    // The usual mirror (program.ts) still runs.
    expect(process.env['AWS_PROFILE']).toBe('prod');
    expect(process.env['AWS_ACCESS_KEY_ID']).toBe('HOSTKEYID00000000000');
    expect(process.env['AWS_ENDPOINT_URL']).toBeUndefined();
    expect(activateAwsEmulatorForCommand).not.toHaveBeenCalled();
  });

  it('refuses a credential-shaped value before anything runs', async () => {
    const program = buildProgram();
    const deploy = find(program, ['deploy']);
    deploy.parseOptions(['--aws-emulator=https://u:topsecret@127.0.0.1:9']);
    expect(() => prepareAwsEmulatorForCommand(deploy)).toThrow(
      /user name, password, query or fragment/
    );
    expect(activateAwsEmulatorForCommand).not.toHaveBeenCalled();
  });
});

describe('under the flag (a `cdkd local` command)', () => {
  it('drops --profile and the credential env, keeps --role-arn, and leaves activation to the command', async () => {
    process.env['AWS_PROFILE'] = 'prod';
    process.env['AWS_ACCESS_KEY_ID'] = 'HOSTKEYID00000000000';
    const opts = await parse(
      ['local', 'invoke'],
      [
        'Stack/Fn',
        '--profile',
        'prod',
        '--role-arn',
        'arn:aws:iam::123456789012:role/Deploy',
        `--aws-emulator=${EMULATOR_URL}`,
      ]
    );
    expect(opts['profile']).toBeUndefined();
    expect(opts['roleArn']).toBe('arn:aws:iam::123456789012:role/Deploy');
    expect(process.env['AWS_PROFILE']).toBeUndefined();
    expect(process.env['AWS_ACCESS_KEY_ID']).toBeUndefined();
    expect(process.env['AWS_ENDPOINT_URL']).toBe(EMULATOR_URL);
    expect(activateAwsEmulatorForCommand).not.toHaveBeenCalled();
  });
});
