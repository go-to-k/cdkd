import type { Command } from 'commander';
import { describe, expect, it } from 'vite-plus/test';
import { createLocalStateProvider as createCdkLocalStateProvider } from 'cdk-local';
import { createLocalStartWebFunctionCommand } from '../../../src/cli/commands/local-start-web-function.js';
import { createLocalCommand } from '../../../src/cli/commands/local-invoke.js';
import { cdkdExtraStateProviders } from '../../../src/cli/commands/local-state-source.js';
import { S3LocalStateProvider } from '../../../src/local/s3-local-state-provider.js';

// Unit coverage for the cdkd `local start-web-function` wrapper (#5295), a THIN
// pass-through to cdk-local's factory. The serve behavior and the
// web-function option block live in cdk-local and are tested there; what cdkd
// owns, and what is pinned here, is the registration, the inherited option
// contract, and the `--from-state` wiring: the bag this command parses selects
// cdkd's S3 provider through the registry it hands the factory, which is the
// state cdk-local resolves a bare `--assume-role`'s ExecutionRoleArn against.

function parsed(argv: string[]): Command {
  const cmd = createLocalStartWebFunctionCommand();
  cmd.action(() => {});
  cmd.exitOverride();
  cmd.configureOutput({ writeErr: () => {} });
  cmd.parse(['MyStack/Web', ...argv], { from: 'user' });
  return cmd;
}

describe('createLocalStartWebFunctionCommand', () => {
  const cmd = createLocalStartWebFunctionCommand();
  cmd.action(() => {});

  it('registers the start-web-function subcommand name', () => {
    expect(cmd.name()).toBe('start-web-function');
  });

  it('is registered under `cdkd local`', () => {
    const local = createLocalCommand();
    expect(local.commands.map((c) => c.name())).toContain('start-web-function');
  });

  it('accepts a single optional positional target (not variadic)', () => {
    expect(cmd.registeredArguments.map((a) => a.name())).toEqual(['target']);
    expect(cmd.registeredArguments[0]?.variadic).toBe(false);
    expect(cmd.registeredArguments[0]?.required).toBe(false);
  });

  it('inherits the web-function options from cdk-local', () => {
    const longs = cmd.options.map((o) => o.long);
    for (const long of [
      '--revision',
      '--port',
      '--host',
      '--platform',
      '--env-vars',
      '--no-pull',
      '--timeout',
      '--assume-role',
      '--from-cfn-stack',
      '--stack-region',
    ]) {
      expect(longs, long).toContain(long);
    }
  });

  it("declares cdkd's S3-backed state-source options and --no-assume-role", () => {
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toContain('--from-state');
    expect(longs).toContain('--state-bucket');
    expect(longs).toContain('--state-prefix');
    expect(longs).toContain('--no-assume-role');
  });

  it('defaults --from-state to false, --state-prefix to "cdkd", --port to 0, --host to 127.0.0.1', () => {
    expect(cmd.options.find((o) => o.long === '--from-state')?.defaultValue).toBe(false);
    expect(cmd.options.find((o) => o.long === '--state-prefix')?.defaultValue).toBe('cdkd');
    expect(cmd.options.find((o) => o.long === '--port')?.defaultValue).toBe(0);
    expect(cmd.options.find((o) => o.long === '--host')?.defaultValue).toBe('127.0.0.1');
  });

  it('hides --region (replaced by the deprecated twin)', () => {
    const region = cmd.options.find((o) => o.long === '--region');
    expect(region?.hidden).toBe(true);
  });

  it('parses --revision and a bare --assume-role', () => {
    const c = parsed(['--revision', 'RevB', '--assume-role']);
    expect(c.opts()).toMatchObject({ revision: 'RevB', assumeRole: true });
  });

  it('parses --no-assume-role as false and leaves an absent flag undefined', () => {
    expect(parsed(['--no-assume-role']).opts()['assumeRole']).toBe(false);
    expect(parsed([]).opts()['assumeRole']).toBeUndefined();
  });
});

describe('start-web-function --from-state wiring', () => {
  it("selects cdkd's S3 provider from the parsed bag, through cdk-local's dispatcher", () => {
    const cmd = parsed(['--from-state', '--state-bucket', 'my-bucket', '--state-prefix', 'p']);
    // The same dispatcher cdk-local's resolveLambdaContainerEnv calls for the
    // revision, with the registry this command was built with.
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
    const cmd = parsed([]);
    expect(
      createCdkLocalStateProvider(cmd.opts() as never, 'MyStack', 'us-east-1', cdkdExtraStateProviders)
    ).toBeUndefined();
  });

  it('keeps --from-state and --from-cfn-stack mutually exclusive', () => {
    const cmd = parsed(['--from-state', '--from-cfn-stack', 'MyStack']);
    expect(() =>
      createCdkLocalStateProvider(cmd.opts() as never, 'MyStack', 'us-east-1', cdkdExtraStateProviders)
    ).toThrow(/mutually exclusive/);
  });
});
