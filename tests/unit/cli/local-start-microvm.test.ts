import type { Command } from 'commander';
import { describe, expect, it } from 'vite-plus/test';
import { createLocalStateProvider as createCdkLocalStateProvider } from 'cdk-local';
import { createLocalStartMicrovmCommand } from '../../../src/cli/commands/local-start-microvm.js';
import { createLocalCommand } from '../../../src/cli/commands/local-invoke.js';
import { cdkdExtraStateProviders } from '../../../src/cli/commands/local-state-source.js';
import { S3LocalStateProvider } from '../../../src/local/s3-local-state-provider.js';

// Unit coverage for the cdkd `local start-microvm` wrapper (#5330), a THIN
// pass-through to cdk-local's factory. The build / hooks / front-door
// behavior and the microvm option block live in cdk-local and are tested
// there; what cdkd owns, and what is pinned here, is the registration, the
// inherited option contract, and the `--from-state` wiring: the bag this
// command parses selects cdkd's S3 provider through the registry it hands the
// factory, which resolves the image's EnvironmentVariables.

function parsed(argv: string[]): Command {
  const cmd = createLocalStartMicrovmCommand();
  cmd.action(() => {});
  cmd.exitOverride();
  cmd.configureOutput({ writeErr: () => {} });
  cmd.parse(['MyStack/Image', ...argv], { from: 'user' });
  return cmd;
}

describe('createLocalStartMicrovmCommand', () => {
  const cmd = createLocalStartMicrovmCommand();
  cmd.action(() => {});

  it('registers the start-microvm subcommand name', () => {
    expect(cmd.name()).toBe('start-microvm');
  });

  it('is registered under `cdkd local`', () => {
    const local = createLocalCommand();
    expect(local.commands.map((c) => c.name())).toContain('start-microvm');
  });

  it('accepts a single optional positional target (not variadic)', () => {
    expect(cmd.registeredArguments.map((a) => a.name())).toEqual(['target']);
    expect(cmd.registeredArguments[0]?.variadic).toBe(false);
    expect(cmd.registeredArguments[0]?.required).toBe(false);
  });

  it('inherits the microvm options from cdk-local', () => {
    const longs = cmd.options.map((o) => o.long);
    for (const long of [
      '--count',
      '--run-hook-payload',
      '--run-hook-payload-file',
      '--port',
      '--host',
      '--platform',
      '--proxy-port',
      '--auto-resume',
      '--no-build-cache',
      '--env-vars',
      '--timeout',
      '--assume-role',
      '--from-cfn-stack',
      '--stack-region',
    ]) {
      expect(longs, long).toContain(long);
    }
  });

  it("declares cdkd's S3-backed state-source options", () => {
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toContain('--from-state');
    expect(longs).toContain('--state-bucket');
    expect(longs).toContain('--state-prefix');
  });

  it('registers no --no-assume-role: --assume-role takes a required ARN', () => {
    const assume = cmd.options.find((o) => o.long === '--assume-role');
    expect(assume?.required).toBe(true);
    expect(cmd.options.map((o) => o.long)).not.toContain('--no-assume-role');
  });

  it('defaults --from-state to false, --state-prefix to "cdkd", --count to 1, --port to 0, --host to 127.0.0.1', () => {
    expect(cmd.options.find((o) => o.long === '--from-state')?.defaultValue).toBe(false);
    expect(cmd.options.find((o) => o.long === '--state-prefix')?.defaultValue).toBe('cdkd');
    expect(cmd.options.find((o) => o.long === '--count')?.defaultValue).toBe(1);
    expect(cmd.options.find((o) => o.long === '--port')?.defaultValue).toBe(0);
    expect(cmd.options.find((o) => o.long === '--host')?.defaultValue).toBe('127.0.0.1');
  });

  it('hides --region (replaced by the deprecated twin)', () => {
    expect(cmd.options.find((o) => o.long === '--region')?.hidden).toBe(true);
  });

  it('parses --count, --auto-resume and a repeatable --proxy-port', () => {
    const opts = parsed(['--count', '2', '--auto-resume', '--proxy-port', '5005', '--proxy-port', '5006']).opts();
    expect(opts['count']).toBe(2);
    expect(opts['autoResume']).toBe(true);
    expect(Array.isArray(opts['proxyPort'])).toBe(true);
    expect((opts['proxyPort'] as unknown[]).length).toBe(2);
  });

  it('parses --assume-role <arn>', () => {
    const arn = 'arn:aws:iam::111111111111:role/MicrovmExec';
    expect(parsed(['--assume-role', arn]).opts()['assumeRole']).toBe(arn);
  });
});

describe('start-microvm --from-state wiring', () => {
  it("selects cdkd's S3 provider from the parsed bag, through cdk-local's dispatcher", () => {
    const cmd = parsed(['--from-state', '--state-bucket', 'my-bucket', '--state-prefix', 'p']);
    const provider = createCdkLocalStateProvider(
      cmd.opts() as never,
      'MyStack',
      'us-east-1',
      cdkdExtraStateProviders
    );
    expect(provider).toBeInstanceOf(S3LocalStateProvider);
    expect((provider as unknown as { opts: unknown }).opts).toMatchObject({
      stateBucket: 'my-bucket',
      statePrefix: 'p',
    });
    provider?.dispose();
  });

  it('returns no provider without a state-source flag', () => {
    expect(
      createCdkLocalStateProvider(parsed([]).opts() as never, 'MyStack', 'us-east-1', cdkdExtraStateProviders)
    ).toBeUndefined();
  });

  it('keeps --from-state and --from-cfn-stack mutually exclusive', () => {
    const cmd = parsed(['--from-state', '--from-cfn-stack', 'MyStack']);
    expect(() =>
      createCdkLocalStateProvider(cmd.opts() as never, 'MyStack', 'us-east-1', cdkdExtraStateProviders)
    ).toThrow(/mutually exclusive/);
  });
});
