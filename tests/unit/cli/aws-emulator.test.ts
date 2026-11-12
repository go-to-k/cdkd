import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('../../../src/local/local-aws-wiring.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/local/local-aws-wiring.js')>();
  // The real activation probes the emulator's health endpoint over the network.
  return { ...actual, activateLocalAwsWiring: vi.fn(async () => {}) };
});

import { buildProgram } from '../../../src/cli/program.js';
import {
  defaultProfileRegion,
  prepareAwsEmulatorForCommand,
} from '../../../src/cli/aws-emulator.js';
import { activateLocalAwsWiring } from '../../../src/local/local-aws-wiring.js';
import { getLogger } from '../../../src/utils/logger.js';
import { pasteableRunFlags } from '../../../src/utils/pasteable-run-context.js';
import { setAwsEndpointOverrideSource } from '../../../src/utils/aws-client-defaults.js';

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
  vi.mocked(activateLocalAwsWiring).mockClear();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setAwsEndpointOverrideSource(undefined);
});

function find(program: Command, path: string[]): Command {
  let cmd = program;
  for (const name of path) cmd = cmd.commands.find((c) => c.name() === name)!;
  return cmd;
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
  ])('cdkd %s declares --aws-emulator', (...path) => {
    expect(declares(find(program, path), '--aws-emulator')).toBe(true);
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
    await program.parseAsync([...path, ...argv], { from: 'user' });
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
    process.env['AWS_ENDPOINT_URL_S3'] = 'https://elsewhere.example';
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
        'AWS_ENDPOINT_URL_S3',
        'CDKD_ROLE_ARN',
      ]) {
        expect(process.env[k], k).toBeUndefined();
      }
      expect(process.env['AWS_ENDPOINT_URL']).toBe(EMULATOR_URL);
      expect(process.env['AWS_CONFIG_FILE']).toBe(devNull);
      expect(process.env['AWS_SHARED_CREDENTIALS_FILE']).toBe(devNull);
      expect(process.env['AWS_EC2_METADATA_DISABLED']).toBe('true');
      expect(activateLocalAwsWiring).toHaveBeenCalledWith({ awsEmulator: EMULATOR_URL });
      // One notice naming what was ignored, never a value.
      const lines = info.mock.calls.map((c) => String(c[0])).filter((l) => /ignoring/.test(l));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('--profile');
      expect(lines[0]).toContain('--role-arn');
      expect(lines[0]).toContain('AWS_ACCESS_KEY_ID');
      expect(lines[0]).not.toContain('HOSTKEYID');
      expect(lines[0]).not.toContain('real-secret');
      expect(lines[0]).not.toContain('prod');
    } finally {
      info.mockRestore();
    }
  });

  it('CDKD_AWS_EMULATOR turns it on without the flag', async () => {
    process.env['CDKD_AWS_EMULATOR'] = EMULATOR_URL;
    process.env['AWS_PROFILE'] = 'prod';
    const opts = await parse(['state', 'list'], ['--profile', 'prod']);
    expect(opts['profile']).toBeUndefined();
    expect(process.env['AWS_PROFILE']).toBeUndefined();
    expect(activateLocalAwsWiring).toHaveBeenCalledTimes(1);
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
    process.env['HOME'] = home;
    await parse(['deploy'], [`--aws-emulator=${EMULATOR_URL}`]);
    expect(process.env['AWS_CONFIG_FILE']).toBe(join(run, 'config'));
    expect(process.env['AWS_SHARED_CREDENTIALS_FILE']).toBe(join(run, 'emulator_credentials'));
    expect(process.env['AWS_REGION']).toBe('eu-west-1');
    // A region the shell names wins.
    process.env['AWS_REGION'] = 'ap-northeast-1';
    await parse(['deploy'], [`--aws-emulator=${EMULATOR_URL}`]);
    expect(process.env['AWS_REGION']).toBe('ap-northeast-1');
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
    expect(activateLocalAwsWiring).not.toHaveBeenCalled();
  });

  it('refuses a credential-shaped value before anything runs', async () => {
    const program = buildProgram();
    const deploy = find(program, ['deploy']);
    deploy.parseOptions(['--aws-emulator=https://u:topsecret@127.0.0.1:9']);
    expect(() => prepareAwsEmulatorForCommand(deploy)).toThrow(
      /user name, password, query or fragment/
    );
    expect(activateLocalAwsWiring).not.toHaveBeenCalled();
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
    expect(activateLocalAwsWiring).not.toHaveBeenCalled();
  });
});
